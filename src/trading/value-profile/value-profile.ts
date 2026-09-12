/**
 * GATE 6 #1 (roadmap row 60) — PRIOR-DAY VALUE PROFILE: POC / VAH / VAL / HVN / LVN.
 *
 * Single responsibility: turn ONE session's intraday observations into a price profile and derive its
 * point of control, value area and high/low-volume nodes — deterministically, with the BASIS it used
 * stated explicitly. PURE: no clock, no I/O, no DB, no network, no AI, no randomness.
 *
 * ── BASIS (the honest core of this component) ───────────────────────────────────────────────
 *   A profile needs an activity measure per price level. Two are possible here and they are NOT
 *   interchangeable, so the choice is never silent — every profile carries `basis` and `basisReason`:
 *     VOLUME — activity = the volume attributed to each observation. Requires that a sufficient
 *              fraction of in-window observations actually carry usable volume (measured on this
 *              archive: only `source='fyers-history'` rows carry volume; every live `fyers` and
 *              `yahoo` row carries 0, so VOLUME is the exception, not the default).
 *     TPO    — activity = the NUMBER of observations at that price (time/observation-at-price).
 *              Always derivable from the tick tape, so it is the honest fallback.
 *   config.basis: 'AUTO' (default) chooses VOLUME only when coverage clears `minVolumeCoverage`,
 *   otherwise TPO, AND says which and why. basis 'VOLUME' demanded explicitly with insufficient
 *   coverage is REFUSED (`VOLUME_UNAVAILABLE`) — it is never quietly downgraded to TPO.
 *
 * ── PINNED DEFINITION (units, buckets, area rule, nodes) ────────────────────────────────────
 *   level      = a price bucket of `levelSizePoints` (default 10 index points), bucketed by
 *                floor(price / levelSize) so bucket edges are fixed and order-free.
 *   activity   = sum of (volume | 1) per level, per the chosen basis.
 *   POC        = the level with the greatest activity; ties break to the LOWEST price (deterministic).
 *   VALUE AREA = expand ONE level at a time from the POC, each step taking the side whose next level
 *                has the greater activity (ties → lower price), until the accumulated activity is at
 *                least `valueAreaPct` (default 70%) of the total, or both sides are exhausted.
 *                VAL = lowest price in the band, VAH = highest.
 *   HVN        = a level INSIDE the value area whose activity is at or above the MEAN activity of the
 *                value-area levels (data-derived separator, no fitted multiplier).
 *   LVN        = a level OUTSIDE the value area whose activity is at or below the MEAN activity of
 *                ALL levels (same doctrine: derived from the data, never tuned).
 *
 *   UNITS: prices in index points, activity in shares (VOLUME) or observations (TPO), the area share
 *   as a fraction of total activity. Thresholds are structural defaults documented in ONE config.
 *
 * ── MISSING / DEGENERATE DATA → a safe explicit state ───────────────────────────────────────
 *   NO_POINTS / NO_LEVELS / INSUFFICIENT_LEVELS / ZERO_ACTIVITY / VOLUME_UNAVAILABLE /
 *   LEVEL_SIZE_INVALID / NO_SESSION_DATE
 *   — each yields a null profile with the token and a human detail; nothing is interpolated,
 *     carried forward or fabricated. A profile is never invented for an empty session.
 *
 * RESEARCH / SHADOW ONLY: nothing in production imports this module (asserted by test). It writes no
 * state. Versioned: valprof-v1.
 */

import { sessionMidnightMs } from '../pre-open/pre-open-alignment';
import { MARKET_OPEN_START_MIN, MARKET_CLOSE_MIN } from '../pre-open/pre-open-session';

export const VALUE_PROFILE_VERSION = 'valprof-v1';

/**
 * The VALUE-AREA CONSTRUCTION METHOD — versioned INDEPENDENTLY of the feature version, so a historical
 * profile can always state WHICH construction produced it. These are the exact, pinned steps; changing
 * any one of them (bucket rule, POC tie-break, expansion rule, area share, node separators) REQUIRES a
 * new method id, otherwise two differently-built areas would be indistinguishable in the archive.
 */
export const VALUE_AREA_METHOD_VERSION = 'va-70pct-expand1-v1';

export const VALUE_AREA_METHOD = {
	id: VALUE_AREA_METHOD_VERSION,
	steps: [
		'bucket each in-window observation to floor(price / levelSizePoints)',
		'activity = the volume attributed to the observation (VOLUME basis) or 1 per observation (TPO basis)',
		'POC = the level with the greatest activity; ties break to the LOWEST price',
		'value area = start at the POC and expand ONE level at a time, each step taking the side whose next level has the greater activity (ties to the lower price), until accumulated activity >= valueAreaPct of the total, or both sides are exhausted',
		'VAL = the lowest price in the band; VAH = the highest',
		'HVN = an in-area level with activity >= the mean in-area activity',
		'LVN = an outside-area level with activity <= the mean activity of ALL levels',
	],
	parameters: ['levelSizePoints', 'valueAreaPct'] as string[],
	note: 'node separators are data-derived means, never fitted multipliers; the method carries no constant tuned against outcomes',
};

export type ProfileBasis = 'VOLUME' | 'TPO';
export type ValueProfileStatus = 'OK' | 'UNAVAILABLE' | 'DISABLED';

/** Closed, published refusal vocabulary (declaration order is the canonical order). */
export const VALUE_PROFILE_REFUSALS = [
	'NO_SESSION_DATE',
	'NO_POINTS',
	'NO_LEVELS',
	'INSUFFICIENT_LEVELS',
	'VOLUME_UNAVAILABLE',
	'LEVEL_SIZE_INVALID',
] as const;
export type ValueProfileRefusal = (typeof VALUE_PROFILE_REFUSALS)[number];

export const VALUE_PROFILE_STATUSES: readonly ValueProfileStatus[] = ['OK', 'UNAVAILABLE', 'DISABLED'];

export interface ProfilePoint {
	instantMs: number;
	price: number;
	/** Volume attributed to this observation. Omitted/0 ⇒ this point carries no volume information. */
	volume?: number | null;
}

export interface ProfilePath {
	sessionDate: string;
	instrument: string;
	points: ProfilePoint[];
}

export interface ValueProfileConfig {
	enabled: boolean;
	/** 'AUTO' picks VOLUME when coverage clears the bound, else TPO — and always says which/why. */
	basis: 'AUTO' | ProfileBasis;
	/** Price bucket width, in index points. A granularity, not a fitted threshold. */
	levelSizePoints: number;
	/** Fraction of in-window observations that must carry usable volume for AUTO to choose VOLUME. */
	minVolumeCoverage: number;
	/** Standard market-profile value-area share. */
	valueAreaPct: number;
	/** Minimum distinct levels before an area can be formed at all. */
	minLevels: number;
}

export const DEFAULT_VALUE_PROFILE_CONFIG: ValueProfileConfig = {
	enabled: true,
	basis: 'AUTO',
	levelSizePoints: 10,
	minVolumeCoverage: 0.9,
	valueAreaPct: 0.7,
	minLevels: 3,
};

export interface ProfileLevel {
	priceLow: number;
	priceHigh: number;
	activity: number;
}

export interface ValueProfile {
	sessionDate: string;
	instrument: string;
	status: ValueProfileStatus;
	reason: ValueProfileRefusal | null;
	reasonDetail: string | null;
	basis: ProfileBasis | null;
	basisReason: string | null;
	/** Which value-area CONSTRUCTION produced this profile (see VALUE_AREA_METHOD). */
	method: string;
	levelSizePoints: number;
	observationsIn: number;
	observationsUsed: number;
	observationsWithVolume: number;
	levels: number;
	totalActivity: number | null;
	poc: ProfileLevel | null;
	val: number | null;
	vah: number | null;
	valueAreaActivityShare: number | null;
	hvn: ProfileLevel[];
	lvn: ProfileLevel[];
	evidence: { firstInstantMs: number | null; lastInstantMs: number | null; volumeCoverage: number | null };
}

export interface ValueProfileReport {
	version: string;
	enabled: boolean;
	config: ValueProfileConfig;
	spec: typeof VALUE_PROFILE_SPEC;
	/** The construction method every profile in this run declares. */
	methodVersion: string;
	profiles: ValueProfile[];
	counts: Record<ValueProfileStatus, number>;
	basisCounts: Record<ProfileBasis, number>;
	refusalCounts: Record<ValueProfileRefusal, number>;
	coverage: { sessionsIn: number; pathsIn: number; ok: number; volume: number; tpo: number; unavailable: number; disabled: number };
	reviewerSummary: string;
	digest: string;
}

export const VALUE_PROFILE_SPEC = {
	feature: 'ValueProfile',
	version: VALUE_PROFILE_VERSION,
	/** The construction method id a reviewer must be able to read off any profile. */
	method: VALUE_AREA_METHOD_VERSION,
	question: 'For one session: the point of control, the 70% value area (VAL/VAH) and the high/low-volume nodes, over an explicitly stated activity basis.',
	basis: 'VOLUME (volume per observation) when coverage suffices, else TPO (observations per level); the chosen basis and the reason are always reported, and an explicitly demanded basis that is unavailable is refused rather than downgraded',
	level: 'price buckets of levelSizePoints (default 10), bucketed by floor(price / levelSize)',
	poc: 'greatest activity; ties break to the lowest price',
	valueArea: 'expand one level at a time from the POC, taking the side with the greater next-level activity (ties → lower price), until >= valueAreaPct (70%) of total activity',
	nodes: 'HVN = in-area level at/above the mean in-area activity; LVN = outside-area level at/below the mean activity of all levels (both data-derived, never tuned)',
	units: 'prices in index points; activity in volume (VOLUME) or observations (TPO); area share is a fraction of total activity',
	refuses: [...VALUE_PROFILE_REFUSALS] as string[],
	missingData: 'no observations, no level carrying activity, too few levels, an invalid level size or an unavailable demanded basis ⇒ a null profile with a closed-vocabulary token, never a fabricated area',
};

export const describeValueProfile = (c: ValueProfileConfig = DEFAULT_VALUE_PROFILE_CONFIG): string =>
	[
		`${VALUE_PROFILE_VERSION}: derives POC / VAL / VAH / HVN / LVN for one session over an explicit activity basis.`,
		`basis=${c.basis} (AUTO uses VOLUME only when >= ${c.minVolumeCoverage} of in-window observations carry usable volume, else TPO — and always reports which and why);`,
		`levels are ${c.levelSizePoints}-point price buckets; POC is the greatest-activity level (ties to the lowest price);`,
		`the value area expands one level at a time from the POC, taking the side with the greater next-level activity, until ${c.valueAreaPct * 100}% of total activity;`,
		`HVN/LVN use the mean activity as the separator (data-derived, never a fitted multiplier).`,
		`A session with no observations, fewer than ${c.minLevels} levels, zero activity or an unavailable demanded basis is refused with one of ${VALUE_PROFILE_REFUSALS.join(' / ')}, never given a fabricated area.`,
		`enabled=${c.enabled}.`,
	].join(' ');

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const bySession = (rows: ProfilePath[]): ProfilePath[] =>
	[...rows].sort((a, b) => {
		if (a.sessionDate !== b.sessionDate) return a.sessionDate < b.sessionDate ? -1 : 1;
		const ka = `${a.instrument}|${a.points.length}|${a.points[0]?.instantMs ?? ''}|${a.points[a.points.length - 1]?.instantMs ?? ''}`;
		const kb = `${b.instrument}|${b.points.length}|${b.points[0]?.instantMs ?? ''}|${b.points[b.points.length - 1]?.instantMs ?? ''}`;
		return ka < kb ? -1 : ka > kb ? 1 : 0;
	});

const refused = (
	path: ProfilePath,
	cfg: ValueProfileConfig,
	reason: ValueProfileRefusal,
	detail: string,
	extra: Partial<ValueProfile> = {},
): ValueProfile => ({
	sessionDate: path.sessionDate, instrument: path.instrument, status: 'UNAVAILABLE', reason, reasonDetail: detail,
	basis: null, basisReason: null, method: VALUE_AREA_METHOD_VERSION, levelSizePoints: cfg.levelSizePoints,
	observationsIn: path.points.length, observationsUsed: 0, observationsWithVolume: 0, levels: 0,
	totalActivity: null, poc: null, val: null, vah: null, valueAreaActivityShare: null, hvn: [], lvn: [],
	evidence: { firstInstantMs: null, lastInstantMs: null, volumeCoverage: null },
	...extra,
});

function buildOne(path: ProfilePath, cfg: ValueProfileConfig): ValueProfile {
	if (!cfg.enabled) {
		return { ...refused(path, cfg, 'NO_POINTS', 'the component is disabled; no profile was computed for this input'), status: 'DISABLED', reason: null, reasonDetail: 'the component is disabled; no profile was computed for this input' };
	}
	if (!/^\d{4}-\d{2}-\d{2}$/.test(String(path.sessionDate ?? ''))) {
		return refused(path, cfg, 'NO_SESSION_DATE', `"${path.sessionDate}" is not a usable YYYY-MM-DD session date`);
	}
	if (!(cfg.levelSizePoints > 0)) {
		return refused(path, cfg, 'LEVEL_SIZE_INVALID', `levelSizePoints=${cfg.levelSizePoints} must be > 0`);
	}
	const midnight = sessionMidnightMs(path.sessionDate);
	if (midnight === null) return refused(path, cfg, 'NO_SESSION_DATE', `"${path.sessionDate}" is not a usable session date`);
	const openMs = midnight + MARKET_OPEN_START_MIN * 60_000;
	const closeMs = midnight + MARKET_CLOSE_MIN * 60_000;

	const points = (path.points ?? [])
		.filter((p) => isNum(p.instantMs) && isNum(p.price) && p.price > 0 && p.instantMs >= openMs && p.instantMs <= closeMs)
		.sort((a, b) => a.instantMs - b.instantMs);
	if (!points.length) return refused(path, cfg, 'NO_POINTS', 'the path holds no observation inside the session window');

	const withVolume = points.filter((p) => isNum(p.volume) && (p.volume as number) > 0).length;
	const volumeCoverage = withVolume / points.length;

	// Basis resolution — explicit, and an explicitly demanded basis is never silently downgraded.
	let basis: ProfileBasis;
	let basisReason: string;
	if (cfg.basis === 'VOLUME' || cfg.basis === 'TPO') {
		if (cfg.basis === 'VOLUME' && volumeCoverage < cfg.minVolumeCoverage) {
			return refused(path, cfg, 'VOLUME_UNAVAILABLE', `VOLUME was demanded but only ${(volumeCoverage * 100).toFixed(1)}% of ${points.length} in-window observations carry usable volume (need ${(cfg.minVolumeCoverage * 100).toFixed(0)}%); refusing rather than downgrading to TPO`, { observationsWithVolume: withVolume, evidence: { firstInstantMs: points[0].instantMs, lastInstantMs: points[points.length - 1].instantMs, volumeCoverage } });
		}
		basis = cfg.basis;
		basisReason = `basis demanded explicitly by config`;
	} else if (volumeCoverage >= cfg.minVolumeCoverage) {
		basis = 'VOLUME';
		basisReason = `AUTO: ${(volumeCoverage * 100).toFixed(1)}% of in-window observations carry usable volume (>= ${(cfg.minVolumeCoverage * 100).toFixed(0)}%)`;
	} else {
		basis = 'TPO';
		basisReason = `AUTO: only ${(volumeCoverage * 100).toFixed(1)}% of in-window observations carry usable volume (< ${(cfg.minVolumeCoverage * 100).toFixed(0)}%), so the profile is built from observation counts instead`;
	}

	const size = cfg.levelSizePoints;
	const buckets = new Map<number, number>();
	for (const p of points) {
		const key = Math.floor(p.price / size);
		const activity = basis === 'VOLUME' ? (isNum(p.volume) && (p.volume as number) > 0 ? (p.volume as number) : 0) : 1;
		buckets.set(key, (buckets.get(key) ?? 0) + activity);
	}
	const levels: Array<ProfileLevel & { key: number }> = [...buckets.entries()]
		.filter(([, activity]) => activity > 0)
		.map(([key, activity]) => ({ key, priceLow: key * size, priceHigh: (key + 1) * size, activity }))
		.sort((a, b) => (a.priceLow < b.priceLow ? -1 : a.priceLow > b.priceLow ? 1 : 0));

	const baseEvidence = { firstInstantMs: points[0].instantMs, lastInstantMs: points[points.length - 1].instantMs, volumeCoverage };
	const common = { basis, basisReason, observationsIn: path.points.length, observationsUsed: points.length, observationsWithVolume: withVolume, levels: levels.length, evidence: baseEvidence };

	if (!levels.length) return refused(path, cfg, 'NO_LEVELS', `no level carried activity on the ${basis} basis`, common);
	const totalActivity = levels.reduce((a, l) => a + l.activity, 0);
	if (levels.length < cfg.minLevels) {
		return refused(path, cfg, 'INSUFFICIENT_LEVELS', `${levels.length} level(s) with activity (need at least ${cfg.minLevels}) to form a value area`, { ...common, totalActivity });
	}

	// POC — greatest activity, ties to the lowest price (levels are price-ascending).
	let pocIndex = 0;
	for (let i = 1; i < levels.length; i += 1) if (levels[i].activity > levels[pocIndex].activity) pocIndex = i;

	// Value area — one level at a time, greater next-level activity wins, ties to lower price.
	let lo = pocIndex;
	let hi = pocIndex;
	let acc = levels[pocIndex].activity;
	const target = cfg.valueAreaPct * totalActivity;
	while (acc < target && (lo > 0 || hi < levels.length - 1)) {
		const leftAct = lo > 0 ? levels[lo - 1].activity : -1;
		const rightAct = hi < levels.length - 1 ? levels[hi + 1].activity : -1;
		if (rightAct > leftAct) { hi += 1; acc += levels[hi].activity; } else { lo -= 1; acc += levels[lo].activity; }
	}
	const areaLevels = levels.slice(lo, hi + 1);
	const areaMean = areaLevels.reduce((a, l) => a + l.activity, 0) / areaLevels.length;
	const allMean = totalActivity / levels.length;
	const hvn = areaLevels.filter((l) => l.activity >= areaMean).map(({ priceLow, priceHigh, activity }) => ({ priceLow, priceHigh, activity }));
	const lvn = levels.slice(0, lo).concat(levels.slice(hi + 1)).filter((l) => l.activity <= allMean).map(({ priceLow, priceHigh, activity }) => ({ priceLow, priceHigh, activity }));

	return {
		sessionDate: path.sessionDate, instrument: path.instrument, status: 'OK', reason: null, reasonDetail: null,
		method: VALUE_AREA_METHOD_VERSION,
		levelSizePoints: size,
		...common,
		totalActivity,
		poc: { priceLow: levels[pocIndex].priceLow, priceHigh: levels[pocIndex].priceHigh, activity: levels[pocIndex].activity },
		val: levels[lo].priceLow,
		vah: levels[hi].priceHigh,
		valueAreaActivityShare: acc / totalActivity,
		hvn,
		lvn,
	};
}

const digestOf = (profiles: ValueProfile[]): string =>
	JSON.stringify(profiles.map((p) => [
		p.sessionDate, p.instrument, p.status, p.reason, p.basis,
		p.poc ? p.poc.priceLow : null, p.val, p.vah,
		p.valueAreaActivityShare === null ? null : Number(p.valueAreaActivityShare.toFixed(4)),
		p.hvn.map((l) => l.priceLow), p.lvn.map((l) => l.priceLow),
	]));

/**
 * Build a value profile for every session path offered. Input order is irrelevant; profiles are
 * emitted in canonical order and the digest is a function of the DATA alone.
 */
export function buildValueProfiles(
	paths: ProfilePath[],
	config: Partial<ValueProfileConfig> = {},
): ValueProfileReport {
	const cfg: ValueProfileConfig = { ...DEFAULT_VALUE_PROFILE_CONFIG, ...config };
	const ordered = bySession(paths);
	const profiles = ordered.map((p) => buildOne(p, cfg));

	const counts: Record<ValueProfileStatus, number> = { OK: 0, UNAVAILABLE: 0, DISABLED: 0 };
	const basisCounts: Record<ProfileBasis, number> = { VOLUME: 0, TPO: 0 };
	const refusalCounts = Object.fromEntries(VALUE_PROFILE_REFUSALS.map((r) => [r, 0])) as Record<ValueProfileRefusal, number>;
	for (const p of profiles) {
		counts[p.status] += 1;
		if (p.basis && p.status === 'OK') basisCounts[p.basis] += 1;
		if (p.reason) refusalCounts[p.reason] += 1;
	}

	return {
		version: VALUE_PROFILE_VERSION,
		enabled: cfg.enabled,
		config: cfg,
		spec: VALUE_PROFILE_SPEC,
		methodVersion: VALUE_AREA_METHOD_VERSION,
		profiles,
		counts,
		basisCounts,
		refusalCounts,
		coverage: {
			sessionsIn: ordered.length,
			pathsIn: (paths ?? []).length,
			ok: counts.OK,
			volume: basisCounts.VOLUME,
			tpo: basisCounts.TPO,
			unavailable: counts.UNAVAILABLE,
			disabled: counts.DISABLED,
		},
		reviewerSummary: describeValueProfile(cfg),
		digest: digestOf(profiles),
	};
}
