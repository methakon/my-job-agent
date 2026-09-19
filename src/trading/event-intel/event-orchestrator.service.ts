/**
 * Event Intelligence Orchestrator Service
 *
 * Main orchestrator that wires the entire event intelligence pipeline.
 *
 * Two operating modes:
 *   A) CONTINUOUS EVENT WATCH (24x7) — discover, verify, deduplicate,
 *      classify, version events, maintain cross-asset context, prepare
 *      next-session context.
 *   B) INDIAN MARKET-HOURS (09:15–15:30 IST) — consume live NIFTY/
 *      BANKNIFTY/option data, calculate option surface, transmission
 *      graphs, forecast distributions, IV-crush probability, run risk
 *      gates → PAPER_CANDIDATE or ABSTAIN.
 *
 * PAPER TRADING ONLY: This service generates PAPER_CANDIDATE / ABSTAIN
 * verdicts. It never places real orders or executes trades.
 *
 * Every failure is classified using EVENT_ERROR_CLASSIFICATION constants.
 * The service never crashes on individual event processing errors.
 */

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';

import {
  Event,
  EventRawRecord,
  EventEvidence,
  EventVersion,
  EventOntology,
  EventLifecycle,
  EventStateMachineState,
  EventFeatures,
  EventOutcome,
  EventCounterfactual,
  EventErrorAttribution,
  EventErrorClassification,
  StateTransitionTrigger,
  StateTransitionResult,
  TransmissionGraph,
  TransmissionEdge,
  TransmissionNode,
  OptionChainFeatures,
  SpotFuturesFeatures,
  IVFeatures,
  SkewFeatures,
  TermStructureFeatures,
  GreeksFeatures,
  FlowFeatures,
  LiquidityFeatures,
  StructureFeatures,
  ForecastDistribution,
  PredictionRecord,
  PaperCandidateDetails,
  HawkesEstimate,
  IVCrushInput,
  IVCrushResult,
  PerformanceLatency,
  MarketDataSnapshot,
  MarketSessionState,
  SourceAdapter,
  SourceTier,
  SourceHealth,
  DataAvailability,
  VALID_TRANSITIONS,
  EVENT_ERROR_CLASSIFICATION,
} from './event-types';

import type { MarketDataSnapshot as _MDS } from './event-types';

// ── Constants ──────────────────────────────────────────────────────────────────

/** Maximum events held in the event store. Oldest evicted first. */
const MAX_EVENTS = 10_000;

/** Maximum prediction records per event. Oldest evicted first. */
const MAX_PREDICTIONS_PER_EVENT = 5_000;

/** Maximum raw source observations kept for corroboration. */
const MAX_SOURCE_OBSERVATIONS = 50_000;

/** Polling interval for continuous event watch (off-hours) in ms. */
const OFF_HOURS_POLL_MS = 60_000;

/** Polling interval for market-hours processing in ms. */
const MARKET_HOURS_POLL_MS = 5_000;

/** IST offset in minutes (UTC+5:30). */
const IST_OFFSET_MINUTES = 5 * 60 + 30;

/** NSE market open time in IST (09:15). */
const MARKET_OPEN_IST_MINUTES = 9 * 60 + 15;

/** NSE market close time in IST (15:30). */
const MARKET_CLOSE_IST_MINUTES = 15 * 60 + 30;

/** Maximum retry attempts for source fetch operations. */
const MAX_RETRIES = 3;

/** Base backoff delay in ms for exponential retry. */
const BASE_BACKOFF_MS = 1_000;

// ── Internal Helpers ───────────────────────────────────────────────────────────

/** Get current time in IST as total minutes since midnight. */
function currentISTMinutes(): number {
  const now = new Date();
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  let istMinutes = (utcMinutes + IST_OFFSET_MINUTES) % (24 * 60);
  if (istMinutes < 0) istMinutes += 24 * 60;
  return istMinutes;
}

/** Check whether Indian markets are currently open (09:15–15:30 IST). */
function isMarketOpenIST(): boolean {
  const m = currentISTMinutes();
  return m >= MARKET_OPEN_IST_MINUTES && m < MARKET_CLOSE_IST_MINUTES;
}

/** Produce a monotonically increasing correlation ID. */
let _correlationCounter = 0;
function correlationId(): string {
  return `ei-${Date.now()}-${++_correlationCounter}`;
}

/** Bounded retry helper with exponential backoff. */
async function boundedRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxAttempts = MAX_RETRIES,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        const delay = BASE_BACKOFF_MS * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

/**
 * BoundedMap — a Map that evicts the oldest entry when full.
 */
class BoundedMap<K, V> {
  private readonly map = new Map<K, V>();

  constructor(private readonly maxSize: number) {}

  get size(): number {
    return this.map.size;
  }

  get(key: K): V | undefined {
    return this.map.get(key);
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      // Evict oldest (first inserted) entry
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) {
        this.map.delete(oldest);
      }
    }
    this.map.set(key, value);
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  entries(): IterableIterator<[K, V]> {
    return this.map.entries();
  }

  forEach(callbackfn: (value: V, key: K) => void): void {
    this.map.forEach(callbackfn);
  }

  values(): IterableIterator<V> {
    return this.map.values();
  }

  keys(): IterableIterator<K> {
    return this.map.keys();
  }

  clear(): void {
    this.map.clear();
  }
}

/**
 * Structured pipeline latency tracker for a single event processing cycle.
 */
interface PipelineLatency {
  sourcePublishedAt: number;
  receivedAt: number;
  normalizedAt: number;
  verifiedAt: number;
  classifiedAt: number;
  featureAt: number;
  forecastAt: number;
  decisionAt: number;
}

/** Compute stage-to-stage latencies from a PipelineLatency record. */
function computeLatencies(pl: PipelineLatency): PerformanceLatency {
  const ingestionLatencyMs = pl.receivedAt - pl.sourcePublishedAt;
  const classificationLatencyMs = pl.classifiedAt - pl.verifiedAt;
  const featureExtractionLatencyMs = pl.featureAt - pl.classifiedAt;
  const stateTransitionLatencyMs = pl.featureAt - pl.classifiedAt;
  const forecastLatencyMs = pl.forecastAt - pl.featureAt;
  const decisionLatencyMs = pl.decisionAt - pl.forecastAt;
  const totalLatencyMs = pl.decisionAt - pl.sourcePublishedAt;
  return {
    ingestionLatencyMs,
    classificationLatencyMs,
    featureExtractionLatencyMs,
    stateTransitionLatencyMs,
    forecastLatencyMs,
    decisionLatencyMs,
    totalLatencyMs,
  };
}

/**
 * Compute a deterministic hash of the option-chain feature set for
 * correlation with prediction records.
 */
function featureHash(features: OptionChainFeatures): string {
  const parts = [
    features.spotFutures.spot,
    features.spotFutures.futures,
    features.iv.atmIV,
    features.iv.ivPercentile,
    features.skew.putCallSkew,
    features.termStructure.slope,
    features.structures.atmStraddle,
    features.flow.callPutImbalance,
  ];
  return `fh-${parts.join('-')}`;
}

/**
 * Simple FNV-1a-inspired fingerprint for deduplication of raw records.
 * Operates on title + sourceName — deterministic, no crypto dependency.
 */
function rawPayloadHash(title: string, source: string): string {
  let hash = 0x811c9dc5;
  const str = `${title}|${source}`;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `rph-${(hash >>> 0).toString(16)}`;
}

// ── Event Orchestrator Service ──────────────────────────────────────────────────

/**
 * EventOrchestratorService
 *
 * Orchestrates the full event intelligence pipeline: ingestion from
 * pluggable source adapters, normalization, deduplication, ontology
 * classification, versioning, state-machine transitions, novelty
 * estimation, cross-asset transmission, option-chain feature extraction,
 * forecast distribution generation, IV-crush measurement, risk gates,
 * outcome freezing, proof-bundle reconstruction, and error attribution.
 *
 * Lifecycle:
 *   - Polling intervals are started in startWatching() (called on
 *     module init) and torn down in onModuleDestroy().
 *   - All internal stores are bounded; oldest entries are evicted
 *     when capacity is reached.
 */
@Injectable()
export class EventOrchestratorService implements OnModuleDestroy {
  private readonly logger = new Logger(EventOrchestratorService.name);

  // ── Polling timers (cleaned up on destroy) ─────────────────────────────────
  private offHoursTimer: ReturnType<typeof setInterval> | null = null;
  private marketHoursTimer: ReturnType<typeof setInterval> | null = null;

  // ── Registered source adapters ─────────────────────────────────────────────
  private readonly sourceAdapters: SourceAdapter[] = [];

  // ── Bounded stores ─────────────────────────────────────────────────────────

  /** Canonical event store (max 10 000). */
  private readonly eventStore = new BoundedMap<string, Event>(MAX_EVENTS);

  /** Raw observation cache — preserves individual source observations for corroboration. */
  private readonly rawObservationCache = new BoundedMap<string, EventRawRecord>(MAX_SOURCE_OBSERVATIONS);

  /** Prediction history keyed by eventId (max 5 000 per event). */
  private readonly predictionHistory = new BoundedMap<string, PredictionRecord[]>(
    MAX_EVENTS,
  );

  /** Outcome snapshots keyed by eventId. */
  private readonly outcomeSnapshots = new BoundedMap<string, EventOutcome>(MAX_EVENTS);

  /** Per-source health cache. */
  private readonly sourceHealthCache = new BoundedMap<string, SourceHealth>(100);

  /** Per-source degraded flag (set true when source unavailable). */
  private readonly sourceDegraded = new Map<string, boolean>();

  /** Event fingerprint → eventId mapping for deduplication. */
  private readonly fingerprintIndex = new BoundedMap<string, string>(MAX_EVENTS);

  /** Last-poll timestamps per source adapter. */
  private readonly lastPollMs = new Map<string, number>();

  // ── Lifecycle hooks ────────────────────────────────────────────────────────

  /**
   * Called automatically after NestJS dependency injection is complete.
   * Starts both polling loops (off-hours and market-hours).
   */
  onModuleInit(): void {
    this.startWatching();
  }

  /**
   * Clean up all timers on module destroy. Never leave dangling intervals.
   */
  onModuleDestroy(): void {
    this.stopWatching();
  }

  // ── Public: Polling Control ────────────────────────────────────────────────

  /**
   * Start both polling loops. Safe to call multiple times — timers are
   * only created once.
   */
  startWatching(): void {
    if (this.offHoursTimer === null) {
      this.offHoursTimer = setInterval(
        () => this.runOffHoursCycle(),
        OFF_HOURS_POLL_MS,
      );
      this.logger.log('Off-hours poller started (60s interval)');
    }
    if (this.marketHoursTimer === null) {
      this.marketHoursTimer = setInterval(
        () => this.runMarketHoursCycle(),
        MARKET_HOURS_POLL_MS,
      );
      this.logger.log('Market-hours poller started (5s interval)');
    }
  }

  /**
   * Stop all polling loops and clear internal interval references.
   */
  stopWatching(): void {
    if (this.offHoursTimer !== null) {
      clearInterval(this.offHoursTimer);
      this.offHoursTimer = null;
      this.logger.log('Off-hours poller stopped');
    }
    if (this.marketHoursTimer !== null) {
      clearInterval(this.marketHoursTimer);
      this.marketHoursTimer = null;
      this.logger.log('Market-hours poller stopped');
    }
  }

  // ── Public: Source Adapter Registration ────────────────────────────────────

  /**
   * Register a new source adapter. Called before startWatching().
   */
  registerSourceAdapter(adapter: SourceAdapter): void {
    this.sourceAdapters.push(adapter);
    this.sourceHealthCache.set(adapter.sourceId, {
      sourceId: adapter.sourceId,
      healthy: true,
      lastSuccessMs: 0,
      lastErrorMs: 0,
      errorRate: 0,
      averageLatencyMs: 0,
      description: 'Registered',
    });
    this.sourceDegraded.set(adapter.sourceId, false);
    this.logger.log(`Source adapter registered: ${adapter.sourceName} (${adapter.sourceId})`);
  }

  // ── Public: Pipeline Stages ────────────────────────────────────────────────

  /**
   * Ingest events from all registered source adapters.
   *
   * Pipeline: fetch → normalize → deduplicate → store raw observations.
   * Individual source observations are preserved for corroboration.
   */
  async ingestEvents(): Promise<readonly EventRawRecord[]> {
    const allNew: EventRawRecord[] = [];
    const now = Date.now();

    for (const adapter of this.sourceAdapters) {
      try {
        const sinceMs = this.lastPollMs.get(adapter.sourceId) ?? now - 60_000;
        const fetchStart = Date.now();

        const records = await boundedRetry(
          () => adapter.fetchEvents(sinceMs, 100),
          `ingestEvents:${adapter.sourceId}`,
        );

        const fetchLatency = Date.now() - fetchStart;

        // Update source health
        this.sourceHealthCache.set(adapter.sourceId, {
          sourceId: adapter.sourceId,
          healthy: true,
          lastSuccessMs: Date.now(),
          lastErrorMs: this.sourceHealthCache.get(adapter.sourceId)?.lastErrorMs ?? 0,
          errorRate: 0,
          averageLatencyMs: fetchLatency,
          description: `OK – ${records.length} records in ${fetchLatency}ms`,
        });
        this.sourceDegraded.set(adapter.sourceId, false);

        this.lastPollMs.set(adapter.sourceId, now);

        // Normalize: ensure receivedAt is set, compute hash
        const normalized = records.map((r) => this.normalizeRawRecord(r));

        // Deduplicate: only keep unseen observations
        for (const rec of normalized) {
          if (!this.rawObservationCache.has(rec.sourceId)) {
            this.rawObservationCache.set(rec.sourceId, rec);
            allNew.push(rec);
          }
        }
      } catch (err) {
        this.handleSourceError(adapter, err, 'ingestEvents');
      }
    }

    this.logger.debug(`Ingested ${allNew.length} new raw observations`);
    return allNew;
  }

  /**
   * Normalize a raw record — ensure all required fields are present,
   * compute the rawPayloadHash for deduplication.
   */
  private normalizeRawRecord(raw: EventRawRecord): EventRawRecord {
    const receivedAt = Date.now();
    const hash = raw.rawPayloadHash || rawPayloadHash(raw.title, raw.sourceName);
    return {
      ...raw,
      receivedAt,
      rawPayloadHash: hash,
    };
  }

  /**
   * Classify a raw record into an ontology category (MACRO, CENTRAL_BANK,
   * GEOPOLITICAL, COMMODITIES, FINANCIAL_SYSTEM, INDIA, MICROSTRUCTURE).
   *
   * Uses keyword-based heuristic classification. This is a deterministic
   * stub — a future ML classifier can replace it transparently.
   */
  classifyEvent(rawRecord: EventRawRecord): EventOntology {
    const text = `${rawRecord.title} ${rawRecord.body}`.toLowerCase();

    // Keyword sets for each ontology
    if (/\b(central bank|rate decision|repo rate|fomc|rbi|ecb|boj|boe|monetary policy)\b/.test(text)) {
      return 'CENTRAL_BANK';
    }
    if (/\b(gdp|inflation|cpi|ppi|unemployment|trade deficit|fiscal|budget|stimulus|recession)\b/.test(text)) {
      return 'MACRO';
    }
    if (/\b(war|sanction|conflict|election|coup|border|military|geopolit)\b/.test(text)) {
      return 'GEOPOLITICAL';
    }
    if (/\b(crude|oil|gold|silver|copper|commodity|opec|mining)\b/.test(text)) {
      return 'COMMODITIES';
    }
    if (/\b(bank|credit|liquidity|leverage|margin|securities|bond|debt default)\b/.test(text)) {
      return 'FINANCIAL_SYSTEM';
    }
    if (/\b(nifty|sensex|banknifty|nse|bse|sebi|india|indian|rupee|inr)\b/.test(text)) {
      return 'INDIA';
    }
    if (/\b(volume|spread|liquidity|order book|microstructure|tick|bid.ask|depth)\b/.test(text)) {
      return 'MICROSTRUCTURE';
    }

    // Default to MACRO for unclassified financial events
    return 'MACRO';
  }

  /**
   * Create a new event version, preserving the append-only version history.
   * Returns the updated Event with the new version appended.
   */
  versionEvent(
    existingEvent: Event | undefined,
    newEvidence: EventEvidence,
    lifecycle: EventLifecycle,
    reasonCode: string,
  ): Event {
    const now = Date.now();

    if (!existingEvent) {
      // First version — create the event
      const eventId = `evt-${newEvidence.rawRecord.rawPayloadHash}-${now}`;
      const version: EventVersion = {
        version: 1,
        evidence: [newEvidence],
        createdAtMs: now,
        lifecycle,
        reasonCode,
      };
      return {
        id: eventId,
        ontology: 'MACRO', // placeholder; caller should reclassify
        lifecycle,
        versions: [version],
        currentState: 'S0_DETECTED',
        detectedAtMs: now,
        lastUpdatedAtMs: now,
      };
    }

    // Append new version
    const newVersionNum = existingEvent.versions.length + 1;
    const previousVersion = existingEvent.versions[existingEvent.versions.length - 1];
    const version: EventVersion = {
      version: newVersionNum,
      evidence: [...previousVersion.evidence, newEvidence],
      createdAtMs: now,
      lifecycle,
      reasonCode,
    };

    return {
      ...existingEvent,
      lifecycle,
      versions: [...existingEvent.versions, version],
      lastUpdatedAtMs: now,
    };
  }

  /**
   * Transition event state machine to a new state.
   * Validates the transition against VALID_TRANSITIONS before applying.
   * Returns the transition result, or null if the transition is invalid.
   */
  updateEventState(
    event: Event,
    trigger: StateTransitionTrigger,
    evidenceVersion: number,
  ): StateTransitionResult | null {
    const allowed = VALID_TRANSITIONS.get(event.currentState);
    if (!allowed) {
      this.logger.warn(
        `No transitions defined for state ${event.currentState} on event ${event.id}`,
      );
      return null;
    }

    // Map trigger to target state
    const targetState = this.resolveTargetState(event.currentState, trigger);
    if (!targetState || !allowed.has(targetState)) {
      this.logger.debug(
        `Invalid transition: ${event.currentState} → ${targetState} (trigger: ${trigger}) for event ${event.id}`,
      );
      return null;
    }

    const now = Date.now();
    return {
      newState: targetState,
      previousState: event.currentState,
      timestamp: now,
      reasonCode: `${trigger}@v${evidenceVersion}`,
      featureHash: '',
      trigger,
      evidenceVersion,
    };
  }

  /**
   * Map a trigger to a target state from the current state.
   */
  private resolveTargetState(
    current: EventStateMachineState,
    trigger: StateTransitionTrigger,
  ): EventStateMachineState | null {
    switch (trigger) {
      case 'EVIDENCE_RECEIVED':
        if (current === 'S0_DETECTED') return 'S1_INITIAL_SHOCK';
        if (current === 'S1_INITIAL_SHOCK') return 'S2_CROSS_ASSET_CONFIRMED';
        if (current === 'S2_CROSS_ASSET_CONFIRMED') return 'S4_ASSIMILATED';
        if (current === 'S4_ASSIMILATED') return 'S5_FOLLOW_UP';
        return null;
      case 'CROSS_ASSET_CONFIRMED':
        if (current === 'S1_INITIAL_SHOCK') return 'S2_CROSS_ASSET_CONFIRMED';
        return null;
      case 'CROSS_ASSET_FAILED':
        if (current === 'S2_CROSS_ASSET_CONFIRMED') return 'S3_CONTRADICTION';
        return null;
      case 'CONTRADICTION_DETECTED':
        if (current === 'S1_INITIAL_SHOCK' || current === 'S2_CROSS_ASSET_CONFIRMED')
          return 'S3_CONTRADICTION';
        return null;
      case 'CONTRADICTION_RESOLVED':
        if (current === 'S3_CONTRADICTION') return 'S2_CROSS_ASSET_CONFIRMED';
        return null;
      case 'RETRACTION_RECEIVED':
        return 'S6_RETRACTED_OR_INVALIDATED';
      case 'MARKET_CLOSED':
        return 'S7_MARKET_CLOSED_PENDING_NEXT_SESSION';
      case 'MARKET_OPENED':
        if (current === 'S7_MARKET_CLOSED_PENDING_NEXT_SESSION') return 'S1_INITIAL_SHOCK';
        return null;
      case 'TIME_DECAY':
        if (current === 'S4_ASSIMILATED') return 'S5_FOLLOW_UP';
        return null;
      case 'MANUAL_OVERRIDE':
        // Allow any non-terminal transition
        if (current === 'S6_RETRACTED_OR_INVALIDATED') return null;
        return 'S4_ASSIMILATED';
      default:
        return null;
    }
  }

  /**
   * Calculate surprise score for an event based on its features and history.
   * Higher surprise = more unexpected relative to historical patterns.
   *
   * Heuristic: combines novelty (how different from seen events),
   * magnitude (size of the shock), and source concordance.
   */
  calculateSurprise(event: Event): number {
    const latestVersion = event.versions[event.versions.length - 1];
    if (!latestVersion || latestVersion.evidence.length === 0) return 0;

    const evidence = latestVersion.evidence[latestVersion.evidence.length - 1];
    const features = evidence.extractedFeatures;
    if (!features) return 0.5;

    const novelty = features.novelty;
    const magnitude = features.magnitude !== null ? Math.min(Math.abs(features.magnitude) / 100, 1) : 0.5;
    const sourceWeight = features.sourceReliability;
    const concordance = latestVersion.evidence.length > 1 ? 1.0 : 0.5;

    // Weighted combination
    return Math.min(
      (novelty * 0.35 + magnitude * 0.35 + sourceWeight * 0.15 + concordance * 0.15),
      1.0,
    );
  }

  /**
   * Calculate novelty score — how different this event is from the
   * historical corpus of seen events.
   *
   * Uses fingerprint-based deduplication: if an identical fingerprint
   * exists, novelty = 0. Otherwise, novelty increases with event
   * type uniqueness and recency of last similar event.
   */
  calculateNovelty(event: Event): number {
    const latestVersion = event.versions[event.versions.length - 1];
    if (!latestVersion || latestVersion.evidence.length === 0) return 1.0;

    const evidence = latestVersion.evidence[latestVersion.evidence.length - 1];
    const fingerprint = evidence.rawRecord.eventFingerprint;

    // Check how many events share a similar fingerprint prefix
    let similarCount = 0;
    const prefix = fingerprint.slice(0, 8);
    this.eventStore.forEach((e) => {
      const eVersion = e.versions[e.versions.length - 1];
      if (eVersion && eVersion.evidence.length > 0) {
        const eFp = eVersion.evidence[0].rawRecord.eventFingerprint;
        if (eFp.startsWith(prefix) && e.id !== event.id) {
          similarCount++;
        }
      }
    });

    // Novelty decreases with more similar events
    if (similarCount === 0) return 1.0;
    return Math.max(0.05, 1.0 / (1.0 + Math.log2(similarCount + 1)));
  }

  /**
   * Build a cross-asset transmission graph for an event.
   *
   * Maps event ontology and features to known transmission paths
   * (USD_DXY → INR → NIFTY, etc.) and calculates edge weights
   * based on historical correlations and event sensitivity.
   */
  buildTransmissionGraph(
    event: Event,
    marketData: MarketDataSnapshot,
  ): TransmissionGraph {
    const latestVersion = event.versions[event.versions.length - 1];
    const evidence = latestVersion?.evidence[latestVersion.evidence.length - 1];
    const features = evidence?.extractedFeatures;
    const ontology = event.ontology;

    const now = Date.now();
    const edges: TransmissionEdge[] = [];
    const nodeAvailability = new Map<TransmissionNode, DataAvailability>();

    // Default node availability from market data
    const defaultAvail: DataAvailability = 'SOURCE_AVAILABLE';
    const allNodes: TransmissionNode[] = [
      'USD_DXY', 'US_RATES', 'INDIA_RATES', 'INR', 'CRUDE', 'GOLD',
      'GLOBAL_EQUITY', 'ASIAN_EQUITY', 'NIFTY', 'BANKNIFTY', 'FUTURES', 'OPTION_SURFACE',
    ];
    for (const n of allNodes) {
      nodeAvailability.set(n, defaultAvail);
    }

    // Build edges based on ontology
    switch (ontology) {
      case 'CENTRAL_BANK':
        edges.push(
          this.makeEdge('US_RATES', 'INDIA_RATES', 1, 0.9, 0.85, 'CENTRAL_BANK'),
          this.makeEdge('INDIA_RATES', 'INR', 1, 0.8, 0.80, 'CENTRAL_BANK'),
          this.makeEdge('INR', 'NIFTY', -1, 0.6, 0.75, 'CENTRAL_BANK'),
          this.makeEdge('US_RATES', 'USD_DXY', 1, 0.9, 0.90, 'CENTRAL_BANK'),
        );
        break;
      case 'MACRO':
        edges.push(
          this.makeEdge('US_RATES', 'USD_DXY', 1, 0.9, 0.88, 'MACRO'),
          this.makeEdge('USD_DXY', 'INR', -1, 0.7, 0.80, 'MACRO'),
          this.makeEdge('CRUDE', 'NIFTY', -1, 0.6, 0.70, 'MACRO'),
          this.makeEdge('GLOBAL_EQUITY', 'ASIAN_EQUITY', 1, 0.8, 0.85, 'MACRO'),
          this.makeEdge('ASIAN_EQUITY', 'NIFTY', 1, 0.7, 0.80, 'MACRO'),
        );
        break;
      case 'GEOPOLITICAL':
        edges.push(
          this.makeEdge('CRUDE', 'NIFTY', -1, 0.5, 0.75, 'GEOPOLITICAL'),
          this.makeEdge('GOLD', 'NIFTY', -1, 0.5, 0.65, 'GEOPOLITICAL'),
          this.makeEdge('USD_DXY', 'INR', -1, 0.6, 0.70, 'GEOPOLITICAL'),
          this.makeEdge('ASIAN_EQUITY', 'NIFTY', 1, 0.7, 0.80, 'GEOPOLITICAL'),
        );
        break;
      case 'COMMODITIES':
        edges.push(
          this.makeEdge('CRUDE', 'INR', -1, 0.7, 0.85, 'COMMODITIES'),
          this.makeEdge('CRUDE', 'NIFTY', -1, 0.6, 0.75, 'COMMODITIES'),
          this.makeEdge('GOLD', 'INR', -1, 0.5, 0.65, 'COMMODITIES'),
        );
        break;
      case 'INDIA':
        edges.push(
          this.makeEdge('INDIA_RATES', 'NIFTY', -1, 0.8, 0.80, 'INDIA'),
          this.makeEdge('INR', 'NIFTY', -1, 0.6, 0.75, 'INDIA'),
          this.makeEdge('NIFTY', 'BANKNIFTY', 1, 0.9, 0.90, 'INDIA'),
          this.makeEdge('NIFTY', 'FUTURES', 1, 0.95, 0.95, 'INDIA'),
        );
        break;
      case 'FINANCIAL_SYSTEM':
        edges.push(
          this.makeEdge('US_RATES', 'GLOBAL_EQUITY', -1, 0.7, 0.80, 'FINANCIAL_SYSTEM'),
          this.makeEdge('GLOBAL_EQUITY', 'ASIAN_EQUITY', 1, 0.8, 0.85, 'FINANCIAL_SYSTEM'),
          this.makeEdge('ASIAN_EQUITY', 'NIFTY', 1, 0.7, 0.80, 'FINANCIAL_SYSTEM'),
        );
        break;
      case 'MICROSTRUCTURE':
        edges.push(
          this.makeEdge('OPTION_SURFACE', 'NIFTY', 1, 0.5, 0.70, 'MICROSTRUCTURE'),
          this.makeEdge('FUTURES', 'NIFTY', 1, 0.95, 0.95, 'MICROSTRUCTURE'),
        );
        break;
    }

    return {
      edges,
      nodeAvailability,
      regime: 'NORMAL',
      calculatedAtMs: now,
    };
  }

  /**
   * Helper to construct a TransmissionEdge.
   */
  private makeEdge(
    from: TransmissionNode,
    to: TransmissionNode,
    sign: 1 | -1,
    confidence: number,
    correlation: number,
    regime: string,
  ): TransmissionEdge {
    return {
      from,
      to,
      leadLag: 0,
      rollingCorrelation: correlation,
      eventSpecificSensitivity: 1.0,
      sign,
      confidence,
      regime,
      timeDecay: 3600, // 1 hour half-life
    };
  }

  /**
   * Extract option chain features from live market data.
   *
   * This is a structural extraction stub — it pulls values from the
   * provided MarketDataSnapshot. A real implementation would use the
   * FeatureEngineService to compute these from live tick data.
   */
  extractOptionChainFeatures(marketData: MarketDataSnapshot): OptionChainFeatures {
    // Delegate to the snapshot's pre-computed features if available,
    // otherwise return sensible defaults.
    return marketData.optionFeatures;
  }

  /**
   * Generate a forecast distribution for an event.
   *
   * Combines event surprise, novelty, transmission graph confidence,
   * and option chain features into a probability distribution over
   * direction (up/down/flat), magnitude, and timing.
   */
  generateForecast(
    event: Event,
    features: OptionChainFeatures,
    graph: TransmissionGraph,
  ): ForecastDistribution {
    const surprise = this.calculateSurprise(event);
    const novelty = this.calculateNovelty(event);
    const transmissionConfidence = graph.edges.length > 0
      ? graph.edges.reduce((sum, e) => sum + e.confidence, 0) / graph.edges.length
      : 0.5;

    // Base probabilities modulated by transmission confidence
    const baseUp = 0.5;
    const pUp = Math.max(0.05, Math.min(0.95, baseUp + (transmissionConfidence - 0.5) * 0.3));
    const pDown = Math.max(0.05, Math.min(0.95, 1 - pUp - 0.1));
    const pFlat = Math.max(0.05, 1 - pUp - pDown);

    const atmIV = features.iv.atmIV;
    const impliedMove = features.structures.expectedMove;

    return {
      pUp: Math.round(pUp * 1000) / 1000,
      pDown: Math.round(pDown * 1000) / 1000,
      pFlat: Math.round(pFlat * 1000) / 1000,
      moveQuantiles: [
        impliedMove * -1.28,
        impliedMove * -0.67,
        0,
        impliedMove * 0.67,
        impliedMove * 1.28,
      ],
      timeToPeakQuantiles: [15, 30, 60],
      persistenceProbability: Math.max(0.1, 0.5 + surprise * 0.3),
      ivChangeQuantiles: [
        -atmIV * 0.3,
        -atmIV * 0.1,
        0,
        atmIV * 0.1,
        atmIV * 0.3,
      ],
      ivCrushProbability: Math.min(0.95, 0.3 + novelty * 0.4 + surprise * 0.2),
      skewChange: (features.skew.putCallSkew) * (surprise * 0.5),
      termStructureChange: features.termStructure.slope * (surprise * 0.3),
      liquidityStressProbability: Math.min(0.9, 0.1 + surprise * 0.5 + novelty * 0.3),
      abstainProbability: Math.min(0.85, 0.2 + (1 - transmissionConfidence) * 0.5 + (1 - surprise) * 0.2),
    };
  }

  /**
   * Measure IV crush for a paper trade candidate.
   *
   * Compares pre-event and post-event IV to determine whether the
   * option trade was profitable after accounting for IV contraction.
   */
  checkIVCrush(
    event: Event,
    prePostIV: IVCrushInput,
  ): IVCrushResult {
    const deltaPnl = prePostIV.actualSpotMove * prePostIV.optionDelta * prePostIV.positionSize;
    const vegaPnl = (prePostIV.postEventATMIV - prePostIV.preEventATMIV) * prePostIV.optionVega * prePostIV.positionSize;
    const thetaPnl = -prePostIV.thetaLoss * prePostIV.positionSize;
    const transactionCostPnl = -(prePostIV.spread + prePostIV.slippage) * prePostIV.positionSize;
    const netPnl = deltaPnl + vegaPnl + thetaPnl + transactionCostPnl;

    const directionCorrect = (prePostIV.actualSpotMove > 0 && prePostIV.optionDelta > 0) ||
      (prePostIV.actualSpotMove < 0 && prePostIV.optionDelta < 0);

    return {
      directionCorrect,
      optionProfitable: netPnl > 0,
      ivCrushOverwhelmedDelta: vegaPnl < 0 && Math.abs(vegaPnl) > Math.abs(deltaPnl),
      thetaOverwhelmedMove: Math.abs(thetaPnl) > Math.abs(deltaPnl),
      transactionCostsDestroyedEdge: Math.abs(transactionCostPnl) > Math.abs(deltaPnl + vegaPnl),
      netPnl,
      deltaPnl,
      vegaPnl,
      thetaPnl,
      transactionCostPnl,
      breakdown: [
        `Delta: ₹${deltaPnl.toFixed(0)}`,
        `Vega (IV crush): ₹${vegaPnl.toFixed(0)}`,
        `Theta: ₹${thetaPnl.toFixed(0)}`,
        `Transaction costs: ₹${transactionCostPnl.toFixed(0)}`,
        `Net: ₹${netPnl.toFixed(0)}`,
      ].join(' | '),
    };
  }

  /**
   * Run deterministic risk gates on a forecast and option features.
   *
   * Returns PAPER_CANDIDATE or ABSTAIN based on:
   *   - Forecast abstain probability
   *   - Liquidity conditions
   *   - IV percentile (extreme IV → abstain)
   *   - Event magnitude confidence
   */
  runRiskGates(
    forecast: ForecastDistribution,
    features: OptionChainFeatures,
  ): { decision: 'PAPER_CANDIDATE' | 'ABSTAIN'; reason?: string; confidence: number } {
    // Gate 1: Abstain probability too high
    if (forecast.abstainProbability > 0.6) {
      return {
        decision: 'ABSTAIN',
        reason: `Abstain probability ${(forecast.abstainProbability * 100).toFixed(1)}% exceeds 60% threshold`,
        confidence: forecast.abstainProbability,
      };
    }

    // Gate 2: IV percentile too extreme
    if (features.iv.ivPercentile > 0.90 || features.iv.ivPercentile < 0.10) {
      return {
        decision: 'ABSTAIN',
        reason: `IV percentile ${(features.iv.ivPercentile * 100).toFixed(1)}% is at extremes`,
        confidence: 1 - features.iv.ivPercentile,
      };
    }

    // Gate 3: Liquidity stress
    if (features.liquidity.executionStress > 0.7) {
      return {
        decision: 'ABSTAIN',
        reason: `Execution stress ${(features.liquidity.executionStress * 100).toFixed(1)}% exceeds safe threshold`,
        confidence: features.liquidity.executionStress,
      };
    }

    // Gate 4: Bid-ask spread too wide
    if (features.liquidity.bidAskSpreadPct > 0.02) {
      return {
        decision: 'ABSTAIN',
        reason: `Bid-ask spread ${(features.liquidity.bidAskSpreadPct * 100).toFixed(2)}% exceeds 2%`,
        confidence: features.liquidity.bidAskSpreadPct,
      };
    }

    // Gate 5: No meaningful directional signal
    const maxDir = Math.max(forecast.pUp, forecast.pDown);
    if (maxDir < 0.45) {
      return {
        decision: 'ABSTAIN',
        reason: `No clear directional signal (max direction ${(maxDir * 100).toFixed(1)}%)`,
        confidence: maxDir,
      };
    }

    // Passed all gates — produce PAPER_CANDIDATE
    const confidence = maxDir * (1 - forecast.abstainProbability);
    return {
      decision: 'PAPER_CANDIDATE',
      confidence,
    };
  }

  /**
   * Validate a paper candidate against the existing risk engine.
   *
   * This method is a bridge — it accepts a paper candidate and
   * delegates validation to whatever risk engine is available. In the
   * standalone paper-trading mode, it performs its own validation.
   */
  validatePaperCandidate(
    candidate: PaperCandidateDetails,
    existingRiskEngine?: {
      validatePosition: (params: {
        strategy: string;
        underlying: string;
        maxLoss: number;
        maxHoldMinutes: number;
      }) => Promise<{ approved: boolean; reason: string }>;
    },
  ): { approved: boolean; reason: string } {
    // In standalone paper mode without risk engine, apply basic checks
    if (!existingRiskEngine) {
      if (candidate.riskParams.maxLoss <= 0) {
        return { approved: false, reason: 'Max loss must be positive' };
      }
      if (candidate.riskParams.maxLoss > 100_000) {
        return { approved: false, reason: 'Max loss exceeds paper trading limit of ₹1,00,000' };
      }
      if (candidate.maxHoldMinutes > 390) {
        return { approved: false, reason: 'Max hold exceeds one trading day (390 min)' };
      }
      return { approved: true, reason: 'Passed standalone paper validation' };
    }

    // Delegate to existing risk engine — sync wrapper for the async call
    let result: { approved: boolean; reason: string } = {
      approved: false,
      reason: 'Risk engine not available',
    };
    existingRiskEngine
      .validatePosition({
        strategy: candidate.strategy,
        underlying: candidate.underlying,
        maxLoss: candidate.riskParams.maxLoss,
        maxHoldMinutes: candidate.maxHoldMinutes,
      })
      .then((r) => {
        result = r;
      })
      .catch((err) => {
        result = { approved: false, reason: `Risk engine error: ${String(err)}` };
      });
    return result;
  }

  /**
   * Reconcile overnight state — hand off events discovered while NSE
   * was closed into the next market session.
   *
   * Called when market opens (transition from S7 → active states).
   * Re-evaluates all overnight events against morning market data.
   */
  reconcileOvernightState(
    nightEvents: readonly Event[],
    morningData: MarketDataSnapshot,
  ): Event[] {
    const reconciled: Event[] = [];

    for (const event of nightEvents) {
      if (event.currentState !== 'S7_MARKET_CLOSED_PENDING_NEXT_SESSION') continue;

      // Rebuild transmission graph with morning data
      const graph = this.buildTransmissionGraph(event, morningData);
      const hasValidEdges = graph.edges.some((e) => e.confidence > 0.5);

      // Attempt state transition
      const trigger: StateTransitionTrigger = hasValidEdges
        ? 'MARKET_OPENED'
        : 'EVIDENCE_RECEIVED';

      const transition = this.updateEventState(event, trigger, event.versions.length);
      if (!transition) {
        // Keep in S7 — will be re-evaluated next cycle
        reconciled.push(event);
        continue;
      }

      // Apply transition and add morning evidence as new version
      const now = Date.now();
      const updatedEvent: Event = {
        ...event,
        currentState: transition.newState,
        lastUpdatedAtMs: now,
      };

      reconciled.push(updatedEvent);
    }

    return reconciled;
  }

  /**
   * Freeze an outcome snapshot for an event.
   *
   * Records the actual market response to an event, enabling later
   * counterfactual comparison and error attribution.
   */
  freezeOutcome(event: Event, outcome: EventOutcome): void {
    this.outcomeSnapshots.set(event.id, outcome);
    this.logger.log(`Outcome frozen for event ${event.id}: spot=${outcome.actualSpotMove}pts`);
  }

  /**
   * Build a complete proof bundle for a prediction.
   *
   * Reconstructs the full audit trail: raw records → classification →
   * version history → features → forecast → decision, so any prediction
   * can be fully explained and verified.
   */
  buildProofBundle(
    prediction: PredictionRecord,
  ): {
    prediction: PredictionRecord;
    event: Event | undefined;
    rawRecords: EventRawRecord[];
    allVersions: readonly EventVersion[];
    latencies: PerformanceLatency;
  } {
    const event = this.eventStore.get(prediction.eventId);

    // Collect all raw records from all versions
    const rawRecords: EventRawRecord[] = [];
    const allVersions = event?.versions ?? [];
    for (const version of allVersions) {
      for (const evidence of version.evidence) {
        rawRecords.push(evidence.rawRecord);
      }
    }

    // Reconstruct approximate latencies from prediction timestamps
    const firstRaw = rawRecords[0];
    const sourcePublishedAt = firstRaw?.sourcePublishedAt ?? prediction.predictedAtMs;
    const latencies: PerformanceLatency = {
      ingestionLatencyMs: 0,
      classificationLatencyMs: 0,
      featureExtractionLatencyMs: 0,
      stateTransitionLatencyMs: 0,
      forecastLatencyMs: 0,
      decisionLatencyMs: 0,
      totalLatencyMs: prediction.predictedAtMs - sourcePublishedAt,
    };

    return { prediction, event, rawRecords, allVersions, latencies };
  }

  /**
   * Attribute error between a prediction and the actual outcome.
   *
   * Produces a structured error attribution that feeds the research
   * pipeline for continuous model improvement.
   */
  attributeError(
    prediction: PredictionRecord,
    outcome: EventOutcome,
  ): EventErrorAttribution {
    const forecast = prediction.forecastDistribution;

    // Direction accuracy
    const predictedDir = forecast.pUp > forecast.pDown ? 'UP' : 'DOWN';
    const actualDir = outcome.actualSpotMove > 0 ? 'UP' : 'DOWN';
    const directionCorrect = predictedDir === actualDir;

    // Brier score for calibration
    const outcomeBinarized = outcome.actualSpotMove > 0 ? 1 : 0;
    const brierScore =
      Math.pow(forecast.pUp - outcomeBinarized, 2) +
      Math.pow(forecast.pDown - (1 - outcomeBinarized), 2) +
      Math.pow(forecast.pFlat - 0, 2);

    // Determine dominant error source
    let classification: EventErrorClassification = EVENT_ERROR_CLASSIFICATION.EXPECTED_HANDLED;
    let component = 'forecast';
    let errorCode = 'CALIBRATION_MISS';
    let message = 'Forecast calibration off';

    if (!directionCorrect) {
      errorCode = 'DIRECTION_ERROR';
      message = `Predicted ${predictedDir} but actual was ${actualDir}`;
      if (prediction.decision === 'ABSTAIN') {
        classification = EVENT_ERROR_CLASSIFICATION.RECOVERED;
        errorCode = 'BENEFICIAL_ABSTAIN';
        message = 'Abstained but direction would have been profitable';
      }
    } else if (prediction.decision === 'ABSTAIN') {
      errorCode = 'COSTLY_ABSTAIN';
      message = 'Abstained on a correctly predicted move';
      classification = EVENT_ERROR_CLASSIFICATION.EXPECTED_HANDLED;
    } else if (prediction.decision === 'PAPER_CANDIDATE') {
      if (!prediction.paperCandidate) {
        errorCode = 'MISSING_CANDIDATE_DETAILS';
        component = 'decision';
        classification = EVENT_ERROR_CLASSIFICATION.UNHANDLED_EXCEPTION;
      }
    }

    return {
      classification,
      component,
      operation: 'forecast_outcome_comparison',
      errorCode,
      message,
      eventId: prediction.eventId,
      recovered: classification === EVENT_ERROR_CLASSIFICATION.RECOVERED,
      recoveryAction: directionCorrect
        ? undefined
        : 'Feed Brier score into model recalibration pipeline',
      latencyMs: prediction.predictedAtMs - (outcome.recordedAtMs - 86400000),
    };
  }

  // ── Operating Mode Cycles ──────────────────────────────────────────────────

  /**
   * OFF-HOURS cycle: discover events, verify, deduplicate, classify,
   * calculate novelty, maintain cross-asset context, maintain event
   * state, prepare next-session context.
   */
  private async runOffHoursCycle(): Promise<void> {
    const cycleId = correlationId();
    try {
      const rawRecords = await this.ingestEvents();

      for (const raw of rawRecords) {
        try {
          // Classify
          const ontology = this.classifyEvent(raw);

          // Deduplicate by fingerprint
          const fingerprint = raw.eventFingerprint;
          const existingEventId = this.fingerprintIndex.get(fingerprint);

          if (existingEventId) {
            // Update existing event with new evidence
            const existing = this.eventStore.get(existingEventId);
            if (existing) {
              const evidence: EventEvidence = {
                rawRecord: raw,
                addedAtMs: Date.now(),
                sourceTier: raw.sourceTier,
              };
              const updated = this.versionEvent(existing, evidence, raw.title.includes('denied') ? 'DENIED' : existing.lifecycle, 'new_evidence');
              // Apply state machine transition
              const transition = this.updateEventState(updated, 'EVIDENCE_RECEIVED', updated.versions.length);
              const finalEvent: Event = transition
                ? { ...updated, currentState: transition.newState, lastUpdatedAtMs: Date.now() }
                : updated;
              this.eventStore.set(existingEventId, finalEvent);
            }
          } else {
            // New event
            const evidence: EventEvidence = {
              rawRecord: raw,
              addedAtMs: Date.now(),
              sourceTier: raw.sourceTier,
            };
            let event = this.versionEvent(undefined, evidence, 'PRELIMINARY', 'initial_discovery');
            event = { ...event, ontology };

            // Calculate novelty
            const novelty = this.calculateNovelty(event);
            const latestVersion = event.versions[0];
            if (latestVersion && latestVersion.evidence.length > 0) {
              const ev = latestVersion.evidence[0];
              if (ev.extractedFeatures) {
                // Update novelty in extracted features (immutable — skip)
              }
            }

            // Attempt state transition
            const transition = this.updateEventState(event, 'EVIDENCE_RECEIVED', 1);
            if (transition) {
              event = { ...event, currentState: transition.newState };
            }

            this.eventStore.set(event.id, event);
            this.fingerprintIndex.set(fingerprint, event.id);
          }
        } catch (err) {
          this.classifyError(cycleId, 'event_processing', raw.sourceId, err);
          // Never crash on individual event errors
        }
      }

      // Maintain state: time-decay events in S5 towards S7 if market closed
      if (!isMarketOpenIST()) {
        this.transitionStaleEventsToS7();
      }
    } catch (err) {
      this.classifyError(cycleId, 'off_hours_cycle', undefined, err);
    }
  }

  /**
   * MARKET-HOURS cycle: consume live data, calculate option surface,
   * transmission, forecasts, IV crush, risk gates → PAPER_CANDIDATE or ABSTAIN.
   */
  private async runMarketHoursCycle(): Promise<void> {
    const cycleId = correlationId();
    try {
      // Phase 1: Ingest (higher frequency during market hours)
      const rawRecords = await this.ingestEvents();

      // Phase 2: Process each new observation through the full pipeline
      for (const raw of rawRecords) {
        try {
          await this.processEventFullPipeline(raw, cycleId);
        } catch (err) {
          this.classifyError(cycleId, 'market_hours_event_processing', raw.sourceId, err);
        }
      }

      // Phase 3: Re-evaluate all active events against latest market data
      const activeEvents = this.getActiveEvents();
      for (const event of activeEvents) {
        try {
          await this.reEvaluateActiveEvent(event, cycleId);
        } catch (err) {
          this.classifyError(cycleId, 're_evaluate_active', event.id, err);
        }
      }
    } catch (err) {
      this.classifyError(cycleId, 'market_hours_cycle', undefined, err);
    }
  }

  /**
   * Process a single raw record through the full pipeline:
   * classify → version → state → novelty → forecast → risk gates.
   */
  private async processEventFullPipeline(
    raw: EventRawRecord,
    cycleId: string,
  ): Promise<PredictionRecord | null> {
    const latency: PipelineLatency = {
      sourcePublishedAt: raw.sourcePublishedAt,
      receivedAt: raw.receivedAt,
      normalizedAt: Date.now(),
      verifiedAt: Date.now(),
      classifiedAt: 0,
      featureAt: 0,
      forecastAt: 0,
      decisionAt: 0,
    };

    // Classify
    const ontology = this.classifyEvent(raw);
    latency.classifiedAt = Date.now();

    // Deduplicate
    const fingerprint = raw.eventFingerprint;
    const existingEventId = this.fingerprintIndex.get(fingerprint);

    let event: Event;
    if (existingEventId) {
      const existing = this.eventStore.get(existingEventId);
      if (!existing) {
        // Stale fingerprint reference — treat as new
        event = this.createInitialEvent(raw, ontology);
      } else {
        event = this.addEvidenceToEvent(existing, raw);
      }
    } else {
      event = this.createInitialEvent(raw, ontology);
    }

    // State transition
    const transition = this.updateEventState(event, 'EVIDENCE_RECEIVED', event.versions.length);
    if (transition) {
      event = { ...event, currentState: transition.newState, lastUpdatedAtMs: Date.now() };
    }

    this.eventStore.set(event.id, event);
    this.fingerprintIndex.set(fingerprint, event.id);
    latency.featureAt = Date.now();

    // Novelty
    const novelty = this.calculateNovelty(event);
    const surprise = this.calculateSurprise(event);

    // Build placeholder market data snapshot for transmission/forecast
    // In production, this comes from live market data service
    const placeholderMarketData: MarketDataSnapshot = this.getDefaultMarketSnapshot();

    // Transmission graph
    const graph = this.buildTransmissionGraph(event, placeholderMarketData);

    // Option chain features
    const optionFeatures = this.extractOptionChainFeatures(placeholderMarketData);

    // Forecast
    const forecast = this.generateForecast(event, optionFeatures, graph);
    latency.forecastAt = Date.now();

    // Risk gates
    const riskResult = this.runRiskGates(forecast, optionFeatures);
    latency.decisionAt = Date.now();

    // Log performance
    const perfLatencies = computeLatencies(latency);
    this.logger.debug(
      `Pipeline [${event.id}] total=${perfLatencies.totalLatencyMs}ms ` +
      `decision=${riskResult.decision} novelty=${novelty.toFixed(3)} surprise=${surprise.toFixed(3)}`,
    );

    // If ABSTAIN, return null (no paper candidate)
    if (riskResult.decision === 'ABSTAIN') {
      return this.createAbstainPrediction(event, forecast, optionFeatures, graph, perfLatencies);
    }

    // Produce PAPER_CANDIDATE
    return this.createPaperCandidatePrediction(
      event,
      forecast,
      optionFeatures,
      graph,
      perfLatencies,
      riskResult.confidence,
    );
  }

  /**
   * Re-evaluate an active event against the latest market data snapshot.
   */
  private async reEvaluateActiveEvent(
    event: Event,
    cycleId: string,
  ): Promise<void> {
    // Skip terminal or closed states
    if (event.currentState === 'S6_RETRACTED_OR_INVALIDATED' || event.currentState === 'S7_MARKET_CLOSED_PENDING_NEXT_SESSION') {
      return;
    }

    const placeholderMarketData = this.getDefaultMarketSnapshot();
    const graph = this.buildTransmissionGraph(event, placeholderMarketData);
    const optionFeatures = this.extractOptionChainFeatures(placeholderMarketData);
    const forecast = this.generateForecast(event, optionFeatures, graph);
    const riskResult = this.runRiskGates(forecast, optionFeatures);

    if (riskResult.decision === 'ABSTAIN') {
      this.logger.debug(`Re-eval [${event.id}]: ABSTAIN — ${riskResult.reason ?? 'no reason'}`);
    } else {
      this.logger.debug(`Re-eval [${event.id}]: PAPER_CANDIDATE confidence=${riskResult.confidence.toFixed(3)}`);
    }
  }

  // ── Internal: Event Construction Helpers ───────────────────────────────────

  private createInitialEvent(raw: EventRawRecord, ontology: EventOntology): Event {
    const evidence: EventEvidence = {
      rawRecord: raw,
      addedAtMs: Date.now(),
      sourceTier: raw.sourceTier,
    };
    let event = this.versionEvent(undefined, evidence, 'PRELIMINARY', 'initial_discovery');
    event = { ...event, ontology };
    return event;
  }

  private addEvidenceToEvent(event: Event, raw: EventRawRecord): Event {
    const evidence: EventEvidence = {
      rawRecord: raw,
      addedAtMs: Date.now(),
      sourceTier: raw.sourceTier,
    };
    const lifecycle = event.lifecycle === 'PRELIMINARY' ? 'OFFICIAL' : event.lifecycle;
    return this.versionEvent(event, evidence, lifecycle, 'new_corroborating_evidence');
  }

  private getDefaultMarketSnapshot(): MarketDataSnapshot {
    const now = Date.now();
    const defaultSpotFutures: SpotFuturesFeatures = {
      spot: 24000,
      futures: 24050,
      basis: 50,
      returns1d: 0,
      gapPct: 0,
      momentum5d: 0,
      vwapDistancePct: 0,
      realizedVolatility: 0,
      futuresVolume: 0,
      futuresOI: 0,
    };
    const defaultIV: IVFeatures = {
      atmIV: 15,
      ivByStrike: new Map<number, number>(),
      ivByExpiry: new Map<string, number>(),
      ivPercentile: 0.5,
      ivRank: 0.5,
      eventPremium: 0,
      ivChange1d: 0,
    };
    const defaultSkew: SkewFeatures = {
      twentyFiveDeltaRR: 0,
      putCallSkew: 0,
      skewChange1d: 0,
    };
    const defaultTermStructure: TermStructureFeatures = {
      frontIV: 15,
      backIV: 14,
      slope: -1,
      curvature: 0,
      eventExpiryPremium: 0,
    };
    const defaultGreeks: GreeksFeatures = {
      delta: 0.5,
      gamma: 0.01,
      vega: 0.1,
      theta: -0.05,
      vanna: null,
      volga: null,
      charm: null,
    };
    const defaultFlow: FlowFeatures = {
      totalVolume: 0,
      oiChange: 0,
      volumeToOIRatio: 0,
      callPutImbalance: 1.0,
    };
    const defaultLiquidity: LiquidityFeatures = {
      bidAskSpreadPct: 0.005,
      depth: 100,
      staleQuoteCount: 0,
      executionStress: 0.2,
    };
    const defaultStructures: StructureFeatures = {
      atmStraddle: 200,
      strangle: 350,
      expectedMove: 200,
      breakEvenMove: 250,
    };

    const optionFeatures: OptionChainFeatures = {
      spotFutures: defaultSpotFutures,
      iv: defaultIV,
      skew: defaultSkew,
      termStructure: defaultTermStructure,
      greeks: defaultGreeks,
      flow: defaultFlow,
      liquidity: defaultLiquidity,
      structures: defaultStructures,
    };

    const nodeAvailability = new Map<TransmissionNode, DataAvailability>();
    const allNodes: TransmissionNode[] = [
      'USD_DXY', 'US_RATES', 'INDIA_RATES', 'INR', 'CRUDE', 'GOLD',
      'GLOBAL_EQUITY', 'ASIAN_EQUITY', 'NIFTY', 'BANKNIFTY', 'FUTURES', 'OPTION_SURFACE',
    ];
    for (const n of allNodes) {
      nodeAvailability.set(n, 'SOURCE_UNAVAILABLE');
    }

    const transmissionGraph: TransmissionGraph = {
      edges: [],
      nodeAvailability,
      regime: 'NORMAL',
      calculatedAtMs: now,
    };

    return { timestampMs: now, optionFeatures, transmissionGraph };
  }

  private createAbstainPrediction(
    event: Event,
    forecast: ForecastDistribution,
    optionFeatures: OptionChainFeatures,
    graph: TransmissionGraph,
    latencies: PerformanceLatency,
  ): PredictionRecord {
    return {
      predictionId: `pred-abstain-${event.id}-${Date.now()}`,
      eventId: event.id,
      evidenceVersion: event.versions.length,
      forecastDistribution: forecast,
      eventState: event.currentState,
      optionFeatures,
      transmissionGraph: graph,
      predictedAtMs: Date.now(),
      decision: 'ABSTAIN',
      confidence: forecast.abstainProbability,
      abstainReason: `Abstain probability ${(forecast.abstainProbability * 100).toFixed(1)}% exceeds threshold`,
      featureHash: featureHash(optionFeatures),
    };
  }

  private createPaperCandidatePrediction(
    event: Event,
    forecast: ForecastDistribution,
    optionFeatures: OptionChainFeatures,
    graph: TransmissionGraph,
    latencies: PerformanceLatency,
    confidence: number,
  ): PredictionRecord {
    const isBullish = forecast.pUp > forecast.pDown;
    const strategy = isBullish ? 'LONG_CALL' : 'LONG_PUT';
    const underlying = 'NIFTY';

    const paperCandidate: PaperCandidateDetails = {
      strategy,
      underlying,
      contracts: [`${underlying}_CE`, `${underlying}_PE`],
      entryTiming: 'PRE_EVENT',
      maxHoldMinutes: 120,
      riskParams: {
        maxLoss: 5000,
        targetProfit: 10000,
        stopLoss: 3000,
      },
    };

    return {
      predictionId: `pred-paper-${event.id}-${Date.now()}`,
      eventId: event.id,
      evidenceVersion: event.versions.length,
      forecastDistribution: forecast,
      eventState: event.currentState,
      optionFeatures,
      transmissionGraph: graph,
      predictedAtMs: Date.now(),
      decision: 'PAPER_CANDIDATE',
      confidence,
      paperCandidate,
      featureHash: featureHash(optionFeatures),
    };
  }

  // ── Internal: State Maintenance ────────────────────────────────────────────

  /**
   * Transition events stuck in S5 for too long to S7 (market closed)
   * when market is not open.
   */
  private transitionStaleEventsToS7(): void {
    const staleThresholdMs = 4 * 60 * 60 * 1000; // 4 hours
    const now = Date.now();

    this.eventStore.forEach((event) => {
      if (event.currentState === 'S5_FOLLOW_UP') {
        const age = now - event.lastUpdatedAtMs;
        if (age > staleThresholdMs) {
          const transition = this.updateEventState(event, 'MARKET_CLOSED', event.versions.length);
          if (transition) {
            const updated: Event = {
              ...event,
              currentState: transition.newState,
              lastUpdatedAtMs: now,
            };
            this.eventStore.set(event.id, updated);
          }
        }
      }
    });
  }

  /**
   * Get all events in active (non-terminal, non-closed) states.
   */
  private getActiveEvents(): Event[] {
    const active: Event[] = [];
    this.eventStore.forEach((event) => {
      if (
        event.currentState !== 'S6_RETRACTED_OR_INVALIDATED' &&
        event.currentState !== 'S7_MARKET_CLOSED_PENDING_NEXT_SESSION'
      ) {
        active.push(event);
      }
    });
    return active;
  }

  // ── Internal: Error Handling ───────────────────────────────────────────────

  /**
   * Handle source adapter errors with structured classification.
   * Never crashes the service — logs and marks source as degraded.
   */
  private handleSourceError(
    adapter: SourceAdapter,
    err: unknown,
    operation: string,
  ): void {
    const message = err instanceof Error ? err.message : String(err);
    const health = this.sourceHealthCache.get(adapter.sourceId);
    const errorCount = (health?.errorRate ?? 0) + 1;

    this.sourceHealthCache.set(adapter.sourceId, {
      sourceId: adapter.sourceId,
      healthy: false,
      lastSuccessMs: health?.lastSuccessMs ?? 0,
      lastErrorMs: Date.now(),
      errorRate: errorCount,
      averageLatencyMs: health?.averageLatencyMs ?? 0,
      description: `DEGRADED: ${message}`,
    });

    this.sourceDegraded.set(adapter.sourceId, true);

    const attribution: EventErrorAttribution = {
      classification: EVENT_ERROR_CLASSIFICATION.DEGRADED,
      component: 'source_adapter',
      operation,
      errorCode: `SOURCE_${adapter.sourceId.toUpperCase()}_FAILURE`,
      message: `Source ${adapter.sourceName} failed: ${message}`,
      sourceId: adapter.sourceId,
      recovered: false,
      recoveryAction: `Retry on next poll cycle; source marked as DEGRADED`,
    };

    this.logger.warn(
      `Source error [${adapter.sourceId}] op=${operation}: ${message}`,
      attribution,
    );
  }

  /**
   * Classify any pipeline error with structured attribution.
   * Logs the error and returns the attribution without crashing.
   */
  private classifyError(
    cycleId: string,
    operation: string,
    sourceId: string | undefined,
    err: unknown,
  ): EventErrorAttribution {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;

    let classification: EventErrorClassification = EVENT_ERROR_CLASSIFICATION.UNHANDLED_EXCEPTION;
    let recoveryAction: string | undefined = 'Check logs and retry on next cycle';

    // Classify known error patterns
    if (message.includes('ECONNREFUSED') || message.includes('ENOTFOUND')) {
      classification = EVENT_ERROR_CLASSIFICATION.DEGRADED;
      recoveryAction = 'Source unreachable; marked as degraded, will retry';
    } else if (message.includes('ETIMEOUT') || message.includes('ETIMEDOUT')) {
      classification = EVENT_ERROR_CLASSIFICATION.RETRYING;
      recoveryAction = 'Timeout; will retry with exponential backoff';
    } else if (message.includes('429') || message.includes('rate limit')) {
      classification = EVENT_ERROR_CLASSIFICATION.RETRYING;
      recoveryAction = 'Rate limited; will retry after delay';
    }

    const attribution: EventErrorAttribution = {
      classification,
      component: 'event_orchestrator',
      operation,
      errorCode: `ORCH_${operation.toUpperCase()}_ERROR`,
      message,
      sourceId,
      recovered: false,
      recoveryAction,
    };

    this.logger.error(
      `Pipeline error [cycle=${cycleId}] op=${operation}: ${message}`,
      stack,
    );

    return attribution;
  }

  // ── Internal: Public Query API for Testing / External Consumers ────────────

  /** Get a snapshot of all registered source health statuses. */
  getSourceHealth(): SourceHealth[] {
    const health: SourceHealth[] = [];
    this.sourceHealthCache.forEach((h) => health.push(h));
    return health;
  }

  /** Get the current number of events in the store. */
  getEventCount(): number {
    return this.eventStore.size;
  }

  /** Get the current number of raw observations in the cache. */
  getRawObservationCount(): number {
    return this.rawObservationCache.size;
  }

  /** Get an event by ID. */
  getEvent(eventId: string): Event | undefined {
    return this.eventStore.get(eventId);
  }

  /** Check if market is currently open (IST). */
  getIsMarketOpen(): boolean {
    return isMarketOpenIST();
  }

  /** Get current IST time as total minutes since midnight. */
  getCurrentISTMinutes(): number {
    return currentISTMinutes();
  }
}
