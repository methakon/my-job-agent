import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UpstoxLivePaperConfig } from '../upstox-live-paper/upstox-live-paper.config';
import { PreOpenObservation } from './pre-open-observation.entity';
import {
  assessObservation,
  derivePreOpenFeatures,
  ObservationQuality,
  preOpenDedupeKey,
  PreOpenSourceValues,
  PreOpenFeatures,
} from './pre-open-features';
import { PreOpenRepository, PriorClose } from './pre-open.repository';
import {
  MARKET_OPEN_START_MIN,
  SessionPhase,
  isAuctionPhase,
  istDateString,
  istMinutes,
  phaseFromBrokerStatus,
  sessionPhaseAt,
} from './pre-open-session';
import { PRE_OPEN_QUOTE_SOURCE, PreOpenQuoteSource } from './pre-open-source.interface';

/**
 * GATE 2 slice 1 — pre-open / auction capture into point-in-time storage.
 *
 * REUSE, NOT A SECOND MARKET-DATA SYSTEM (item 3): this service is an
 * observation PRODUCER. It normalizes one broker payload per instrument into an
 * append-only pre-open observation (its own event/receive timestamps, source,
 * quality and per-field quality) and, when the source publishes nothing usable,
 * records that fact as UNAVAILABLE. It does not open a second tick stream, does
 * not duplicate tick storage, and its output is designed to feed the existing
 * feature engine / gap engine / decision journal later.
 *
 * POLLING IS BOUNDED TO THE OPENING WINDOW: auction phases (09:00–09:15 IST)
 * plus a short post-open sample. Outside that it does nothing at all, so it adds
 * no API load or storage during the trading day (item 21 scope discipline).
 *
 * NO-FABRICATION RULE: a failed fetch, a missing token or an instrument with no
 * auction fields produces NO row with invented values — fetch failures are
 * recorded in status, and empty fields are stored as NULL with an explicit
 * quality label (item 6/17).
 */
export type PreOpenCaptureStatus = {
  enabled: boolean;
  source: string;
  pollIntervalMs: number;
  instruments: string[];
  instrumentsConfiguredFrom: 'PRE_OPEN_INSTRUMENTS' | 'UPSTOX_LIVE_INSTRUMENTS';
  phase: SessionPhase;
  brokerStatus: string | null;
  lastPollAt: string | null;
  lastPersistAt: string | null;
  lastSkippedReason: string | null;
  lastError: string | null;
  consecutiveFetchFailures: number;
  evaluatedTotal: number;
  persistedTotal: number;
  duplicatesSuppressed: number;
  unavailableTotal: number;
  byQuality: Record<string, number>;
  staleMaxAgeMs: number;
  prevCloseFromStore: boolean;
  nextWindowStartsInMs: number | null;
};

@Injectable()
export class PreOpenCaptureService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PreOpenCaptureService.name);

  private enabled: boolean;
  private readonly pollIntervalMs: number;
  private readonly staleMaxAgeMs: number;
  private readonly postOpenSampleMs: number;
  private readonly prevCloseFromStore: boolean;
  private readonly instruments: string[];
  private readonly instrumentsConfiguredFrom: 'PRE_OPEN_INSTRUMENTS' | 'UPSTOX_LIVE_INSTRUMENTS';

  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;

  private phase: SessionPhase = 'UNKNOWN';
  private brokerStatus: string | null = null;
  private lastPollAt: Date | null = null;
  private lastPersistAt: Date | null = null;
  private lastSkippedReason: string | null = null;
  private lastError: string | null = null;
  private consecutiveFetchFailures = 0;
  private evaluatedTotal = 0;
  private persistedTotal = 0;
  private duplicatesSuppressed = 0;
  private unavailableTotal = 0;
  private readonly byQuality: Record<string, number> = {};

  constructor(
    private readonly config: UpstoxLivePaperConfig,
    @Inject(PRE_OPEN_QUOTE_SOURCE) private readonly source: PreOpenQuoteSource,
    private readonly repo: PreOpenRepository,
    configService: ConfigService,
  ) {
    const bool = (key: string, dflt: boolean): boolean => {
      const raw = configService.get<string>(key);
      return raw === undefined || raw === null || raw === '' ? dflt : /^(1|true|yes)$/i.test(String(raw));
    };
    this.enabled = bool('PRE_OPEN_CAPTURE_ENABLED', true);
    this.pollIntervalMs = Math.max(5_000, Number(configService.get<string>('PRE_OPEN_POLL_MS') ?? 15_000) || 15_000);
    this.staleMaxAgeMs = Math.max(5_000, Number(configService.get<string>('PRE_OPEN_STALE_MAX_AGE_MS') ?? 120_000) || 120_000);
    this.postOpenSampleMs = Math.max(0, Math.min(30, Number(configService.get<string>('PRE_OPEN_POST_OPEN_SAMPLE_MIN') ?? 5) || 5)) * 60_000;
    // OFF by default. During runtime verification this fallback returned the
    // CURRENT session's close as "previous close" for the index, because the known
    // wall-clock IST/UTC anomaly in unified_market_snapshots makes a
    // session-boundary comparison unreliable. Until that anomaly is fixed and
    // this path is proven point-in-time, a source that does not publish a
    // previous close leaves the gap UNAVAILABLE rather than risking look-ahead
    // (item 4 / item 17).
    this.prevCloseFromStore = bool('PRE_OPEN_PREVCLOSE_FROM_STORE', false);
    const explicit = (configService.get<string>('PRE_OPEN_INSTRUMENTS') ?? '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    this.instruments = explicit.length ? explicit.slice(0, 100) : this.config.liveInstruments.slice(0, 100);
    this.instrumentsConfiguredFrom = explicit.length ? 'PRE_OPEN_INSTRUMENTS' : 'UPSTOX_LIVE_INSTRUMENTS';
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.log('[PRE-OPEN] capture disabled (PRE_OPEN_CAPTURE_ENABLED=false)');
      return;
    }
    if (!this.instruments.length) {
      this.logger.warn('[PRE-OPEN] no instruments configured — capture will not poll (set PRE_OPEN_INSTRUMENTS)');
      return;
    }
    this.logger.log(
      `[PRE-OPEN] capture armed: every ${Math.round(this.pollIntervalMs / 1000)}s during 09:00–09:15 IST (+${Math.round(this.postOpenSampleMs / 60000)}min post-open) for ${this.instruments.length} instrument(s) via ${this.source.sourceName}`,
    );
    this.timer = setInterval(() => { void this.tick(); }, this.pollIntervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Is capture permitted at this instant, by exchange calendar only? */
  private windowOpenAt(nowMs: number): { open: boolean; phase: SessionPhase; reason: string | null } {
    const phase = sessionPhaseAt(nowMs);
    if (isAuctionPhase(phase)) return { open: true, phase, reason: null };
    if (phase === 'MARKET_OPEN') {
      const openMs = nowMs - (istMinutes(nowMs) - MARKET_OPEN_START_MIN) * 60_000;
      if (nowMs - openMs <= this.postOpenSampleMs) return { open: true, phase, reason: null };
      return { open: false, phase, reason: 'post-open sample window elapsed' };
    }
    return { open: false, phase, reason: `outside opening window (phase ${phase})` };
  }

  /** One poll cycle. Safe to await; never throws. */
  async tick(nowMs = Date.now()): Promise<{ evaluated: number; inserted: number; skipped: string | null }> {
    if (!this.enabled) return { evaluated: 0, inserted: 0, skipped: 'disabled' };
    if (this.inFlight) return { evaluated: 0, inserted: 0, skipped: 'previous poll still in flight' };
    const gate = this.windowOpenAt(nowMs);
    this.phase = gate.phase;
    if (!gate.open) {
      this.lastSkippedReason = gate.reason;
      return { evaluated: 0, inserted: 0, skipped: gate.reason };
    }

    this.inFlight = true;
    try {
      const fetch = await this.source.fetchPreOpen(this.instruments);
      this.lastPollAt = new Date(nowMs);
      this.brokerStatus = fetch.marketStatus;
      if (!fetch.ok) {
        this.consecutiveFetchFailures += 1;
        this.lastError = fetch.error ?? 'fetch failed';
        return { evaluated: 0, inserted: 0, skipped: this.lastError };
      }
      this.consecutiveFetchFailures = 0;
      this.lastError = fetch.error;

      const brokerPhase = phaseFromBrokerStatus(fetch.marketStatus);
      const rows: PreOpenObservation[] = [];
      for (const [instrumentKey, values] of Object.entries(fetch.values)) {
        const built = await this.buildObservation(instrumentKey, values, { nowMs, phase: gate.phase, brokerPhase, brokerStatus: fetch.marketStatus });
        rows.push(built);
      }
      const inserted = await this.repo.insertIgnore(rows);
      this.evaluatedTotal += rows.length;
      this.persistedTotal += inserted;
      this.duplicatesSuppressed += Math.max(0, rows.length - inserted);
      for (const row of rows) {
        this.byQuality[row.quality] = (this.byQuality[row.quality] ?? 0) + 1;
        if (row.quality === 'UNAVAILABLE') this.unavailableTotal += 1;
      }
      if (rows.length) this.lastPersistAt = new Date(nowMs);
      this.lastSkippedReason = null;
      return { evaluated: rows.length, inserted, skipped: null };
    } catch (err) {
      this.consecutiveFetchFailures += 1;
      this.lastError = err instanceof Error ? err.message : String(err);
      return { evaluated: 0, inserted: 0, skipped: this.lastError };
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * Compose one append-only observation: normalize → (optional provenance-labelled
   * previous close) → validate → stamp quality. PURE decisions only from the
   * passed values, so the same source payload always yields the same row.
   */
  private async buildObservation(
    instrumentKey: string,
    values: PreOpenSourceValues,
    ctx: { nowMs: number; phase: SessionPhase; brokerPhase: SessionPhase | 'UNKNOWN'; brokerStatus: string | null },
  ): Promise<PreOpenObservation> {
    const eventValid = values.eventTime !== null && Number.isFinite(values.eventTime.getTime());
    const sessionDate = istDateString(eventValid ? (values.eventTime as Date).getTime() : ctx.nowMs);

    let priorClose: PriorClose | null = null;
    let previousClose = values.previousClose;
    let previousCloseSource: string | null = previousClose !== null ? 'SOURCE' : null;
    if (previousClose === null && this.prevCloseFromStore && eventValid) {
      const sessionStart = new Date((values.eventTime as Date).getTime());
      sessionStart.setHours(9, 15, 0, 0);
      priorClose = await this.repo.priorSessionClose(instrumentKey, sessionStart).catch(() => null);
      if (priorClose) {
        previousClose = priorClose.price;
        previousCloseSource = 'STORE_PRIOR_SESSION';
      }
    }

    const assessed = assessObservation({ ...values, previousClose }, {
      nowMs: ctx.nowMs,
      staleMaxAgeMs: this.staleMaxAgeMs,
      phase: ctx.phase,
    });

    const row = new PreOpenObservation();
    row.instrumentKey = instrumentKey;
    row.symbol = values.symbol ?? null;
    row.underlying = values.underlying ?? null;
    row.exchange = values.exchange ?? null;
    row.sessionDate = sessionDate;
    row.sessionPhase = ctx.phase;
    row.sourceStatus = ctx.brokerStatus ?? 'UNAVAILABLE';
    row.eventTime = values.eventTime;
    row.receivedAt = new Date(ctx.nowMs);
    row.dataAgeMs = assessed.dataAgeMs;
    row.previousClose = previousClose;
    row.previousCloseSource = previousCloseSource;
    row.referencePrice = values.referencePrice;
    row.indicativePrice = values.indicativePrice;
    row.indicativeQuantity = values.indicativeQuantity;
    row.imbalanceTotal = values.imbalanceTotal;
    row.imbalanceMarket = values.imbalanceMarket;
    row.buyQuantity = values.buyQuantity;
    row.sellQuantity = values.sellQuantity;
    row.lastPrice = values.lastPrice;
    row.volume = values.volume;
    row.bestBid = values.depthBestBid?.price ?? null;
    row.bestBidQty = values.depthBestBid?.quantity ?? null;
    row.bestAsk = values.depthBestAsk?.price ?? null;
    row.bestAskQty = values.depthBestAsk?.quantity ?? null;
    row.source = this.source.sourceName;
    row.quality = assessed.quality;
    row.fieldQuality = {
      ...assessed.fieldQuality,
      brokerPhase: ctx.brokerPhase,
      previousCloseSource: previousCloseSource ?? 'UNAVAILABLE',
      reasons: assessed.reasons.join('; ').slice(0, 200) || 'none',
      priorCloseNote: priorClose ? `${priorClose.symbol}/${priorClose.source} @ ${priorClose.asOfTs.toISOString()}` : 'not used',
    };
    row.dedupeKey = preOpenDedupeKey({
      instrumentKey,
      sessionDate,
      sessionPhase: ctx.phase,
      source: this.source.sourceName,
      eventTime: values.eventTime,
      receivedAtMs: ctx.nowMs,
    });
    row.rawPayload = this.sanitizeRaw(values);
    row.featuresVersion = 'po-v1';
    return row;
  }

  /** Store only market-data fields of the source payload — no credentials, ever. */
  private sanitizeRaw(values: PreOpenSourceValues): Record<string, unknown> {
    return {
      instrumentKey: values.instrumentKey,
      symbol: values.symbol,
      eventTime: values.eventTime ? values.eventTime.toISOString() : null,
      lastPrice: values.lastPrice,
      previousClose: values.previousClose,
      referencePrice: values.referencePrice,
      indicativePrice: values.indicativePrice,
      buyQuantity: values.buyQuantity,
      sellQuantity: values.sellQuantity,
      imbalanceTotal: values.imbalanceTotal,
      imbalanceMarket: values.imbalanceMarket,
      volume: values.volume,
    };
  }

  /** Derived features for the latest observation known at an instant (no look-ahead). */
  async featuresAsOf(instrumentKey: string, at: Date): Promise<PreOpenFeatures | null> {
    const row = await this.repo.latestAsOf(instrumentKey, at);
    if (!row) return null;
    return derivePreOpenFeatures({
      instrumentKey: row.instrumentKey,
      sessionDate: row.sessionDate,
      sessionPhase: row.sessionPhase as SessionPhase,
      eventTime: row.eventTime,
      previousClose: row.previousClose === null ? null : Number(row.previousClose),
      indicativePrice: row.indicativePrice === null ? null : Number(row.indicativePrice),
      buyQuantity: row.buyQuantity === null ? null : Number(row.buyQuantity),
      sellQuantity: row.sellQuantity === null ? null : Number(row.sellQuantity),
    }, { observationQuality: row.quality as ObservationQuality, asOfMs: at.getTime() });
  }

  /** Manual one-shot poll (diagnostics / tests); bypasses the window gate. */
  async pollNow(): Promise<Awaited<ReturnType<PreOpenCaptureService['tick']>>> {
    const saved = this.enabled;
    this.enabled = true;
    try {
      return await this.doForcedTick();
    } finally {
      this.enabled = saved;
    }
  }

  private async doForcedTick(): Promise<{ evaluated: number; inserted: number; skipped: string | null }> {
    if (this.inFlight) return { evaluated: 0, inserted: 0, skipped: 'previous poll still in flight' };
    this.inFlight = true;
    const nowMs = Date.now();
    try {
      const fetch = await this.source.fetchPreOpen(this.instruments);
      this.lastPollAt = new Date(nowMs);
      this.brokerStatus = fetch.marketStatus;
      this.phase = sessionPhaseAt(nowMs);
      if (!fetch.ok) {
        this.lastError = fetch.error ?? 'fetch failed';
        return { evaluated: 0, inserted: 0, skipped: this.lastError };
      }
      const brokerPhase = phaseFromBrokerStatus(fetch.marketStatus);
      const rows: PreOpenObservation[] = [];
      for (const [instrumentKey, values] of Object.entries(fetch.values)) {
        rows.push(await this.buildObservation(instrumentKey, values, { nowMs, phase: this.phase, brokerPhase, brokerStatus: fetch.marketStatus }));
      }
      const inserted = await this.repo.insertIgnore(rows);
      this.evaluatedTotal += rows.length;
      this.persistedTotal += inserted;
      for (const row of rows) {
        this.byQuality[row.quality] = (this.byQuality[row.quality] ?? 0) + 1;
        if (row.quality === 'UNAVAILABLE') this.unavailableTotal += 1;
      }
      if (rows.length) this.lastPersistAt = new Date(nowMs);
      return { evaluated: rows.length, inserted, skipped: null };
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      return { evaluated: 0, inserted: 0, skipped: this.lastError };
    } finally {
      this.inFlight = false;
    }
  }

  status(nowMs = Date.now()): PreOpenCaptureStatus {
    const gate = this.windowOpenAt(nowMs);
    let nextWindowStartsInMs: number | null = null;
    if (!gate.open) {
      const m = istMinutes(nowMs);
      const untilOpenMin = m < 9 * 60 ? 9 * 60 - m : 24 * 60 - m + 9 * 60;
      nextWindowStartsInMs = untilOpenMin * 60_000;
    }
    return {
      enabled: this.enabled,
      source: this.source.sourceName,
      pollIntervalMs: this.pollIntervalMs,
      instruments: this.instruments,
      instrumentsConfiguredFrom: this.instrumentsConfiguredFrom,
      phase: gate.phase,
      brokerStatus: this.brokerStatus,
      lastPollAt: this.lastPollAt?.toISOString() ?? null,
      lastPersistAt: this.lastPersistAt?.toISOString() ?? null,
      lastSkippedReason: this.lastSkippedReason,
      lastError: this.lastError,
      consecutiveFetchFailures: this.consecutiveFetchFailures,
      evaluatedTotal: this.evaluatedTotal,
      persistedTotal: this.persistedTotal,
      duplicatesSuppressed: this.duplicatesSuppressed,
      unavailableTotal: this.unavailableTotal,
      byQuality: { ...this.byQuality },
      staleMaxAgeMs: this.staleMaxAgeMs,
      prevCloseFromStore: this.prevCloseFromStore,
      nextWindowStartsInMs,
    };
  }
}
