import { Injectable } from '@nestjs/common';
import {
  DEFAULT_DOWN_AFTER_MS,
  DEFAULT_STALE_AFTER_MS,
  EngineGate,
  evaluateEngine,
  TradingEngine,
} from './feed-health.state';

/**
 * Runtime registry of live feed adapters feeding the health gate (brief s6/s8).
 *
 * Every process that can run an engine hosts this service. Feed adapters
 * register themselves with a last-tick-age provider; the engine loops
 * (session-driver for FnF today) ask gateFor(engine) before opening NEW
 * positions and hold when no feed is fresh. Recovery is automatic when a feed
 * starts producing fresh ticks again.
 */
@Injectable()
export class FeedHealthService {
  private readonly feeds = new Map<string, { engine: TradingEngine | TradingEngine[]; ageMs: () => number | null; enabled: () => boolean }>();
  private readonly staleAfterMs: number;
  private readonly downAfterMs: number;

  constructor() {
    this.staleAfterMs = Math.max(1_000, Number(process.env.MARKET_DATA_STALE_AFTER_MS ?? DEFAULT_STALE_AFTER_MS));
    this.downAfterMs = Math.max(this.staleAfterMs + 1_000, Number(process.env.MARKET_DATA_DOWN_AFTER_MS ?? DEFAULT_DOWN_AFTER_MS));
  }

  registerFeed(
    name: string,
    engine: TradingEngine | TradingEngine[],
    opts: { ageMs: () => number | null; enabled?: () => boolean },
  ): void {
    this.feeds.set(name, {
      engine,
      ageMs: opts.ageMs,
      enabled: opts.enabled ?? (() => true),
    });
  }

  unregisterFeed(name: string): void {
    this.feeds.delete(name);
  }

  /** Full status for observability/UI (all feeds, all engines). */
  status(): {
    asOf: Date;
    staleAfterMs: number;
    downAfterMs: number;
    feeds: { name: string; engine: TradingEngine | TradingEngine[]; ageMs: number | null; enabled: boolean }[];
  } {
    const asOf = new Date();
    const feeds = [...this.feeds.entries()].map(([name, feed]) => ({
      name,
      engine: feed.engine,
      ageMs: feed.ageMs(),
      enabled: feed.enabled(),
    }));
    return { asOf, staleAfterMs: this.staleAfterMs, downAfterMs: this.downAfterMs, feeds };
  }

  /** New-trading gate for one engine. */
  gateFor(engine: TradingEngine, now = new Date()): EngineGate {
    const feeds = [...this.feeds.entries()].map(([name, feed]) => ({
      name,
      engine: feed.engine,
      ageMs: feed.ageMs(),
      enabled: feed.enabled(),
    }));
    return evaluateEngine(feeds, this.staleAfterMs, this.downAfterMs, now, engine);
  }

  gateForFnf(): EngineGate {
    return this.gateFor('fnf');
  }
}
