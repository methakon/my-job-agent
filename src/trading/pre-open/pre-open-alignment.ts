/**
 * GATE 2 #6 (roadmap row 27) — TIME-ALIGN pre-open and cross-market information
 * BEFORE inference.
 *
 * WHAT THIS ITEM DOES (the doneWhen is "a reviewer can determine exactly what the
 * item does and a replay/test demonstrates the behavior", so it is stated here):
 *
 *   The database stores wall-clock strings under TWO different bases — server-written
 *   UTC (`createdAt`, `updatedAt`) and driver-written IST (`receivedTimestamp`, `ts`,
 *   `eventTime`, ...). Comparing or joining those columns without converting them is
 *   the exact mistake that once produced a false "the server clock is 5.5 h behind"
 *   diagnosis and ~20x overstated windowed counts. This module is the single place
 *   that reconciles them:
 *
 *     1. each input row declares the basis of ITS OWN time column;
 *     2. the declared wall clock is converted to one ABSOLUTE instant (epoch ms);
 *     3. rows are kept only if they belong to the session's window on the exchange
 *        calendar (default 09:00–09:15 IST). REFERENCE rows (previous close, prior-day
 *        levels) must instead PRECEDE the window AND come from a real trading window on
 *        the calendar: a same-day row at 08:30 is refused as CALENDAR_CLOSED, because
 *        "closed market data" is not a prior-session reference;
 *     4. nothing at or after the inference cutoff (`asOf`) may enter the frame — this
 *        is the only door look-ahead could come through, so it is refused and counted;
 *     5. when a row carries two columns of different bases, they are cross-checked:
 *        a gap larger than EXACT_TOLERANCE_MS means someone wrote an IST value into a
 *        UTC-declared column (or vice versa) — flagged and excluded, never averaged;
 *     6. finally each symbol's newest known values AT `asOf` are resolved. A symbol
 *        with no usable row reports UNAVAILABLE with a reason — values are never
 *        interpolated, carried forward, or guessed.
 *
 * PURE: no clock reads, no I/O. `asOf` is derived from the session date + window, so a
 * replay of archived rows and a live poll run identical code. Input order is irrelevant:
 * the frame is sorted by (instant, kind, source, symbol, sequence) and every tie is
 * stable, which makes the digest byte-identical for reordered input.
 */

import {
	IST_OFFSET_MS,
	MARKET_OPEN_START_MIN,
	PRE_OPEN_START_MIN,
	SessionPhase,
	istDateString,
	sessionPhaseAt,
} from './pre-open-session';

export const PRE_OPEN_ALIGNMENT_VERSION = 'align-v1';

/** Bases a stored time column can be written in. 'UNKNOWN' is not a basis — it is a refusal. */
export type TimeBasis = 'IST' | 'UTC';

export type AlignedKind = 'PRE_OPEN' | 'CROSS_MARKET' | 'REFERENCE';

/** Documented, closed set of exclusion reasons. A produced reason MUST be one of these. */
export const ALIGNMENT_EXCLUSION_REASONS = [
	'NO_TIMESTAMP',
	'BASIS_UNKNOWN',
	'TIMESTAMP_INVALID',
	'CALENDAR_CLOSED',
	'OUT_OF_WINDOW',
	'REFERENCE_AFTER_WINDOW_START',
	'REFERENCE_TOO_OLD',
	'LOOK_AHEAD',
	'BASIS_MISMATCH',
	'MISSING_SYMBOL',
	'DUPLICATE',
] as const;
export type AlignmentExclusionReason = (typeof ALIGNMENT_EXCLUSION_REASONS)[number];

/** Two columns of different bases describing the same event must agree within this. */
export const EXACT_TOLERANCE_MS = 30 * 60_000;

/** How far back a REFERENCE row (previous close / prior-day level) may sit. */
export const MAX_REFERENCE_AGE_MS = 30 * 3_600_000;

export type AlignmentInput = {
	kind: AlignedKind;
	source: string;
	symbol: string | null;
	/** Wall clock as stored, e.g. '2026-09-11 09:04:12'. */
	wall: string | null;
	/** Declared basis of `wall`. null = the caller does not know → the row is refused. */
	basis: TimeBasis | null;
	sequence?: number | null;
	values?: Record<string, number | null>;
	/** Optional second column on the same row, used for the dual-basis cross-check. */
	crossCheck?: { wall: string | null; basis: TimeBasis | null } | null;
};

export type AlignedRow = {
	key: string;
	kind: AlignedKind;
	source: string;
	symbol: string | null;
	instantMs: number;
	istWall: string;
	utcWall: string;
	basis: TimeBasis;
	phase: SessionPhase;
	sequence: number | null;
	values: Record<string, number | null>;
};

export type AlignmentExclusion = { reason: AlignmentExclusionReason; detail: string };

export type SymbolView = {
	symbol: string;
	status: 'OK' | 'UNAVAILABLE';
	reason: string | null;
	/** Newest PRE_OPEN row at/before asOf, if any. */
	preOpen: AlignedRow | null;
	/** Newest CROSS_MARKET row at/before asOf, if any. */
	crossMarket: AlignedRow | null;
	/** Newest REFERENCE row preceding the window, if any. */
	reference: AlignedRow | null;
	informativeRows: number;
};

export type AlignmentFrame = {
	version: string;
	sessionDate: string;
	windowStartMs: number;
	windowEndMs: number;
	asOfMs: number;
	rows: AlignedRow[];
	symbols: SymbolView[];
	exclusions: AlignmentExclusion[];
	exclusionCounts: Record<string, number>;
	coverage: {
		rowCount: number;
		symbolCount: number;
		sourceCounts: Record<string, number>;
		kindCounts: Record<string, number>;
		firstInstantMs: number | null;
		lastInstantMs: number | null;
		spanMs: number | null;
	};
	/** One-paragraph statement of the behaviour a reviewer can check against the frame. */
	reviewerSummary: string;
	digest: string;
};

const pad = (n: number): string => String(n).padStart(2, '0');

/** Instant of IST midnight for a 'YYYY-MM-DD' session date, or null when malformed. */
export function sessionMidnightMs(sessionDate: string): number | null {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(String(sessionDate ?? ''))) return null;
	const ms = Date.parse(`${sessionDate}T00:00:00+05:30`);
	return Number.isFinite(ms) ? ms : null;
}

/** Convert a stored wall clock in a DECLARED basis to an absolute instant. */
export function wallToInstantMs(wall: string | null, basis: TimeBasis | null): number | null {
	if (!wall) return null;
	if (basis !== 'IST' && basis !== 'UTC') return null;
	const normalized = String(wall).trim().replace(' ', 'T');
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(normalized)) return null;
	const ms = Date.parse(basis === 'IST' ? `${normalized}+05:30` : `${normalized}Z`);
	return Number.isFinite(ms) ? ms : null;
}

/** Render an instant back into both stored wall-clock forms (for audit strings). */
export function instantToWalls(ms: number): { istWall: string; utcWall: string } {
	const ist = new Date(ms + IST_OFFSET_MS);
	const utc = new Date(ms);
	const fmt = (d: Date): string =>
		`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
	return { istWall: fmt(ist), utcWall: fmt(utc) };
}

const KIND_RANK: Record<AlignedKind, number> = { PRE_OPEN: 0, CROSS_MARKET: 1, REFERENCE: 2 };

/** Vocabulary order of kinds, so count maps are canonical. */
const KIND_VOCABULARY: readonly AlignedKind[] = ['PRE_OPEN', 'CROSS_MARKET', 'REFERENCE'];

/**
 * Canonicalise a count map so the frame's digest can never depend on input order: keys are
 * emitted in the declared vocabulary order when one exists, otherwise sorted. A raw
 * insertion-ordered map made two otherwise identical frames digest differently depending
 * on which exclusion was met first — caught by the determinism section of the test.
 */
export function canonicalCounts(counts: Record<string, number>, vocabulary?: readonly string[]): Record<string, number> {
	const keys = vocabulary ? vocabulary.filter((k) => counts[k] !== undefined) : Object.keys(counts).sort();
	const out: Record<string, number> = {};
	for (const k of keys) out[k] = counts[k];
	return out;
}

export const describeAlignment = (): string =>
	[
		`${PRE_OPEN_ALIGNMENT_VERSION}: normalises every stored wall clock to ONE absolute instant using the`,
		'basis its own column declares (IST market clock vs UTC server clock), keeps only rows inside the',
		'session window on the exchange calendar (REFERENCE rows must instead precede it), refuses anything',
		`at/after the asOf cutoff, cross-checks two differently-based columns on the same row (mismatch > ${EXACT_TOLERANCE_MS / 60_000} min = BASIS_MISMATCH),`,
		'then resolves each symbol newest-known-at-asOf with explicit UNAVAILABLE reasons and no interpolation.',
		`Exclusion reasons are closed: ${ALIGNMENT_EXCLUSION_REASONS.join(', ')}.`,
	].join(' ');

/**
 * Align pre-open + cross-market rows into ONE frame at ONE cutoff.
 * Defaults: window = [09:00, 09:15) IST of `sessionDate`, asOf = window end.
 */
export function alignPreOpenFrame(
	inputs: AlignmentInput[],
	config: { sessionDate: string; asOfMs?: number; windowStartMin?: number; windowEndMin?: number },
): AlignmentFrame {
	const sessionDate = String(config.sessionDate ?? '');
	const midnight = sessionMidnightMs(sessionDate);
	const windowStartMin = config.windowStartMin ?? PRE_OPEN_START_MIN;
	const windowEndMin = config.windowEndMin ?? MARKET_OPEN_START_MIN;
	const windowStartMs = midnight === null ? NaN : midnight + windowStartMin * 60_000;
	const windowEndMs = midnight === null ? NaN : midnight + windowEndMin * 60_000;
	const asOfMs = config.asOfMs ?? windowEndMs;

	const exclusions: AlignmentExclusion[] = [];
	const exclude = (reason: AlignmentExclusionReason, detail: string): void => {
		exclusions.push({ reason, detail });
	};

	const rows: AlignedRow[] = [];
	const seen = new Set<string>();

	for (const input of inputs) {
		const who = `${input.kind}/${input.source}/${input.symbol ?? '-'}`;

		if (!input.wall) {
			exclude('NO_TIMESTAMP', `${who}: no time column supplied`);
			continue;
		}
		if (input.basis !== 'IST' && input.basis !== 'UTC') {
			exclude('BASIS_UNKNOWN', `${who}: wall "${input.wall}" has no declared basis`);
			continue;
		}
		const instantMs = wallToInstantMs(input.wall, input.basis);
		if (instantMs === null) {
			exclude('TIMESTAMP_INVALID', `${who}: "${input.wall}" is not a valid ${input.basis} wall clock`);
			continue;
		}

		// dual-basis cross-check: two columns of the same event must agree
		if (input.crossCheck && input.crossCheck.wall) {
			const crossMs = wallToInstantMs(input.crossCheck.wall, input.crossCheck.basis);
			if (crossMs === null) {
				exclude('BASIS_UNKNOWN', `${who}: cross-checked column has no invalid/undeclared basis ("${input.crossCheck.wall}")`);
				continue;
			}
			if (Math.abs(crossMs - instantMs) > EXACT_TOLERANCE_MS) {
				exclude(
					'BASIS_MISMATCH',
					`${who}: ${input.basis} column "${input.wall}" and ${input.crossCheck.basis} column "${input.crossCheck.wall}" differ by ${Math.round(Math.abs(crossMs - instantMs) / 60_000)} min`,
				);
				continue;
			}
		}

		if (!Number.isFinite(midnight)) {
			exclude('TIMESTAMP_INVALID', `${who}: session date "${sessionDate}" is not YYYY-MM-DD`);
			continue;
		}

		const phase = sessionPhaseAt(instantMs);
		if (input.kind === 'REFERENCE') {
			// A reference describes the PREVIOUS session (previous close, prior-day level), so it
			// legitimately sits on an earlier date: it must come from a trading day, strictly
			// precede the window, and not be stale beyond the declared bound.
			if (phase === 'CLOSED' || phase === 'UNKNOWN') {
				exclude('CALENDAR_CLOSED', `${who}: reference instant is ${phase} on the exchange calendar`);
				continue;
			}
			if (instantMs >= windowStartMs) {
				exclude('REFERENCE_AFTER_WINDOW_START', `${who}: a reference must precede the window start`);
				continue;
			}
			if (windowStartMs - instantMs > MAX_REFERENCE_AGE_MS) {
				exclude('REFERENCE_TOO_OLD', `${who}: reference is ${Math.round((windowStartMs - instantMs) / 3_600_000)} h before the window`);
				continue;
			}
		} else {
			if (istDateString(instantMs) !== sessionDate) {
				exclude('OUT_OF_WINDOW', `${who}: instant is on ${istDateString(instantMs)}, not session ${sessionDate}`);
				continue;
			}
			if (phase === 'CLOSED' || phase === 'UNKNOWN') {
				exclude('CALENDAR_CLOSED', `${who}: exchange calendar says ${phase} at ${instantToWalls(instantMs).istWall} IST`);
				continue;
			}
			if (!(instantMs >= windowStartMs && instantMs < windowEndMs)) {
				exclude('OUT_OF_WINDOW', `${who}: ${instantToWalls(instantMs).istWall} IST is outside [${windowStartMin},${windowEndMin}) min`);
				continue;
			}
		}

		if (instantMs >= asOfMs) {
			exclude('LOOK_AHEAD', `${who}: instant is at/after the asOf cutoff`);
			continue;
		}
		if (!input.symbol) {
			exclude('MISSING_SYMBOL', `${who}: row carries no symbol, so it cannot be aligned to an instrument`);
			continue;
		}

		const key = `${input.kind}|${input.source}|${input.symbol}|${instantMs}|${input.sequence ?? '-'}`;
		if (seen.has(key)) {
			exclude('DUPLICATE', `${who}: duplicate of an already-aligned row (${key})`);
			continue;
		}
		seen.add(key);
		const walls = instantToWalls(instantMs);
		rows.push({
			key,
			kind: input.kind,
			source: input.source,
			symbol: input.symbol,
			instantMs,
			istWall: walls.istWall,
			utcWall: walls.utcWall,
			basis: input.basis,
			phase,
			sequence: input.sequence ?? null,
			values: input.values ?? {},
		});
	}

	rows.sort((a, b) => {
		if (a.instantMs !== b.instantMs) return a.instantMs - b.instantMs;
		if (KIND_RANK[a.kind] !== KIND_RANK[b.kind]) return KIND_RANK[a.kind] - KIND_RANK[b.kind];
		if (a.source !== b.source) return a.source < b.source ? -1 : 1;
		if ((a.symbol ?? '') !== (b.symbol ?? '')) return (a.symbol ?? '') < (b.symbol ?? '') ? -1 : 1;
		return (a.sequence ?? 0) - (b.sequence ?? 0);
	});

	// newest-known-at-asOf per symbol, per kind (never interpolated)
	const symbolViews: SymbolView[] = [];
	const symbols = [...new Set(rows.map((r) => r.symbol as string))].sort();
	for (const symbol of symbols) {
		const mine = rows.filter((r) => r.symbol === symbol);
		const newest = (kind: AlignedKind): AlignedRow | null => {
			const of = mine.filter((r) => r.kind === kind);
			return of.length ? of[of.length - 1] : null;
		};
		const preOpen = newest('PRE_OPEN');
		const crossMarket = newest('CROSS_MARKET');
		const reference = newest('REFERENCE');
		const reasons: string[] = [];
		if (!preOpen) reasons.push('no pre-open row at/before asOf');
		if (!crossMarket) reasons.push('no cross-market row at/before asOf');
		if (!reference) reasons.push('no pre-window reference row');
		symbolViews.push({
			symbol,
			status: preOpen && crossMarket ? 'OK' : 'UNAVAILABLE',
			reason: reasons.length ? reasons.join('; ') : null,
			preOpen,
			crossMarket,
			reference,
			informativeRows: mine.length,
		});
	}

	// Count maps are canonicalised (vocabulary/sorted order) so the digest is a function of
	// the DATA only — never of the order the caller happened to supply it in.
	const rawExclusionCounts: Record<string, number> = {};
	for (const e of exclusions) rawExclusionCounts[e.reason] = (rawExclusionCounts[e.reason] ?? 0) + 1;
	const rawSourceCounts: Record<string, number> = {};
	const rawKindCounts: Record<string, number> = {};
	for (const r of rows) {
		rawSourceCounts[r.source] = (rawSourceCounts[r.source] ?? 0) + 1;
		rawKindCounts[r.kind] = (rawKindCounts[r.kind] ?? 0) + 1;
	}
	const exclusionCounts = canonicalCounts(rawExclusionCounts, ALIGNMENT_EXCLUSION_REASONS);
	const sourceCounts = canonicalCounts(rawSourceCounts);
	const kindCounts = canonicalCounts(rawKindCounts, KIND_VOCABULARY);

	const firstInstantMs = rows.length ? rows[0].instantMs : null;
	const lastInstantMs = rows.length ? rows[rows.length - 1].instantMs : null;
	const digest = JSON.stringify({
		v: PRE_OPEN_ALIGNMENT_VERSION,
		sessionDate,
		asOfMs: Number.isFinite(asOfMs) ? asOfMs : null,
		rows: rows.map((r) => r.key),
		symbols: symbolViews.map((s) => [s.symbol, s.status, s.preOpen?.key ?? null, s.crossMarket?.key ?? null, s.reference?.key ?? null]),
		exclusionCounts,
	});

	return {
		version: PRE_OPEN_ALIGNMENT_VERSION,
		sessionDate,
		windowStartMs,
		windowEndMs,
		asOfMs,
		rows,
		symbols: symbolViews,
		exclusions,
		exclusionCounts,
		coverage: {
			rowCount: rows.length,
			symbolCount: symbols.length,
			sourceCounts,
			kindCounts,
			firstInstantMs,
			lastInstantMs,
			spanMs: firstInstantMs !== null && lastInstantMs !== null ? lastInstantMs - firstInstantMs : null,
		},
		reviewerSummary: describeAlignment(),
		digest,
	};
}
