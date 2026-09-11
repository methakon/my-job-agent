import { Injectable, Logger } from '@nestjs/common';
import { UnifiedMarketDataService } from '../unified-market-data.service';
import { UnifiedOptionQuote } from '../unified-option-quote.entity';
import {
  CanonicalTick,
  InterpreterResult,
  TickBudgets,
  TickRejection,
  budgetsFromEnv,
  interpretObservation,
} from './canonical-tick';
import { MapperContext, envelopeFor, mapperFor } from './provider-mappers';

/**
 * The single entry point every broker feed goes through.
 *
 * Deterministic and provider-independent: the provider adapter translates the
 * payload, this service validates and canonicalizes it, then persists the
 * canonical tick into the COMMON store that both paper desks read. No AI, no
 * heuristics, no clock-dependence beyond the injected receive time — the same
 * input always yields the same canonical tick or the same rejection.
 *
 * Modes (`TICK_INTERPRETER_MODE`):
 *   shadow (default) — interpret + measure only; the existing ingest path stays
 *                      authoritative and NOTHING is written here
 *   on               — canonical ticks are authoritative AND persisted
 *   off              — interpreter inert (no interpretation, no metrics)
 *
 * Whatever the mode, a rejected tick is never persisted and never repaired.
 */
export type InterpreterMode = 'off' | 'shadow' | 'on';

export type InterpreterMetrics = {
  mode: InterpreterMode;
  accepted: number;
  rejected: number;
  persisted: number;
  rejectionsByCode: Record<string, number>;
  rejectionsBySource: Record<string, number>;
  latency: { samples: number; p50Ms: number | null; p95Ms: number | null; maxMs: number | null };
  latencyBudgetExceeded: number;
  lastSample: { source: string; instrumentKey: string; lagMs: number | null; accepted: boolean } | null;
};

export type InterpretAndPersistInput = {
  source: string;
  payload: unknown;
  receivedAt?: Date;
  /** Deterministic token → symbol resolution for brokers whose ticks carry only a token. */
  resolveSymbol?: (providerInstrumentId: string) => string | null;
};

@Injectable()
export class TickInterpreterService {
  private readonly logger = new Logger(TickInterpreterService.name);
  private readonly mode: InterpreterMode;
  private readonly budgets: TickBudgets;

  private accepted = 0;
  private rejected = 0;
  private persisted = 0;
  private latencyBudgetExceeded = 0;
  private readonly rejectionsByCode = new Map<string, number>();
  private readonly rejectionsBySource = new Map<string, number>();
  private readonly latencies: number[] = [];
  private lastSample: InterpreterMetrics['lastSample'] = null;
  private readonly maxLatencySamples = 1_000;
  /** Bound on records interpreted from ONE provider message (shadow safety). */
  private readonly maxRecordsPerMessage = 500;

  constructor(private readonly unified: UnifiedMarketDataService) {
    this.mode = this.modeFromEnv();
    this.budgets = budgetsFromEnv();
  }

  private modeFromEnv(): InterpreterMode {
    const raw = String(process.env.TICK_INTERPRETER_MODE ?? 'shadow').trim().toLowerCase();
    return raw === 'on' || raw === 'off' ? (raw as InterpreterMode) : 'shadow';
  }

  get currentMode(): InterpreterMode {
    return this.mode;
  }

  /** Interpret one provider payload. Pure w.r.t. everything except receivedAt. */
  interpret(input: InterpretAndPersistInput): InterpreterResult {
    const receivedAt = input.receivedAt ?? new Date();
    const mapper = mapperFor(input.source);
    if (!mapper) {
      return this.record({
        ok: false,
        code: 'UNSUPPORTED_PROVIDER',
        reason: `no interpreter adapter for source ${input.source}`,
        source: String(input.source ?? ''),
      });
    }
    const ctx: MapperContext = { receivedAt, resolveSymbol: input.resolveSymbol };
    const mapped = mapper(input.payload, ctx);
    if (!mapped.ok) {
      return this.record({ ok: false, code: 'SCHEMA', reason: mapped.reason, source: String(input.source).toUpperCase() });
    }
    return this.record(interpretObservation(input.source, mapped.observation, receivedAt, this.budgets));
  }

  /**
   * SHADOW hook for live adapters: interpret every record a provider message
   * carries, measure it, and never throw or write. The live ingest path is
   * untouched, so a rejection here can never starve a desk — in `on` mode the
   * adapters call interpretAndPersist instead, which is when canonical ticks
   * become authoritative.
   */
  observe(source: string, payload: unknown, receivedAt = new Date()): void {
    if (this.mode === 'off') return;
    try {
      for (const record of envelopeFor(source)(payload).slice(0, this.maxRecordsPerMessage)) {
        this.interpret({ source, payload: record, receivedAt });
      }
    } catch (error) {
      this.logger.warn(`canonical observe failed for ${source}: ${(error as Error).message}`);
    }
  }

  /**
   * Interpret and, in `on` mode, persist the canonical tick into the common
   * store. Rejections are counted and dropped: a desk never sees a repaired tick.
   */
  async interpretAndPersist(input: InterpretAndPersistInput): Promise<InterpreterResult> {
    const result = this.interpret(input);
    if (!result.ok || this.mode !== 'on') return result;
    const row = await this.persist(result.tick);
    if (row) this.persisted += 1;
    return result;
  }

  /** Persist a canonical tick into the common normalized layer (one writer shape). */
  async persist(tick: CanonicalTick): Promise<UnifiedOptionQuote | null> {
    const input = canonicalToTickInput(tick);
    try {
      return tick.instrumentType === 'INDEX' || tick.instrumentType === 'EQUITY' || tick.optionType === null
        ? await this.unified.ingestSnapshot(input).then((row) => row as unknown as UnifiedOptionQuote | null)
        : await this.unified.ingestQuote(input);
    } catch (error) {
      this.logger.warn(`canonical persist failed for ${tick.instrumentKey}: ${(error as Error).message}`);
      return null;
    }
  }

  metrics(): InterpreterMetrics {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const at = (q: number): number | null => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null);
    return {
      mode: this.mode,
      accepted: this.accepted,
      rejected: this.rejected,
      persisted: this.persisted,
      rejectionsByCode: Object.fromEntries(this.rejectionsByCode),
      rejectionsBySource: Object.fromEntries(this.rejectionsBySource),
      latency: { samples: sorted.length, p50Ms: at(0.5), p95Ms: at(0.95), maxMs: sorted.at(-1) ?? null },
      latencyBudgetExceeded: this.latencyBudgetExceeded,
      lastSample: this.lastSample,
    };
  }

  resetMetrics(): void {
    this.accepted = 0;
    this.rejected = 0;
    this.persisted = 0;
    this.latencyBudgetExceeded = 0;
    this.rejectionsByCode.clear();
    this.rejectionsBySource.clear();
    this.latencies.length = 0;
    this.lastSample = null;
  }

  private record(result: InterpreterResult): InterpreterResult {
    if (result.ok) {
      this.accepted += 1;
      const lag = result.tick.sourceLagMs;
      if (lag !== null) {
        this.latencies.push(lag);
        if (this.latencies.length > this.maxLatencySamples) this.latencies.shift();
        if (!result.tick.latencyWithinBudget) this.latencyBudgetExceeded += 1;
      }
      this.lastSample = {
        source: result.tick.source, instrumentKey: result.tick.instrumentKey, lagMs: lag, accepted: true,
      };
      return result;
    }
    this.rejected += 1;
    this.rejectionsByCode.set(result.code, (this.rejectionsByCode.get(result.code) ?? 0) + 1);
    this.rejectionsBySource.set(result.source, (this.rejectionsBySource.get(result.source) ?? 0) + 1);
    this.lastSample = { source: result.source, instrumentKey: '', lagMs: null, accepted: false };
    return result;
  }
}

/**
 * Canonical tick → the common store's ingest shape. Pure, lossless for every
 * field the schema defines; nothing is defaulted (absent stays null so the store
 * records it as absent rather than as a fabricated 0).
 */
export function canonicalToTickInput(tick: CanonicalTick): Parameters<UnifiedMarketDataService['ingestQuote']>[0] {
  return {
    instrumentKey: tick.instrumentKey,
    underlying: tick.underlying,
    exchange: tick.exchange,
    segment: tick.segment,
    instrumentType: tick.instrumentType,
    expiry: tick.expiry,
    strike: tick.strike,
    optionType: tick.optionType,
    ltp: tick.ltp,
    bid: tick.bid,
    ask: tick.ask,
    bidQty: tick.bidQty,
    askQty: tick.askQty,
    volume: tick.volume,
    oi: tick.oi,
    previousOi: tick.previousOi,
    changeOi: tick.changeOi,
    iv: tick.iv,
    delta: tick.delta,
    gamma: tick.gamma,
    theta: tick.theta,
    vega: tick.vega,
    open: tick.open,
    high: tick.high,
    low: tick.low,
    close: tick.close,
    depth: { providerDepth: tick.depth, providerInstrumentId: tick.providerInstrumentId, payloadHash: tick.rawPayloadHash },
    source: tick.source,
    sourceTimestamp: tick.sourceTimestamp ?? tick.receivedTimestamp,
  };
}

/**
 * Common-store row → canonical tick, so desks read ONE canonical representation
 * with no broker-specific interpretation. The provider payload hash/id travel in
 * the stored depth payload; nothing is recomputed or invented on the way out.
 */
export function canonicalFromStoredQuote(row: {
  instrumentKey: string; source: string; ltp?: unknown; bid?: unknown; ask?: unknown;
  bidQty?: unknown; askQty?: unknown; volume?: unknown; oi?: unknown; previousOi?: unknown;
  changeOi?: unknown; iv?: unknown; delta?: unknown; gamma?: unknown; theta?: unknown; vega?: unknown;
  underlying?: string | null; exchange?: string | null; segment?: string | null; instrumentType?: string | null;
  expiry?: string | null; strike?: unknown; optionType?: string | null; sourceTimestamp?: Date | null;
  receivedTimestamp?: Date | null; sequenceNumber?: number | null; dataQuality?: string | null; depth?: unknown;
}): CanonicalTick {
  const num = (value: unknown): number | null => {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  const depth = (row.depth && typeof row.depth === 'object' ? (row.depth as Record<string, unknown>) : {}) as {
    providerDepth?: unknown; providerInstrumentId?: unknown; payloadHash?: unknown;
  };
  const sourceTimestamp = row.sourceTimestamp ?? null;
  const receivedTimestamp = row.receivedTimestamp ?? row.sourceTimestamp ?? new Date(0);
  const sourceLagMs = sourceTimestamp ? Math.max(0, receivedTimestamp.getTime() - sourceTimestamp.getTime()) : null;
  return {
    instrumentKey: row.instrumentKey,
    source: row.source,
    providerInstrumentId: String(depth.providerInstrumentId ?? row.instrumentKey),
    underlying: row.underlying ?? null,
    exchange: row.exchange ?? null,
    segment: row.segment ?? null,
    instrumentType: (String(row.instrumentType ?? '').toUpperCase().startsWith('OPT') ? 'OPTION' : 'UNKNOWN'),
    expiry: row.expiry ?? null,
    strike: num(row.strike),
    optionType: (String(row.optionType ?? '').toUpperCase() === 'CE' ? 'CE' : String(row.optionType ?? '').toUpperCase() === 'PE' ? 'PE' : null),
    ltp: num(row.ltp), bid: num(row.bid), ask: num(row.ask), bidQty: num(row.bidQty), askQty: num(row.askQty),
    volume: num(row.volume), oi: num(row.oi), previousOi: num(row.previousOi), changeOi: num(row.changeOi),
    iv: num(row.iv), delta: num(row.delta), gamma: num(row.gamma), theta: num(row.theta), vega: num(row.vega),
    open: null, high: null, low: null, close: null,
    depth: depth.providerDepth ?? null,
    sourceTimestamp,
    sourceTimestampKind: 'QUOTE',
    receivedTimestamp,
    sourceLagMs,
    latencyWithinBudget: sourceLagMs === null || sourceLagMs <= 5_000,
    dataQuality: String(row.dataQuality ?? 'GOOD') === 'STALE' ? 'STALE' : 'GOOD',
    raw: null,
    rawPayloadHash: String(depth.payloadHash ?? ''),
  };
}
