/**
 * GATE 4 #1 (roadmap row 38) — GAP SESSION SERIES adapter.
 *
 * Single responsibility: turn raw archived daily-bar candidates into a clean, ordered,
 * gap-ready session series. It is a pure function: no clock, no I/O, no DB.
 *
 * WHY THIS EXISTS (measured, 2026-09-12):
 *   The FNF feed's daily rows carry `open`, `high`, `low` of the session but their
 *   `close` column is the broker's PREVIOUS close, not the session's own close. Proven
 *   against an independent source: the row for session 2026-09-11 quotes close 23477.80,
 *   which is exactly the index tape's session-2026-09-10 close (NIFTYBANK 56471.90 vs
 *   tape 56471.95). So:
 *       prevClose(S) = quotedClose(row S)
 *       close(S)     = quotedClose(row S+1)      <- the NEXT session's quote
 *   Reading `close` as the session's own close would silently mislabel every gap, which
 *   is exactly the class of error this pipeline exists to prevent. The last session of a
 *   series therefore has NO derivable close and is reported INCOMPLETE (never guessed).
 *
 * Row selection: several raw rows can describe one session (intraday quotes all repeat the
 * day's OHLC; partial rows repeat the last price in all four fields). The complete bar is
 * the one with the WIDEST high-low span; ties break on the earliest timestamp, then the
 * lexicographically smallest source id — so selection is deterministic and order-free.
 */

export const GAP_SESSION_SERIES_VERSION = 'gapsess-v1';

export type RawDailyBar = {
	instrument: string;
	/** 'YYYY-MM-DD' — the session date in IST, supplied by the caller (never re-derived). */
	sessionDate: string;
	open: number | null;
	high: number | null;
	low: number | null;
	/** The broker's quoted close = the PREVIOUS session's close (see header). */
	quotedClose: number | null;
	/** Stable per-row discriminator used only to break ties deterministically. */
	sourceId?: string | null;
};

export type SessionBar = {
	sessionDate: string;
	instrument: string;
	/** Completeness of the bar's own OHLC (the close always comes from the next session). */
	provenance: 'QUOTED' | 'DERIVED_CLOSE' | 'INCOMPLETE_NO_CLOSE';
	open: number;
	high: number;
	low: number;
	/** The session's own close (from the next session's quote) or null when unknown. */
	close: number | null;
	/** The previous session's close, as quoted on this session's own row. */
	prevClose: number | null;
	/** This session's own high-low range (the NEXT session's gapRatio denominator). */
	range: number;
	/** The session's next quoted close, kept so a reviewer can re-derive `close`. */
	nextQuotedClose: number | null;
};

export type SeriesExclusionReason =
	| 'INVALID_SESSION_DATE'
	| 'NON_POSITIVE_PRICE'
	| 'IMPOSSIBLE_BAR'      // high < low, or open outside [low, high]
	| 'NO_USABLE_BAR';

export type SessionSeries = {
	version: string;
	instrument: string;
	sessions: SessionBar[];
	exclusions: Array<{ sessionDate: string; reason: SeriesExclusionReason; detail: string }>;
	coverage: {
		rawRows: number;
		sessionsIn: number;
		sessionsOut: number;
		completeSessions: number;
		/** Sessions whose own close was derivable (i.e. all but the last usable one). */
		closedSessions: number;
		firstSession: string | null;
		lastSession: string | null;
	};
	digest: string;
};

const isPos = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** Widest high-low span wins; ties → earliest date order is preserved by caller sort, then id. */
const betterBar = (a: RawDailyBar, b: RawDailyBar): boolean => {
	const spanA = (a.high as number) - (a.low as number);
	const spanB = (b.high as number) - (b.low as number);
	if (spanA !== spanB) return spanA > spanB;
	const idA = String(a.sourceId ?? '');
	const idB = String(b.sourceId ?? '');
	return idA < idB;
};

/**
 * Build an ordered session series for ONE instrument.
 * Input order is irrelevant; sessions are sorted by date and the digest is order-free.
 */
export function buildSessionSeries(instrument: string, rows: RawDailyBar[]): SessionSeries {
	const exclusions: SessionSeries['exclusions'] = [];
	const byDate = new Map<string, RawDailyBar[]>();

	for (const raw of rows) {
		if (!/^\d{4}-\d{2}-\d{2}$/.test(String(raw.sessionDate ?? ''))) {
			exclusions.push({ sessionDate: String(raw.sessionDate ?? ''), reason: 'INVALID_SESSION_DATE', detail: 'sessionDate must be YYYY-MM-DD (IST)' });
			continue;
		}
		const bucket = byDate.get(raw.sessionDate) ?? [];
		bucket.push({ ...raw, instrument });
		byDate.set(raw.sessionDate, bucket);
	}

	const picked: Array<{ sessionDate: string; row: RawDailyBar }> = [];
	for (const [sessionDate, bucket] of byDate) {
		const usable = bucket.filter((r) => isPos(r.open) && isPos(r.high) && isPos(r.low));
		const impossible = usable.filter((r) => r.high! < r.low! || r.open! > r.high! || r.open! < r.low!);
		if (usable.length === 0) {
			exclusions.push({ sessionDate, reason: 'NO_USABLE_BAR', detail: `${bucket.length} raw row(s), none with positive open/high/low` });
			continue;
		}
		const sound = usable.filter((r) => !impossible.includes(r));
		if (sound.length === 0) {
			exclusions.push({ sessionDate, reason: 'IMPOSSIBLE_BAR', detail: `${impossible.length} row(s) had high<low or open outside [low,high]` });
			continue;
		}
		let best = sound[0];
		for (const candidate of sound.slice(1)) if (betterBar(candidate, best)) best = candidate;
		picked.push({ sessionDate, row: best });
	}

	picked.sort((a, b) => (a.sessionDate < b.sessionDate ? -1 : a.sessionDate > b.sessionDate ? 1 : 0));

	const sessions: SessionBar[] = [];
	for (let i = 0; i < picked.length; i += 1) {
		const { sessionDate, row } = picked[i];
		const next = picked[i + 1];
		const quotedClose = isPos(row.quotedClose) ? (row.quotedClose as number) : null;
		const nextQuotedClose = next && isPos(next.row.quotedClose) ? (next.row.quotedClose as number) : null;
		const open = row.open as number;
		const high = row.high as number;
		const low = row.low as number;
		sessions.push({
			sessionDate,
			instrument,
			provenance: nextQuotedClose === null ? 'INCOMPLETE_NO_CLOSE' : (!quotedClose ? 'QUOTED' : 'DERIVED_CLOSE'),
			open,
			high,
			low,
			close: nextQuotedClose,                 // the session's own close lives on the NEXT row
			prevClose: quotedClose,
			range: high - low,
			nextQuotedClose,
		});
	}

	const closedSessions = sessions.filter((s) => s.close !== null).length;
	const digest = JSON.stringify(sessions.map((s) => [s.sessionDate, s.open, s.high, s.low, s.close, s.prevClose]));

	return {
		version: GAP_SESSION_SERIES_VERSION,
		instrument,
		sessions,
		exclusions,
		coverage: {
			rawRows: rows.length,
			sessionsIn: byDate.size,
			sessionsOut: sessions.length,
			completeSessions: sessions.filter((s) => s.provenance !== 'INCOMPLETE_NO_CLOSE').length,
			closedSessions,
			firstSession: sessions.length ? sessions[0].sessionDate : null,
			lastSession: sessions.length ? sessions[sessions.length - 1].sessionDate : null,
		},
		digest,
	};
}
