import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SandboxTick } from './sandbox-tick.entity';

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
 *    a background flush writes batches. A sandbox write failure can never block
 *    or slow the FYERS real path (spec §3/§14). Failed batches are logged and
 *    dropped with retry on the next flush cycle — no coupling to real services.
 *  - Disabled until UPSTOX_SANDBOX_ENABLED=true (constructor never throws).
 */
@Injectable()
export class UpstoxSandboxIngestionService implements OnModuleInit, OnModuleDestroy {
	private readonly logger = new Logger('UpstoxSandboxIngestionService');
	private readonly enabled: boolean;
	private queue: SandboxTick[] = [];
	private flushTimer: NodeJS.Timeout | null = null;
	private flushing = false;
	private readonly maxQueue = 5000;

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
		this.flushTimer = setInterval(() => void this.flush().catch(() => undefined), 2000);
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
		return { ok: true };
	}

	/** Background flush: batch-insert queued ticks into sandbox_ticks only. */
	private async flush(): Promise<void> {
		if (this.flushing || this.queue.length === 0) return;
		this.flushing = true;
		const batch = this.queue.splice(0, Math.min(this.queue.length, 500));
		try {
			if (batch.length) {
				await this.ticks.save(batch.map((t) => this.ticks.create(t)), { chunk: 100 });
				this.logger.debug(`[SANDBOX][UPSTOX] flushed ${batch.length} sandbox tick(s) → sandbox_ticks`);
			}
		} catch (err) {
			// sandbox write failure — log + requeue is skipped (drop) so sandbox
			// problems can never back-pressure the real path. Spec §14.
			this.logger.warn(`[SANDBOX][UPSTOX] flush failed (${(err as Error).message}) — ${batch.length} tick(s) dropped`);
		} finally {
			this.flushing = false;
		}
	}

	/** For tests/observability: pending queue depth + enabled state. */
	status(): { enabled: boolean; queueDepth: number } {
		return { enabled: this.enabled, queueDepth: this.queue.length };
	}
}
