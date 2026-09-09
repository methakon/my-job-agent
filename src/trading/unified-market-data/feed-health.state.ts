/**
 * Pure market-data feed health machine (brief s6/s8).
 *
 * Stateless over inputs: given each registered feed's latest-tick age it
 * derives per-feed state (FRESH/STALE/DOWN) and the overall gate
 * (HEALTHY/STALE_ONLY/DOWN). Recovery is automatic by construction — when a
 * feed produces fresh ticks again it returns to FRESH on the next evaluation;
 * no timers, no persistent state, trivially testable.
 *
 * Decision rule (s8): NEW trading is allowed ONLY while at least one of the
 * engine's feeds is FRESH. STALE-only or DOWN ⇒ pause new entries. Existing
 * positions are never force-closed by this machine (position exits stay
 * possible as long as their own price source is readable).
 */

export type FeedState = 'FRESH' | 'STALE' | 'DOWN';
export type OverallFeedState = 'HEALTHY' | 'STALE_ONLY' | 'DOWN';
export type TradingEngine = 'fnf' | 'upstox-paper';

export type FeedHealthInput = {
  /** Feed name (e.g. FYERS_LIVE, UPSTOX_LIVE). */
  name: string;
  engine: TradingEngine | TradingEngine[];
  /** Age of the newest observation in ms, or null when never observed. */
  ageMs: number | null;
  /** Whether the feed is enabled on this host at all. */
  enabled: boolean;
};

export type FeedHealthOutput = {
  name: string;
  engine: TradingEngine | TradingEngine[];
  state: FeedState;
  ageMs: number | null;
  enabled: boolean;
};

export type EngineGate = {
  engine: TradingEngine;
  allowNewTrading: boolean;
  overall: OverallFeedState | 'NO_FEED';
  reason: string;
  asOf: Date;
  feeds: FeedHealthOutput[];
};

export const DEFAULT_STALE_AFTER_MS = 10_000;
export const DEFAULT_DOWN_AFTER_MS = 60_000;

export function stateForFeed(ageMs: number | null, staleAfterMs: number, downAfterMs: number): FeedState {
  if (ageMs === null) return 'DOWN';
  if (ageMs <= staleAfterMs) return 'FRESH';
  if (ageMs <= downAfterMs) return 'STALE';
  return 'DOWN';
}

/** Overall state + new-trading gate across one engine's feeds. */
export function evaluateEngine(
  feeds: FeedHealthInput[],
  staleAfterMs: number,
  downAfterMs: number,
  asOf: Date,
  engine: TradingEngine,
): EngineGate {
  const own = feeds.filter((feed) => feed.enabled && (feed.engine === engine || (Array.isArray(feed.engine) && feed.engine.includes(engine))));
  const outputs: FeedHealthOutput[] = feeds
    .filter((feed) => feed.engine === engine || (Array.isArray(feed.engine) && feed.engine.includes(engine)))
    .map((feed) => ({
      name: feed.name,
      engine: feed.engine,
      state: feed.enabled ? stateForFeed(feed.ageMs, staleAfterMs, downAfterMs) : 'DOWN',
      ageMs: feed.ageMs,
      enabled: feed.enabled,
    }));

  if (own.length === 0) {
    return {
      engine,
      allowNewTrading: false,
      overall: 'NO_FEED',
      reason: 'no market-data feed enabled for engine',
      asOf,
      feeds: outputs,
    };
  }

  const fresh = outputs.some((f) => f.state === 'FRESH');
  const anyLive = outputs.some((f) => f.state === 'FRESH' || f.state === 'STALE');

  if (fresh) {
    return { engine, allowNewTrading: true, overall: 'HEALTHY', reason: 'fresh market data', asOf, feeds: outputs };
  }
  if (anyLive) {
    return {
      engine,
      allowNewTrading: false,
      overall: 'STALE_ONLY',
      reason: 'market data stale — no fresh feed within the stale window; new entries paused',
      asOf,
      feeds: outputs,
    };
  }
  return {
    engine,
    allowNewTrading: false,
    overall: 'DOWN',
    reason: 'market data down — all feeds disconnected or never connected; new entries paused',
    asOf,
    feeds: outputs,
  };
}

export const MARKET_DATA_PAUSE_REASON = 'PAUSED_NO_FRESH_DATA';
