/**
 * Tick fan-out — the ONE boundary between the trading hot path and market-data persistence.
 *
 * WHY THIS EXISTS
 * ---------------
 * Today the canonical and desk writers await a MySQL write inside the tick path
 * (`unified-market-data.service.ts:229`, `fnf-option-chain.service.ts:198`,
 * `upstox-live-paper-market.service.ts:741`). Measured, that write costs ~287 ms p50 over the tunnel,
 * so persistence latency sits directly inside the decision path - including EXIT/stop-loss decisions.
 *
 * This module is the corrected shape: a canonical tick is handed to the trading engine FIRST and
 * SYNCHRONOUSLY, and only *enqueued* (an O(1) append into a bounded in-process ring) for persistence.
 * Redis and MySQL are strictly downstream of the hand-off; nothing here awaits them.
 *
 * INVARIANTS (asserted by scripts/tick-fanout.test.js)
 * ---------------------------------------------------
 * 1. `ingest()` is synchronous. It contains no `await` and creates no promise, so no persistence
 *    latency can be inherited by the caller. The decision callback has already run when it returns.
 * 2. The decision path NEVER drops: `decide` is invoked once per offered tick, even when the
 *    persistence queue is full, the sink is blocked forever, or the sink throws.
 * 3. Persistence is best-effort and bounded: overflow drops the NEWEST tick with a counted reason
 *    (keeping the persisted history gap-free up to the drop point) and never grows memory.
 * 4. The sink is invoked ONLY from `drain()`, one batch at a time (single-flight), and only from
 *    outside the hot path. A slow or dead sink degrades persistence only.
 * 5. A batch is removed from the queue only after the sink resolves, so a failed write stays
 *    recoverable in order (retry the same batch; no reordering, no loss).
 * 6. No clock, no timers, no I/O, no AI: the host schedules drains and supplies the clock
 *    (`drainBounded`), which keeps this boundary deterministic and testable under a hostile sink.
 *
 * NOT WIRED INTO PRODUCTION. Research/shadow only: no production module imports it, and enabling it
 * requires the deterministic canonical id prerequisite documented in docs/REDIS_HOT_PATH_OFFLOAD.md.
 */

export interface PersistenceSink<T> {
	/** Persist one batch. May be slow, may block, may throw - the hot path never sees it. */
	(batch: readonly T[]): Promise<void> | void;
}

export interface TickFanoutConfig {
	/** Hard cap on ticks queued for persistence. Memory is bounded by this, never by volume. */
	queueCapacity: number;
	/** Max ticks handed to the sink in one drain (the row half of the dual trigger). */
	maxBatchRows: number;
}

export const DEFAULT_FANOUT_CONFIG: TickFanoutConfig = { queueCapacity: 5_000, maxBatchRows: 100 };

export type DropReason = 'QUEUE_FULL';
export type DrainStatus = 'COMMITTED' | 'FAILED' | 'EMPTY' | 'IN_FLIGHT';

export interface TickFanoutCounters {
	/** Every tick offered to the boundary, whatever happens downstream. */
	offered: number;
	/** Decisions taken. Must always equal `offered`. */
	decided: number;
	/** Decision callbacks that threw (counted, never propagated into the ingest caller). */
	decisionErrors: number;
	enqueued: number;
	/** Ticks the persistence path had to discard (bounded, counted, reasoned). */
	droppedForPersistence: number;
	droppedReasons: Partial<Record<DropReason, number>>;
	persisted: number;
	persistBatches: number;
	persistErrors: number;
	queueDepth: number;
	peakQueueDepth: number;
	inFlight: boolean;
}

export interface DrainResult {
	status: DrainStatus;
	/** Rows in the batch handed to the sink (or 0 when nothing was attempted). */
	rows: number;
	/** The batch stayed queued and can be retried in order. */
	retryable: boolean;
}

export interface TickFanout<T> {
	/** HOT PATH. Decides now, queues for persistence. Never awaits, never throws. */
	ingest(tick: T, decide: (tick: T) => void): void;
	/** Persistence worker. One batch, single-flight, never throws. */
	drain(): Promise<DrainResult>;
	/** Bounded shutdown drain using an INJECTED clock so this module stays clock-free. */
	drainBounded(opts: { now: () => number; deadlineMs: number }): Promise<{ persisted: number; remaining: number; timedOut: boolean }>;
	counters(): TickFanoutCounters;
	/** Ticks still awaiting persistence (for shutdown/close reporting). */
	pending(): number;
}

export function createTickFanout<T>(
	sink: PersistenceSink<T>,
	config: Partial<TickFanoutConfig> = {},
	hooks: { onDrop?: (reason: DropReason, tick: T) => void; onDecisionError?: (error: unknown, tick: T) => void } = {},
): TickFanout<T> {
	const cfg: TickFanoutConfig = { ...DEFAULT_FANOUT_CONFIG, ...config };
	if (!Number.isInteger(cfg.queueCapacity) || cfg.queueCapacity < 1) throw new Error('tick-fanout: queueCapacity must be a positive integer');
	if (!Number.isInteger(cfg.maxBatchRows) || cfg.maxBatchRows < 1) throw new Error('tick-fanout: maxBatchRows must be a positive integer');
	if (cfg.maxBatchRows > cfg.queueCapacity) throw new Error('tick-fanout: maxBatchRows cannot exceed queueCapacity');

	const ring: Array<T | undefined> = new Array(cfg.queueCapacity);
	let head = 0; // oldest unpersisted
	let tail = 0; // next write position
	let inFlight = false;
	const c: TickFanoutCounters = {
		offered: 0, decided: 0, decisionErrors: 0, enqueued: 0, droppedForPersistence: 0, droppedReasons: {},
		persisted: 0, persistBatches: 0, persistErrors: 0, queueDepth: 0, peakQueueDepth: 0, inFlight: false,
	};

	const depth = (): number => tail - head;
	const refresh = (): void => {
		c.queueDepth = depth();
		c.inFlight = inFlight;
		if (c.queueDepth > c.peakQueueDepth) c.peakQueueDepth = c.queueDepth;
	};
	refresh();

	const api: TickFanout<T> = {
		ingest(tick: T, decide: (tick: T) => void): void {
			c.offered += 1;

			// 1) DECISION PATH FIRST, synchronously. Nothing below can delay it, and an exception in a
			//    decision callback must not damage the ingest contract either.
			try {
				decide(tick);
				c.decided += 1;
			} catch (error) {
				c.decisionErrors += 1;
				try { hooks.onDecisionError?.(error, tick); } catch { /* never propagate: the hot path must survive */ }
			}

			// 2) PERSISTENCE HAND-OFF: O(1) append. No await, no promise, no throw. If the queue is
			//    full, the NEWEST tick is dropped (counted) so the persisted history keeps its order and
			//    stays gap-free up to the drop point - a decision is never dropped for this reason.
			if (depth() >= cfg.queueCapacity) {
				c.droppedForPersistence += 1;
				c.droppedReasons.QUEUE_FULL = (c.droppedReasons.QUEUE_FULL ?? 0) + 1;
				try { hooks.onDrop?.('QUEUE_FULL', tick); } catch { /* as above */ }
				refresh();
				return;
			}
			ring[tail % cfg.queueCapacity] = tick;
			tail += 1;
			c.enqueued += 1;
			refresh();
		},

		async drain(): Promise<DrainResult> {
			if (inFlight) return { status: 'IN_FLIGHT', rows: 0, retryable: true };
			const available = depth();
			if (available === 0) return { status: 'EMPTY', rows: 0, retryable: false };

			// peek only: the batch leaves the queue when (and only when) the sink resolves, so a failed
			// write is recoverable in order instead of being lost or reordered.
			const rows = Math.min(available, cfg.maxBatchRows);
			const batch: T[] = [];
			for (let i = 0; i < rows; i += 1) batch.push(ring[(head + i) % cfg.queueCapacity] as T);

			inFlight = true;
			refresh();
			try {
				await sink(batch);
				head += rows;
				for (let i = 0; i < rows; i += 1) ring[(head - 1 - i) % cfg.queueCapacity] = undefined;
				c.persisted += rows;
				c.persistBatches += 1;
				return { status: 'COMMITTED', rows, retryable: false };
			} catch {
				c.persistErrors += 1;
				return { status: 'FAILED', rows: 0, retryable: true };
			} finally {
				inFlight = false;
				refresh();
			}
		},

		async drainBounded({ now, deadlineMs }): Promise<{ persisted: number; remaining: number; timedOut: boolean }> {
			const startedAt = now();
			const before = c.persisted;
			while (depth() > 0 && now() - startedAt < deadlineMs) {
				const r = await api.drain();
				if (r.status === 'FAILED') break; // stay recoverable; the host reports the remainder
			}
			const remaining = depth();
			refresh();
			return { persisted: c.persisted - before, remaining, timedOut: remaining > 0 };
		},

		counters(): TickFanoutCounters {
			refresh();
			return { ...c, droppedReasons: { ...c.droppedReasons } };
		},

		pending(): number {
			return depth();
		},
	};

	return api;
}
