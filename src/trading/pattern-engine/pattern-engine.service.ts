import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, MoreThanOrEqual, Not, Repository } from 'typeorm';
import { UnifiedOptionQuote } from '../unified-market-data/unified-option-quote.entity';
import { UnifiedMarketSnapshot } from '../unified-market-data/unified-market-snapshot.entity';
import { FeedArbitrationService, FeedArbitrationStatus } from '../unified-market-data/feed-arbitration.service';
import { optionUniversesFromSymbols, trackedUniversesFromSymbols } from '../unified-market-data/feed-arbitration.state';
import {
  Candle, ChainLeg, OUTCOME_HORIZONS_MIN, PatternAssessment, PatternThresholds, TickLike,
  assessPattern, bucketCandles, labelOutcomes, patternThresholdsFromEnv,
} from './pattern-features';
import { PatternSignal } from './pattern-signal.entity';
import { PatternSignalDispatchService } from './pattern-signal-dispatch.service';

type UniverseScan = {
  universe: string;
  contracts: number;
  assessed: number;
  recorded: number;
  signals: number;
  skipped: string | null;
};

const STRATEGY_VERSION = 'pattern-engine-v1';
const round = (value: number, places = 4): number => Math.round(value * 10 ** places) / 10 ** places;
/** IST wall-clock date — the market's own calendar, not the host's. */
const istDate = (at = Date.now()): string => new Date(at + 5.5 * 3_600_000).toISOString().slice(0, 10);
/**
 * The Indian cash session in IST minutes (09:15–15:30). The desk keeps polling
 * after the close, so the tape is not empty — it is FROZEN. Assessing it then
 * produced hundreds of "no movement" NO_TRADEs that described nothing about a
 * market, and they would have been fed into the outcome dataset as if they were
 * session setups. The engine only learns from session tape.
 */
const MARKET_OPEN_IST_MINUTES = 9 * 60 + 15;
const MARKET_CLOSE_IST_MINUTES = 15 * 60 + 30;
const istMinutesOfDay = (at = Date.now()): number => {
  const shifted = new Date(at + 5.5 * 3_600_000);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
};
const withinMarketSession = (at = Date.now()): boolean => {
  const minutes = istMinutesOfDay(at);
  return minutes >= MARKET_OPEN_IST_MINUTES && minutes <= MARKET_CLOSE_IST_MINUTES;
};

/**
 * The pattern/learning engine (brief sections 1-21).
 *
 * It READS the common normalized live store (brief s17: no feed of its own, no
 * Yahoo) and, per tracked universe:
 *   1. rebuilds option candles from stored ticks (5-min buckets by default),
 *   2. measures consolidation → exhaustion → breakout → entry state,
 *   3. scores underlying, chain, OI, IV, volume and liquidity SEPARATELY,
 *   4. stores a feature snapshot for good AND bad setups (brief s16), and
 *   5. sends any tradable signal to each paper desk independently, flag-gated.
 *
 * It then labels what actually happened afterwards (MFE/MAE at 5/10/15/30/60
 * min) so the dataset can answer which features preceded explosive moves.
 *
 * It NEVER writes strategy parameters, weights or calibration (brief s18).
 */
@Injectable()
export class PatternEngineService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PatternEngineService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private scanning = false;
  private lastScanAt: Date | null = null;
  private lastError: string | null = null;
  private scans = 0;
  private assessedToday = 0;
  private signalsToday = 0;
  private lastScans: UniverseScan[] = [];
  /** Throttles the "outside the session" notice to once per closed period. */
  private outsideSessionLogged = false;

  private readonly enabled = !/^(0|false|no|off)$/i.test(process.env.PATTERN_ENGINE_ENABLED ?? 'true');
  private readonly intervalMs = Math.max(10_000, Number(process.env.PATTERN_ENGINE_INTERVAL_MS ?? 60_000));
  private readonly bucketMs = Math.max(60_000, Number(process.env.PATTERN_BUCKET_MINUTES ?? 5) * 60_000);
  private readonly lookbackMinutes = Math.max(30, Number(process.env.PATTERN_LOOKBACK_MINUTES ?? 180));
  private readonly strikeWindow = Math.max(0, Math.trunc(Number(process.env.PATTERN_STRIKE_WINDOW ?? 3)));
  private readonly maxContracts = Math.max(2, Math.trunc(Number(process.env.PATTERN_MAX_CONTRACTS ?? 12)));
  private readonly maxTicks = Math.max(500, Math.trunc(Number(process.env.PATTERN_MAX_TICKS ?? 8000)));
  private readonly recordMinConfidence = Number(process.env.PATTERN_RECORD_MIN_CONFIDENCE ?? 0.2);
  private readonly thresholds: PatternThresholds = patternThresholdsFromEnv();

  constructor(
    @InjectRepository(UnifiedOptionQuote) private readonly quotes: Repository<UnifiedOptionQuote>,
    @InjectRepository(UnifiedMarketSnapshot) private readonly snapshots: Repository<UnifiedMarketSnapshot>,
    @InjectRepository(PatternSignal) private readonly signals: Repository<PatternSignal>,
    private readonly arbitration: FeedArbitrationService,
    private readonly dispatchService: PatternSignalDispatchService,
  ) {}

  onModuleInit(): void {
    if (!this.enabled) { this.logger.warn('[PATTERN] engine DISABLED (PATTERN_ENGINE_ENABLED=off)'); return; }
    this.logger.log(
      `[PATTERN] engine ${STRATEGY_VERSION} · universes=${this.universes().join(',') || 'none'} · bucket=${this.bucketMs / 60_000}m · every ${this.intervalMs}ms · ` +
      `dispatch fnf=${this.dispatchService.targets().fnf.enabled ? 'ON' : 'off'} upstox=${this.dispatchService.targets().upstox.enabled ? 'ON' : 'off'}`,
    );
    if (!this.universes().length) { this.logger.warn('[PATTERN] no universes configured — set PATTERN_ENGINE_UNIVERSES or UPSTOX_LIVE_INSTRUMENTS'); return; }
    void this.scanAll().catch((error) => this.recordError(error));
    const timer = setInterval(() => { void this.scanAll().catch((error) => this.recordError(error)); }, this.intervalMs);
    timer.unref?.();
    this.timer = timer;
  }

  onModuleDestroy(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  private recordError(error: unknown): void {
    this.lastError = (error as Error).message;
    this.logger.warn(`[PATTERN] scan failed: ${this.lastError}`);
  }

  /** Tracked universes: explicit list, else derived from the live desk's keys. */
  universes(): string[] {
    const explicit = String(process.env.PATTERN_ENGINE_UNIVERSES ?? '')
      .split(',').map((v) => v.trim().toUpperCase()).filter(Boolean);
    if (explicit.length) return [...new Set(explicit)];
    return [...new Set(trackedUniversesFromSymbols(String(process.env.UPSTOX_LIVE_INSTRUMENTS ?? '').split(',')))];
  }

  async scanAll(): Promise<UniverseScan[]> {
    if (this.scanning) return this.lastScans;
    if (!withinMarketSession()) {
      // Reporting only: the tape after the close is frozen, so a scan would score
      // a market that is not trading and pollute the outcome dataset.
      if (!this.outsideSessionLogged) {
        this.logger.log('[PATTERN] outside the market session (09:15–15:30 IST) — detection paused, the post-close tape is frozen');
        this.outsideSessionLogged = true;
      }
      this.lastScans = this.universes().map((universe) => ({
        universe, contracts: 0, assessed: 0, recorded: 0, signals: 0,
        skipped: 'outside the market session (09:15–15:30 IST)',
      }));
      this.lastScanAt = new Date();
      return this.lastScans;
    }
    this.outsideSessionLogged = false;
    this.scanning = true;
    const results: UniverseScan[] = [];
    try {
      for (const universe of this.universes()) {
        try {
          results.push(await this.scanUniverse(universe));
        } catch (error) {
          this.logger.warn(`[PATTERN] ${universe} scan failed: ${(error as Error).message}`);
          results.push({ universe, contracts: 0, assessed: 0, recorded: 0, signals: 0, skipped: (error as Error).message });
        }
      }
      this.lastScans = results;
      this.lastScanAt = new Date();
      this.scans++;
      // Forward labelling rides the same tick: it only reads history.
      await this.labelPending().catch((error) => this.logger.warn(`[PATTERN] labelling failed: ${(error as Error).message}`));
      const signals = results.reduce((a, r) => a + r.signals, 0);
      this.assessedToday += results.reduce((a, r) => a + r.assessed, 0);
      this.signalsToday += signals;
      if (signals) this.logger.log(`[PATTERN] ${signals} signal(s): ${results.filter((r) => r.signals).map((r) => `${r.universe}:${r.signals}`).join(' ')}`);
      this.lastError = null;
    } finally {
      this.scanning = false;
    }
    return results;
  }

  /** One universe: rebuild candles from the common store and assess candidates. */
  async scanUniverse(universe: string): Promise<UniverseScan> {
    const since = new Date(Date.now() - this.lookbackMinutes * 60_000);
    const rows = await this.quotes.find({
      where: { underlying: universe, ts: MoreThanOrEqual(since) },
      order: { ts: 'ASC' },
      take: this.maxTicks,
    });
    if (!rows.length) return { universe, contracts: 0, assessed: 0, recorded: 0, signals: 0, skipped: 'no live ticks in the common store for this universe' };

    const byContract = new Map<string, UnifiedOptionQuote[]>();
    for (const row of rows) {
      const key = String(row.instrumentKey ?? '');
      if (!key) continue;
      const list = byContract.get(key);
      if (list) list.push(row); else byContract.set(key, [row]);
    }
    const underlyingCandles = await this.loadUnderlyingCandles(universe, since);

    // ATM window by strike, then ranked by traded volume (brief s6: never only
    // the selected option — ATM ± window with the real strike interval).
    const latestPerContract = [...byContract.values()].map((list) => list[list.length - 1]);
    // Only contracts that are LIVE right now. A 3-hour lookback also still holds
    // contracts the desk has stopped polling (its strike window rolls as the index
    // moves), and assessing those produced a stream of "quote stale" NO_TRADEs that
    // said nothing about the tape. The lookback stays — it is what builds the
    // candles — but a contract whose newest tick is older than the desk's own
    // freshness gate cannot be an honest candidate.
    const maxTickAgeMs = this.thresholds.maxTickAgeMs;
    const liveContracts = latestPerContract.filter((r) => {
      const tickMs = r.ts ? new Date(r.ts).getTime() : NaN;
      return Number.isFinite(tickMs) && Date.now() - tickMs <= maxTickAgeMs;
    });
    if (!liveContracts.length) {
      return {
        universe, contracts: 0, assessed: 0, recorded: 0, signals: 0,
        skipped: `no contract ticked within ${Math.round(maxTickAgeMs / 1000)}s (${latestPerContract.length} contract(s) in the lookback are stale)`,
      };
    }
    const strikes = [...new Set(liveContracts.map((r) => Number(r.strike)).filter((s) => Number.isFinite(s) && s > 0))].sort((a, b) => a - b);
    const spot = await this.latestSpot(universe, liveContracts);
    let windowStrikes = strikes;
    if (spot !== null && strikes.length > this.strikeWindow * 2 + 1) {
      const atm = strikes.reduce((best, s) => (Math.abs(s - spot) < Math.abs(best - spot) ? s : best), strikes[0]);
      const idx = strikes.indexOf(atm);
      windowStrikes = strikes.slice(Math.max(0, idx - this.strikeWindow), idx + this.strikeWindow + 1);
    }
    const windowSet = new Set(windowStrikes);
    const candidates = liveContracts
      .filter((r) => windowSet.size === 0 || windowSet.has(Number(r.strike)))
      .sort((a, b) => (Number(b.volume ?? 0) + Number(b.oi ?? 0) / 100) - (Number(a.volume ?? 0) + Number(a.oi ?? 0) / 100))
      .slice(0, this.maxContracts);
    if (!candidates.length) return { universe, contracts: 0, assessed: 0, recorded: 0, signals: 0, skipped: 'no candidate contracts in the window' };

    // Chain legs for the same cycle (ATM ± window, both sides) — used for the
    // chain/OI confirmation, not just the contract we might trade.
    const chainLegs: ChainLeg[] = liveContracts
      .filter((r) => windowSet.size === 0 || windowSet.has(Number(r.strike)))
      .map((r) => ({
        strike: Number(r.strike), optionType: (String(r.optionType ?? 'CE').toUpperCase() === 'PE' ? 'PE' : 'CE'),
        oi: Number(r.oi ?? 0), changeOi: Number(r.changeOi ?? 0), volume: Number(r.volume ?? 0),
        iv: r.iv === null || r.iv === undefined ? null : Number(r.iv), ltp: Number(r.ltp ?? 0),
        bid: r.bid === null ? null : Number(r.bid), ask: r.ask === null ? null : Number(r.ask),
      }));

    let assessed = 0; let recorded = 0; let signalCount = 0;
    for (const latest of candidates) {
      const key = String(latest.instrumentKey);
      const ticks: TickLike[] = byContract.get(key)!.map((r) => ({ ts: r.ts, price: Number(r.ltp ?? 0), volume: Number(r.volume ?? 0) }));
      const optionCandles = bucketCandles(ticks, this.bucketMs);
      if (optionCandles.length < 4) continue;
      assessed++;
      const optionType: 'CE' | 'PE' = String(latest.optionType ?? 'CE').toUpperCase() === 'PE' ? 'PE' : 'CE';
      const assessment = assessPattern({
        optionCandles,
        // The option's OWN series must never confirm itself: with no mirrored
        // underlying tape the setup has to clear the stricter unconfirmed
        // threshold instead of getting a free pass from its own trend.
        underlyingCandles,
        chainLegs,
        quote: {
          ltp: Number(latest.ltp ?? 0), bid: latest.bid === null ? null : Number(latest.bid),
          ask: latest.ask === null ? null : Number(latest.ask),
          bidQty: latest.bidQty === null ? null : Number(latest.bidQty),
          askQty: latest.askQty === null ? null : Number(latest.askQty),
          ts: latest.ts, oi: latest.oi === null ? null : Number(latest.oi),
          changeOi: latest.changeOi === null ? null : Number(latest.changeOi),
          iv: latest.iv === null ? null : Number(latest.iv),
        },
        optionType, spot, thresholds: this.thresholds,
      });

      const bucketTs = new Date(Math.floor(latest.ts.getTime() / this.bucketMs) * this.bucketMs);
      const worthRecording = assessment.signal !== 'NO_TRADE' || assessment.consolidation.detected ||
        assessment.confidence >= this.recordMinConfidence;
      if (!worthRecording) continue;
      const stored = await this.record(universe, latest, bucketTs, optionType, assessment);
      if (!stored) continue;
      recorded++;
      if (assessment.signal !== 'NO_TRADE') {
        signalCount++;
        await this.dispatchService.dispatch(stored);
      }
    }

    return { universe, contracts: candidates.length, assessed, recorded, signals: signalCount, skipped: null };
  }

  private async loadUnderlyingCandles(universe: string, since: Date): Promise<Candle[]> {
    const rows = await this.snapshots.find({
      where: [{ symbol: universe, ts: MoreThanOrEqual(since) }, { underlying: universe, ts: MoreThanOrEqual(since) }],
      order: { ts: 'ASC' },
      take: 2000,
    });
    return bucketCandles(rows.map((r) => ({ ts: r.ts, price: Number(r.ltp ?? 0), volume: Number(r.volume ?? 0) })), this.bucketMs);
  }

  private async latestSpot(universe: string, latestContracts: UnifiedOptionQuote[]): Promise<number | null> {
    const row = await this.snapshots.findOne({ where: [{ symbol: universe }, { underlying: universe }], order: { ts: 'DESC' } });
    const price = row ? Number(row.ltp) : null;
    if (price !== null && Number.isFinite(price) && price > 0) return price;
    // Fall back to the strike carrying the most volume (never invent a level).
    const byVolume = [...latestContracts].sort((a, b) => Number(b.volume ?? 0) - Number(a.volume ?? 0))[0];
    const strike = byVolume ? Number(byVolume.strike) : null;
    return strike !== null && Number.isFinite(strike) && strike > 0 ? strike : null;
  }

  /** Persist one assessment (good or bad). Returns the stored row, or null. */
  private async record(
    universe: string, latest: UnifiedOptionQuote, bucketTs: Date, optionType: 'CE' | 'PE', assessment: PatternAssessment,
  ): Promise<PatternSignal | null> {
    const contractSymbol = String(latest.instrumentKey).split(':').pop() ?? String(latest.instrumentKey);
    const existing = await this.signals.findOne({ where: { contractSymbol, bucketTs, strategyVersion: STRATEGY_VERSION } });
    if (existing) return null; // one assessment per contract per bucket

    const atrValue = assessment.consolidation.atrValue;
    const ltp = Number(latest.ltp ?? 0);
    const targetPct = atrValue && ltp > 0 ? round(Math.max(0.15, (atrValue * 2) / ltp)) : null;
    const stopPct = atrValue && ltp > 0 ? round(Math.max(0.08, atrValue / ltp)) : null;

    const entity = this.signals.create({
      sessionDate: istDate(bucketTs.getTime()),
      underlying: universe,
      instrumentKey: String(latest.instrumentKey),
      contractSymbol,
      expiry: latest.expiry ?? null,
      strike: latest.strike === null || latest.strike === undefined ? null : Number(latest.strike),
      optionType,
      bucketTs,
      bucketMinutes: this.bucketMs / 60_000,
      signalTs: latest.ts,
      feedSource: latest.source ? String(latest.source) : null,
      patternType: assessment.patternType,
      signal: assessment.signal,
      entryState: assessment.entryState,
      confidence: round(assessment.confidence),
      strategyVersion: STRATEGY_VERSION,
      reason: assessment.reason.slice(0, 760),
      consolidationDetected: assessment.consolidation.detected,
      rangeHigh: assessment.consolidation.rangeHigh || null,
      rangeLow: assessment.consolidation.rangeLow || null,
      rangeWidthPct: round(assessment.consolidation.rangeWidthPct, 6),
      rangeWidthAtr: assessment.consolidation.rangeWidthAtr === null ? null : round(assessment.consolidation.rangeWidthAtr),
      atr: atrValue === null ? null : round(atrValue),
      atrPct: assessment.consolidation.atrPct === null ? null : round(assessment.consolidation.atrPct, 6),
      consolidationBars: assessment.consolidation.durationBars,
      failedBreakouts: assessment.consolidation.failedBreakouts,
      reversalScore: round(assessment.components.reversal),
      breakoutScore: round(assessment.components.breakout),
      momentumScore: round(assessment.components.momentum),
      volumeScore: round(assessment.components.volume),
      oiScore: round(assessment.components.oi),
      ivScore: round(assessment.components.iv),
      underlyingScore: round(assessment.components.underlying),
      liquidityScore: round(assessment.components.liquidity),
      chainScore: round(assessment.components.chain),
      breakoutClass: assessment.breakout.classification,
      distanceAtr: assessment.breakout.atrMultiple === null ? null : round(assessment.breakout.atrMultiple),
      barsSinceBreakout: assessment.breakout.barsSince,
      underlyingDirection: assessment.underlying.direction,
      optionDirection: assessment.breakout.detected ? 'BULLISH' : null,
      underlyingConfirmed: assessment.underlying.confirmed,
      oiBehaviour: assessment.oi.behaviour,
      ltp: ltp || null,
      bid: latest.bid === null ? null : Number(latest.bid),
      ask: latest.ask === null ? null : Number(latest.ask),
      spreadPct: assessment.liquidity.spreadPct === null ? null : round(assessment.liquidity.spreadPct, 6),
      volume: latest.volume === null ? null : String(latest.volume),
      oi: latest.oi === null ? null : String(latest.oi),
      changeOi: latest.changeOi === null ? null : String(latest.changeOi),
      iv: latest.iv === null ? null : Number(latest.iv),
      delta: latest.delta === null ? null : Number(latest.delta),
      gamma: latest.gamma === null ? null : Number(latest.gamma),
      theta: latest.theta === null ? null : Number(latest.theta),
      vega: latest.vega === null ? null : Number(latest.vega),
      pcr: assessment.chain.pcr === null ? null : round(assessment.chain.pcr),
      targetPct, stopPct,
      features: {
        components: assessment.components, weights: undefined, penalties: assessment.penalties,
        reversalParts: assessment.reversal.parts, reversalFlags: assessment.reversal.flags,
        momentum: assessment.momentum, oi: assessment.oi, iv: assessment.iv,
        consolidation: assessment.consolidation.components,
        chain: { score: assessment.chain.score, pcr: assessment.chain.pcr, atmStrike: assessment.chain.atmStrike, strikesExamined: assessment.chain.strikesExamined, parts: assessment.chain.parts },
        underlying: { score: assessment.underlying.score, parts: assessment.underlying.parts, features: assessment.underlying.features },
        liquidity: { score: assessment.liquidity.score, reasons: assessment.liquidity.reasons },
        breakout: { class: assessment.breakout.classification, distancePct: assessment.breakout.distancePct, volumeRatio: assessment.breakout.volumeRatio, spreadAtBreakout: assessment.breakout.spreadAtBreakout },
        entryState: assessment.entryState,
      },
      outcomeLabel: 'PENDING',
    } as Partial<PatternSignal>);
    try {
      return await this.signals.save(entity as PatternSignal);
    } catch (error) {
      this.logger.warn(`[PATTERN] record failed for ${contractSymbol}: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Forward outcome labelling (brief s13): for every stored setup, measure what
   * happened next at 5/10/15/30/60 minutes. Horizons that have not happened yet
   * are simply absent — nothing is extrapolated.
   */
  async labelPending(limit = 40): Promise<number> {
    const now = Date.now();
    const oldest = new Date(now - (Math.max(...OUTCOME_HORIZONS_MIN) + 10) * 60_000);
    const rows = await this.signals.find({
      where: { outcomeLabel: 'PENDING', signalTs: MoreThanOrEqual(oldest) },
      order: { signalTs: 'DESC' }, take: limit,
    });
    let labelled = 0;
    for (const row of rows) {
      const entryPrice = Number(row.ltp ?? 0);
      if (!(entryPrice > 0)) {
        await this.signals.update({ id: row.id }, { outcomeLabel: 'PENDING', labelledAt: new Date() });
        continue;
      }
      const future = await this.quotes.find({
        where: { instrumentKey: row.instrumentKey, ts: MoreThanOrEqual(row.signalTs) },
        order: { ts: 'ASC' }, take: 4000,
      });
      const outcomes = labelOutcomes({
        entryPrice, entryTs: row.signalTs.getTime(),
        futureTicks: future.map((r) => ({ ts: r.ts, price: Number(r.ltp ?? 0), volume: Number(r.volume ?? 0) })),
        targetPct: row.targetPct === null ? null : Number(row.targetPct),
        stopPct: row.stopPct === null ? null : Number(row.stopPct),
      });
      if (!outcomes.length) continue;
      const maxFavourable = Math.max(...outcomes.map((o) => o.maxFavourablePct ?? 0));
      const maxAdverse = Math.min(...outcomes.map((o) => o.maxAdversePct ?? 0));
      // The headline label describes the LONGEST horizon the tape actually
      // covered — never a horizon the future has not reached yet.
      const covered = outcomes.filter((o) => o.covered !== false);
      const label = (covered.length ? covered[covered.length - 1] : outcomes[outcomes.length - 1]).label;
      await this.signals.update({ id: row.id }, {
        outcomes: { horizons: outcomes, coverageMinutes: covered.length ? covered[covered.length - 1].horizonMinutes : 0 },
        maxFavourablePct: round(maxFavourable, 6),
        maxAdversePct: round(maxAdverse, 6),
        outcomeLabel: label,
        labelledAt: new Date(),
      });
      labelled++;
    }
    return labelled;
  }

  /** Dashboard payload (brief s20): current pattern per universe + WHY. */
  async status(): Promise<Record<string, unknown>> {
    const universes = this.universes();
    const current: Record<string, unknown>[] = [];
    for (const universe of universes) {
      const row = await this.signals.findOne({ where: { underlying: universe }, order: { signalTs: 'DESC' } });
      current.push({
        universe,
        asOf: row?.signalTs?.toISOString() ?? null,
        contract: row?.contractSymbol ?? null,
        patternType: row?.patternType ?? null,
        signal: row?.signal ?? null,
        entryState: row?.entryState ?? null,
        confidence: row ? Number(row.confidence) : null,
        reason: row?.reason ?? null,
        consolidation: row ? { detected: Boolean(row.consolidationDetected), rangeHigh: row.rangeHigh, rangeLow: row.rangeLow, bars: row.consolidationBars, failedBreakouts: row.failedBreakouts, rangeWidthAtr: row.rangeWidthAtr } : null,
        scores: row ? {
          reversal: Number(row.reversalScore), breakout: Number(row.breakoutScore), momentum: Number(row.momentumScore),
          volume: Number(row.volumeScore), oi: Number(row.oiScore), iv: Number(row.ivScore),
          underlying: Number(row.underlyingScore), liquidity: Number(row.liquidityScore), chain: Number(row.chainScore),
        } : null,
        confirmations: row ? {
          underlying: { direction: row.underlyingDirection, confirmed: Boolean(row.underlyingConfirmed) },
          oi: row.oiBehaviour, chain: row.pcr === null ? null : `PCR ${Number(row.pcr).toFixed(2)}`,
          liquidity: Number(row.liquidityScore) >= 0.5 ? 'GOOD' : 'WEAK',
          iv: Number(row.ivScore) >= 0.5 ? 'SUPPORTIVE' : 'MUTED',
          volume: Number(row.volumeScore) >= 0.5 ? 'SUPPORTIVE' : 'MUTED',
        } : null,
      });
    }
    let arbitration: FeedArbitrationStatus | null = null;
    try { arbitration = await this.arbitration.status(); } catch (error) { this.logger.warn(`arbiter status failed: ${(error as Error).message}`); }
    return {
      strategyVersion: STRATEGY_VERSION,
      enabled: this.enabled,
      universes,
      bucketMinutes: this.bucketMs / 60_000,
      intervalMs: this.intervalMs,
      thresholds: this.thresholds,
      targets: this.dispatchService.targets(),
      lastScanAt: this.lastScanAt?.toISOString() ?? null,
      scans: this.scans,
      assessedToday: this.assessedToday,
      signalsToday: this.signalsToday,
      lastScans: this.lastScans,
      lastError: this.lastError,
      current,
      arbitration: arbitration ? {
        enabled: arbitration.enabled, mode: arbitration.mode, activeFeeds: arbitration.activeFeeds,
        unowned: arbitration.unowned, staleAfterMs: arbitration.staleAfterMs,
        decisions: arbitration.decisions.map((d) => ({ universe: d.universe, owner: d.owner, reason: d.reason })),
      } : null,
      note: 'Signals are recommendations from the pattern engine. Strategy parameters are never modified automatically (brief s18).',
    };
  }

  async recentSignals(limit = 25, onlySignals = false): Promise<PatternSignal[]> {
    const where: FindOptionsWhere<PatternSignal> = onlySignals ? { signal: Not('NO_TRADE') } : {};
    return this.signals.find({ where, order: { signalTs: 'DESC' }, take: Math.min(200, Math.max(1, limit)) });
  }

  /**
   * Outcome metrics (brief s19) — honest about small samples.
   *
   * Only horizons the tape actually COVERED are used: a setup that is 12 minutes
   * old has no 30/60-minute measurement, and treating a partial window as a
   * result is how a dataset starts lying to itself.
   */
  async metrics(days = 30): Promise<Record<string, unknown>> {
    const since = new Date(Date.now() - days * 86_400_000);
    const rows = await this.signals.find({ where: { signalTs: MoreThanOrEqual(since) }, order: { signalTs: 'DESC' }, take: 5000 });
    const horizons = (row: PatternSignal) => (row.outcomes?.horizons ?? []) as { covered?: boolean; returnPct?: number; label?: string }[];
    const measured = (row: PatternSignal) => {
      const covered = horizons(row).filter((h) => h.covered !== false);
      return covered.length ? covered[covered.length - 1] : null;
    };
    const group = (list: PatternSignal[], key: (row: PatternSignal) => string | null) => {
      const buckets = new Map<string, PatternSignal[]>();
      for (const row of list) {
        const k = key(row);
        if (!k) continue;
        const bucket = buckets.get(k);
        if (bucket) bucket.push(row); else buckets.set(k, [row]);
      }
      return [...buckets.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 12).map(([k, bucket]) => ({
        key: k, total: bucket.length, buySignals: bucket.filter((r) => r.signal !== 'NO_TRADE').length,
        ...this.returnStats(bucket, measured),
      }));
    };
    const over = (list: PatternSignal[]): Record<string, unknown> => ({
      total: list.length,
      buySignals: list.filter((r) => r.signal !== 'NO_TRADE').length,
      noTrade: list.filter((r) => r.signal === 'NO_TRADE').length,
      failedBreakouts: list.filter((r) => r.outcomeLabel === 'FAILED_BREAKOUT').length,
      measured: list.filter((r) => measured(r)).length,
      fullyCovered: list.filter((r) => horizons(r).some((h) => h.covered !== false && h.label)).length,
      ...this.returnStats(list, measured),
      byUnderlying: group(list, (r) => r.underlying),
      bySide: group(list, (r) => r.optionType),
      byEntryState: group(list, (r) => r.entryState),
      byHourIst: group(list, (r) => `${String(new Date(r.signalTs.getTime() + 5.5 * 3_600_000).getUTCHours()).padStart(2, '0')}h`),
      byConfidenceBand: group(list, (r) => {
        const c = Number(r.confidence ?? 0);
        return c >= 0.85 ? '>=0.85' : c >= 0.75 ? '0.75-0.85' : c >= 0.6 ? '0.60-0.75' : '<0.60';
      }),
    });
    const buy = rows.filter((r) => r.signal !== 'NO_TRADE');
    return {
      windowDays: days,
      samples: rows.length,
      sufficientForConclusion: rows.length >= 30 && buy.filter((r) => measured(r)).length >= 30,
      caveat: rows.length < 30
        ? 'Not enough stored setups to conclude anything about profitability — this is feature collection, not evidence.'
        : 'Feature-level aggregates only. Profitability requires a proper backtest (brief s19).',
      ...over(rows),
      buySignals: over(buy),
      recommendation: 'Strategy weights are frozen for now; go/no-go on tuning comes after enough labelled samples (brief s18/s19).',
    };
  }

  /** Return statistics over one slice, using only covered horizons. */
  private returnStats(list: PatternSignal[], measured: (row: PatternSignal) => { returnPct?: number } | null): Record<string, unknown> {
    const values = list.map((row) => measured(row)).filter((h): h is { returnPct?: number } => Boolean(h))
      .map((h) => Number(h.returnPct ?? 0));
    if (!values.length) return { winRate: null, avgReturnPct: null, medianReturnPct: null, avgMfePct: null, avgMaePct: null };
    const sorted = [...values].sort((a, b) => a - b);
    const mfe = list.map((row) => measured(row)).filter(Boolean).map((h) => Number((h as { maxFavourablePct?: number }).maxFavourablePct ?? 0));
    const mae = list.map((row) => measured(row)).filter(Boolean).map((h) => Number((h as { maxAdversePct?: number }).maxAdversePct ?? 0));
    return {
      winRate: round(values.filter((v) => v > 0).length / values.length, 4),
      avgReturnPct: round(values.reduce((a, b) => a + b, 0) / values.length, 6),
      medianReturnPct: round(sorted[Math.floor(sorted.length / 2)], 6),
      avgMfePct: mfe.length ? round(mfe.reduce((a, b) => a + b, 0) / mfe.length, 6) : null,
      avgMaePct: mae.length ? round(mae.reduce((a, b) => a + b, 0) / mae.length, 6) : null,
    };
  }
}
