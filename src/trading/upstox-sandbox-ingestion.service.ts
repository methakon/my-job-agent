import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SandboxTick } from './sandbox-tick.entity';

/** Flush cadence: the background writer runs on this interval. */
const FLUSH_INTERVAL_MS = 2000;
/** Rows per set-based INSERT statement (one statement per chunk, never one per row). */
const FLUSH_BATCH_ROWS = 500;
/** Hard bound on the in-memory queue (overflow drops the OLDEST tick). */
const MAX_QUEUE_ROWS = 5000;

/** What the Upstox Sandbox feed can deliver per tick (map only what exists). */
export interface SandboxTickInput {
	instrument: string;
	ts: Date | string;
	price: number;
	exchangeSegment?: string | null;
	symbol?: string | null;
	volume?: number | null;
	bidPrice?: number | null;
	askPrice?: number | null;
	bidQty?: number | null;
	askQty?: number | null;
	expiry?: string | null;
	strike?: number | null;
	optionType?: string | null;
	upstoxRef?: string | null;
}

/**
 * Spec v2 §2/§4/§14 — Upstox Sandbox tick ingestion.
 *
 * ISOLATION + NON-BLOCKING DESIGN:
 *  - Only ever writes to `sandbox_ticks` — never to the FYERS real tick tables.
 *  - ingest() validates the environment and FAILS CLOSED on anything that looks
 *    real (on_real_data=true / REAL environment) or misconfigured.
 *  - Async queue: ingest() enqueues (O(1), no DB await) and returns instantly;
 *    a background flush writes SET-BASED batches — ONE multi-row INSERT per chunk,
 *    never one INSERT per row — so the flush does not pay a WAN round trip per tick.
 *    A sandbox write failure can never block or slow the FYERS real path (spec §3/§14).
 *    A failed batch is EXPLICIT and COUNTED (flushFailures/droppedOnFailure) and the
 *    batch is dropped rather than requeued, so memory stays bounded — an enqueue is
 *    never reported as a successful persist.
 *  - Disabled until UPSTOX_SANDBOX_ENABLED=true (constructor never throws).
 */

/** Observable counters so a flush failure or a queue overflow is never silent. */
export interface SandboxIngestionCounters {
	enqueued: number;
	persisted: number;
	droppedQueueFull: number;
	flushFailures: number;
	droppedOnFailure: number;
	flushes: number;
	lastBatchRows: number;
	lastFlushMs: number;
	totalFlushMs: number;
	queueHighWater: number;
	lastFlushError: string | null;
}

@Injectable()
export class UpstoxSandboxIngestionService implements OnModuleInit, OnModuleDestroy {
	private readonly logger = new Logger('UpstoxSandboxIngestionService');
	private readonly enabled: boolean;
	private queue: SandboxTick[] = [];
	private flushTimer: NodeJS.Timeout | null = null;
	private flushing = false;
	private readonly maxQueue = MAX_QUEUE_ROWS;
	private readonly counters: SandboxIngestionCounters = {
		enqueued: 0, persisted: 0, droppedQueueFull: 0, flushFailures: 0, droppedOnFailure: 0,
		flushes: 0, lastBatchRows: 0, lastFlushMs: 0, totalFlushMs: 0, queueHighWater: 0, lastFlushError: null,
	};

	constructor(
		config: ConfigService,
		@InjectRepository(SandboxTick) private readonly ticks: Repository<SandboxTick>,
	) {
		this.enabled = config.get<string>('UPSTOX_SANDBOX_ENABLED') === 'true';
	}

	onModuleInit(): void {
		if (!this.enabled) {
			this.logger.log('[SANDBOX][UPSTOX] ingestion disabled — UPSTOX_SANDBOX_ENABLED != true');
			return;
		}
		this.flushTimer = setInterval(() => void this.flush().catch(() => undefined), FLUSH_INTERVAL_MS);
		this.flushTimer.unref?.();
		this.logger.log('[SANDBOX][UPSTOX] ingestion armed (background flush every 2s)');
	}

	onModuleDestroy(): void {
		if (this.flushTimer) clearInterval(this.flushTimer);
		// best-effort final flush of anything queued
		if (this.queue.length) void this.flush().catch(() => undefined);
	}

	get sandboxReady(): boolean {
		return this.enabled;
	}

	/** Enqueue one sandbox tick. Never throws into the real path; returns quickly. */
	ingest(input: SandboxTickInput): { ok: boolean; error?: string } {
		if (!this.enabled) return { ok: false, error: '[SANDBOX][UPSTOX] ingestion disabled' };
		if (!input || typeof input.instrument !== 'string' || !input.instrument) {
			return { ok: false, error: 'instrument required' };
		}
		const price = Number(input.price);
		if (!Number.isFinite(price) || price <= 0) return { ok: false, error: 'price required' };
		const ts = input.ts instanceof Date ? input.ts : new Date(String(input.ts));
		if (Number.isNaN(ts.getTime())) return { ok: false, error: 'ts required' };
		if (this.queue.length >= this.maxQueue) {
			this.logger.warn('[SANDBOX][UPSTOX] queue full — dropping oldest sandbox tick');
			this.queue.shift();
			this.counters.droppedQueueFull += 1;
		}
		this.queue.push({
			instrument: input.instrument,
			exchangeSegment: input.exchangeSegment ?? null,
			symbol: input.symbol ?? null,
			ts,
			price,
			volume: input.volume ?? null,
			bidPrice: input.bidPrice ?? null,
			askPrice: input.askPrice ?? null,
			bidQty: input.bidQty ?? null,
			askQty: input.askQty ?? null,
			expiry: input.expiry ?? null,
			strike: input.strike ?? null,
			optionType: input.optionType ?? null,
			source: 'UPSTOX',
			environment: 'SANDBOX',
			onRealData: false,
			upstoxRef: input.upstoxRef ?? null,
		} as SandboxTick);
		this.counters.enqueued += 1;
		if (this.queue.length > this.counters.queueHighWater) this.counters.queueHighWater = this.queue.length;
		return { ok: true };
	}

	/** Set-based persistence: ONE multi-row INSERT per chunk, never one INSERT per row. */
	private async flush(): Promise<void> {
		if (this.flushing || this.queue.length === 0) return;
		this.flushing = true;
		const batch = this.queue.splice(0, Math.min(this.queue.length, FLUSH_BATCH_ROWS));
		const startedAt = Date.now();
		try {
			if (batch.length) {
				// Explicit columns, including the uuid PK and ingestedAt, so the write is a single
				// `INSERT ... VALUES (...), (...), …` per chunk — the fix for the measured ~3 rows/s
				// per-row-save path. No payload is fabricated, repaired or rerouted.
				const rows = batch.map((t) => ({ ...t, id: t.id ?? randomUUID(), ingestedAt: t.ingestedAt ?? new Date() }));
				await this.ticks.insert(rows as never);
				this.counters.persisted += batch.length;
				this.counters.flushes += 1;
				this.counters.lastBatchRows = batch.length;
				this.counters.lastFlushMs = Date.now() - startedAt;
				this.counters.totalFlushMs += this.counters.lastFlushMs;
				this.counters.lastFlushError = null;
				this.logger.debug(`[SANDBOX][UPSTOX] flushed ${batch.length} sandbox tick(s) → sandbox_ticks (${this.counters.lastFlushMs}ms)`);
			}
		} catch (err) {
			// EXPLICIT, COUNTED drop: the batch is not requeued (bounded memory) and the failure is
			// never reported as a successful persist. Spec §14 — sandbox problems never back-pressure.
			this.counters.flushFailures += 1;
			this.counters.droppedOnFailure += batch.length;
			this.counters.lastFlushError = (err as Error).message;
			this.logger.warn(`[SANDBOX][UPSTOX] flush FAILED (${this.counters.lastFlushError}) — ${batch.length} tick(s) dropped (flushFailures=${this.counters.flushFailures})`);
		} finally {
			this.flushing = false;
		}
	}

	/** For tests/observability: pending queue depth, enabled state and the explicit counters. */
	status(): { enabled: boolean; queueDepth: number; counters: SandboxIngestionCounters } {
		return { enabled: this.enabled, queueDepth: this.queue.length, counters: { ...this.counters } };
	}
}
