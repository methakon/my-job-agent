import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { FnfTradingService } from '../trading/fnf-trading.service';
import { FeedHealthService } from '../trading/unified-market-data/feed-health.service';
import { UnifiedArchiveService, ArchiveRunResult } from '../trading/unified-market-data/unified-archive.service';
import { PersistenceHealthMachine } from '../shared/persistence-state';
import { OffHoursResearchService } from '../trading/research/off-hours-research.service';
import { HistoricalContextBuilderService } from '../trading/unified-market-data/historical-context-builder.service';

type Signal = Awaited<ReturnType<FnfTradingService['generateSignals']>>[number];
type Portfolio = Awaited<ReturnType<FnfTradingService['listPortfolios']>>[number];
type Trade = Awaited<ReturnType<FnfTradingService['listTrades']>>[number];
type PersistencePolicy = 'ALLOW' | 'BLOCK_NEW_ENTRIES';

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000; // UTC → IST without tz database

/**
 * Autonomous paper-trading session driver (runs inside the headless trading agent).
 *
 * During IST Mon–Fri 09:15–15:30 it turns the real-data feed into live paper
 * executions: BUY/SELL signals open positions, target/stop levels (persisted in
 * decisionParams) close them, and FnfTradingService.closeTrade() rectifies the
 * decay calibration from every outcome — the self-learning loop the user asked
 * for. Outside the session it idles and logs an hourly heartbeat.
 */
@Injectable()
export class SessionDriverService implements OnModuleInit, OnModuleDestroy {
	private readonly logger = new Logger(SessionDriverService.name);
	private timer: ReturnType<typeof setInterval> | null = null;
	private inFlight = false;
	private readonly intervalMs: number;
	private readonly paperQty: number;
	private readonly sessionStartMin = 9 * 60 + 15; // 09:15 IST
	private readonly sessionEndMin = 15 * 60 + 30; // 15:30 IST
	private lastNoPortfolioLog = 0;
	private lastWarnAt = 0;
	private lastArmedLog = 0;
	private lastSessionDate = '';
	private lastSessionArchiveDate = '';
	private lastContextLoadDate = '';
	private lastDayArchiveDate = '';
	private persistencePolicy: PersistencePolicy = 'ALLOW';

	constructor(
		private readonly trading: FnfTradingService,
		private readonly feedHealth: FeedHealthService,
		private readonly persistenceHealth: PersistenceHealthMachine,
		private readonly unifiedArchive: UnifiedArchiveService,
		private readonly offHoursResearch: OffHoursResearchService,
		private readonly contextBuilder: HistoricalContextBuilderService,
	) {
		this.intervalMs = Math.max(5_000, Number(process.env.FNO_SESSION_DRIVER_MS ?? 10_000));
		this.paperQty = Math.max(1, Number(process.env.FNO_PAPER_QTY ?? 1));
	}

	private istDateKey(now: Date): string {
		const ist = new Date(now.getTime() + IST_OFFSET_MS);
		return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, '0')}-${String(ist.getUTCDate()).padStart(2, '0')}`;
	}

	/**
	 * Session tick archival (user directive 2026-09-04): today's ticks live in
	 * fnf_market_snapshots / fnf_option_quotes; each finished session's ticks are
	 * moved to the *_history tables and the live tables cleaned. Two idempotent
	 * passes run on the 10s tick:
	 *   1. Session close — first weekday tick at/after 15:30 archives that day's
	 *      session ticks (ts < today 15:30) once per IST date.
	 *   2. Day rollover — first tick of a new IST date archives any stragglers
	 *      (ts < today 00:00) so a live table never mixes two days.
	 */
	private async maybeArchiveSessions(now: Date): Promise<void> {
		try {
			const { dow, minutes } = this.istParts(now);
			const today = this.istDateKey(now);
			if (dow >= 1 && dow <= 5 && minutes >= this.sessionEndMin && this.lastSessionArchiveDate !== today) {
				this.lastSessionArchiveDate = today;
				// FNF archival (existing).
				const moved = await this.trading.archiveTicksBefore(`${today} 15:30:00`);
				if (moved.snapshots || moved.quotes) {
					this.logger.log(`session archive ${today}: ${moved.snapshots} snapshot(s), ${moved.quotes} quote(s) → history`);
				}
				// Unified archival (new).
				const unified = await this.unifiedArchive.archiveTicksBefore(`${today} 15:30:00`);
				if (unified.snapshots.deleted || unified.quotes.deleted) {
					this.logger.log(`unified session archive ${today}: ${unified.snapshots.deleted} snapshot(s), ${unified.quotes.deleted} quote(s) → history (${unified.durationMs}ms)`);
				} else if (unified.error) {
					this.logger.warn(`unified session archive ${today} error: ${unified.error}`);
				}
			}
			if (this.lastDayArchiveDate !== today) {
				this.lastDayArchiveDate = today;
				// FNF day-rollover archival (existing).
				const moved = await this.trading.archiveTicksBefore(`${today} 00:00:00`);
				if (moved.snapshots || moved.quotes) {
					this.logger.log(`day-rollover archive ${today}: ${moved.snapshots} snapshot(s), ${moved.quotes} quote(s) → history`);
				}
				// Unified day-rollover archival (new).
				const unified = await this.unifiedArchive.archiveTicksBefore(`${today} 00:00:00`);
				if (unified.snapshots.deleted || unified.quotes.deleted) {
					this.logger.log(`unified day-rollover archive ${today}: ${unified.snapshots.deleted} snapshot(s), ${unified.quotes.deleted} quote(s) → history (${unified.durationMs}ms)`);
				} else if (unified.error) {
					this.logger.warn(`unified day-rollover archive ${today} error: ${unified.error}`);
				}
			}
		} catch (error) {
			this.throttledWarn(`tick archive failed: ${(error as Error).message}`);
		}
	}

	onModuleInit(): void {
		this.logger.log(
			`session driver armed: IST Mon-Fri 09:15-15:30, tick ${this.intervalMs}ms, paper qty ${this.paperQty} LOT(S) of the ATM option (autoTrade portfolios only)`,
		);
		void this.cycle();
		this.timer = setInterval(() => void this.cycle(), this.intervalMs);
	}

	onModuleDestroy(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	private istParts(now: Date): { dow: number; minutes: number } {
		const ist = new Date(now.getTime() + IST_OFFSET_MS);
		return { dow: ist.getUTCDay(), minutes: ist.getUTCHours() * 60 + ist.getUTCMinutes() };
	}

	private sessionOpen(now: Date): boolean {
		const { dow, minutes } = this.istParts(now);
		return dow >= 1 && dow <= 5 && minutes >= this.sessionStartMin && minutes < this.sessionEndMin;
	}

	private throttledWarn(message: string): void {
		const now = Date.now();
		if (now - this.lastWarnAt < 300_000) return; // one warn per 5 min
		this.lastWarnAt = now;
		this.logger.warn(message);
	}

	async cycle(): Promise<void> {
		if (this.inFlight) return;
		this.inFlight = true;
		try {
			await this.runOnce();
		} finally {
			this.inFlight = false;
		}
	}

	private async runOnce(): Promise<void> {
		const now = new Date();

		// ── Phase 3: Persistence health gate (separate from market-data freshness) ──
		// The persistence state machine tracks DB health independently. When
		// persistence is DEGRADED or DOWN, new position entries are blocked but
		// existing positions continue monitoring (Phase 4A handles exits).
		const persistenceSnapshot = this.persistenceHealth.snapshot();
		this.persistencePolicy = persistenceSnapshot.state === 'HEALTHY' ? 'ALLOW' : 'BLOCK_NEW_ENTRIES';
		if (this.persistencePolicy === 'BLOCK_NEW_ENTRIES') {
			this.logger.warn(
				`[PERSISTENCE-GATE] state=${persistenceSnapshot.state} reason=${persistenceSnapshot.reason} — new entries BLOCKED, monitoring existing positions`,
			);
		}

		// Tick archival runs unconditionally (even with no portfolio / out of session).
		await this.maybeArchiveSessions(now);
		const portfolios = (await this.trading.listPortfolios()).filter((p) => p.autoTradeEnabled);
		if (!portfolios.length) {
			const ts = Date.now();
			if (ts - this.lastNoPortfolioLog > 600_000) {
				this.lastNoPortfolioLog = ts;
				this.logger.warn('no autoTrade-enabled portfolio found; creating sandbox portfolio is required for paper trading');
			}
			return;
		}

		if (!this.sessionOpen(now)) {
			// Log the session summary once after close, then an hourly idle heartbeat.
			const { dow } = this.istParts(now);
			const dayKey = `${now.getUTCFullYear()}-${now.getUTCMonth() + 1}-${now.getUTCDate()}`;
			// IST minute-based check: utcMinutes + 330 >= 960 (16:00 IST = 960 min)
			const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
			const istMinutes = utcMinutes + 330; // +5:30
			if (dow >= 1 && dow <= 5 && this.lastSessionDate !== dayKey && istMinutes >= 960) {
				this.lastSessionDate = dayKey;
				await this.logLearningSummary();

				// ── Off-Hours Research (asynchronous, never blocks trading) ──
				// Fire-and-forget: runs post-market analysis + adaptation review.
				// Errors are logged, never crash the trading agent.
				this.runOffHoursResearchSafely().catch((err) => {
					this.logger.error(`[RESEARCH] unhandled off-hours research error: ${(err as Error).message}`);
				});
			}
			if (Date.now() - this.lastArmedLog > 3_600_000) {
				this.lastArmedLog = Date.now();
				const next = new Date(now.getTime() + IST_OFFSET_MS);
				this.logger.log(
					`outside session (IST ${String(next.getUTCHours()).padStart(2, '0')}:${String(next.getUTCMinutes()).padStart(2, '0')}); next window 09:15 IST`,
				);
			}
			return;
		}

		// ── Session startup: load historical context (once per day, before first trade) ──
		const todayKey = `${now.getUTCFullYear()}-${now.getUTCMonth() + 1}-${now.getUTCDate()}`;
		if (this.lastContextLoadDate !== todayKey) {
			this.lastContextLoadDate = todayKey;
			await this.loadHistoricalContext();
		}

		for (const portfolio of portfolios) {
			try {
				await this.trading.ensureCalibrations(portfolio.id);
				const openTrades = (await this.trading.listTrades(portfolio.id, 500)).filter((t) => t.status === 'OPEN');

				// ── PHASE 4A: Continuous position monitoring ──────────────────────
				// Run the full monitoring pipeline: canonical data → health → shadow
				// → exit evaluation. Deterministic exit authorization only.
				let exits = 0;
				if (openTrades.length > 0) {
					const evaluations = await this.trading.evaluateOpenPositions(portfolio.id);
					for (const ev of evaluations) {
						if (ev.exitRecommended && ev.exitReason) {
							try {
								// Get exit price: use currentPremium from monitoring
								const exitPrice = ev.currentPremium;
								if (exitPrice > 0) {
									await this.trading.closeTrade(ev.tradeId, {
										exitPrice,
										exitTrigger: ev.exitReason,
									});
									this.logger.log(
										`[FNF-MONITOR] paper exit ${ev.tradeId} (${ev.instrument}) @ ${exitPrice}: ${ev.exitReason} | health=${ev.healthState} shadow=${ev.shadowAction} pnl=${ev.pnlPct.toFixed(1)}% trap=${ev.trapScore.toFixed(2)} src=${ev.dataSource}`,
									);
									exits += 1;
								}
							} catch (error) {
								this.throttledWarn(`monitoring exit failed for ${ev.tradeId}: ${(error as Error).message}`);
							}
						} else {
							// Log position state even when no exit is recommended
							this.logger.debug(
								`[FNF-MONITOR] ${ev.tradeId} (${ev.instrument}): health=${ev.healthState} shadow=${ev.shadowAction} pnl=${ev.pnlPct.toFixed(1)}% mae=${ev.mae} mfe=${ev.mfe} trap=${ev.trapScore.toFixed(2)} src=${ev.dataSource}`,
							);
						}
					}
				}

				// Opens only from option-contract signals (the engine never emits an
				// index instrument anymore; openTrade additionally hard-rejects any).
				const signals = await this.trading.generateSignals(portfolio.id);
				let opens = 0;
				for (const signal of signals) {
					if (signal.action === 'HOLD') continue;
					const alreadyOpen = openTrades.some((t) => t.instrument === signal.instrument);
					if (!alreadyOpen && await this.maybeOpen(portfolio, signal)) opens += 1;
				}
				if (opens || exits) {
					this.logger.log(
						`session cycle ${portfolio.label}: ${opens} open(s), ${exits} exit(s) across ${signals.length} signal(s) | persistence=${this.persistenceHealth.currentState()}`,
					);
				}
			} catch (error) {
				this.throttledWarn(`portfolio cycle failed (${portfolio.label}): ${(error as Error).message}`);
			}
		}
	}

	/** Open a paper position for a fresh signal, respecting Friday flag and headroom. */
	private async maybeOpen(portfolio: Portfolio, signal: Signal): Promise<boolean> {
		if (signal.fridayBlocked || signal.action === 'HOLD') return false;
		const { dow } = this.istParts(new Date());
		if (dow === 5 && !portfolio.fridayTradingEnabled) return false;
		const price = Number(signal.price);
		if (!Number.isFinite(price) || price <= 0) return false;
		// Account model (user directive 2026-09-03): paper trading starts with a
		// ₹5,000 deposit. Losses and service charges reduce the balance; the desk
		// keeps trading in later sessions with whatever remains (no freeze on
		// drawdown). Only when the remaining balance is truly gone do we hold new
		// opens and log "awaiting redeposit" — the user tops up at their discretion.
		const effectiveBalance = Number(portfolio.capital) + Number(portfolio.netPnl);
		if (effectiveBalance <= 0) {
			this.logger.warn(
				`paper account depleted (capital ${Number(portfolio.capital).toFixed(2)} + netPnl ${Number(portfolio.netPnl).toFixed(2)}) — holding new opens until user redeposits`,
			);
			return false;
		}
		// Feed-health gate (brief s8): never OPEN a new position on stale/down
		// data. Recovery is automatic — the gate re-opens when fresh ticks resume.
		const gate = this.feedHealth.gateForFnf();
		if (!gate.allowNewTrading) {
			this.throttledWarn(`feed gate paused new opens (${gate.reason}) — holding`);
			return false;
		}
		// Phase 5: Persistence-degraded policy — block new entries when persistence
		// is DEGRADED or DOWN. Existing positions continue monitoring (Phase 4A).
		if (this.persistencePolicy === 'BLOCK_NEW_ENTRIES') {
			this.throttledWarn(`persistence gate paused new opens (state=${this.persistenceHealth.currentState()}) — holding`);
			return false;
		}
		try {
			const decisionParams = JSON.stringify({
				openedBy: 'session-driver',
				algoSource: signal.algoSource,
				target: signal.target,
				stopLoss: signal.stopLoss,
				confidence: signal.confidence,
				decayedConfidence: signal.decayedConfidence,
				astroMatch: signal.astroMatch,
				fridayBlocked: signal.fridayBlocked,
				reasons: signal.reasons,
			});
			await this.trading.openTrade(
				{
					portfolioId: portfolio.id,
					instrument: signal.instrument,
					side: signal.action,
					quantity: this.paperQty,
					entryPrice: price,
					algoSource: signal.algoSource,
					decisionParams,
				},
				new Date(),
			);
			this.logger.log(
				`paper open ${signal.action} ${this.paperQty} lot(s) ${signal.instrument} @ premium ${price} (conf ${signal.decayedConfidence}, ${signal.algoSource})`,
			);
			return true;
		} catch (error) {
			this.throttledWarn(`open failed for ${signal.instrument}: ${(error as Error).message}`);
			return false;
		}
	}

	private async logLearningSummary(): Promise<void> {
		try {
			const summary = await this.trading.learningSummary();
			this.logger.log(
				`learning summary — ${summary.total} closed trades, ${summary.winners} wins (${summary.winRate}%), net P&L ${summary.netPnl.toFixed(2)}`,
			);
			for (const [algo, stat] of Object.entries(summary.byAlgo)) {
				this.logger.log(`  ${algo}: ${stat.count} trades, ${stat.winRate}% win, net ${stat.netPnl.toFixed(2)}`);
			}
		} catch (error) {
			this.throttledWarn(`learning summary failed: ${(error as Error).message}`);
		}
	}

	/**
	 * Run off-hours research asynchronously. Fire-and-forget from session close.
	 * Uses today's session date, NIFTY underlying, and empty trades (research
	 * loads its own historical data). Errors logged, never crash the agent.
	 */
	private async runOffHoursResearchSafely(): Promise<void> {
		try {
			const today = new Date();
			const sessionDate = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}-${String(today.getUTCDate()).padStart(2, '0')}`;
			this.logger.log(`[RESEARCH] off-hours research triggered for ${sessionDate}`);
			// Pass empty trades — the research service loads its own data from history tables
			const report = await this.offHoursResearch.runDailyResearch('NIFTY', sessionDate, []);
			this.logger.log(
				`[RESEARCH] completed: regime=${report.marketRegime}, ${report.candidateImprovements.length} candidates`,
			);
		} catch (error) {
			this.logger.error(`[RESEARCH] off-hours research failed (non-fatal): ${(error as Error).message}`);
		}
	}

	/**
	 * Load precomputed historical context into the builder's cache.
	 * Called at session startup. Reads from the history tables via the
	 * HistoricalContextBuilder's cached precomputed context (memory-only).
	 * No per-tick DB queries — just a Map lookup after the initial load.
	 */
	private async loadHistoricalContext(): Promise<void> {
		try {
			const today = new Date().toISOString().slice(0, 10);
			// assembleContext needs activeCandidates; none at startup (empty = no adaptations yet)
			const context = await this.contextBuilder.assembleContext('NIFTY', []);
			this.logger.log(
				`[CONTEXT] loaded: regime=${context.historical.regime}, ` +
				`vol=${context.historical.volatility.dailyVol ?? 'N/A'}, ` +
				`trend=${context.historical.trend.direction}, ` +
				`patterns=${Object.keys(context.patterns.frequency).length}`,
			);
		} catch (error) {
			this.logger.warn(`[CONTEXT] historical context load failed (non-fatal): ${(error as Error).message}`);
		}
	}
}
