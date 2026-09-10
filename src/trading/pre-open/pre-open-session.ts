/**
 * GATE 2 — NSE/BSE pre-open session phase model.
 *
 * PURE: every function takes the instant it must judge. No Date.now(), no
 * module-level clock reads — a replay of historical observations and a live poll
 * therefore run the exact same code path (item 14, deterministic replay).
 *
 * PHASE vs DATA (mandatory distinction, item 8):
 *   A session phase label is NOT evidence that auction data exists. phase says
 *   "the exchange calendar is in window X at instant T"; whether IEP / buy qty /
 *   sell qty were actually captured is decided separately by field quality in
 *   pre-open-features.ts. Never infer data presence from a phase label.
 *
 * Exchange timings below are the NSE/BSE pre-open schedule (IST wall clock) and
 * are exchange calendar facts, not tunable trading thresholds:
 *   09:00–09:08  PRE_OPEN      order entry / auction collection
 *   09:08–09:15  OPEN_AUCTION  matching, indicative equilibrium published
 *   09:15–15:30  MARKET_OPEN   continuous trading
 *   15:30–16:00  POST_OPEN     post-close session
 * Unknown holidays are NOT modelled here — the broker's own market status is the
 * authority and is recorded alongside (phaseFromBrokerStatus). A holiday simply
 * yields no auction fields, which quality flags as UNAVAILABLE, never a guess.
 */

export type SessionPhase = 'PRE_OPEN' | 'OPEN_AUCTION' | 'MARKET_OPEN' | 'POST_OPEN' | 'CLOSED' | 'UNKNOWN';

/** Broker publishable market states (Upstox /v2/market/status). */
export type BrokerMarketStatus =
  | 'PRE_OPEN_START' | 'PRE_OPEN_END' | 'NORMAL_OPEN' | 'NORMAL_CLOSE'
  | 'CLOSING_START' | 'CLOSING_END' | string;

export const IST_OFFSET_MS = 5.5 * 3_600_000;

export const PRE_OPEN_START_MIN = 9 * 60; // 09:00
export const OPEN_AUCTION_START_MIN = 9 * 60 + 8; // 09:08
export const MARKET_OPEN_START_MIN = 9 * 60 + 15; // 09:15
export const MARKET_CLOSE_MIN = 15 * 60 + 30; // 15:30
export const POST_OPEN_END_MIN = 16 * 60; // 16:00

/** The only phases in which auction/IEP values are meaningful. */
export const AUCTION_PHASES: SessionPhase[] = ['PRE_OPEN', 'OPEN_AUCTION'];

export const isAuctionPhase = (phase: SessionPhase): boolean => AUCTION_PHASES.includes(phase);

/** IST calendar fields for an instant (ms since epoch). */
export function istParts(ms: number): { year: number; month: number; day: number; weekday: number; minutes: number } {
  const d = new Date(ms + IST_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    weekday: d.getUTCDay(),
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
  };
}

/** 'YYYY-MM-DD' session date in IST — the market's own calendar day. */
export const istDateString = (ms: number): string => {
  const p = istParts(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
};

/** Minutes since IST midnight (used for boundary tests). */
export const istMinutes = (ms: number): number => istParts(ms).minutes;

/** Mon–Fri in IST. Holidays are not modelled here (see header). */
export const isTradingWeekday = (ms: number): boolean => {
  const wd = istParts(ms).weekday;
  return wd >= 1 && wd <= 5;
};

/**
 * Exchange-calendar phase at an instant. Weekends are CLOSED. Outside the
 * windows below the session is CLOSED (this is a calendar fact, not a
 * "no data" judgement).
 */
export function sessionPhaseAt(ms: number): SessionPhase {
  if (!Number.isFinite(ms)) return 'UNKNOWN';
  if (!isTradingWeekday(ms)) return 'CLOSED';
  const m = istMinutes(ms);
  if (m < PRE_OPEN_START_MIN) return 'CLOSED';
  if (m < OPEN_AUCTION_START_MIN) return 'PRE_OPEN';
  if (m < MARKET_OPEN_START_MIN) return 'OPEN_AUCTION';
  if (m < MARKET_CLOSE_MIN) return 'MARKET_OPEN';
  if (m < POST_OPEN_END_MIN) return 'POST_OPEN';
  return 'CLOSED';
}

/**
 * Broker-published status → phase. Unknown/absent values are 'UNKNOWN' (never
 * guessed into a phase). This is a SECONDARY label recorded next to the clock
 * phase so a reviewer can see both the calendar and the exchange's own view.
 */
export function phaseFromBrokerStatus(status: BrokerMarketStatus | null | undefined): SessionPhase | 'UNKNOWN' {
  const s = String(status ?? '').trim().toUpperCase();
  switch (s) {
    case 'PRE_OPEN_START':
    case 'PRE_OPEN':
      return 'PRE_OPEN';
    case 'PRE_OPEN_END':
      return 'OPEN_AUCTION';
    case 'NORMAL_OPEN':
      return 'MARKET_OPEN';
    case 'CLOSING_START':
    case 'NORMAL_CLOSE':
    case 'CLOSING_END':
      return 'POST_OPEN';
    default:
      return 'UNKNOWN';
  }
}

/**
 * The phase recorded on an observation: the clock phase is authoritative for
 * the session date/window, the broker status is kept as provenance. When the
 * two disagree the observation still records the clock phase and the mismatch
 * is visible in fieldQuality.brokerPhase / sourceStatus.
 */
export function resolvePhase(clockPhase: SessionPhase, brokerPhase: SessionPhase | 'UNKNOWN'): SessionPhase {
  if (clockPhase === 'UNKNOWN') return brokerPhase === 'UNKNOWN' ? 'UNKNOWN' : brokerPhase;
  return clockPhase;
}
