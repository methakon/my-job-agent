/**
 * Capture-integrity rules for the Upstox OI capture (research-only).
 *
 * The OI research archive records WHAT the provider said but, until now, not
 * enough to say WHEN the market said it, or whether a row is a genuine print.
 * The poller runs 24x7 with no session gate; after the bell the provider keeps
 * serving its frozen close value, so `ts` (CAPTURE time, the host clock at parse
 * time) advances over stale market data. Measured 2026-09-14: 53.8% (NIFTY) to
 * 71.6% (SENSEX) of a weekday's rows fall outside 09:15-15:30 IST, and 100% of
 * the Saturday capture does.
 *
 * These rules are DELIBERATELY derived at READ time from recorded facts rather
 * than stamped into history at write time, because:
 *   * "fresh" is a property of the observation, not of the row. A rule that is
 *     later found wrong must be correctable without rewriting evidence.
 *   * a stored classification would itself be an unverifiable claim, exactly the
 *     kind of thing this archive exists to avoid.
 *
 * Nothing here is a provider claim. `REPEATED` says "our capture recorded the
 * same payload twice", never "the market did not move" — the provider may simply
 * not have re-published. `UNKNOWN` is reported when no recorded fact supports a
 * verdict; it is never guessed.
 */

export const CAPTURE_INTEGRITY_VERSION = 'capture-integrity-v1';

/** IST is UTC+05:30 with no DST — the market's calendar, not the host clock's. */
export const IST_OFFSET_MS = 5.5 * 3_600_000;

/** The observation session: 09:15 open to the 15:30 bell. */
export const IST_SESSION_OPEN_MINUTES = 9 * 60 + 15;
export const IST_SESSION_CLOSE_MINUTES = 15 * 60 + 30;

export type CaptureObservationClass =
  /** Inside the session with evidence the provider re-published (payload/timestamp advanced). */
  | 'GENUINE'
  /** Inside the session, but our capture recorded a byte-identical payload to the previous one. */
  | 'REPEATED'
  /** Captured outside a real session: the provider's frozen/settled value, not a live observation. */
  | 'OUTSIDE_SESSION'
  /** Inside the session with nothing recorded that distinguishes a print from a repeat. */
  | 'UNKNOWN';

/**
 * Which calendar decided session membership. Reported on every verdict so a
 * consumer can see whether holidays were resolvable instead of assuming they
 * were. `WEEKDAY_RULE_ONLY` means no authoritative calendar was supplied, so a
 * weekday HOLIDAY cannot be told from a trading day by time alone.
 */
export type SessionCalendar = 'AUTHORITATIVE' | 'WEEKDAY_RULE_ONLY';

export interface CaptureObservationInput {
  /** Capture time — when the capture wrote the row. NOT market time. */
  ts: Date | number | string;
  /** The provider's own quote time, when it published one. */
  providerTs?: Date | number | string | null;
  /** sha256 of the raw provider payload for this row, when computed. */
  payloadHash?: string | null;
  /** Same three facts for the PREVIOUS observation of the SAME contract. */
  previousProviderTs?: Date | number | string | null;
  previousPayloadHash?: string | null;
  /**
   * Optional AUTHORITATIVE session calendar: true when the IST date is a real
   * trading session. Only a caller holding the actual calendar (or the broker's
   * own market status, which is the authority) can supply this — it is the only
   * way to classify a weekday holiday correctly. When absent, the verdict says
   * it fell back to the weekday rule.
   */
  isTradingSessionDate?: (istDate: string) => boolean;
}

export interface CaptureObservationVerdict {
  version: string;
  class: CaptureObservationClass;
  /** Why, in the terms the recorded facts actually support. */
  reason: string;
  /** IST trading date this capture belongs to. */
  captureSessionDate: string;
  /** IST wall-clock minute-of-day of the capture. */
  captureMinuteOfDay: number;
  insideSession: boolean;
  /** Which rule decided session membership for this verdict. */
  sessionCalendar: SessionCalendar;
}

const toMs = (value: Date | number | string): number | null => {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
};

const istDateString = (ms: number): string => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);

const istMinuteOfDay = (ms: number): number => {
  const shifted = new Date(ms + IST_OFFSET_MS);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
};

/** 0 = Sunday … 6 = Saturday, in IST. */
const istDayOfWeek = (ms: number): number => new Date(ms + IST_OFFSET_MS).getUTCDay();

/**
 * Classify ONE captured observation from recorded facts only.
 *
 * Session membership comes first and is decided from CAPTURE time: a post-close
 * row is not a live observation no matter what it contains, and the fact that the
 * provider re-published a frozen value does not make it live.
 */
export function classifyCaptureObservation(input: CaptureObservationInput): CaptureObservationVerdict {
  const tsMs = toMs(input.ts);
  const sessionCalendar: SessionCalendar = input.isTradingSessionDate ? 'AUTHORITATIVE' : 'WEEKDAY_RULE_ONLY';
  const base = {
    version: CAPTURE_INTEGRITY_VERSION,
    captureSessionDate: tsMs === null ? 'UNKNOWN' : istDateString(tsMs),
    captureMinuteOfDay: tsMs === null ? -1 : istMinuteOfDay(tsMs),
    sessionCalendar,
  };

  if (tsMs === null) {
    return { ...base, class: 'UNKNOWN', insideSession: false, reason: 'no readable capture timestamp' };
  }

  // A weekend is never a trading session — that is a property of the calendar,
  // not a guess, and it is why time-of-day alone is not sufficient.
  const day = istDayOfWeek(tsMs);
  if (day === 0 || day === 6) {
    return {
      ...base,
      class: 'OUTSIDE_SESSION',
      insideSession: false,
      reason: `captured on ${day === 0 ? 'a Sunday' : 'a Saturday'} — no session exists on this date`,
    };
  }

  if (input.isTradingSessionDate && !input.isTradingSessionDate(base.captureSessionDate)) {
    return {
      ...base,
      class: 'OUTSIDE_SESSION',
      insideSession: false,
      reason: `captured on ${base.captureSessionDate}, which the supplied calendar reports as NOT a trading session`,
    };
  }

  const insideSession =
    base.captureMinuteOfDay >= IST_SESSION_OPEN_MINUTES && base.captureMinuteOfDay <= IST_SESSION_CLOSE_MINUTES;

  if (!insideSession) {
    return {
      ...base,
      class: 'OUTSIDE_SESSION',
      insideSession: false,
      reason: `captured at IST minute-of-day ${base.captureMinuteOfDay}, outside the 09:15-15:30 session`,
    };
  }

  const payload = input.payloadHash ?? null;
  const previousPayload = input.previousPayloadHash ?? null;
  if (payload !== null && previousPayload !== null) {
    return payload === previousPayload
      ? { ...base, class: 'REPEATED', insideSession: true, reason: 'in session: byte-identical payload to the previous capture of this contract' }
      : { ...base, class: 'GENUINE', insideSession: true, reason: 'in session: payload differs from the previous capture of this contract' };
  }

  const providerTsMs = input.providerTs === undefined || input.providerTs === null ? null : toMs(input.providerTs);
  const previousProviderTsMs =
    input.previousProviderTs === undefined || input.previousProviderTs === null ? null : toMs(input.previousProviderTs);
  if (providerTsMs !== null) {
    if (previousProviderTsMs !== null && providerTsMs === previousProviderTsMs) {
      return { ...base, class: 'REPEATED', insideSession: true, reason: 'in session: provider quote time unchanged since the previous capture' };
    }
    return {
      ...base,
      class: 'GENUINE',
      insideSession: true,
      reason: previousProviderTsMs === null
        ? 'in session: provider quote time present (no comparable previous observation)'
        : 'in session: provider quote time advanced since the previous capture',
    };
  }

  return {
    ...base,
    class: 'UNKNOWN',
    insideSession: true,
    reason: 'in session, but the provider published no quote time and no payload identity was recorded — a print cannot be told from a repeat',
  };
}

/**
 * What `upstox_live_paper_option_quotes.oiChange` actually is.
 *
 * ESTABLISHED from captured evidence, not assumed: `oiChange` =
 * `openInterest - prevOi`, where `prevOi` is the PROVIDER's own reference.
 *
 * EVIDENCE (2026-09-14, one contract, 5,179 rows, 27h window):
 *   * `openInterest - oiChange` took exactly 2 distinct values while
 *     `openInterest` took 92 — so the subtrahend is a near-fixed provider
 *     reference, NOT the previous snapshot's OI (a per-tick delta would have made
 *     those counts equal).
 *   * Restricted to the 11-Sep session alone (1,385 rows) the reference took
 *     exactly ONE value while `openInterest` took 87.
 *   * The single reference change happened between 04:23:36 and 10:42:38 IST and
 *     then held across the whole session and after the close.
 *
 * STILL UNKNOWN: the exact provider rule that sets `prevOi` (previous session's
 * close vs some other daily reference). We therefore treat it as
 * PROVIDER_REFERENCE_RELATIVE and do NOT equate it with any named interval.
 */
export const DELTA_OI_SEMANTICS = {
  version: CAPTURE_INTEGRITY_VERSION,
  field: 'upstox_live_paper_option_quotes.oiChange',
  definition: 'openInterest - prevOi, where prevOi is the PROVIDER\'s own previous-OI reference',
  class: 'PROVIDER_REFERENCE_RELATIVE',
  isSnapshotToSnapshotDelta: false,
  evidence: [
    'one contract, 5,179 rows, 27h: distinct(openInterest - oiChange) = 2 while distinct(openInterest) = 92',
    'same contract, 11-Sep session only, 1,385 rows: distinct(openInterest - oiChange) = 1 while distinct(openInterest) = 87',
    'the provider reference changed once (between 04:23:36 and 10:42:38 IST) and then held across the session and the close',
  ],
  unknown: 'the exact provider rule that sets prevOi (previous session close vs provider daily reference) is not established',
  allowedUse: 'features whose OI interval matches the provider-reference interval; compare like-for-like only',
  forbiddenUse: [
    'pairing it with a per-observation (tick-to-tick) price move — the two sides then measure different intervals',
    'OI-level migration measured per observation',
    'price x delta-OI measured per observation',
  ],
} as const;

export type DeltaOiIntendedUse = 'PROVIDER_REFERENCE_RELATIVE' | 'SNAPSHOT_TO_SNAPSHOT';

/**
 * Fail-closed gate for any consumer of the capture's ΔOI.
 *
 * A research feature that needs a snapshot-to-snapshot OI change must NOT read
 * `oiChange`: it must derive the change from consecutive OI observations of the
 * SAME contract. Callers treat a non-ok verdict as "feature unavailable".
 */
export function assertDeltaOiIntendedUse(use: DeltaOiIntendedUse): { ok: true } | { ok: false; reason: string } {
  if (use === 'PROVIDER_REFERENCE_RELATIVE') return { ok: true };
  return {
    ok: false,
    reason:
      `upstox_live_paper_option_quotes.oiChange is ${DELTA_OI_SEMANTICS.class}, not ${use}; ` +
      `derive a per-observation change from consecutive OI values of the same contract instead. ` +
      `(${DELTA_OI_SEMANTICS.unknown})`,
  };
}
