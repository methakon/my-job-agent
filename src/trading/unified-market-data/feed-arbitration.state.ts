/**
 * Single-active-feed arbitration (brief s2/s6 — PRIMARY FYERS, SECONDARY Upstox).
 *
 * Requirement it encodes: the two paper desks keep SEPARATE trades and balances,
 * may CONSUME each other's live ticks, but only ONE feed PRODUCES ticks for any
 * given instrument universe at a time. Two producers on one universe is exactly
 * how the store collected ~39 % duplicate ticks; ownership makes that
 * structurally impossible.
 *
 * Stateless and pure over inputs (like feed-health.state): given each feed's
 * priority, coverage (which underlyings it can price), enablement, credential
 * validity and latest-tick age, it elects exactly one owner per universe.
 *
 * Ownership rule
 *   1. candidates = enabled && credentialsOk && covers(universe)
 *   2. no candidate  -> no owner (the desk must PAUSE, never invent prices)
 *   3. eligible = candidates not DOWN (never ticked / past downAfterMs)
 *      - eligible empty (every candidate is DOWN) -> all candidates eligible,
 *        so the highest-priority feed may retry the moment it recovers
 *   4. owner = eligible ranked by state (FRESH > STALE > DOWN), then priority
 *      (lower wins), then freshest tick, then name — deterministic, no flapping
 *   5. everyone else that covers the universe is STANDBY for it
 *
 * Coverage matters: a feed that only carries an INDEX snapshot does not own the
 * underlying's OPTION universe. That is why SENSEX options stay with the Upstox
 * REST secondary today — the FYERS WS subscribes no SENSEX option legs — and why
 * ownership passes to FYERS automatically the moment its symbol list includes
 * SENSEX CE/PE legs (no expiry is ever hard-coded; coverage is derived from the
 * configured symbol list).
 */

export type ArbitrationMode = 'universe' | 'global';

/** One feed that could produce ticks (own process or a sibling process). */
export type FeedCandidate = {
  /** Stable feed identity, e.g. FYERS_WS | UPSTOX_REST. */
  name: string;
  /** Lower wins. PRIMARY FYERS 0, SECONDARY Upstox REST 1. */
  priority: number;
  /** Configured/enabled on the host that runs it. */
  enabled: boolean;
  /** Live credentials present and unexpired. */
  credentialsOk: boolean;
  /** Underlyings this feed can price (short names). ['*'] = every universe. */
  universes: string[];
  /** Age of its newest observation in ms, null when it has never produced. */
  ageMs: number | null;
};

export type OwnershipDecision = {
  universe: string;
  /** The single feed allowed to produce ticks for this universe (null = pause). */
  owner: string | null;
  /** Enabled feeds that cover the universe but must NOT produce for it. */
  standby: string[];
  /** Every feed that covers the universe, ranked as evaluated. */
  ranked: string[];
  reason: string;
};

export type ArbitrationOptions = {
  staleAfterMs: number;
  downAfterMs: number;
  /** 'universe' (per-underlying ownership) or 'global' (one feed, whole market). */
  mode: ArbitrationMode;
};

export const DEFAULT_FEED_STALE_AFTER_MS = 10_000;
export const DEFAULT_FEED_DOWN_AFTER_MS = 60_000;
/** Whole-market wildcard coverage. */
export const ANY_UNIVERSE = '*';

type FeedState = 'FRESH' | 'STALE' | 'DOWN';

const stateOf = (ageMs: number | null, staleAfterMs: number, downAfterMs: number): FeedState => {
  if (ageMs === null) return 'DOWN';
  if (ageMs <= staleAfterMs) return 'FRESH';
  if (ageMs <= downAfterMs) return 'STALE';
  return 'DOWN';
};

const STATE_RANK: Record<FeedState, number> = { FRESH: 0, STALE: 1, DOWN: 2 };

/** 'BSE_INDEX|SENSEX' | 'NSE:NIFTY50-INDEX' | 'SENSEX' -> 'SENSEX' | 'NIFTY50'. */
export const shortUniverse = (value: string): string =>
  String(value ?? '')
    .trim()
    .split('|')
    .pop()!
    .split(':')
    .pop()!
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

/**
 * Underlying of an OPTION contract symbol: NIFTY26SEP23900CE -> NIFTY,
 * BANKNIFTY26SEP57400CE -> BANKNIFTY. Index symbols (…-INDEX) return null —
 * an index snapshot is not option coverage.
 */
export const underlyingOfOptionSymbol = (symbol: string): string | null => {
  const raw = String(symbol ?? '').trim();
  if (!raw) return null;
  const tail = raw.split(':').pop() ?? raw;
  const m = tail.toUpperCase().match(/^([A-Z]+?)\d{2}[A-Z]{3}\d+(CE|PE)$/);
  return m ? m[1] : null;
};

/**
 * Option universes a producer is configured to serve, derived from its symbol
 * list (never hard-coded). NSE:NIFTY50-INDEX contributes nothing; NSE:NIFTY26SEP23900CE
 * contributes NIFTY.
 */
export const optionUniversesFromSymbols = (symbols: readonly string[]): string[] => {
  const out = new Set<string>();
  for (const symbol of symbols ?? []) {
    const underlying = underlyingOfOptionSymbol(symbol);
    if (underlying) out.add(underlying);
  }
  return [...out].sort();
};

/**
 * Universes for arbitration/pattern-tracking from arbitrary config keys.
 *
 * Accepts BOTH shapes the app actually stores: option contract keys
 * (NIFTY26SEP23900CE -> NIFTY) and index keys (BSE_INDEX|SENSEX -> SENSEX).
 * The strict option-only parser returns nothing for an index key, which once
 * made a desk register zero universes and then stand down against nobody —
 * i.e. it silently stopped polling its own feed.
 */
export const trackedUniversesFromSymbols = (symbols: readonly string[]): string[] => {
  const out = new Set<string>();
  for (const symbol of symbols ?? []) {
    const universe = underlyingOfOptionSymbol(symbol) ?? shortUniverse(symbol);
    if (universe) out.add(universe);
  }
  return [...out].sort();
};

/** Whether a candidate serves this universe (wildcard feeds serve all). */
export const covers = (candidate: Pick<FeedCandidate, 'universes'>, universe: string): boolean =>
  candidate.universes.includes(ANY_UNIVERSE) || candidate.universes.includes(universe);

const rank = (
  candidates: FeedCandidate[],
  universe: string,
  opts: ArbitrationOptions,
): FeedCandidate[] =>
  [...candidates].sort((a, b) => {
    const sa = STATE_RANK[stateOf(a.ageMs, opts.staleAfterMs, opts.downAfterMs)];
    const sb = STATE_RANK[stateOf(b.ageMs, opts.staleAfterMs, opts.downAfterMs)];
    if (sa !== sb) return sa - sb;
    if (a.priority !== b.priority) return a.priority - b.priority;
    const aa = a.ageMs ?? Number.POSITIVE_INFINITY;
    const ba = b.ageMs ?? Number.POSITIVE_INFINITY;
    if (aa !== ba) return aa - ba;
    return a.name.localeCompare(b.name);
  });

/**
 * Elect one owner per universe. Never returns two owners for one universe, and
 * never returns an owner that does not cover it.
 */
export function decideOwnership(
  universes: readonly string[],
  feeds: readonly FeedCandidate[],
  opts: ArbitrationOptions,
): OwnershipDecision[] {
  const wanted = [...new Set((universes ?? []).map(shortUniverse).filter(Boolean))].sort();

  if (opts.mode === 'global') {
    // One feed for the whole market: the highest-priority enabled+credentialed feed
    // that covers ANY of the wanted universes. Everything else stands by.
    const anyCovering = feeds.filter(
      (feed) => feed.enabled && feed.credentialsOk && wanted.some((u) => covers(feed, u)),
    );
    const ranked = rank(anyCovering, wanted[0] ?? ANY_UNIVERSE, opts);
    const owner = ranked[0] ?? null;
    return wanted.map((universe) => {
      const covering = feeds.filter(
        (feed) => feed.enabled && feed.credentialsOk && covers(feed, universe),
      );
      if (!covering.length) {
        return {
          universe,
          owner: null,
          standby: [],
          ranked: [],
          reason: `no enabled feed covers ${universe} — new trading paused`,
        };
      }
      const winner = owner && covers(owner, universe) ? owner : null;
      return {
        universe,
        owner: winner?.name ?? null,
        standby: covering.filter((f) => f.name !== winner?.name).map((f) => f.name),
        ranked: rank(covering, universe, opts).map((f) => f.name),
        reason: winner
          ? `global exclusivity — ${winner.name} owns the live feed`
          : 'global exclusivity — no feed owns the live slot',
      };
    });
  }

  return wanted.map((universe) => {
    const covering = feeds.filter(
      (feed) => feed.enabled && feed.credentialsOk && covers(feed, universe),
    );
    if (!covering.length) {
      return {
        universe,
        owner: null,
        standby: [],
        ranked: [],
        reason: `no enabled feed covers ${universe} — new trading paused`,
      };
    }

    const eligible = covering.filter(
      (feed) => stateOf(feed.ageMs, opts.staleAfterMs, opts.downAfterMs) !== 'DOWN',
    );
    // Nothing is alive: let the highest-priority candidate hold the slot so it
    // starts producing the instant it recovers (and nobody else duplicates it).
    const pool = eligible.length ? eligible : covering;
    const ranked = rank(pool, universe, opts);
    const winner = ranked[0];

    const failedOver = eligible.length > 0 && winner.priority > Math.min(...covering.map((f) => f.priority));
    const reason = eligible.length
      ? failedOver
        ? `failed over to ${winner.name} — higher-priority feed(s) not producing`
        : `${winner.name} owns ${universe} (priority ${winner.priority})`
      : `no feed is producing for ${universe} — ${winner.name} holds the slot and must reconnect`;

    return {
      universe,
      owner: winner.name,
      standby: covering.filter((f) => f.name !== winner.name).map((f) => f.name),
      ranked: ranked.map((f) => f.name),
      reason,
    };
  });
}

/** The universe a feed is allowed to produce for (empty = stand by / pause). */
export function ownedUniverses(
  feedName: string,
  universes: readonly string[],
  decisions: readonly OwnershipDecision[],
): string[] {
  const wanted = new Set(universes.map(shortUniverse));
  return decisions
    .filter((d) => d.owner === feedName && wanted.has(d.universe))
    .map((d) => d.universe)
    .sort();
}

/** Whether a feed may produce for at least one of these universes. */
export function mayProduce(
  feedName: string,
  universes: readonly string[],
  decisions: readonly OwnershipDecision[],
): boolean {
  return ownedUniverses(feedName, universes, decisions).length > 0;
}

/** Every universe with no owner — new trading must pause for these. */
export function unownedUniverses(decisions: readonly OwnershipDecision[]): string[] {
  return decisions.filter((d) => d.owner === null).map((d) => d.universe);
}

/** Feeds currently holding at least one universe (the producing set). */
export function activeFeedNames(decisions: readonly OwnershipDecision[]): string[] {
  return [...new Set(decisions.map((d) => d.owner).filter((n): n is string => Boolean(n)))].sort();
}
