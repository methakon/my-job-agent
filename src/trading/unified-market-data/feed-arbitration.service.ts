import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createStructuredLogger } from '../../shared/structured-logger';
import { ErrorClassification } from '../../shared/error-classifications';
import { MarketDataFeedLease } from './market-data-feed-lease.entity';
import { LEASE_STORE, LeaseStore } from './lease-connection.store';
import {
  ArbitrationMode,
  DEFAULT_FEED_DOWN_AFTER_MS,
  DEFAULT_FEED_STALE_AFTER_MS,
  FeedCandidate,
  OwnershipDecision,
  decideOwnership,
  mayProduce as mayProduceIn,
  optionUniversesFromSymbols,
  ownedUniverses as ownedUniversesIn,
  shortUniverse,
  unownedUniverses,
  activeFeedNames,
} from './feed-arbitration.state';

/** What a producer tells the arbiter about itself. */
export type FeedRegistration = {
  name: string;
  /** Lower wins. Defaults to FEED_PRIORITY_<NAME> or 1 (secondary). */
  priority?: number;
  /** Underlyings this feed can PRICE (options). ['*'] = everything. */
  universes: string[];
  /** Enabled on this host right now. */
  enabled: () => boolean;
  /** Live credentials present/unexpired. */
  credentialsOk?: () => boolean;
  /** Age of the newest observation, ms (null = never produced). */
  ageMs: () => number | null;
  note?: string;
};

export type FeedArbitrationStatus = {
  enabled: boolean;
  mode: ArbitrationMode;
  asOf: string;
  staleAfterMs: number;
  downAfterMs: number;
  leaseTtlMs: number;
  decisions: OwnershipDecision[];
  activeFeeds: string[];
  unowned: string[];
  candidates: (FeedCandidate & { origin: 'local' | 'lease'; leaseFresh: boolean })[];
};

const csv = (values: readonly string[]): string => values.join(',');
const fromCsv = (value: string): string[] =>
  String(value ?? '')
    .split(',')
    .map((v) => v.trim().toUpperCase())
    .filter(Boolean);

/**
 * Bound ANY single lease/DB operation so a hung read or write can never freeze a
 * provider's liveness. Measured 2026-09-11: the FYERS producer kept ticking and
 * persisting, but its ownership-poll await on a slow lease READ never returned,
 * so its heartbeat stopped advancing for 7+ minutes; the arbiter then saw the
 * primary as DOWN and kept the universe on the standby even after the primary
 * had recovered. Pure + exported for the hung-read regression test.
 *
 * A timeout REJECTS: callers must treat it exactly like any other failure. It
 * never fabricates a result, so a timed-out lease operation cannot create or
 * preserve ownership — ownership stays the arbiter's decision alone.
 */
export const withTimeout = async <T>(
  operation: Promise<T> | (() => Promise<T>),
  ms: number,
  label: string,
): Promise<T> => {
  const promise = typeof operation === 'function' ? operation() : operation;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms (${label})`)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/**
 * Single-active-feed arbiter (brief s2/s6/s12).
 *
 * The two paper desks keep SEPARATE trades and balances, may consume each
 * other's live ticks, and only ONE feed may PRODUCE ticks for a given
 * instrument universe at a time. Ownership is elected by the pure policy in
 * feed-arbitration.state; this service feeds it two sources:
 *
 *  - the local registry (producers in THIS process, authoritative + live), and
 *  - the market_data_feed_leases table (producers in OTHER processes/hosts —
 *    the FYERS WS worker runs on the Dhargent VM and shares this database).
 *
 * Failure policy: arbitration is an optimisation/guard, not a safety interlock.
 * If the lease table is unreadable the arbiter fails OPEN (a producer keeps
 * producing, loudly logged) because a starved desk is worse than a repeated
 * tick — and repeated ticks are separately suppressed by the unified store's
 * ingest dedupe. Nothing here can place, size or block an order.
 */
@Injectable()
export class FeedArbitrationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createStructuredLogger(FeedArbitrationService.name);
  private readonly local = new Map<string, FeedRegistration>();
  private readonly enabled: boolean;
  private readonly mode: ArbitrationMode;
  private readonly staleAfterMs: number;
  private readonly downAfterMs: number;
  private readonly leaseTtlMs: number;
  private readonly heartbeatMs: number;
  /** Upper bound for one lease read/write (FEED_DB_TIMEOUT_MS). */
  private readonly dbTimeoutMs: number;
  private readonly cacheMs = 2_000;

  private cache: { at: number; decisions: OwnershipDecision[]; candidates: FeedArbitrationStatus['candidates'] } | null = null;
  private lastHeartbeatMs = new Map<string, number>();
  private lastState = new Map<string, string>();
  private lastFailOpenWarnMs = 0;
  private readonly host = process.env.HOSTNAME ?? process.env.COMPUTERNAME ?? 'unknown-host';

  constructor(
    // The lease transport is a DEDICATED single connection, deliberately NOT the
    // shared application pool: measured 2026-09-11 the arbiter's lease read/write
    // timed out on the shared pool while that pool kept serving ~48 market-data
    // inserts/s, which froze the provider's heartbeat for minutes. See
    // lease-connection.store.ts. Ownership is still decided only by the arbiter.
    @Inject(LEASE_STORE)
    private readonly leases: LeaseStore,
  ) {
    this.enabled = !/^(0|false|no|off)$/i.test(process.env.FEED_ARBITRATION_ENABLED ?? 'true');
    this.mode = String(process.env.FEED_EXCLUSIVITY_MODE ?? 'universe').toLowerCase() === 'global' ? 'global' : 'universe';
    this.staleAfterMs = Math.max(1_000, Number(process.env.FEED_STALE_AFTER_MS ?? process.env.MARKET_DATA_STALE_AFTER_MS ?? DEFAULT_FEED_STALE_AFTER_MS));
    this.downAfterMs = Math.max(this.staleAfterMs + 1_000, Number(process.env.FEED_DOWN_AFTER_MS ?? process.env.MARKET_DATA_DOWN_AFTER_MS ?? DEFAULT_FEED_DOWN_AFTER_MS));
    this.leaseTtlMs = Math.max(this.downAfterMs, Number(process.env.FEED_LEASE_TTL_MS ?? 90_000));
    this.heartbeatMs = Math.max(2_000, Number(process.env.FEED_HEARTBEAT_MS ?? 15_000));
    this.dbTimeoutMs = Math.max(1_000, Number(process.env.FEED_DB_TIMEOUT_MS ?? 8_000));
  }

  onModuleInit(): void {
    this.logger.log(
      `[FEED-ARBITER] ${this.enabled ? 'enabled' : 'DISABLED'} · mode=${this.mode} · stale=${this.staleAfterMs}ms · down=${this.downAfterMs}ms · leaseTtl=${this.leaseTtlMs}ms`,
    );
    if (!this.enabled) return;
    // Keep this process's own leases warm even when a producer is idle/standing by.
    const timer = setInterval(() => { void this.flushHeartbeats(); }, this.heartbeatMs);
    timer.unref?.();
    void this.flushHeartbeats();
  }

  onModuleDestroy(): void {
    this.cache = null;
  }

  /** A producer in this process announces itself. Idempotent per name. */
  register(registration: FeedRegistration): void {
    this.local.set(registration.name, registration);
    this.cache = null;
  }

  unregister(name: string): void {
    this.local.delete(name);
    this.cache = null;
  }

  /** Option universes a symbol list covers (never hard-coded). */
  static universesFromSymbols(symbols: readonly string[]): string[] {
    return optionUniversesFromSymbols(symbols);
  }

  priorityFor(name: string, fallback = 1): number {
    const raw = process.env[`FEED_PRIORITY_${String(name).toUpperCase().replace(/[^A-Z0-9]/g, '_')}`];
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  }

  private localCandidates(now: number): FeedCandidate[] {
    return [...this.local.values()].map((registration) => ({
      name: registration.name,
      priority: registration.priority ?? this.priorityFor(registration.name, 1),
      enabled: registration.enabled(),
      credentialsOk: registration.credentialsOk ? registration.credentialsOk() : true,
      universes: registration.universes.map(shortUniverse),
      ageMs: registration.ageMs(),
    }));
  }

  /** Non-expired lease rows from other processes, as candidates. */
  private async leaseCandidates(now: number): Promise<{ candidates: FeedCandidate[]; freshNames: Set<string> }> {
    // Bounded: a hung lease read must fail (and thus fail OPEN for local
    // producers) rather than hang the caller. No ownership is implied by a
    // failed read — the arbiter simply has no lease candidates to rank.
    const rows = await withTimeout(() => this.leases.find(), this.dbTimeoutMs, 'lease read');
    const candidates: FeedCandidate[] = [];
    const freshNames = new Set<string>();
    for (const row of rows) {
      if (!row?.feedName || this.local.has(row.feedName)) continue; // local registry wins
      const heartbeatMs = row.heartbeatAt ? new Date(row.heartbeatAt).getTime() : 0;
      const leaseFresh = heartbeatMs > 0 && now - heartbeatMs <= this.leaseTtlMs;
      if (leaseFresh) freshNames.add(row.feedName);
      // An expired lease is NOT trusted as producing: age becomes null (never observed).
      const lastTickMs = row.lastTickAt ? new Date(row.lastTickAt).getTime() : 0;
      candidates.push({
        name: row.feedName,
        priority: Number(row.priority ?? 1),
        enabled: Boolean(row.enabled) && leaseFresh,
        credentialsOk: Boolean(row.credentialsOk),
        universes: fromCsv(row.universes),
        ageMs: leaseFresh && lastTickMs > 0 ? Math.max(0, now - lastTickMs) : null,
      });
    }
    return { candidates, freshNames };
  }

  private async compute(now: number): Promise<{ decisions: OwnershipDecision[]; candidates: FeedArbitrationStatus['candidates'] }> {
    const locals = this.localCandidates(now);
    let leaseRows: FeedCandidate[] = [];
    let freshNames = new Set<string>();
    try {
      const leased = await this.leaseCandidates(now);
      leaseRows = leased.candidates;
      freshNames = leased.freshNames;
    } catch (error) {
      // The dedicated lease connection is recycled after a failure/timeout: a
      // wedged socket must never be reused, and the provider's heartbeat must not
      // be paced by it. Nothing is recorded as delivered, so the lease simply
      // stops being renewed and the TTL rules below take over.
      this.leases.recycle?.('lease read failed');
      const nowMs = Date.now();
      if (nowMs - this.lastFailOpenWarnMs > 300_000) {
        this.lastFailOpenWarnMs = nowMs;
        this.logger.warn(`[FEED-ARBITER] lease read failed (${(error as Error).message}) — failing OPEN for local producers`);
        this.logger.warnWithContext('[FEED-ARBITER] lease read failed — failing OPEN for local producers', {
          component: 'FeedArbitration',
          errorCode: 'LEASE_READ_FAILED',
          operation: 'read',
          message: (error as Error).message,
          recoveryAction: 'fail_open',
          recovered: true,
        });
      }
    }

    const localNames = new Set(locals.map((c) => c.name));
    const candidates = [...locals, ...leaseRows];
    const universes = [...new Set(candidates.flatMap((c) => c.universes))].filter((u) => u && u !== '*');
    const decisions = decideOwnership(universes, candidates, {
      staleAfterMs: this.staleAfterMs,
      downAfterMs: this.downAfterMs,
      mode: this.mode,
    });

    const annotated: FeedArbitrationStatus['candidates'] = candidates.map((c) => ({
      ...c,
      origin: localNames.has(c.name) ? ('local' as const) : ('lease' as const),
      leaseFresh: localNames.has(c.name) ? true : freshNames.has(c.name),
    }));

    this.cache = { at: now, decisions, candidates: annotated };
    return { decisions, candidates: annotated };
  }

  /** Current ownership decisions (cached briefly; journal reads are cross-process). */
  async decisions(now = Date.now()): Promise<OwnershipDecision[]> {
    if (!this.enabled) return [];
    if (this.cache && now - this.cache.at <= this.cacheMs) return this.cache.decisions;
    return (await this.compute(now)).decisions;
  }

  /** Whether this feed may PRODUCE ticks for at least one of these universes. */
  async mayProduce(feedName: string, universes: readonly string[]): Promise<boolean> {
    if (!this.enabled) return true;
    try {
      return mayProduceIn(feedName, universes, await this.decisions());
    } catch (error) {
      this.logger.warn(`[FEED-ARBITER] mayProduce(${feedName}) failed: ${(error as Error).message} — allowing`);
      return true;
    }
  }

  /** The subset of these universes this feed currently owns. */
  async ownedUniverses(feedName: string, universes: readonly string[]): Promise<string[]> {
    if (!this.enabled) return universes.map(shortUniverse);
    try {
      return ownedUniversesIn(feedName, universes, await this.decisions());
    } catch (error) {
      this.logger.warn(`[FEED-ARBITER] ownedUniverses(${feedName}) failed: ${(error as Error).message} — allowing all`);
      return universes.map(shortUniverse);
    }
  }

  /**
   * Publish this producer's lease (liveness + what it produced). Throttled to
   * FEED_HEARTBEAT_MS unless the state changed, so a 10s poll does not write
   * 10s-apart rows for nothing.
   */
  async beat(
    feedName: string,
    patch: { state?: string; lastTickAt?: Date | null; note?: string | null; universes?: readonly string[]; priority?: number; credentialsOk?: boolean; enabled?: boolean; force?: boolean } = {},
  ): Promise<void> {
    if (!this.enabled) return;
    const nowMs = Date.now();
    const state = patch.state ?? 'ACTIVE';
    const changed = this.lastState.get(feedName) !== state;
    const due = nowMs - (this.lastHeartbeatMs.get(feedName) ?? 0) >= this.heartbeatMs;
    if (!changed && !due && !patch.force) return;
    const registration = this.local.get(feedName);
    const row: Partial<MarketDataFeedLease> = {
      feedName,
      priority: patch.priority ?? registration?.priority ?? this.priorityFor(feedName, 1),
      universes: csv(patch.universes ?? registration?.universes ?? []),
      enabled: patch.enabled ?? (registration ? registration.enabled() : true),
      credentialsOk: patch.credentialsOk ?? (registration?.credentialsOk ? registration.credentialsOk() : true),
      state,
      host: this.host,
      pid: process.pid,
      lastTickAt: patch.lastTickAt ?? (registration?.ageMs() !== null && registration?.ageMs() !== undefined ? new Date(nowMs - (registration.ageMs() ?? 0)) : null),
      heartbeatAt: new Date(nowMs),
      note: patch.note ?? registration?.note ?? null,
    };
    try {
      // Bounded: on timeout/failure we do NOT record the beat as delivered, so
      // the next poll retries; the lease keeps its previous value and nothing is
      // half-written (the write is a single atomic upsert).
      await withTimeout(() => this.leases.upsert(row as MarketDataFeedLease, ['feedName']), this.dbTimeoutMs, `lease write ${feedName}`);
      this.lastHeartbeatMs.set(feedName, nowMs);
      this.lastState.set(feedName, state);
      this.cache = null;
    } catch (error) {
      // A failed/timed-out write is NOT a delivered beat (no lastHeartbeatMs, no
      // lastState), so the next poll retries and the previous lease value stands.
      // The dedicated connection is recycled so the retry gets a fresh socket: a
      // lease that cannot be renewed ages out of its TTL instead of staying fresh.
      this.leases.recycle?.(`lease write failed for ${feedName}`);
      const now2 = Date.now();
      if (now2 - this.lastFailOpenWarnMs > 300_000) {
        this.lastFailOpenWarnMs = now2;
        this.logger.warn(`[FEED-ARBITER] lease write failed for ${feedName}: ${(error as Error).message}`);
        this.logger.warnWithContext(`[FEED-ARBITER] lease write failed for ${feedName}`, {
          component: 'FeedArbitration',
          provider: feedName,
          errorCode: 'LEASE_WRITE_FAILED',
          operation: 'beat',
          message: (error as Error).message,
          recoveryAction: 'retry_next_poll',
          recovered: false,
        });
      }
    }
  }

  /** Heartbeat every locally registered feed (keeps standby feeds visible). */
  private async flushHeartbeats(): Promise<void> {
    if (!this.local.size) return;
    let decisions: OwnershipDecision[] = [];
    try {
      decisions = await this.decisions();
    } catch {
      decisions = [];
    }
    const owners = new Set(activeFeedNames(decisions));
    for (const name of this.local.keys()) {
      const owns = decisions.some((d) => d.owner === name);
      void this.beat(name, {
        state: owns ? 'ACTIVE' : owners.size ? 'STANDBY' : 'DOWN',
        note: owns ? null : 'standby — another feed owns the live slot for this universe',
      });
    }
  }

  async status(now = Date.now()): Promise<FeedArbitrationStatus> {
    const { decisions, candidates } = this.enabled ? await this.compute(now) : { decisions: [], candidates: [] as FeedArbitrationStatus['candidates'] };
    return {
      enabled: this.enabled,
      mode: this.mode,
      asOf: new Date(now).toISOString(),
      staleAfterMs: this.staleAfterMs,
      downAfterMs: this.downAfterMs,
      leaseTtlMs: this.leaseTtlMs,
      decisions,
      activeFeeds: activeFeedNames(decisions),
      unowned: unownedUniverses(decisions),
      candidates,
    };
  }
}
