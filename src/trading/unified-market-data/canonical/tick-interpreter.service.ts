import { Injectable, Logger } from '@nestjs/common';
import { UnifiedMarketDataService, UnifiedTickInput } from '../unified-market-data.service';
import { UnifiedOptionQuote } from '../unified-option-quote.entity';
import {
  CanonicalTick,
  InterpreterResult,
  TickBudgets,
  TickIgnored,
  TickRejection,
  budgetsFromEnv,
  interpretObservation,
} from './canonical-tick';
import { MapperContext, MapperIdentity, envelopeFor, mapperFor } from './provider-mappers';

/**
 * THE canonical market-data pipeline stage — mandatory, with no operating mode.
 *
 *   provider raw payload -> provider adapter (provider-mappers)
 *     -> deterministic interpreter (validation, canonical identity/units/timestamps)
 *     -> canonical persistence (the COMMON store)
 *     -> desk/engine consumption
 *
 * There is no `off`/`shadow`/`on` switch: every live payload goes through the
 * interpreter, and what passes validation is persisted in canonical form. A
 * record that FAILS validation is counted, dropped and logged — it is never
 * repaired and never handed to broker-specific logic as a fallback, so a desk can
 * only ever consume canonical, validated data.
 *
 * Interpretation is pure and deterministic: same payload + same receive time ⇒
 * same canonical tick or the same rejection. No AI, no heuristics, no clock
 * dependence beyond the injected receive time.
 *
 * An internal measurement facility (metrics()) is kept for diagnostics/observability
 * and has ZERO effect on production behaviour — it is not a mode and not a gate.
 */
export type InterpreterMetrics = {
  accepted: number;
  rejected: number;
  persisted: number;
  /** Validated ticks the producer's OWN gate declined (arbitration ownership, snapshot throttle). */
  withheld: number;
  /** Provider control/ack records: not ticks, neither rejected nor persisted. */
  ignored: number;
  rejectionsByCode: Record<string, number>;
  rejectionsBySource: Record<string, number>;
  latency: { samples: number; p50Ms: number | null; p95Ms: number | null; maxMs: number | null };
  latencyBudgetExceeded: number;
  /** Streaming back-pressure: messages the bounded queue could not hold (ABSENT, never fabricated). */
  droppedUnderLoad: number;
  ingestQueueDepth: number;
  ingestInFlight: number;
  lastSample: { source: string; instrumentKey: string; lagMs: number | null; accepted: boolean } | null;
};

/** Deterministic token/key → symbol resolver (see MapperContext). */
export type ResolveSymbol = NonNullable<MapperContext['resolveSymbol']>;

/** Positive integer env override, falling back to the documented default. */
const envInt = (name: string, fallback: number): number => {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : fallback;
};

export type InterpretAndPersistInput = {
  source: string;
  payload: unknown;
  receivedAt?: Date;
  /** Deterministic token → symbol resolution for brokers whose ticks carry only a token. */
  resolveSymbol?: ResolveSymbol;
  /** Identity the adapter already knows from the same provider response (see MapperIdentity). */
  identity?: MapperIdentity;
};

export type IngestOptions = {
  receivedAt?: Date;
  resolveSymbol?: ResolveSymbol;
  identity?: MapperIdentity;
  /**
   * The producer's own publication gate, applied AFTER validation and BEFORE
   * persistence: arbitration ownership (never price an instrument another feed
   * owns) and the existing per-instrument snapshot throttle. A tick the gate
   * declines is counted as `withheld` — it is valid data this feed chose not to
   * publish, not a rejection.
   */
  allowPublish?: (tick: CanonicalTick) => boolean;
};

export type IngestOutcome = {
  accepted: number;
  rejected: number;
  persisted: number;
  withheld: number;
  /** Records that were not ticks at all (provider control/ack/heartbeat). */
  ignored: number;
  rejections: TickRejection[];
};

@Injectable()
export class TickInterpreterService {
  private readonly logger = new Logger(TickInterpreterService.name);
  private readonly budgets: TickBudgets;

  private accepted = 0;
  private rejected = 0;
  private persisted = 0;
  private withheld = 0;
  private ignored = 0;
  private latencyBudgetExceeded = 0;
  private readonly rejectionsByCode = new Map<string, number>();
  private readonly rejectionsBySource = new Map<string, number>();
  private readonly latencies: number[] = [];
  private lastSample: InterpreterMetrics['lastSample'] = null;
  private readonly maxLatencySamples = 1_000;
  /** Bound on records interpreted from ONE provider message (a malformed payload cannot loop). */
  private readonly maxRecordsPerMessage = 500;
  /** Rejection warnings are throttled: a bad burst must not flood the log. */
  private lastRejectWarnAt = 0;

  /**
   * ── Bounded ingest queue (stream back-pressure) ──────────────────────────────
   * A fire-and-forget feed handed the interpreter one independent async chain per
   * provider message, each awaiting a WAN write, with NOTHING bounding how many
   * were in flight: writes piled up without limit and the shared tape fell minutes
   * behind the market and never recovered. The queue caps concurrency AND depth,
   * so a fast provider cannot spawn unbounded work.
   *
   * A message the queue cannot hold is DROPPED AND COUNTED — never silently, never
   * repaired, never fabricated. The observation simply never enters the store, and
   * `droppedUnderLoad` says exactly how many; absence stays absence.
   */
  private readonly ingestQueue: Array<{ source: string; payload: unknown; opts: IngestOptions }> = [];
  private ingestInFlight = 0;
  private readonly maxIngestInFlight = envInt('CANONICAL_MAX_INGEST_INFLIGHT', 12);
  private readonly maxIngestQueue = envInt('CANONICAL_MAX_INGEST_QUEUE', 5_000);
  private droppedUnderLoad = 0;

  constructor(private readonly unified: UnifiedMarketDataService) {
    this.budgets = budgetsFromEnv();
  }

  /**
   * Interpret one provider payload. Pure w.r.t. everything except receivedAt.
   * Metrics are collected as a side effect; nothing is ever persisted here.
   */
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
    const ctx: MapperContext = { receivedAt, resolveSymbol: input.resolveSymbol, identity: input.identity };
    const mapped = mapper(input.payload, ctx);
    if (!mapped.ok) {
      const source = String(input.source).toUpperCase();
      // A control/ack record is not market data: ignored, not counted as invalid.
      if (mapped.skip) return this.recordIgnored(source, mapped.reason);
      return this.record({ ok: false, code: 'SCHEMA', reason: mapped.reason, source });
    }
    return this.record(interpretObservation(input.source, mapped.observation, receivedAt, this.budgets));
  }

  /**
   * Interpret one provider payload and persist the canonical tick. This is the
   * production entry point for a single-record payload: validation decides, and a
   * rejection stops here (dropped + counted, never routed anywhere else).
   */
  async interpretAndPersist(input: InterpretAndPersistInput): Promise<InterpreterResult> {
    const result = this.interpret(input);
    if (!result.ok) return result;
    await this.persist(result.tick);
    return result;
  }

  /**
   * Interpret a WHOLE provider message (an envelope may carry many records) and
   * persist every tick that passes validation and the producer's gate.
   *
   * Never throws: a provider payload must not be able to break a feed loop. The
   * outcome reports exactly what happened per record so adapters can surface it.
   */
  async ingestMessage(source: string, payload: unknown, opts: IngestOptions = {}): Promise<IngestOutcome> {
    const receivedAt = opts.receivedAt ?? new Date();
    const outcome: IngestOutcome = { accepted: 0, rejected: 0, persisted: 0, withheld: 0, ignored: 0, rejections: [] };
    const publishable: CanonicalTick[] = [];
    let records: unknown[];
    try {
      records = envelopeFor(source)(payload).slice(0, this.maxRecordsPerMessage);
    } catch (error) {
      this.logger.warn(`canonical envelope failed for ${source}: ${(error as Error).message}`);
      return outcome;
    }
    for (const record of records) {
      const result = this.interpret({ source, payload: record, receivedAt, resolveSymbol: opts.resolveSymbol, identity: opts.identity });
      if (!result.ok) {
        // A provider control/ack record is not market data: ignored, never counted
        // as invalid and never persisted.
        if ('skipped' in result) {
          outcome.ignored += 1;
          continue;
        }
        outcome.rejected += 1;
        outcome.rejections.push(result);
        this.warnRejection(result);
        continue;
      }
      outcome.accepted += 1;
      if (opts.allowPublish && !opts.allowPublish(result.tick)) {
        this.withheld += 1;
        outcome.withheld += 1;
        continue;
      }
      publishable.push(result.tick);
    }
    // ONE batched write for every tick of this message (see persistMany).
    outcome.persisted += await this.persistMany(publishable);
    return outcome;
  }

  /**
   * Persist every canonical tick of ONE provider message in a single batched write.
   *
   * The tape is a real-time stream: a per-record awaited write costs one Oracle
   * Cloud round trip each, and a fire-and-forget feed let those writes pile up
   * unbounded — the shared tape then fell behind the market and never caught up.
   * Batching changes only the TRANSPORT: same validation, identity, units,
   * absence-preserving nulls, provenance and write-behind cache.
   */
  async persistMany(ticks: CanonicalTick[]): Promise<number> {
    if (!ticks.length) return 0;
    const quoteInputs: UnifiedTickInput[] = [];
    const snapshotInputs: UnifiedTickInput[] = [];
    for (const tick of ticks) {
      const input = canonicalToTickInput(tick);
      if (tick.instrumentType === 'INDEX' || tick.instrumentType === 'EQUITY' || tick.optionType === null) snapshotInputs.push(input);
      else quoteInputs.push(input);
    }
    try {
      const [quotes, snapshots] = await Promise.all([this.unified.ingestQuotes(quoteInputs), this.unified.ingestSnapshots(snapshotInputs)]);
      const written = quotes.filter((row) => row !== null).length + snapshots.filter((row) => row !== null).length;
      if (written) this.persisted += written;
      return written;
    } catch (error) {
      this.logger.warn(`canonical batch persist failed for ${ticks.length} tick(s): ${(error as Error).message}`);
      return 0;
    }
  }

  /**
   * Back-pressured sibling of ingestMessage for a STREAMING feed: the message joins
   * a bounded queue drained at a capped concurrency, so a fast provider can never
   * spawn unbounded concurrent writes. Returns false when the queue is full — the
   * message is then dropped and counted, never silently absorbed and never faked.
   */
  enqueueMessage(source: string, payload: unknown, opts: IngestOptions = {}): boolean {
    if (this.ingestQueue.length >= this.maxIngestQueue) {
      this.droppedUnderLoad += 1;
      if (this.droppedUnderLoad === 1 || this.droppedUnderLoad % 500 === 0) {
        this.logger.warn(
          `canonical ingest queue full (depth ${this.ingestQueue.length}, in flight ${this.ingestInFlight}); ` +
            `dropped ${this.droppedUnderLoad} message(s) under load — the observation is ABSENT in the store, never fabricated`,
        );
      }
      return false;
    }
    this.ingestQueue.push({ source, payload, opts });
    this.drainIngestQueue();
    return true;
  }

  private drainIngestQueue(): void {
    while (this.ingestInFlight < this.maxIngestInFlight && this.ingestQueue.length) {
      const job = this.ingestQueue.shift()!;
      this.ingestInFlight += 1;
      void this.ingestMessage(job.source, job.payload, job.opts)
        .catch((error: unknown) => this.logger.warn(`canonical ingest failed for ${job.source}: ${(error as Error).message}`))
        .finally(() => {
          this.ingestInFlight -= 1;
          this.drainIngestQueue();
        });
    }
  }

  /** Persist a canonical tick into the common normalized layer (one writer shape). */
  async persist(tick: CanonicalTick): Promise<UnifiedOptionQuote | null> {
    const input = canonicalToTickInput(tick);
    try {
      const row =
        tick.instrumentType === 'INDEX' || tick.instrumentType === 'EQUITY' || tick.optionType === null
          ? await this.unified.ingestSnapshot(input).then((saved) => saved as unknown as UnifiedOptionQuote | null)
          : await this.unified.ingestQuote(input);
      if (row) this.persisted += 1;
      return row;
    } catch (error) {
      this.logger.warn(`canonical persist failed for ${tick.instrumentKey}: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * One warning per minute for the first rejection of each (code, source) pair,
   * so a systematically bad provider is visible without flooding the log.
   */
  private warnRejection(rejection: TickRejection): void {
    const code = rejection.code;
    const seen = (this.rejectionsByCode.get(code) ?? 0) + (this.rejectionsBySource.get(rejection.source) ?? 0);
    const now = Date.now();
    if (seen > 1 && now - this.lastRejectWarnAt < 60_000) return;
    this.lastRejectWarnAt = now;
    this.logger.warn(`canonical ${code} from ${rejection.source}: ${rejection.reason}`);
  }

  /** Internal diagnostic measurement — never gates, never writes, never repairs. */
  metrics(): InterpreterMetrics {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const at = (q: number): number | null => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null);
    return {
      accepted: this.accepted,
      rejected: this.rejected,
      persisted: this.persisted,
      withheld: this.withheld,
      ignored: this.ignored,
      rejectionsByCode: Object.fromEntries(this.rejectionsByCode),
      rejectionsBySource: Object.fromEntries(this.rejectionsBySource),
      latency: { samples: sorted.length, p50Ms: at(0.5), p95Ms: at(0.95), maxMs: sorted.at(-1) ?? null },
      latencyBudgetExceeded: this.latencyBudgetExceeded,
      droppedUnderLoad: this.droppedUnderLoad,
      ingestQueueDepth: this.ingestQueue.length,
      ingestInFlight: this.ingestInFlight,
      lastSample: this.lastSample,
    };
  }

  resetMetrics(): void {
    this.accepted = 0;
    this.rejected = 0;
    this.persisted = 0;
    this.withheld = 0;
    this.ignored = 0;
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
    // Ignored records are counted by recordIgnored(); they are not rejections.
    if ('skipped' in result) return result;
    this.rejected += 1;
    this.rejectionsByCode.set(result.code, (this.rejectionsByCode.get(result.code) ?? 0) + 1);
    this.rejectionsBySource.set(result.source, (this.rejectionsBySource.get(result.source) ?? 0) + 1);
    this.lastSample = { source: result.source, instrumentKey: '', lagMs: null, accepted: false };
    return result;
  }

  /** A provider control/ack record: not a tick, not a rejection, never persisted. */
  private recordIgnored(source: string, reason: string): TickIgnored {
    this.ignored += 1;
    return { ok: false, skipped: true, reason, source };
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
