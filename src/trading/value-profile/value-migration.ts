/**
 * GATE 6 #4 (roadmap row 63) — VALUE MIGRATION ACROSS SESSIONS.
 *
 * Single responsibility: for each instrument, describe how the value area MOVED from one profiled session
 * to the next — the direction of the move and the descriptive overlap — over an explicit sample, and say
 * so when there is not enough to describe. PURE: no clock, no I/O, no DB, no network, no AI, no randomness.
 *
 * ── PINNED DEFINITION (units, window, states, edges) ───────────────────────────────────────
 *   pair      = two CONSECUTIVE profiled sessions for one instrument, in date order (the row-60 profile
 *               report supplies them; a session whose profile was refused is skipped, and the date gap
 *               between the pair is reported descriptively rather than interpolated).
 *   deltas    = valDelta = VAL(t) − VAL(t−1); vahDelta = VAH(t) − VAH(t−1); pocDelta = POC(t) − POC(t−1)
 *   overlap   = max(0, min(VAH_t, VAH_t−1) − max(VAL_t, VAL_t−1)) — DESCRIPTIVE, never a decision input
 *   MIGRATION STATE, evaluated in this documented precedence (first match wins):
 *     SAME      both edges unchanged
 *     HIGHER    both edges strictly higher  (the whole area moved up)
 *     LOWER     both edges strictly lower   (the whole area moved down)
 *     WIDER     the new area STRICTLY contains the old (val down AND vah up)
 *     NARROWER  the new area is STRICTLY inside the old (val up AND vah down)
 *     MIXED     exactly ONE edge moved and the other stayed put — reported explicitly rather than
 *               forced into one of the four shapes above
 *
 *   UNITS: prices in index points; deltas in index points; overlap in index points and as a fraction of
 *   the union of the two areas (descriptive). No threshold exists — every state is a comparison of the
 *   two areas' own edges.
 *
 * ── INSUFFICIENT DATA → a safe explicit state ───────────────────────────────────────────────
 *   NO_PROFILES / INSUFFICIENT_PROFILES (fewer than two OK profiles for the instrument) /
 *   NO_ADJACENT_OK — each yields an empty transition list with the token and a human detail, plus the
 *   SAMPLE SIZE actually available. Nothing is interpolated between non-adjacent sessions.
 *
 * RESEARCH / SHADOW ONLY: nothing in production imports this module (asserted by test). Versioned:
 * valmig-v1.
 */

import { ValueProfile, ValueProfileReport } from './value-profile';

export const VALUE_MIGRATION_VERSION = 'valmig-v1';

export type MigrationState = 'SAME' | 'HIGHER' | 'LOWER' | 'WIDER' | 'NARROWER' | 'MIXED';
export type MigrationStatus = 'OK' | 'UNAVAILABLE' | 'DISABLED';

/** Closed, published refusal vocabulary (declaration order is the canonical order). */
export const VALUE_MIGRATION_REFUSALS = ['NO_PROFILES', 'INSUFFICIENT_PROFILES', 'NO_ADJACENT_OK'] as const;
export type ValueMigrationRefusal = (typeof VALUE_MIGRATION_REFUSALS)[number];

export const VALUE_MIGRATION_STATUSES: readonly MigrationStatus[] = ['OK', 'UNAVAILABLE', 'DISABLED'];
export const MIGRATION_STATES: readonly MigrationState[] = ['HIGHER', 'LOWER', 'WIDER', 'NARROWER', 'SAME', 'MIXED'];

export interface ValueMigrationConfig {
	enabled: boolean;
}

export const DEFAULT_VALUE_MIGRATION_CONFIG: ValueMigrationConfig = { enabled: true };

export const VALUE_MIGRATION_SPEC = {
	feature: 'ValueMigration',
	version: VALUE_MIGRATION_VERSION,
	question: 'How did the value area move from one profiled session to the next, and over how many pairs?',
	pair: 'two CONSECUTIVE profiled sessions for one instrument in date order; refused profiles are skipped and the date gap is reported, never interpolated',
	states: 'SAME / HIGHER / LOWER / WIDER (new strictly contains old) / NARROWER (new strictly inside old) / MIXED (exactly one edge moved) — first match wins',
	units: 'prices and deltas in index points; overlap in index points and as a fraction of the union of the two areas (descriptive only)',
	thresholds: 'none — every state is a direct comparison of the two areas own edges',
	coverage: 'the report states the SAMPLE SIZE (number of pairs) and the sessions/refusals behind it',
	refuses: [...VALUE_MIGRATION_REFUSALS] as string[],
	missingData: 'no profiles / fewer than two OK profiles for an instrument / no adjacent OK pair ⇒ an empty transition list with a closed-vocabulary token and the sample size actually available',
};

export interface ValueMigrationTransition {
	instrument: string;
	previousSessionDate: string;
	sessionDate: string;
	/** Calendar days between the pair — reported, never used to interpolate. */
	dayGap: number | null;
	state: MigrationState;
	valDelta: number;
	vahDelta: number;
	pocDelta: number | null;
	overlapPoints: number;
	overlapOfUnion: number;
	evidence: { prevVal: number; prevVah: number; val: number; vah: number; prevPoc: number | null; poc: number | null; prevBasis: string | null; basis: string | null };
}

export interface ValueMigrationReport {
	version: string;
	enabled: boolean;
	config: ValueMigrationConfig;
	spec: typeof VALUE_MIGRATION_SPEC;
	/** Carried from the row-60 report, so a reviewer can say which profile version produced these areas. */
	upstreamProfileVersion: string;
	status: MigrationStatus;
	reason: ValueMigrationRefusal | null;
	reasonDetail: string | null;
	transitions: ValueMigrationTransition[];
	stateCounts: Record<MigrationState, number>;
	refusalCounts: Record<ValueMigrationRefusal, number>;
	coverage: {
		sessionsIn: number;
		profilesIn: number;
		okProfiles: number;
		instrumentCount: number;
		/** NUMBER OF PAIRS described — the sample size the doneWhen asks to be shown. */
		sampleSize: number;
		sessionsNotConsecutive: number;
	};
	reviewerSummary: string;
	digest: string;
}

export const describeValueMigration = (c: ValueMigrationConfig = DEFAULT_VALUE_MIGRATION_CONFIG): string =>
	[
		`${VALUE_MIGRATION_VERSION}: describes how the value area moved between two CONSECUTIVE profiled sessions`,
		`as valDelta / vahDelta / pocDelta in index points, with DESCRIPTIVE overlap (points and fraction of the union of the two areas).`,
		`States, first match wins: SAME / HIGHER (both edges up) / LOWER (both down) / WIDER (new strictly contains old) / NARROWER (new strictly inside old) / MIXED (exactly one edge moved).`,
		`A refused profile is skipped, not interpolated, and the calendar gap between a pair is reported rather than smoothed over.`,
		`There is no threshold: every state compares the two areas' own edges. The report always states its SAMPLE SIZE (number of pairs).`,
		`Fewer than two usable profiles yields an empty list with one of ${VALUE_MIGRATION_REFUSALS.join(' / ')}. enabled=${c.enabled}.`,
	].join(' ');

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const dayGapOf = (a: string, b: string): number | null => {
	const ta = Date.parse(`${a}T00:00:00Z`);
	const tb = Date.parse(`${b}T00:00:00Z`);
	if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
	return Math.round((tb - ta) / 86_400_000);
};

/** SAME → HIGHER → LOWER → WIDER → NARROWER → MIXED (exactly one edge moved). Documented precedence. */
const stateOf = (p: ValueProfile, c: ValueProfile): MigrationState => {
	const pv = p.val as number, pvv = p.vah as number, cv = c.val as number, cvv = c.vah as number;
	if (cv === pv && cvv === pvv) return 'SAME';
	if (cv > pv && cvv > pvv) return 'HIGHER';
	if (cv < pv && cvv < pvv) return 'LOWER';
	if (cv < pv && cvv > pvv) return 'WIDER';
	if (cv > pv && cvv < pvv) return 'NARROWER';
	return 'MIXED';
};

/**
 * Describe the value migration for every instrument present in the row-60 profile report.
 * Deterministic: pairs come from date-ordered profiles, and the output is canonical-ordered.
 */
export function buildValueMigration(
	profileReport: ValueProfileReport,
	config: Partial<ValueMigrationConfig> = {},
): ValueMigrationReport {
	const cfg: ValueMigrationConfig = { ...DEFAULT_VALUE_MIGRATION_CONFIG, ...config };

	const base = {
		version: VALUE_MIGRATION_VERSION,
		enabled: cfg.enabled,
		config: cfg,
		spec: VALUE_MIGRATION_SPEC,
		upstreamProfileVersion: profileReport.version,
	};
	const emptyCounts = (): Record<MigrationState, number> => ({ HIGHER: 0, LOWER: 0, WIDER: 0, NARROWER: 0, SAME: 0, MIXED: 0 });
	const zeroRefusals = (): Record<ValueMigrationRefusal, number> => ({ NO_PROFILES: 0, INSUFFICIENT_PROFILES: 0, NO_ADJACENT_OK: 0 });

	if (!cfg.enabled) {
		return {
			...base, status: 'DISABLED', reason: null, reasonDetail: 'the component is disabled; no transition was computed', transitions: [],
			stateCounts: emptyCounts(), refusalCounts: zeroRefusals(),
			coverage: { sessionsIn: profileReport.profiles.length, profilesIn: profileReport.profiles.length, okProfiles: 0, instrumentCount: 0, sampleSize: 0, sessionsNotConsecutive: 0 },
			reviewerSummary: describeValueMigration(cfg), digest: '[]',
		};
	}

	const all = profileReport.profiles ?? [];
	if (!all.length) {
		return {
			...base, status: 'UNAVAILABLE', reason: 'NO_PROFILES', reasonDetail: 'the profile report holds no profiles at all', transitions: [],
			stateCounts: emptyCounts(), refusalCounts: { ...zeroRefusals(), NO_PROFILES: 1 },
			coverage: { sessionsIn: 0, profilesIn: 0, okProfiles: 0, instrumentCount: 0, sampleSize: 0, sessionsNotConsecutive: 0 },
			reviewerSummary: describeValueMigration(cfg), digest: '[]',
		};
	}

	const byInstrument = new Map<string, ValueProfile[]>();
	for (const p of all) {
		if (p.status !== 'OK' || !isNum(p.val) || !isNum(p.vah)) continue;
		if (!byInstrument.has(p.instrument)) byInstrument.set(p.instrument, []);
		byInstrument.get(p.instrument)!.push(p);
	}
	for (const list of byInstrument.values()) list.sort((a, b) => (a.sessionDate < b.sessionDate ? -1 : a.sessionDate > b.sessionDate ? 1 : 0));

	const transitions: ValueMigrationTransition[] = [];
	let sessionsNotConsecutive = 0;
	for (const instrument of [...byInstrument.keys()].sort()) {
		const list = byInstrument.get(instrument) as ValueProfile[];
		for (let i = 1; i < list.length; i += 1) {
			const p = list[i - 1];
			const c = list[i];
			const pv = p.val as number, pvv = p.vah as number, cv = c.val as number, cvv = c.vah as number;
			const overlapPoints = Math.max(0, Math.min(pvv, cvv) - Math.max(pv, cv));
			const union = Math.max(pvv, cvv) - Math.min(pv, cv);
			const gap = dayGapOf(p.sessionDate, c.sessionDate);
			if (gap !== null && gap > 1) sessionsNotConsecutive += 1;
			transitions.push({
				instrument,
				previousSessionDate: p.sessionDate,
				sessionDate: c.sessionDate,
				dayGap: gap,
				state: stateOf(p, c),
				valDelta: cv - pv,
				vahDelta: cvv - pvv,
				pocDelta: isNum(p.poc?.priceLow) && isNum(c.poc?.priceLow) ? (c.poc!.priceLow - p.poc!.priceLow) : null,
				overlapPoints,
				overlapOfUnion: union > 0 ? overlapPoints / union : 0,
				evidence: { prevVal: pv, prevVah: pvv, val: cv, vah: cvv, prevPoc: isNum(p.poc?.priceLow) ? p.poc!.priceLow : null, poc: isNum(c.poc?.priceLow) ? c.poc!.priceLow : null, prevBasis: p.basis, basis: c.basis },
			});
		}
	}

	const okProfiles = [...byInstrument.values()].reduce((a, l) => a + l.length, 0);
	const stateCounts = emptyCounts();
	for (const t of transitions) stateCounts[t.state] += 1;

	let status: MigrationStatus = 'OK';
	let reason: ValueMigrationRefusal | null = null;
	let reasonDetail: string | null = null;
	if (okProfiles === 0) {
		status = 'UNAVAILABLE'; reason = 'NO_PROFILES';
		reasonDetail = `the report holds ${all.length} profile(s), none of them OK, so no area is comparable`;
	} else if (okProfiles < 2) {
		status = 'UNAVAILABLE'; reason = 'INSUFFICIENT_PROFILES';
		reasonDetail = `only ${okProfiles} usable profile(s): a migration needs at least two consecutive profiled sessions`;
	} else if (!transitions.length) {
		status = 'UNAVAILABLE'; reason = 'NO_ADJACENT_OK';
		reasonDetail = 'no instrument had two consecutive usable profiles';
	}
	const refusalCounts = zeroRefusals();
	if (reason) refusalCounts[reason] = 1;

	return {
		...base,
		status,
		reason,
		reasonDetail,
		transitions,
		stateCounts,
		refusalCounts,
		coverage: {
			sessionsIn: all.length,
			profilesIn: all.length,
			okProfiles,
			instrumentCount: byInstrument.size,
			sampleSize: transitions.length,
			sessionsNotConsecutive,
		},
		reviewerSummary: describeValueMigration(cfg),
		digest: JSON.stringify(transitions.map((t) => [t.instrument, t.sessionDate, t.state, Number(t.valDelta.toFixed(6)), Number(t.vahDelta.toFixed(6)), Number(t.overlapOfUnion.toFixed(6))])),
	};
}
