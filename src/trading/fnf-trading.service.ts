import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThanOrEqual, IsNull, DeepPartial } from 'typeorm';
import { FnfPortfolio } from './fnf-portfolio.entity';
import { FnfTrade } from './fnf-trade.entity';
import { FnfMarketSnapshot } from './fnf-market-snapshot.entity';
import { FnfDecayCalibration } from './fnf-decay-calibration.entity';
import { FnfMarketSnapshotHistory } from './fnf-market-snapshot-history.entity';
import { FnfOptionQuoteHistory } from './fnf-option-quote-history.entity';
import { FnfTradeReflection } from './fnf-trade-reflection.entity';
import { FnfDecisionJournal } from './fnf-decision-journal.entity';
import { FnfTradeReport } from './fnf-trade-report.entity';
import { localGreeks } from './bsm-greeks';
import { DecisionSnapshot } from './fnf-decision-snapshot';
import { FnfOptionChainService } from './fnf-option-chain.service';
import { OptionContract } from './option-chain-parser';
import { CreatePortfolioDto, UpdatePortfolioDto, CreateTradeDto, CloseTradeDto, IngestSnapshotDto, SetDecayCalibrationDto } from './fnf-trading.dto';
import { AstroMuhurtaService } from '../astro/astro-muhurta.service';

export { DecisionSnapshot } from './fnf-decision-snapshot';

/** Minimum score for a shubh muhurta window (same threshold as the engine). */
const SHUBH_SCORE_MIN = Number(process.env.SHUBH_MIN_SCORE ?? 65);

export interface CostBreakdown {
	notional: number;
	brokerage: number;
	stt: number;
	exchangeTxn: number;
	gst: number;
	sebi: number;
	stamp: number;
	total: number;
}

export interface SignalDecay {
	/** Hourly exponential decay coefficient applied to this signal. */
	rate: number;
	/** Age of the underlying market data in hours (now − snapshot ts). */
	ageHours: number;
	/** 1.0 inside the weekday timing window, <1 outside. */
	timingFactor: number;
	/** Weekday (0=Sun…6=Sat) whose calibration was used. */
	weekday: number;
	windowStartHour: number;
	windowEndHour: number;
	lastRectifiedAt: Date | null;
}

export interface AlgoSignal {
	instrument: string;
	algoSource: string;
	action: 'BUY' | 'SELL' | 'HOLD';
	price: number;
	target: number;
	stopLoss: number;
	/** Raw model confidence before decay, 0..100. */
	confidence: number;
	/** Decay-adjusted confidence actually used for the decision, 0..100. */
	decayedConfidence: number;
	decay: SignalDecay;
	scenarios: { name: string; probability: number; target: number }[];
	astroMatch: { shubh: boolean; score: number; label: string };
	fridayBlocked: boolean;
	reasons: string[];
}

/** GATE 1 (#3/#7): one ranked candidate carrying its point-in-time quote snapshot
 *  (bid/ask/mid/ltp, spread, volume, OI, OI change, provider, quote ts/age) so the
 *  decision can be re-examined against exactly the quotes that were live. */
export interface JournalCandidate {
	symbol: string;
	premium: number;
	contractValue: number;
	spreadPct: number | null;
	delta: number | null;
	score: number;
	quoteTsMs?: number;
	quoteAgeMin?: number;
	bid?: number | null;
	ask?: number | null;
	mid?: number | null;
	ltp?: number;
	volume?: number;
	oi?: number;
	oiChange?: number | null;
	iv?: number | null;
	provider?: string;
	quality?: string;
}

/** GATE 1 (#5/#7): a feature value with its actual availability timestamp
 *  (epoch ms of the IST-naive DB ts — same convention as the ts columns). */
export interface JournalFeature {
	underlying: string;
	spot: number;
	sma20: number;
	sma5: number;
	momentumFrac: number | null;
	bars: number;
	lastBarMs: number;
}

/**
 * FYERS per-segment cost model (official FYERS charges KB, verified 2026-09-04).
 * Brokerage is charged per executed order — each leg (open AND close) incurs it.
 *  - Futures:  lower of 0.03% × turnover or ₹20
 *  - Options:  flat ₹20 per executed order (premium turnover basis)
 * Statutory: STT sell-side only (futures 0.01%, options 0.05% of premium);
 * NSE txn (futures 0.00183%, options 0.03553% of premium); stamp duty buy-side
 * (futures 0.002%, options 0.003%); SEBI ₹10/crore; GST 18% on (brokerage + txn + SEBI).
 */
const COST_RATES = {
	future: {
		brokeragePct: 0.0003, // 0.03% × turnover
		brokerageFlat: 20, // …or ₹20 flat, whichever is LOWER
		sttSellPct: 0.0001, // 0.01% sell side
		exchangeTxnPct: 0.0000183, // NSE 0.00183%
		stampBuyPct: 0.00002, // 0.002% buy side
	},
	option: {
		brokeragePct: 0, // options: flat fee, no percentage leg
		brokerageFlat: 20, // ₹20 per executed order
		sttSellPct: 0.0005, // 0.05% of premium, sell side
		exchangeTxnPct: 0.0003553, // NSE 0.03553% of premium
		stampBuyPct: 0.00003, // 0.003% of premium, buy side
	},
	gstPct: 0.18,
	sebiPct: 0.000001, // ₹10 per crore
};

export type CostSegment = 'future' | 'option';

/** Classify a FYERS instrument symbol into its cost segment. */
export const segmentOfInstrument = (instrument: string): CostSegment =>
	/(CE|PE)$/i.test(instrument) ? 'option' : 'future';

export const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Signal-decay engine defaults (rectified day-wise from real outcomes). */
export const DECAY_DEFAULTS = {
	rate: 0.04, // hourly exponential coefficient
	minRate: 0.005,
	maxRate: 0.3,
	learningRate: 0.15, // per-trade rectification step (fraction of rate)
	windowStart: 9.5, // 09:30 IST
	windowEnd: 15.25, // 15:15 IST
	windowStep: 0.25, // hours the window edges drift per rectification
	minWindowStart: 9, // never earlier than market open (09:15)
	maxWindowEnd: 15.5, // never later than market close (15:30)
	timingPenalty: 0.85, // confidence multiplier outside the window
	confidenceFloor: 35, // decayed confidence below this → HOLD
} as const;

@Injectable()
export class FnfTradingService {
	private readonly logger = new Logger(FnfTradingService.name);

	constructor(
		@InjectRepository(FnfPortfolio) private readonly portfolios: Repository<FnfPortfolio>,
		@InjectRepository(FnfTrade) private readonly trades: Repository<FnfTrade>,
		@InjectRepository(FnfMarketSnapshot) private readonly snapshots: Repository<FnfMarketSnapshot>,
		@InjectRepository(FnfDecayCalibration) private readonly calibrations: Repository<FnfDecayCalibration>,
		@InjectRepository(FnfMarketSnapshotHistory) private readonly snapshotHistory: Repository<FnfMarketSnapshotHistory>,
		@InjectRepository(FnfOptionQuoteHistory) private readonly quoteHistory: Repository<FnfOptionQuoteHistory>,
		@InjectRepository(FnfTradeReflection) private readonly reflections: Repository<FnfTradeReflection>,
		@InjectRepository(FnfDecisionJournal) private readonly journal: Repository<FnfDecisionJournal>,
		@InjectRepository(FnfTradeReport) private readonly tradeReports: Repository<FnfTradeReport>,
		private readonly optionChain: FnfOptionChainService,
		private readonly muhurta: AstroMuhurtaService,
	) {
		void this.ensureCalibrations().catch((e) => this.logger.warn(`calibration seed failed: ${e.message}`));
	}

	// ── Portfolio ────────────────────────────────────────────────────────

	/** Real envelopes (on_real_data=1) by default — sandbox portfolios are only
	 *  returned when realOnly=false (explicit isolation; Upstox task). */
	async listPortfolios(realOnly = true): Promise<FnfPortfolio[]> {
		if (realOnly) return this.portfolios.find({ where: { onRealData: true }, order: { createdAt: 'ASC' } });
		return this.portfolios.find({ order: { createdAt: 'ASC' } });
	}

	async getPortfolio(id: string): Promise<FnfPortfolio> {
		const p = await this.portfolios.findOne({ where: { id } });
		if (!p) throw new NotFoundException(`portfolio ${id} not found`);
		return p;
	}

	async createPortfolio(dto: CreatePortfolioDto): Promise<FnfPortfolio> {
		const ceiling = dto.ceiling ?? dto.capital;
		return this.portfolios.save(this.portfolios.create({
			label: dto.label ?? 'main',
			capital: dto.capital,
			ceiling,
			autoTradeEnabled: dto.autoTradeEnabled ?? false,
			fridayTradingEnabled: dto.fridayTradingEnabled ?? false,
			brokerConfig: dto.brokerConfig ?? undefined,
			// Isolation (Upstox task): sandbox envelopes are created explicitly
			// with on_real_data=false + provider/mode; defaults preserve FYERS.
			onRealData: dto.onRealData ?? true,
			executionProvider: dto.executionProvider ?? 'FYERS',
			executionMode: dto.executionMode ?? 'REAL',
		}));
	}

	async updatePortfolio(id: string, dto: UpdatePortfolioDto): Promise<FnfPortfolio> {
		const p = await this.getPortfolio(id);
		Object.assign(p, {
			label: dto.label ?? p.label,
			capital: dto.capital ?? p.capital,
			ceiling: dto.ceiling ?? p.ceiling,
			autoTradeEnabled: dto.autoTradeEnabled ?? p.autoTradeEnabled,
			fridayTradingEnabled: dto.fridayTradingEnabled ?? p.fridayTradingEnabled,
			brokerConfig: dto.brokerConfig ?? p.brokerConfig,
		});
		return this.portfolios.save(p);
	}

	async setAutoTrade(id: string, enabled: boolean): Promise<FnfPortfolio> {
		return this.updatePortfolio(id, { autoTradeEnabled: enabled });
	}

	async setFridayTrading(id: string, enabled: boolean): Promise<FnfPortfolio> {
		return this.updatePortfolio(id, { fridayTradingEnabled: enabled });
	}

	// ── Trades ───────────────────────────────────────────────────────────

	/** Open a position. HARD RULE: the trading engine only opens positions on
	 *  registered option contracts (CE/PE). Index/underlying symbols (e.g.
	 *  NSE:NIFTY50-INDEX, NSE:NIFTYBANK-INDEX, SENSEX) are REFERENCE-ONLY and are
	 *  rejected here — the desk never trades an index level directly. Entry price
	 *  is the option PREMIUM per unit; quantity is in LOTS and is multiplied by
	 *  the contract lot size; the premium outlay (premium × units) is what must
	 *  fit the portfolio ceiling. Enforces: contract registered, portfolio exists,
	 *  capital headroom, and the Friday block. */
	async openTrade(dto: CreateTradeDto, asOf: Date = new Date()): Promise<FnfTrade> {
		const portfolio = await this.getPortfolio(dto.portfolioId);
		const isFriday = asOf.getDay() === 5;
		if (isFriday && !portfolio.fridayTradingEnabled) {
			throw new BadRequestException(
				'Friday block active: no new positions on Friday unless fridayTradingEnabled. Enable the Friday toggle to override.',
			);
		}

		// --- Hard safeguard: only registered option contracts are tradable. ---
		if (/-INDEX$/i.test(dto.instrument)) {
			throw new BadRequestException(
				`instrument ${dto.instrument} is an index/underlying — reference only. The desk trades option contracts (CE/PE) on the chain around it, never the index itself.`,
			);
		}
		const contract = await this.optionChain.findContractBySymbol(dto.instrument);
		if (!contract) {
			throw new BadRequestException(
				`instrument ${dto.instrument} is not a registered option contract. Register the CE/PE contract (expiry/strike/lot size) before trading it.`,
			);
		}
		const lotSize = Number(contract.lotSize) || 1;
		const units = Math.round(dto.quantity) * lotSize; // quantity is in LOTS
		const premium = Number(dto.entryPrice);
		const outlay = units * premium; // premium outlay = max loss for a long option
		const headroom = (Number(portfolio.ceiling) || Number(portfolio.capital)) - Number(portfolio.deployed);
		if (outlay > headroom) {
			throw new BadRequestException(
				`premium outlay ${outlay.toFixed(2)} (${dto.quantity} lot(s) × ${lotSize} units × ₹${premium.toFixed(2)}) exceeds available headroom ${headroom.toFixed(2)} (ceiling ${portfolio.ceiling} − deployed ${portfolio.deployed})`,
			);
		}

		const contractMeta = {
			symbol: contract.symbol,
			underlying: contract.underlying,
			expiry: contract.expiry,
			strike: Number(contract.strike),
			optionType: contract.optionType,
			lotSize,
			units,
		};
		const trade = await this.trades.save(this.trades.create({
			portfolio,
			instrument: dto.instrument,
			side: dto.side,
			quantity: units, // stored in units (lots × lot size)
			entryPrice: premium, // premium per unit
			algoSource: dto.algoSource ?? undefined,
			decisionParams: dto.decisionParams
				? JSON.stringify({ ...JSON.parse(dto.decisionParams), contract: contractMeta })
				: JSON.stringify({ contract: contractMeta }),
			status: 'OPEN',
		}));

		await this.portfolios.update(portfolio.id, {
			deployed: Number(portfolio.deployed) + outlay,
		});
		this.logger.log(`[FYERS][REAL] option ${dto.side} ${dto.quantity} lot(s) ${dto.instrument} @ ₹${premium.toFixed(2)}/unit (${units} units, outlay ${outlay.toFixed(2)})`);
		void this.queueTradeReport({
			kind: 'OPEN',
			occurredAt: asOf,
			instrument: dto.instrument,
			side: dto.side,
			status: 'OPEN',
			price: premium,
			quantity: units,
			netPnl: null,
			ceiling: Number(portfolio.ceiling ?? portfolio.capital),
			message: `🟢 OPEN ${dto.side} ${dto.quantity} lot(s) ${dto.instrument}\n   @ ₹${premium.toFixed(2)}/unit · outlay ₹${outlay.toFixed(2)} · envelope ₹${Number(portfolio.ceiling ?? portfolio.capital).toFixed(2)}`,
		});
		return trade;
	}

	/** Close a position: compute gross/net P&L + round-trip cost from the option
	 *  premiums, update portfolio, then rectify the decay calibration day-wise
	 *  from this outcome. */
	async closeTrade(id: string, dto: CloseTradeDto, asOf: Date = new Date()): Promise<FnfTrade> {
		const trade = await this.trades.findOne({ where: { id }, relations: { portfolio: true } });
		if (!trade) throw new NotFoundException(`trade ${id} not found`);
		if (trade.status !== 'OPEN') throw new BadRequestException(`trade ${id} already ${trade.status}`);

		const qty = Number(trade.quantity); // units (lots × lot size)
		const entry = Number(trade.entryPrice); // premium per unit at entry
		const exit = dto.exitPrice; // premium per unit at exit
		const side = trade.side as 'BUY' | 'SELL';
		const segment = segmentOfInstrument(trade.instrument);

		// gross P&L in PREMIUM terms: BUY (long option) → (exit − entry) × units ;
		// SELL (short option) → (entry − exit) × units. Never index-point math.
		const grossPnl = side === 'BUY' ? (exit - entry) * qty : (entry - exit) * qty;

		// Round-trip cost = entry leg + exit leg (each executed order is charged;
		// FYERS options flat ₹20/order; statutory on each leg's premium turnover).
		// Caller may override with an exact cost.
		const entryTurnover = qty * entry;
		const exitTurnover = qty * exit;
		const cost = dto.cost ?? (
			this.calculateCost(entryTurnover, 'BUY', segment).total +
			this.calculateCost(exitTurnover, side === 'SELL' ? 'SELL' : 'BUY', segment).total
		);
		const netPnl = grossPnl - cost;

		trade.exitPrice = exit;
		trade.grossPnl = grossPnl;
		trade.cost = cost;
		trade.netPnl = netPnl;
		trade.status = 'CLOSED';
		trade.closedAt = asOf;
		// Record why this position closed (target/stop/time/manual) so the
		// Reflexion row can classify the outcome deterministically (T-08).
		if (dto.exitTrigger) {
			const dp = (typeof trade.decisionParams === 'string' && trade.decisionParams ? JSON.parse(trade.decisionParams) : {}) as Record<string, unknown>;
			dp.exitTrigger = dto.exitTrigger;
			trade.decisionParams = JSON.stringify(dp);
		}
		const saved = await this.trades.save(trade);

		const portfolio = trade.portfolio;
		// Envelope model (user directive 2026-09-03/04): ₹5,000 base stored in the
		// DB; after every close the stored envelope (ceiling) auto-grows/shrinks by
		// (gross P&L − charges) = netPnl, so future sessions can deploy the gains.
		const newNetPnl = Number(portfolio.netPnl) + netPnl;
		const newCeiling = Math.max(0, Number(portfolio.capital) + newNetPnl);
		await this.portfolios.update(portfolio.id, {
			// release the premium outlay committed at entry (entry × units), not exit value
			deployed: Math.max(0, Number(portfolio.deployed) - qty * entry),
			netPnl: newNetPnl,
			ceiling: newCeiling,
			totalCost: Number(portfolio.totalCost) + cost,
		});
		this.logger.log(`[FYERS][REAL] trade closed ${id}: gross ${grossPnl.toFixed(2)} cost ${cost.toFixed(2)} net ${netPnl.toFixed(2)}`);

		// Day-wise decay rectification from this outcome (fire-and-forget).
		void this.rectifyDecay(portfolio.id).catch((e) => this.logger.warn(`decay rectify failed: ${e.message}`));

		// Reflexion episodic memory (T-08 → v4 Gate 14): deterministic outcome
		// classification + critique persisted for later decision injection.
		void this.writeReflection(saved, newNetPnl)
			.then(() => undefined)
			.catch((e) => this.logger.warn(`reflection write failed: ${(e as Error).message}`));

		// T-07: trade report outbox row (delivered to Telegram/WhatsApp by the local poller).
		const exitLabel = (saved.decisionParams as string | null) ? (JSON.parse(String(saved.decisionParams)) as { exitTrigger?: string })?.exitTrigger ?? 'manual' : 'manual';
		void this.queueTradeReport({
			kind: 'CLOSE',
			occurredAt: asOf,
			instrument: trade.instrument,
			side: (trade.side as string) || 'BUY',
			status: saved.status,
			price: Number(saved.exitPrice),
			quantity: qty,
			netPnl: newNetPnl,
			ceiling: Number(portfolio.ceiling ?? portfolio.capital),
			message: `${newNetPnl >= 0 ? '🟢' : '🔴'} CLOSE ${trade.side} ${trade.instrument} · ${exitLabel}\n   exit ₹${Number(saved.exitPrice).toFixed(2)} · net ₹${newNetPnl.toFixed(2)} (gross ${grossPnl.toFixed(2)}, cost ${cost.toFixed(2)}) · envelope now ₹${Number(portfolio.ceiling ?? portfolio.capital).toFixed(2)}`,
		});

		return saved;
}

/** Deterministic Reflexion row for a closed trade (T-08). Never an LLM call —
	 *  production rules stay deterministic; the critique is structured facts. */
	private async writeReflection(trade: FnfTrade, portfolioNetPnl: number): Promise<void> {
		// Resolve the true underlying token (contract registry first; fall back to
		// symbol parsing for legacy index trades) so the signal-side injection
		// (listReflections by underlying) round-trips.
		let underlying = String(trade.instrument).replace(/^[A-Z]+:/, '').replace(/-INDEX$/, '').toUpperCase();
		try {
			const contract = await this.optionChain.findContractBySymbol(trade.instrument);
			if (contract?.underlying) underlying = String(contract.underlying).toUpperCase();
		} catch {
			/* keep parsed fallback */
		}
		const side = (trade.side as string) || 'BUY';
		const entryUnits = Number(trade.quantity) || 1;
		const entryOutlay = entryUnits * Number(trade.entryPrice);
		const net = Number(trade.netPnl) || 0;
		const pnlPct = entryOutlay > 0 ? (net / entryOutlay) * 100 : 0;
		const heldMs = trade.closedAt ? new Date(trade.closedAt).getTime() - new Date(trade.orderedAt).getTime() : 0;
		const holdingMinutes = Math.max(0, Math.round(heldMs / 60_000));
		// decisionParams is stored as a JSON string — parse it before reading exitTrigger.
		let exitTrigger = 'manual';
		try {
			const dp = (typeof trade.decisionParams === 'string' && trade.decisionParams ? JSON.parse(trade.decisionParams) : trade.decisionParams ?? {}) as { exitTrigger?: string };
			exitTrigger = String(dp.exitTrigger ?? 'manual');
		} catch {
			exitTrigger = 'manual';
		}
		const win = net > 0;
		const outClass = win
			? exitTrigger === 'target'
				? 'WIN_TARGET'
				: exitTrigger === 'time'
					? 'WIN_TIME'
					: 'WIN_MANUAL'
			: exitTrigger === 'stop'
				? 'LOSS_STOP'
				: exitTrigger === 'time'
					? 'TIME_EXIT'
					: 'LOSS_MANUAL';
		const failureTag = win ? '' : exitTrigger === 'stop' ? 'stopped-out' : exitTrigger === 'time' ? 'time-decay-exit' : 'manual-loss';
		const critique =
			`${underlying} ${side} closed ${exitTrigger}: entry ${trade.entryPrice} → exit ${trade.exitPrice}, ` +
			`net ${net.toFixed(2)} (${pnlPct.toFixed(1)}% on ₹${entryOutlay.toFixed(0)} outlay), held ${holdingMinutes}m. ` +
			(win
				? `Thesis paid. Exit discipline worked${exitTrigger === 'time' ? ' (time-stop respected)' : ''}.`
				: failureTag === 'stopped-out'
					? 'Thesis failed before target — review strike distance, entry timing and direction quality; check decay calibration.'
					: failureTag === 'time-decay-exit'
						? 'Theta eroded the position before target — strike too close to ATM or holding too long for the DTE.'
						: 'Closed manually at a loss — was the original thesis violated, or was this a discipline miss?');
		const heuristic = win
			? `Repeat ${underlying} ${side} setups that exit via ${exitTrigger} within ${holdingMinutes}m — they cleared decay and cost hurdles.`
			: failureTag === 'stopped-out'
				? `Do not re-enter ${underlying} ${side} while decayed confidence is below floor or immediately after a stopped-out loss.`
				: failureTag === 'time-decay-exit'
					? `Prefer strikes with ≥ 3-5 DTE and avoid holding ${underlying} options into theta burn without a plan.`
					: `Define the exit BEFORE entry; a manual loss without a recorded reason is a process failure.`;
		// Gate 14 #1: map the outcome to a failure family (deterministic).
		let failureFamily = 'none';
		if (!win) {
			if (exitTrigger === 'stop') failureFamily = 'signal'; // thesis failed before target
			else if (exitTrigger === 'time') failureFamily = 'timing'; // theta/time erosion
			else failureFamily = 'execution'; // manual close without reason
		} else if (exitTrigger === 'time') {
			failureFamily = 'timing';
		}
		// Gate 14 #5/#7/#8: evidence-class the heuristic. Identical heuristic text
		// from a prior reflection → increment confirmations and promote the CLASS
		// (OBSERVATION → HYPOTHESIS at 2 → TESTED_RULE at 3). Never promote from a
		// single trade; a later contradictory loss would need explicit rejection.
		let reflectionClass = 'OBSERVATION';
		let confirmations = 1;
		try {
			const prior = await this.reflections
				.find({ where: { underlying, heuristic }, order: { createdAt: 'DESC' }, take: 1 })
				.catch(() => [] as FnfTradeReflection[]);
			if (prior[0]) {
				confirmations = (prior[0].confirmations ?? 1) + 1;
				reflectionClass =
					confirmations >= 3 ? 'TESTED_RULE' : confirmations >= 2 ? 'HYPOTHESIS' : 'OBSERVATION';
			}
		} catch {
			/* promotion lookup failure → keep OBSERVATION/1 */
		}
		await this.reflections.save(
			this.reflections.create({
				tradeId: trade.id,
				underlying,
				strategyType: String(trade.algoSource ?? 'unknown'),
				pnlRealized: net,
				pnlPct,
				holdingMinutes,
				exitTrigger,
				outcomeClass: outClass,
				failureTag,
				failureFamily,
				reflectionClass,
				confirmations,
				critique,
				heuristic,
			}),
		);
		this.logger.log(`[FYERS][REAL] reflection written for ${trade.id.slice(0, 8)}: ${outClass} ${net.toFixed(2)} [${reflectionClass} x${confirmations}]`);
		void portfolioNetPnl;
	}

	/** Latest Reflexion rows (optionally per underlying) for the UI / injection. */
	async listReflections(underlying?: string, limit = 10): Promise<FnfTradeReflection[]> {
		const where = underlying ? { underlying } : {};
		return this.reflections.find({ where, order: { createdAt: 'DESC' }, take: Math.min(limit, 50) });
	}

	/** Latest decision-journal rows for the UI / audit (GATE 1). */
	async listJournal(limit = 25): Promise<FnfDecisionJournal[]> {
		return this.journal.find({ order: { ts: 'DESC' }, take: Math.min(limit, 200) });
	}

	// ── T-07 trade-report outbox ──────────────────────────────────────────

	/** Insert a report row (fire-and-forget; the local poller delivers it). */
	private queueTradeReport(r: {
		kind: string; occurredAt: Date; instrument?: string | null; side?: string | null;
		status?: string | null; price?: number | null; quantity?: number | null;
		netPnl?: number | null; ceiling?: number | null; message: string;
	}): void {
		void this.tradeReports
			.save(this.tradeReports.create({ ...r, delivery: 'pending' }))
			.catch((e) => this.logger.warn(`report queue failed: ${(e as Error).message}`));
	}

	/** Pending report rows for the poller (oldest first). */
	async pendingTradeReports(limit = 20): Promise<FnfTradeReport[]> {
		return this.tradeReports.find({ where: { delivery: 'pending' }, order: { createdAt: 'ASC' }, take: Math.min(limit, 50) });
	}

	/** Mark a report delivered (poller calls after a successful send). */
	async markTradeReportSent(id: string, delivery = 'sent'): Promise<void> {
		await this.tradeReports.update(id, { delivery });
	}

	/** Persist one decision cycle to the point-in-time journal (GATE 1).
	 *  Fire-and-forget — journal write must never block the signal path. */
	private journalDecision(opts: {
		portfolioId?: string;
		asOf: Date;
		actionFamily: 'BUY' | 'NO TRADE' | 'ERROR';
		winnerSymbol?: string;
		algoSource: string;
		candidates: JournalCandidate[];
		rejected: string[];
		directionSummary: Record<string, string>;
		reasons?: string[];
		/** GATE 1 #8: engine-cycle latency (ms) from cycle start to decision. */
		cycleMs?: number;
		/** GATE 1 #7: newest data consumed by the decision (snapshot/quote ts, epoch ms). */
		featureCutoffMs?: number | null;
		/** GATE 1 #5: every feature used, at its actual availability ts. */
		features?: JournalFeature[];
		/** GATE 1 #8: data-side gaps observed during the cycle (validation failures = rejected). */
		dataWarnings?: string[];
		/** Decision unique ID (point-in-time, correlates snapshot/journal/AI). */
		decisionId?: string;
		/** Point-in-time decision snapshot for AI shadow path (no reconstruction). */
		snapshot?: DecisionSnapshot;
	}): void {
		void (async () => {
			try {
				// max data age across quotes used (best-effort from ts fields)
				let maxAgeMin = 0;
				for (const r of opts.rejected) {
					const m = r.match(/stale quote \(([\d.]+)m\)/);
					if (m) maxAgeMin = Math.max(maxAgeMin, Number(m[1]));
				}
				const phase = this.currentSessionPhase(opts.asOf);
				await this.journal.save(
					this.journal.create({
						ts: opts.asOf,
						portfolioId: opts.portfolioId ?? null,
						sessionPhase: phase,
						dataAgeMin: maxAgeMin,
						actionFamily: opts.actionFamily,
						winnerSymbol: opts.winnerSymbol ?? '',
						algoSource: opts.algoSource,
						buildSha: process.env.BUILD_SHA || (process.env.npm_package_version ? `v${process.env.npm_package_version}` : ''),
						detailJson: JSON.stringify({
						decisionId: opts.decisionId ?? null,
						snapshot: opts.snapshot ? this.sanitizeSnapshot(opts.snapshot) : null,
							direction: opts.directionSummary,
							candidates: opts.candidates,
							rejectedCount: opts.rejected.length,
							rejected: opts.rejected.slice(0, 60),
							reasons: opts.reasons ?? [],
							// GATE 1 #3/#5/#7/#8 — point-in-time extras (see JournalCandidate).
							cycle: {
								startedAtMs: opts.asOf.getTime(),
								latencyMs: opts.cycleMs ?? null,
								featureCutoffMs: opts.featureCutoffMs ?? null,
							},
							features: opts.features ?? [],
							dataWarnings: opts.dataWarnings ?? [],
						}),
					}),
				);
			} catch (e) {
				this.logger.warn(`decision journal write failed: ${(e as Error).message}`);
			}
		})();
	}

	/** Session phase label for the journal: pre-open / open / post-close / closed. */
	private currentSessionPhase(asOf: Date): string {
		// IST-naive (same convention as market snapshots)
		const ist = new Date(asOf.getTime() + (5 * 60 + 30) * 60 * 1000);
		const day = ist.getUTCDay();
		if (day === 0 || day === 6) return 'holiday';
		const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
		if (mins < 9 * 60 + 15) return 'pre-open';
		if (mins <= 15 * 60 + 30) return 'open';
		if (mins <= 18 * 60) return 'post-close';
		return 'closed';
	}

	/** Ledger of trades. realOnly=true (default) returns only on_real_data=1
	 *  (FYERS real pipeline) rows; realOnly=false returns only SANDBOX rows
	 *  (on_real_data=0) — the two environments are never mixed in one result. */
	async listTrades(portfolioId?: string, limit = 100, realOnly = true): Promise<FnfTrade[]> {
		const where = portfolioId
			? { portfolio: { id: portfolioId }, onRealData: realOnly }
			: { onRealData: realOnly };
		return this.trades.find({ where, order: { orderedAt: 'DESC' }, take: limit });
	}

	/** Current tradeable price for one instrument:
	 *  - index/underlying (-INDEX) → latest market snapshot price
	 *  - option contract → latest registered premium quote (ltp)
	 *  Returns null when nothing usable is on record. Used by the session driver
	 *  to manage exits position-by-position (price source = the position itself). */
	async latestReferencePrice(instrument: string): Promise<number | null> {
		if (!instrument) return null;
		if (/-INDEX$/i.test(instrument)) {
			const rows = await this.snapshots.find({ where: { instrument }, order: { ts: 'DESC' }, take: 1 });
			const p = rows[0] ? Number(rows[0].price) : NaN;
			return Number.isFinite(p) && p > 0 ? p : null;
		}
		const quote = await this.optionChain.findChain({ symbol: instrument, latestOnly: true, limit: 1 });
		const ltp = quote.rows[0] ? Number(quote.rows[0].ltp) : NaN;
		return Number.isFinite(ltp) && ltp > 0 ? ltp : null;
	}

	/** Self-learning summary: per-algoSource win rate + totals over closed trades.
	 *  REAL performance only (on_real_data=1) — sandbox rows are never mixed in. */
	async learningSummary(): Promise<{ total: number; winners: number; winRate: number; netPnl: number; byAlgo: Record<string, { count: number; wins: number; winRate: number; netPnl: number }> }> {
		const closed = await this.trades.find({ where: { status: 'CLOSED', onRealData: true } });
		const byAlgo: Record<string, { count: number; wins: number; winRate: number; netPnl: number }> = {};
		let winners = 0;
		let netPnl = 0;
		for (const t of closed) {
			const algo = t.algoSource ?? 'manual';
			const w = Number(t.netPnl) > 0;
			if (w) winners++;
			netPnl += Number(t.netPnl);
			const bucket = byAlgo[algo] ?? { count: 0, wins: 0, winRate: 0, netPnl: 0 };
			bucket.count++;
			if (w) bucket.wins++;
			bucket.netPnl += Number(t.netPnl);
			byAlgo[algo] = bucket;
		}
		for (const b of Object.values(byAlgo)) b.winRate = b.count ? Math.round((b.wins / b.count) * 100) : 0;
		return {
			total: closed.length,
			winners,
			winRate: closed.length ? Math.round((winners / closed.length) * 100) : 0,
			netPnl,
			byAlgo,
		};
	}

	// ── Market snapshots ─────────────────────────────────────────────────

	async ingestSnapshots(dtos: IngestSnapshotDto[]): Promise<number> {
		if (!dtos.length) return 0;

		// Historical imports may be retried. De-duplicate both within the request
		// and against the persisted instrument/timestamp range before saving.
		const normalized = dtos.map((d) => ({
			...d,
			ts: d.ts ? new Date(d.ts) : new Date(),
		}));
		type NormalizedSnapshot = Omit<IngestSnapshotDto, 'ts'> & { ts: Date };
		const unique = new Map<string, NormalizedSnapshot>();
		for (const d of normalized) {
			if (Number.isNaN(d.ts.getTime())) continue;
			unique.set(`${d.instrument}|${d.ts.toISOString()}`, d);
		}
		if (!unique.size) return 0;

		const candidates = [...unique.values()];
		const instruments = [...new Set(candidates.map((d) => d.instrument))];
		const minTs = new Date(Math.min(...candidates.map((d) => d.ts.getTime())));
		const maxTs = new Date(Math.max(...candidates.map((d) => d.ts.getTime())));
		const existing = await this.snapshots
			.createQueryBuilder('s')
			.where('s.instrument IN (:...instruments)', { instruments })
			.andWhere('s.ts BETWEEN :minTs AND :maxTs', { minTs, maxTs })
			.getMany();
		const existingKeys = new Set(existing.map((s) => `${s.instrument}|${new Date(s.ts).toISOString()}`));
		const rows = candidates
			.filter((d) => !existingKeys.has(`${d.instrument}|${d.ts.toISOString()}`))
			.map((d) => this.snapshots.create({
				instrument: d.instrument,
				price: d.price,
				volume: d.volume ?? 0,
				open: d.open ?? undefined,
				high: d.high ?? undefined,
				low: d.low ?? undefined,
				close: d.close ?? undefined,
				ts: d.ts,
				source: d.source ?? null,
			}));
		if (!rows.length) return 0;
		const saved = await this.snapshots.save(rows);
		return saved.length;
	}

	/** Latest price per instrument + value-change % vs previous snapshot. */
	async marketTable(): Promise<{ instrument: string; price: number; prevPrice: number | null; changePct: number | null; volume: number; ts: Date }[]> {
		const instruments = await this.snapshots
			.createQueryBuilder('s')
			.select('DISTINCT s.instrument', 'instrument')
			.getRawMany<{ instrument: string }>();
		const out: { instrument: string; price: number; prevPrice: number | null; changePct: number | null; volume: number; ts: Date }[] = [];
		for (const { instrument } of instruments) {
			const rows = await this.snapshots.find({
				where: { instrument },
				order: { ts: 'DESC' },
				take: 2,
			});
			if (!rows.length) continue;
			const latest = rows[0];
			const prev = rows[1] ?? null;
			const price = Number(latest.price);
			const prevPrice = prev ? Number(prev.price) : null;
			out.push({
				instrument,
				price,
				prevPrice,
				changePct: prevPrice && prevPrice !== 0 ? ((price - prevPrice) / prevPrice) * 100 : null,
				volume: Number(latest.volume),
				ts: latest.ts,
			});
		}
		return out;
	}

	// ── Cost calculator ──────────────────────────────────────────────────

	/**
 * FYERS cost model for ONE executed order leg, segmented by instrument class.
 * For options, turnover = premium × units; for futures, turnover = price × qty.
 * Brokerage rule (FYERS): futures = lower of 0.03%×turnover or ₹20; options = flat ₹20.
 */
	calculateCost(notional: number, side: 'BUY' | 'SELL', segment: CostSegment = segmentOfInstrument('')): CostBreakdown {
		const r = COST_RATES[segment] ?? COST_RATES.future;
		const gstPct = COST_RATES.gstPct;
		const sebiPct = COST_RATES.sebiPct;
		// TRUE lower-of rule: percentage×turnover vs flat fee — the flat fee wins only
		// when it is the smaller charge (the old max() implementation billed the larger).
		const brokerage = r.brokeragePct > 0
			? Math.min(Math.max(r.brokeragePct * notional, 0), r.brokerageFlat)
			: Math.min(r.brokerageFlat, Math.max(notional, 0));
		const stt = side === 'SELL' ? r.sttSellPct * notional : 0;
		const exchangeTxn = r.exchangeTxnPct * notional;
		const sebi = sebiPct * notional;
		// GST applies to brokerage + exchange txn + SEBI (taxable services); not STT/stamp.
		const gst = gstPct * (brokerage + exchangeTxn + sebi);
		const stamp = side === 'BUY' ? r.stampBuyPct * notional : 0;
		const total = brokerage + stt + exchangeTxn + gst + sebi + stamp;
		return { notional, brokerage, stt, exchangeTxn, gst, sebi, stamp, total };
	}

	// ── Decay engine (day-wise, self-rectifying) ─────────────────────────

	/** Seed global calibration rows for all 7 weekdays if absent. */
	async ensureCalibrations(portfolioId?: string): Promise<void> {
		const existing = await this.calibrations.find({ where: { portfolioId: portfolioId ?? IsNull() } });
		const have = new Set(existing.map((c) => c.weekday));
		const rows: DeepPartial<FnfDecayCalibration>[] = [];
		for (let wd = 0; wd <= 6; wd++) {
			if (have.has(wd)) continue;
			rows.push(this.calibrations.create({
				portfolioId: portfolioId ?? null,
				weekday: wd,
				decayRate: DECAY_DEFAULTS.rate,
				windowStartHour: DECAY_DEFAULTS.windowStart,
				windowEndHour: DECAY_DEFAULTS.windowEnd,
				samples: 0,
				lastRectifiedAt: undefined,
			}));
		}
		if (rows.length) await this.calibrations.save(rows);
	}

	/** Active calibration for a weekday: portfolio override → global default. */
	async getCalibration(weekday: number, portfolioId?: string): Promise<FnfDecayCalibration> {
		if (portfolioId) {
			const p = await this.calibrations.findOne({ where: { portfolioId, weekday } });
			if (p) return p;
		}
		const g = await this.calibrations.findOne({ where: { portfolioId: IsNull(), weekday } });
		if (g) return g;
		await this.ensureCalibrations(portfolioId);
		return (await this.calibrations.findOne({ where: { portfolioId: portfolioId ?? IsNull(), weekday } }))!;
	}

	async listCalibrations(portfolioId?: string): Promise<FnfDecayCalibration[]> {
		await this.ensureCalibrations(portfolioId);
		return this.calibrations.find({ where: { portfolioId: portfolioId ?? IsNull() }, order: { weekday: 'ASC' } });
	}

	/** Manual override of one weekday's decay value + timing window. */
	async setCalibration(dto: SetDecayCalibrationDto, portfolioId?: string): Promise<FnfDecayCalibration> {
		const weekday = dto.weekday ?? new Date().getDay();
		const row = await this.getCalibration(weekday, portfolioId);
		Object.assign(row, {
			decayRate: dto.decayRate ?? row.decayRate,
			windowStartHour: dto.windowStartHour ?? row.windowStartHour,
			windowEndHour: dto.windowEndHour ?? row.windowEndHour,
		});
		return this.calibrations.save(row);
	}

	/** Apply exponential decay + timing penalty to a raw confidence.
	 *  Always used: predictions never bypass decay. */
	decayConfidence(
		confidence: number,
		cal: FnfDecayCalibration,
		snapshotTs: Date,
		now: Date = new Date(),
	): { decayed: number; rate: number; ageHours: number; timingFactor: number } {
		const rate = Number(cal.decayRate);
		const ageHours = Math.max(0, (now.getTime() - snapshotTs.getTime()) / 3_600_000);
		const hourOfDay = now.getHours() + now.getMinutes() / 60;
		const inWindow = hourOfDay >= Number(cal.windowStartHour) && hourOfDay <= Number(cal.windowEndHour);
		const timingFactor = inWindow ? 1 : DECAY_DEFAULTS.timingPenalty;
		const decayed = confidence * Math.exp(-rate * ageHours) * timingFactor;
		return { decayed: Math.max(0, Math.min(100, decayed)), rate, ageHours, timingFactor };
	}

	/** Day-wise rectification of decay value + timing windows from closed
	 *  trade outcomes (REAL pipeline only — on_real_data=1; sandbox outcomes
	 *  must never steer the real decay model). Winners → decay too harsh? ease
	 *  it; losers → decay too slow? tighten it. Window edges drift toward
	 *  winning entry hours. */
	async rectifyDecay(portfolioId?: string): Promise<FnfDecayCalibration[]> {
		await this.ensureCalibrations(portfolioId);
		const closed = await this.trades.find({ where: { status: 'CLOSED', onRealData: true }, order: { closedAt: 'ASC' } });
		const updated: FnfDecayCalibration[] = [];

		for (let wd = 0; wd <= 6; wd++) {
			const cal = await this.getCalibration(wd, portfolioId);
			const wdTrades = closed.filter((t) => t.orderedAt && t.orderedAt.getDay() === wd);
			if (!wdTrades.length) continue;

			// Only consume trades not yet absorbed into this calibration.
			const fresh = wdTrades.slice(Number(cal.samples));
			if (!fresh.length) continue;

			let wins = 0;
			let losses = 0;
			const winEntryHours: number[] = [];
			for (const t of fresh) {
				const won = Number(t.netPnl) > 0;
				if (won) { wins++; winEntryHours.push(t.orderedAt.getHours() + t.orderedAt.getMinutes() / 60); }
				else losses++;
			}
			if (!wins && !losses) continue;

			// Rectify decay rate: winners ease it, losers tighten it.
			const lr = DECAY_DEFAULTS.learningRate;
			let rate = Number(cal.decayRate);
			for (let i = 0; i < fresh.length; i++) {
				if (Number(fresh[i].netPnl) > 0) rate *= 1 - lr;
				else rate *= 1 + lr;
			}
			rate = Math.max(DECAY_DEFAULTS.minRate, Math.min(DECAY_DEFAULTS.maxRate, rate));

			// Rectify timing window toward winning entry hours.
			let start = Number(cal.windowStartHour);
			let end = Number(cal.windowEndHour);
			if (winEntryHours.length) {
				const meanWinHour = winEntryHours.reduce((a, b) => a + b, 0) / winEntryHours.length;
				if (meanWinHour < start) start = Math.max(DECAY_DEFAULTS.minWindowStart, start - DECAY_DEFAULTS.windowStep);
				else if (meanWinHour > end) end = Math.min(DECAY_DEFAULTS.maxWindowEnd, end + DECAY_DEFAULTS.windowStep);
			}
			if (start >= end) { start = DECAY_DEFAULTS.minWindowStart; end = DECAY_DEFAULTS.maxWindowEnd; }

			cal.decayRate = rate;
			cal.windowStartHour = start;
			cal.windowEndHour = end;
			cal.samples = Number(cal.samples) + fresh.length;
			cal.lastRectifiedAt = new Date();
			updated.push(await this.calibrations.save(cal));
			this.logger.log(`decay rectified ${WEEKDAY_NAMES[wd]}: rate ${rate.toFixed(4)} window ${start.toFixed(2)}–${end.toFixed(2)} (${wins}W/${losses}L)`);
		}
		return updated;
	}

	// ── Algo signals (decay-aware, option-contract only) ───────────────────

	/** Map an option contract's underlying token to the index/underlying snapshot
	 *  instrument used for direction + ATM determination. */

/**
 * Sanitize DecisionSnapshot for journal storage: remove circular refs, large blobs.
 * This prepares the snapshot for JSON.stringify() without causing errors.
 */
private sanitizeSnapshot(snap: DecisionSnapshot): Record<string, unknown> {
  const sanitized: Record<string, unknown> = { ...snap };
  // Remove any properties that could cause circular references or be unnecessarily large
  // Currently we keep everything as DecisionSnapshot fields are shallow
  return sanitized;
}
	private indexInstrumentFor(underlying: string): string | null {
		const t = underlying.toUpperCase().replace(/[^A-Z0-9]/g, '');
		if (t.startsWith('NIFTY50') || t === 'NIFTY') return 'NSE:NIFTY50-INDEX';
		if (t.startsWith('NIFTYBANK') || t === 'BANKNIFTY') return 'NSE:NIFTYBANK-INDEX';
		if (t.startsWith('SENSEX')) return 'BSE:SENSEX-INDEX';
		return null;
	}


	/**
	 * Candidate-ranking DECISION ENGINE (user architecture 2026-09-04).
	 *
	 * 1. Direction: the strategy computes per-underlying bias from index SMA-20 /
	 *    momentum (bullish → CE candidates, bearish → PE candidates). Range-bound
	 *    underlyings contribute no candidates.
	 * 2. Candidate build: every REGISTERED contract (any underlying × expiry ×
	 *    strike) matching the direction's option type with a live premium quote is
	 *    a candidate carrying premium, lot size, contract value, liquidity
	 *    (volume/OI), bid/ask spread, Greeks and ATM-ness (distance from spot).
	 * 3. Capital filter: contract value = premium × lotSize × lots must fit the
	 *    available headroom (capital + netPnl − deployed); anything over is
	 *    REJECTED as unaffordable. ₹5,000 is a capital constraint, NOT an
	 *    instrument-selection rule.
	 * 4. Mandatory quality gates: minimum liquidity, maximum bid/ask spread,
	 *    non-stale quote, expiry ahead, decayed confidence ≥ floor.
	 * 5. Score the affordable survivors across the whole universe and emit the
	 *    single best contract. Same-underlying OTM is a scored candidate, not a
	 *    hard fallback; SENSEX/BANKNIFTY/FINNIFTY compete on equal footing.
	 * 6. No candidate clearing all gates → NO TRADE (empty result) — never the
	 *    forced next-cheapest.
	 *
	 * Weights are env-tunable: FNO_CAND_W_STRATEGY (default 40), FNO_CAND_W_LIQ
	 * (25), FNO_CAND_W_SPREAD (20), FNO_CAND_W_EXPIRY (15), FNO_CAND_W_GREEKS
	 * (10), FNO_CAND_W_SAMEUND (5, continuity nudge only), FNO_CAND_W_COST (5,
	 * prefers lower capital at risk).
	 */
		async generateSignals(portfolioId?: string, asOf: Date = new Date()): Promise<AlgoSignal[]> {
		// GATE 1 #8: cycle latency + data-gap audit trail.
		const cycleStartedMs = Date.now();
		const dataWarnings: string[] = [];
		const featureMeta = new Map<string, JournalFeature>();
		let dataCutoffMs = 0; // newest data ts consumed (snapshot/quote), 0 = none yet
		const portfolio = portfolioId ? await this.getPortfolio(portfolioId) : (await this.listPortfolios())[0] ?? null;
		const isFriday = asOf.getDay() === 5;
		const fridayBlocked = isFriday && !(portfolio?.fridayTradingEnabled);

		const todayWd = asOf.getDay();
		const cal = await this.getCalibration(todayWd, portfolio?.id);

		// Registered universe = all contracts on record (not just index snapshots).
		const contracts = await this.optionChain.listAllContracts();
		if (!contracts.length) return []; // nothing registered → no option candidates
		const contractBySymbol = new Map(contracts.map((c) => [c.symbol, c]));

		// Live quotes: latest premium per contract symbol (all registered contracts).
		const latest = await this.optionChain.findChain({ latestOnly: true, limit: 2000 });
		const quoteBySymbol = new Map<string, (typeof latest.rows)[number]>();
		for (const q of latest.rows) {
			const ltp = Number(q.ltp);
			if (Number.isFinite(ltp) && ltp > 0) quoteBySymbol.set(q.contractSymbol, q);
		}

		const window = await this.muhurta.nextWindow(asOf, 24);
		const shubh = (window?.score ?? 0) >= SHUBH_SCORE_MIN;
		const astroMatch = {
			shubh,
			score: window?.score ?? 0,
			label: window ? this.muhurta.describeNext(asOf) : 'no muhurta window found in next 24h',
		};

		// ── Scoring weights (env-tunable) ──────────────────────────────────────
		const W = {
			strategy: Number(process.env.FNO_CAND_W_STRATEGY ?? 40),
			liquidity: Number(process.env.FNO_CAND_W_LIQ ?? 25),
			spread: Number(process.env.FNO_CAND_W_SPREAD ?? 20),
			expiry: Number(process.env.FNO_CAND_W_EXPIRY ?? 15),
			greeks: Number(process.env.FNO_CAND_W_GREEKS ?? 10),
			sameUnderlying: Number(process.env.FNO_CAND_W_SAMEUND ?? 5),
			cost: Number(process.env.FNO_CAND_W_COST ?? 5),
		};
		const maxSpreadPct = Number(process.env.FNO_CAND_MAX_SPREAD_PCT ?? 0.15); // 15%
		const minVolume = Number(process.env.FNO_CAND_MIN_VOLUME ?? 0); // 0 = liquidity gate off unless quoted volume
		const staleMinutes = Number(process.env.FNO_CAND_STALE_MIN ?? 5);
		const lots = Math.max(1, Number(process.env.FNO_PAPER_QTY ?? 1)); // match driver position size
		const headroom = portfolio
			? (Number(portfolio.capital) + Number(portfolio.netPnl)) - Number(portfolio.deployed)
			: Number.POSITIVE_INFINITY;
		const maxDte = Number(process.env.FNO_CAND_MAX_DTE ?? 45);

		// ── Phase 1: per-underlying direction from index snapshots ─────────────
		// underlying token (upper) → { spot, direction: 'CE' | 'PE' | null }
		const byUnderlying = new Map<string, typeof contracts>();
		for (const c of contracts) {
			const key = String(c.underlying || '').toUpperCase();
			if (!byUnderlying.has(key)) byUnderlying.set(key, []);
			byUnderlying.get(key)!.push(c);
		}
		const direction = new Map<string, { spot: number; dir: 'CE' | 'PE' | null; reason: string; conf: number }>();
		for (const [underlying] of byUnderlying) {
			const indexInstrument = this.indexInstrumentFor(underlying);
			if (!indexInstrument) continue;
			const rows = await this.snapshots.find({
				where: { instrument: indexInstrument, ts: LessThanOrEqual(asOf) },
				order: { ts: 'DESC' },
				take: 30,
			});
			if (rows.length < 5) {
				dataWarnings.push(`${underlying}: <5 index snapshots ≤ asOf — direction skipped`);
				continue;
			}
			const prices = rows.map((r) => Number(r.price)).reverse();
			const spot = prices[prices.length - 1];
			const sma = prices.reduce((a, b) => a + b, 0) / prices.length;
			const smaShort = prices.slice(-5).reduce((a, b) => a + b, 0) / 5;
			const momentum = (spot / prices[prices.length - 6]) - 1;
			// GATE 1 #5/#7: record the features this engine consumed + the ts of the
			// newest bar they came from (the actual availability point).
			const lastBarMs = new Date(rows[0].ts).getTime();
			featureMeta.set(underlying, {
				underlying,
				spot,
				sma20: sma,
				sma5: smaShort,
				momentumFrac: Number.isFinite(momentum) ? momentum : null,
				bars: rows.length,
				lastBarMs,
			});
			if (lastBarMs > dataCutoffMs) dataCutoffMs = lastBarMs;
			const bullish = spot > sma && smaShort > sma;
			const bearish = spot < sma && smaShort < sma;
			const rawConfidence = Math.min(85, 40 + Math.round(Math.abs(spot - sma) / sma * 1000) + (shubh ? 15 : 0));
			direction.set(underlying, {
				spot,
				dir: bullish ? 'CE' : bearish ? 'PE' : null,
				reason: bullish
					? 'underlying above SMA-20 with rising 5-bar mean (bullish)'
					: bearish
						? 'underlying below SMA-20 with falling 5-bar mean (bearish)'
						: 'underlying oscillating around SMA-20 (range-bound)',
				conf: rawConfidence,
			});
		}

		// Same-underlying continuity: underlying of the most recent trade (any state)
		// on this portfolio — a small scoring nudge only, never a rule.
		let lastTradeUnderlying = '';
		if (portfolioId) {
			const lastTrades = await this.trades.find({ where: { portfolio: { id: portfolioId } }, order: { orderedAt: 'DESC' }, take: 1 });
			const last = lastTrades[0];
			if (last) {
				const lastContract = contractBySymbol.get(last.instrument);
				if (lastContract) lastTradeUnderlying = String(lastContract.underlying || '').toUpperCase();
				else {
					// legacy index trade — derive from symbol so continuity still applies
					const t = last.instrument.replace(/^[A-Z]+:/, '').replace(/-INDEX$/, '').toUpperCase();
					lastTradeUnderlying = t.startsWith('NIFTY50') ? 'NIFTY50-INDEX' : t;
				}
			}
		}

		// ── Phases 2–4: build candidates across the whole registered universe ──
		interface Candidate {
			contract: typeof contracts[number];
			quote: (typeof latest.rows)[number];
			premium: number;
			contractValue: number;
			spreadPct: number | null;
			atmScore: number; // 1 = ATM, → 0 as strike drifts from spot
			expiryScore: number;
			greeksScore: number;
			score: number;
			reasons: string[];
		}
		const candidates: Candidate[] = [];
		const rejected: string[] = [];
		const now = asOf.getTime();
		const nowIst = new Date(now + (5 * 60 + 30) * 60 * 1000);

		for (const [underlying, group] of byUnderlying) {
			const dirInfo = direction.get(underlying);
			if (!dirInfo || !dirInfo.dir) continue; // no snapshot data or range-bound → no candidates
			const { spot, dir, reason, conf } = dirInfo;
			for (const contract of group) {
				const sym = contract.symbol;
				if (String(contract.optionType).toUpperCase() !== dir) continue; // CE when bullish, PE when bearish
				const quote = quoteBySymbol.get(sym);
				if (!quote) { rejected.push(`${sym}: no live premium quote`); continue; }
				const premium = Number(quote.ltp);
				if (!Number.isFinite(premium) || premium <= 0) { rejected.push(`${sym}: invalid premium`); continue; }
				const quoteAgeMin = Math.max(0, (now - new Date(quote.ts).getTime()) / 60_000);
				// GATE 1 #7: the quote's own ts is data the decision consumed.
				const quoteTsMs = new Date(quote.ts).getTime();
				if (quoteTsMs > dataCutoffMs) dataCutoffMs = quoteTsMs;
				if (quoteAgeMin > staleMinutes) { rejected.push(`${sym}: stale quote (${quoteAgeMin.toFixed(1)}m)`); continue; }
				const lotSize = Number(contract.lotSize) || 1;
				const contractValue = premium * lotSize * lots;

				// ── Phase 3 gates ──────────────────────────────────────────────
				// Capital filter: ₹5,000 is a per-position cap, not an instrument rule.
				if (contractValue > headroom) {
					rejected.push(`${sym}: unaffordable — contract value ₹${contractValue.toFixed(0)} > headroom ₹${headroom.toFixed(0)}`);
					continue;
				}
				// Expiry sanity: must be a future expiry within max DTE.
				const expiry = new Date(String(contract.expiry).slice(0, 10) + 'T00:00:00.000Z');
				const dte = Math.max(0, Math.round((expiry.getTime() - nowIst.getTime()) / 86_400_000));
				if (dte < 1) { rejected.push(`${sym}: expiry ${String(contract.expiry).slice(0, 10)} is today or past`); continue; }
				if (dte > maxDte) { rejected.push(`${sym}: expiry ${dte} DTE beyond max ${maxDte}`); continue; }
				// Liquidity: volume floor (0 = disabled unless a positive requirement set).
				const volume = Number(quote.volume ?? 0);
				if (minVolume > 0 && volume < minVolume) { rejected.push(`${sym}: volume ${volume} < ${minVolume}`); continue; }
				// Spread sanity: skip illiquid wide-spread contracts.
				const bid = Number(quote.bid);
				const ask = Number(quote.ask);
				const hasTwoWay = Number.isFinite(bid) && bid > 0 && Number.isFinite(ask) && ask >= bid;
				const spreadPct = hasTwoWay ? (ask - bid) / ((ask + bid) / 2) : null;
				if (spreadPct !== null && spreadPct > maxSpreadPct) {
					rejected.push(`${sym}: spread ${(spreadPct * 100).toFixed(1)}% > ${(maxSpreadPct * 100).toFixed(0)}% cap`);
					continue;
				}
				// Decay gate: stale-data confidence must clear the floor.
				const { decayed } = this.decayConfidence(conf, cal, new Date(quote.ts), asOf);
				if (decayed < DECAY_DEFAULTS.confidenceFloor) {
					rejected.push(`${sym}: decayed confidence ${decayed.toFixed(0)} below floor`);
					continue;
				}

				// ── T-09 local Greeks / IV + delta-band gate ─────────────────────
				// Compute delta/IV locally from (spot, strike, DTE, premium) via BSM
				// so candidates are scored on Greeks even when FYERS omits them, and
				// cross-check provider-supplied delta for desynchronization.
				const strike = Number(contract.strike);
				const spotNum = Number(spot);
				const rate = Number(process.env.FNO_RISK_FREE_RATE ?? 0.065);
				const years = dte / 365;
				const optType = (String(contract.optionType).toUpperCase() as 'CE' | 'PE');
				const local = Number.isFinite(spotNum) && spotNum > 0 && years > 0
					? localGreeks(premium, { spot: spotNum, strike, years, rate, q: 0 }, optType)
					: null;
				const localDelta = local ? local.delta : null;
				const provDeltaRaw = Number(quote.delta);
				const provDelta = Number.isFinite(provDeltaRaw) && Math.abs(provDeltaRaw) > 0 && Math.abs(provDeltaRaw) < 1 ? provDeltaRaw : null;
				const deltaForGate = localDelta ?? provDelta;
				// Guidebook actionable band: 0.10–0.40 |delta| (env-tunable). Rejects
				// deep-OTM lottery strikes AND near-ATM contracts too rich for ₹5k.
				const deltaMin = Number(process.env.FNO_CAND_DELTA_MIN ?? 0.1);
				const deltaMax = Number(process.env.FNO_CAND_DELTA_MAX ?? 0.4);
				if (deltaForGate !== null && (Math.abs(deltaForGate) < deltaMin || Math.abs(deltaForGate) > deltaMax)) {
					rejected.push(`${sym}: |delta| ${Math.abs(deltaForGate).toFixed(3)} outside ${deltaMin}–${deltaMax} band`);
					continue;
				}
				// Provider cross-check: flag material divergence between local and
				// provider delta (desync warning, not a hard reject).
				let greeksNote = '';
				if (localDelta !== null && provDelta !== null && Math.abs(localDelta - provDelta) > 0.05) {
					greeksNote = ` ⚠ provider delta ${provDelta.toFixed(2)} vs local ${localDelta.toFixed(2)} desync`;
				}

				// ── Phase 4 component scores (each 0..1, weighted below) ─────────
				// (strike was declared in the T-09 block above)
				// ATM-ness band widened to 6%: with a ₹5k cap only OTM contracts
				// (≈1.5–5% from spot) are affordable, so the strategy term must still
				// differentiate the nearest affordable strikes from the deep ones.
				const atmBandPct = Number(process.env.FNO_CAND_ATM_BAND_PCT ?? 0.06);
				const atmScore = Math.max(0, 1 - Math.abs(strike - spot) / spot / atmBandPct); // ATM=1; band away → 0
				const expiryScore = dte >= 3 && dte <= 14 ? 1 : dte < 3 ? dte / 3 : Math.max(0, 1 - (dte - 14) / 30);
				const oi = Number(quote.openInterest ?? 0);
				// T-09: prefer local delta when available (provider delta may be absent
				// or stale); greeksScore rewards ATM-ish delta (≈0.5 absolute for long options).
				const delta = (localDelta ?? provDelta) as number | null;
				const hasDelta = delta !== null && Number.isFinite(delta) && Math.abs(delta) > 0 && Math.abs(delta) < 1;
				const greeksScore = hasDelta ? 1 - Math.abs(Math.abs(delta) - 0.5) / 0.5 : 0.5; // ATM delta ≈ ±0.5
				const reasons = [
					`${dir} ${underlying} — ${reason}`,
					`strike ${strike} (spot ${spot.toFixed(2)}; ${(Math.abs(strike - spot) / spot * 100).toFixed(2)}% from ATM)`,
					`premium ₹${premium.toFixed(2)} × ${lotSize} units × ${lots} lot(s) = ₹${contractValue.toFixed(0)}`,
				];
				if (spreadPct !== null) reasons.push(`spread ${(spreadPct * 100).toFixed(2)}%`);
				if (hasDelta) reasons.push(`delta ${delta.toFixed(2)}${greeksNote}`);
				if (local) reasons.push(`local IV ${(local.iv * 100).toFixed(1)}% · theta ${local.theta.toFixed(2)}/d · vega ${local.vega.toFixed(2)}`);
				const sameUndNudge = lastTradeUnderlying === underlying ? 1 : 0;
				const costScore = headroom === Number.POSITIVE_INFINITY ? 0.5 : 1 - contractValue / headroom;

				const score =
					W.strategy * atmScore +
					W.liquidity * Math.min(1, volume / 100) + // percentile-ish within 100+ contracts
					W.spread * (spreadPct === null ? 0.5 : Math.max(0, 1 - spreadPct / maxSpreadPct)) +
					W.expiry * expiryScore +
					W.greeks * greeksScore +
					W.sameUnderlying * sameUndNudge +
					W.cost * costScore;

				candidates.push({
					contract,
					quote,
					premium,
					contractValue,
					spreadPct,
					atmScore,
					expiryScore,
					greeksScore,
					score,
					reasons,
				});
			}
		}

		// ── Phase 5: pick the single best eligible contract (NO TRADE if none) ─
		// Decision-journal context (GATE 1): every candidate + rejection is
		// persisted regardless of outcome, so NO TRADE is auditable too.
		// GATE 1 #3: journal candidates carry their full point-in-time quote
		// snapshot (bid/ask/mid/ltp, spread, volume, OI, IV, provider, quote ts).
		const journalCandidates: JournalCandidate[] = candidates.map((c) => {
			const bid = Number(c.quote.bid);
			const ask = Number(c.quote.ask);
			const hasTwoWay = Number.isFinite(bid) && bid > 0 && Number.isFinite(ask) && ask >= bid;
			const oi = Number(c.quote.openInterest);
			const iv = Number(c.quote.impliedVolatility);
			return {
				symbol: c.contract.symbol,
				premium: c.premium,
				contractValue: c.contractValue,
				spreadPct: c.spreadPct,
				delta: null, // filled by winner path below when available
				score: c.score,
				quoteTsMs: new Date(c.quote.ts).getTime(),
				quoteAgeMin: Math.max(0, (now - new Date(c.quote.ts).getTime()) / 60_000),
				bid: Number.isFinite(bid) && bid > 0 ? bid : null,
				ask: Number.isFinite(ask) && ask > 0 ? ask : null,
				mid: hasTwoWay ? (bid + ask) / 2 : null,
				ltp: c.premium,
				volume: Number.isFinite(Number(c.quote.volume)) ? Number(c.quote.volume) : 0,
				oi: Number.isFinite(oi) && oi > 0 ? oi : 0,
				oiChange: null, // filled best-effort below
				iv: Number.isFinite(iv) && iv > 0 ? iv : null,
				provider: c.quote.provider ?? '',
				quality: hasTwoWay ? 'two-way' : 'one-way/ltp-only',
			};
		});
		// GATE 1 #3: OI change per survivor (current − previous quote for the same
		// symbol). Best-effort — a lookup failure leaves oiChange null and never
		// blocks the signal path.
		if (journalCandidates.length) {
			try {
				await Promise.all(
					journalCandidates.map(async (jc) => {
						try {
							const hist = await this.optionChain.findChain({ symbol: jc.symbol, latestOnly: false, limit: 2 });
							const cur = hist.rows[0];
							const prev = hist.rows[1];
							if (cur && prev) {
								const cOi = Number(cur.openInterest);
								const pOi = Number(prev.openInterest);
								if (Number.isFinite(cOi) && Number.isFinite(pOi)) jc.oiChange = cOi - pOi;
							}
						} catch {
							/* leave oiChange null */
						}
					}),
				);
			} catch {
				/* leave all oiChange null */
			}
		}
		const directionSummary: Record<string, string> = {};
		for (const [u, d] of direction) {
			directionSummary[u] = d?.dir ? `${d.dir} (conf ${d.conf})` : 'range/none';
		}
		if (!candidates.length) {
			// NO TRADE snapshot for deterministic decision trail
			const noTradeSnapshot: DecisionSnapshot = {
				decisionId: 'NO_TRADE_' + asOf.getTime().toString(),
				asOf,
				portfolioId: portfolio?.id ?? null,
				portfolio: {
					label: portfolio?.label || '',
					capital: Number(portfolio?.capital ?? 0),
					ceiling: Number(portfolio?.ceiling ?? 0),
					deployed: Number(portfolio?.deployed ?? 0),
					netPnl: Number(portfolio?.netPnl ?? 0),
					headroom: (Number(portfolio?.capital ?? 0) + Number(portfolio?.netPnl ?? 0)) - Number(portfolio?.deployed ?? 0),
					autoTradeEnabled: !!portfolio?.autoTradeEnabled,
					fridayTradingEnabled: !!portfolio?.fridayTradingEnabled,
				},
				underlying: '',
				direction: { dir: 'CE', reason: 'no candidates', conf: 0, spot: 0, sma20: 0, sma5: 0 },
				optionContract: { symbol: '', underlying: '', strike: 0, expiry: '', optionType: 'CE' as 'CE', lotSize: 0 },
				dte: 0,
				actualQuote: { ltp: 0, bid: null, ask: null, mid: null, volume: 0, oi: 0, oiChange: null, iv: null, provider: 'none', quoteTs: asOf, quoteAgeMin: 0, quality: 'none', spreadPct: null },
				localGreeks: { delta: null, gamma: null, theta: null, vega: null, iv: null },
				providerGreeks: { delta: null, gamma: null, theta: null, vega: null },
				candidateScoring: { atmScore: 0, expiryScore: 0, greeksScore: 0, totalScore: 0, rank: 0, totalCandidates: 0 },
				confidence: { raw: 0, decayed: 0, rate: 0, ageHours: 0, timingFactor: 0 },
				sessionPhase: this.currentSessionPhase(asOf),
				cycle: { startedAtMs: cycleStartedMs, latencyMs: Date.now() - cycleStartedMs, featureCutoffMs: dataCutoffMs > 0 ? dataCutoffMs : null },
				features: [...featureMeta.values()],
				dataWarnings,
				rejected,
				winnerSymbol: '',
				algoSource: 'option-candidate-rank-v1',
				buildSha: process.env.BUILD_SHA || (process.env.npm_package_version ? `v${process.env.npm_package_version}` : ''),
				sessionId: asOf.getTime().toString(),
			};
			this.journalDecision({
				portfolioId,
				asOf,
				actionFamily: 'NO TRADE',
				algoSource: 'option-candidate-rank-v1',
				candidates: [],
				rejected,
				directionSummary,
				cycleMs: Date.now() - cycleStartedMs,
				featureCutoffMs: dataCutoffMs > 0 ? dataCutoffMs : null,
				features: [...featureMeta.values()],
				dataWarnings,
				snapshot: noTradeSnapshot,
			});
			return [];
		}
		candidates.sort((a, b) => b.score - a.score);
		const best = candidates[0];
		// Confidence source: the direction info of the winner's underlying (raw SMA confidence).
		const bestUnderlying = String(best.contract.underlying || '').toUpperCase();
		const bestRawConf = (direction.get(bestUnderlying)?.conf) ?? 55;
		const { decayed, rate, ageHours, timingFactor } = this.decayConfidence(
			bestRawConf,
			cal,
			new Date(best.quote.ts),
			asOf,
		);
		const premium = best.premium;
		// BUY snapshot for deterministic decision trail
		const bestExpiry = new Date(best.contract.expiry);
		const dte = Math.round((bestExpiry.getTime() - asOf.getTime()) / 86_400_000);
		const greeks = localGreeks(premium, {
			spot: direction.get(bestUnderlying)?.spot ?? 0,
			strike: Number(best.contract.strike),
			years: dte / 365,
			rate: 0.07,
			q: 0,
		}, best.contract.optionType.toUpperCase() as 'CE' | 'PE');
		const winnerSymbol = best.contract.symbol;
		const dirInfo = direction.get(bestUnderlying)!; // BUY case: winner underlying always has direction
		const winnerSnapshot: DecisionSnapshot = {
			decisionId: 'BUY_' + winnerSymbol + '_' + asOf.getTime().toString(),
			asOf,
			portfolioId: portfolio?.id ?? null,
			portfolio: {
				label: portfolio?.label || '',
				capital: Number(portfolio?.capital ?? 0),
				ceiling: Number(portfolio?.ceiling ?? 0),
				deployed: Number(portfolio?.deployed ?? 0),
				netPnl: Number(portfolio?.netPnl ?? 0),
				headroom: (Number(portfolio?.capital ?? 0) + Number(portfolio?.netPnl ?? 0)) - Number(portfolio?.deployed ?? 0),
				autoTradeEnabled: !!portfolio?.autoTradeEnabled,
				fridayTradingEnabled: !!portfolio?.fridayTradingEnabled,
			},
			underlying: bestUnderlying,
			direction: {
				dir: dirInfo.dir!,
				reason: dirInfo.reason,
				conf: dirInfo.conf,
				spot: dirInfo.spot,
				sma20: (dirInfo as any).sma20,
				sma5: (dirInfo as any).sma5,
			},
			optionContract: {
				symbol: winnerSymbol,
				underlying: bestUnderlying,
				strike: Number(best.contract.strike),
				expiry: best.contract.expiry,
				optionType: best.contract.optionType.toUpperCase() as 'CE' | 'PE',
				lotSize: best.contract.lotSize,
			},
			dte,
			actualQuote: {
				ltp: premium,
				bid: best.quote.bid ? Number(best.quote.bid) : null,
				ask: best.quote.ask ? Number(best.quote.ask) : null,
				mid: (best.quote.bid && best.quote.ask) ? (Number(best.quote.bid) + Number(best.quote.ask)) / 2 : premium,
				volume: best.quote.volume ? Number(best.quote.volume) : 0,
				oi: best.quote.openInterest ? Number(best.quote.openInterest) : 0,
				oiChange: null,
				iv: best.quote.impliedVolatility ? Number(best.quote.impliedVolatility) : null,
				provider: best.quote.provider || 'FNO',
				quoteTs: new Date(best.quote.ts),
				quoteAgeMin: 0,
				quality: 'live',
				spreadPct: null,
			},
			localGreeks: {
				delta: greeks?.delta ?? null,
				gamma: greeks?.gamma ?? null,
				theta: greeks?.theta ?? null,
				vega: greeks?.vega ?? null,
				iv: greeks?.iv ?? null,
			},
			providerGreeks: {
				delta: best.quote.delta ? Number(best.quote.delta) : null,
				gamma: best.quote.gamma ? Number(best.quote.gamma) : null,
				theta: best.quote.theta ? Number(best.quote.theta) : null,
				vega: best.quote.vega ? Number(best.quote.vega) : null,
			},
			candidateScoring: {
				atmScore: Number(best.atmScore),
				expiryScore: Number(best.expiryScore),
				greeksScore: Number(best.greeksScore),
				totalScore: Number(best.score),
				rank: 1,
				totalCandidates: candidates.length,
			},
			confidence: {
				raw: Math.round(bestRawConf),
				decayed: Math.round(decayed),
				rate,
				ageHours,
				timingFactor,
			},
			sessionPhase: this.currentSessionPhase(asOf),
			cycle: { startedAtMs: cycleStartedMs, latencyMs: Date.now() - cycleStartedMs, featureCutoffMs: dataCutoffMs > 0 ? dataCutoffMs : null },
			features: [...featureMeta.values()],
			dataWarnings,
			rejected,
			winnerSymbol,
			algoSource: 'option-candidate-rank-v1',
			buildSha: process.env.BUILD_SHA || (process.env.npm_package_version ? `v${process.env.npm_package_version}` : ''),
			sessionId: asOf.getTime().toString(),
		};

		const reasons = [...best.reasons];
		reasons.push(`ranked #1 of ${candidates.length} affordable candidate(s) with score ${best.score.toFixed(1)}`);
		if (candidates.length > 1) {
			reasons.push(`next best: ${candidates[1].contract.symbol} (${candidates[1].score.toFixed(1)})`);
		}
		reasons.push(`decay-adjusted confidence ${decayed.toFixed(0)} (premium age ${ageHours.toFixed(1)}h, rate ${rate.toFixed(3)}, ${timingFactor === 1 ? 'in window' : 'off window ×0.85'})`);
		if (astroMatch.shubh) reasons.push(`shubh muhurta ${astroMatch.label}`);

		// T-08: inject recent Reflexion lessons for this underlying (fire-and-forget
		// read; absence of reflections is fine) so the decision context carries
		// learned heuristics into decisionParams. Reflections store the contract's
		// underlying token (index symbol, e.g. NIFTY50-INDEX) — match on that.
		try {
			const lessons = await this.listReflections(bestUnderlying, 2);
			if (lessons.length) {
				for (const lsn of lessons) {
					if (lsn.heuristic) reasons.push(`📌 lesson: ${lsn.heuristic}`);
				}
			}
		} catch {
			/* reflections unavailable → signal proceeds without lessons */
		}

		const target = premium * 1.5; // option-buyer premium target
		const stopLoss = premium * 0.75; // ≈25% premium drop stop

		// GATE 1: journal the BUY decision with the winner + all runners-up.
		const deltaMatch = best.reasons.join(' ').match(/delta (-?[\d.]+)/);
		const winnerSummary = journalCandidates.map((c) =>
			c.symbol === best.contract.symbol ? { ...c, delta: deltaMatch ? Number(deltaMatch[1]) : null } : c,
		);
		this.journalDecision({
			portfolioId,
			asOf,
			actionFamily: 'BUY',
			winnerSymbol: best.contract.symbol,
			algoSource: 'option-candidate-rank-v1',
			candidates: winnerSummary,
			rejected,
			directionSummary,
			reasons,
			cycleMs: Date.now() - cycleStartedMs,
			featureCutoffMs: dataCutoffMs > 0 ? dataCutoffMs : null,
			features: [...featureMeta.values()],
			dataWarnings,
			snapshot: winnerSnapshot,
		});

		return [{
			instrument: best.contract.symbol,
			algoSource: 'option-candidate-rank-v1',
			action: 'BUY',
			price: premium,
			target,
			stopLoss,
			confidence: Math.round(direction.get(String(best.contract.underlying || '').toUpperCase())?.conf ?? 55),
			decayedConfidence: Math.round(decayed),
			decay: { rate, ageHours, timingFactor, weekday: todayWd, windowStartHour: Number(cal.windowStartHour), windowEndHour: Number(cal.windowEndHour), lastRectifiedAt: cal.lastRectifiedAt },
			scenarios: [
				{ name: 'bull', probability: 45, target: premium * 1.5 },
				{ name: 'base', probability: 30, target: premium * 1.1 },
				{ name: 'bear', probability: 25, target: premium * 0.6 },
			],
			astroMatch,
			fridayBlocked,
			reasons,
		}];
	}

	/** Convenience: does today's muhurta engine see a shubh window? */
	async astroMatch(): Promise<{ shubh: boolean; score: number; label: string }> {
		const window = await this.muhurta.nextWindow(new Date(), 24);
		return {
			shubh: (window?.score ?? 0) >= SHUBH_SCORE_MIN,
			score: window?.score ?? 0,
			label: window ? this.muhurta.describeNext(new Date()) : 'no muhurta window found in next 24h',
		};
	}

	async purgeOldSnapshots(before: Date): Promise<number> {
		const res = await this.snapshots.delete({ ts: LessThanOrEqual(before) });
		return res.affected ?? 0;
	}

	/**
	 * Session rollover archive: move every tick recorded BEFORE the given IST
	 * boundary out of the live "today" tables into the history tables, then
	 * delete them from live. Live tables therefore only ever hold the current
	 * session's ticks; each finished session's ticks accumulate in history.
	 * Boundary is an IST-naive 'YYYY-MM-DD HH:MM:SS' string compared against the
	 * IST-naive ts columns. Idempotent: run any number of times.
	 */
	async archiveTicksBefore(boundaryIst: string): Promise<{ snapshots: number; quotes: number }> {
		const snapshots = await this.snapshots.manager.query(
			`INSERT INTO fnf_market_snapshots_history
				 (id, instrument, price, volume, open, high, low, close, ts, source, createdAt, archivedAt)
			 SELECT id, instrument, price, volume, open, high, low, close, ts, source, createdAt, NOW()
			 FROM fnf_market_snapshots WHERE ts < ?`,
			[boundaryIst],
		);
		const delSnap = await this.snapshots.manager.query(
			'DELETE FROM fnf_market_snapshots WHERE ts < ?',
			[boundaryIst],
		);
		const quotes = await this.quoteHistory.manager.query(
			`INSERT INTO fnf_option_quotes_history
				 (id, contractSymbol, underlying, expiry, strike, optionType, ltp, bid, ask, volume,
				  openInterest, impliedVolatility, delta, gamma, theta, vega, provider, ts, createdAt, archivedAt)
			 SELECT id, contractSymbol, underlying, expiry, strike, optionType, ltp, bid, ask, volume,
				  openInterest, impliedVolatility, delta, gamma, theta, vega, provider, ts, createdAt, NOW()
			 FROM fnf_option_quotes WHERE ts < ?`,
			[boundaryIst],
		);
		const delQuotes = await this.quoteHistory.manager.query(
			'DELETE FROM fnf_option_quotes WHERE ts < ?',
			[boundaryIst],
		);
		const moved = {
			snapshots: Number(delSnap?.affectedRows ?? delSnap?.affected ?? 0),
			quotes: Number(delQuotes?.affectedRows ?? delQuotes?.affected ?? 0),
		};
		if (moved.snapshots || moved.quotes) {
			this.logger.log(`tick archive @ ${boundaryIst}: ${moved.snapshots} snapshot(s), ${moved.quotes} quote(s) moved to history`);
		}
		return moved;
	}
}
