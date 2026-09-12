/**
 * GATE 4 #12 (roadmap row 49) — KEEP OLD U.S. STATISTICS AS BENCHMARK METADATA ONLY.
 *
 * Single responsibility: hold the U.S. market gap statistics as an AUTHORITATIVE, versioned METADATA
 * declaration — explicitly marked `usage: METADATA_ONLY`, `decisionInput: false` — and provide the ONE
 * control that keeps them out of any decision: `detectBenchmarkMisuse()`. PURE: no clock, no I/O, no DB,
 * no network, no AI, no randomness.
 *
 * ── THE INVARIANT (this is the protected behaviour) ────────────────────────────────────────
 *   The U.S. statistics are a BENCHMARK TO COMPARE AGAINST, never an input to a signal, candidate, score,
 *   expected value or decision. The NSE desk decides from its own measured features; a U.S. fill-rate band
 *   must never be read as a probability, a threshold or a reward/risk rule.
 *
 *   The control lives HERE, in GATE 4's research/config layer, not in a caller: every statistic carries
 *   `usage` and `decisionInput`, and `detectBenchmarkMisuse()` flags any source that imports this module or
 *   hard-codes one of the benchmark fingerprints. The gate-4 regression suite runs the detector over the
 *   real `src/trading` tree, so a future research module that tries to consume the statistics fails the
 *   build instead of silently becoming a second, unmeasured source of edge.
 *
 *   Source of the transcribed values: `docs/FNO_MARKET_REFERENCE.md` (U.S. E-mini S&P / mini-Dow gap
 *   statistics). The fingerprints below exist ONLY for the misuse detector — they are not decision inputs.
 *
 * RESEARCH / SHADOW ONLY: nothing in production imports this module (asserted by test). Versioned:
 * gapbench-v1.
 */

export const GAP_BENCHMARK_VERSION = 'gapbench-v1';

export type BenchmarkUsage = 'METADATA_ONLY';

export interface BenchmarkStatistic {
	id: string;
	market: 'US';
	instruments: readonly string[];
	measure: string;
	/** The value EXACTLY as recorded in the reference, kept as text on purpose (never parsed into a rule). */
	value: string;
	/** Distinctive tokens used ONLY by the misuse detector. */
	fingerprints: readonly string[];
	usage: BenchmarkUsage;
	decisionInput: false;
	source: string;
}

/**
 * The transcribed U.S. reference statistics. Frozen: a consumer cannot mutate a benchmark into a rule.
 * These are the "old U.S. statistics" the roadmap requires to stay metadata only.
 */
export const US_GAP_BENCHMARKS: readonly BenchmarkStatistic[] = Object.freeze(
	[
		{
			id: 'us-gap-fill-rate-low-volume',
			market: 'US' as const,
			instruments: ['E-mini S&P', 'mini-Dow'] as const,
			measure: 'gap fill rate at low volume (< 30,000 shares)',
			value: '~80%',
			fingerprints: ['us-gap-fill-rate-low-volume', 'E-mini S&P', 'mini-Dow'] as const,
			usage: 'METADATA_ONLY' as const,
			decisionInput: false as const,
			source: 'docs/FNO_MARKET_REFERENCE.md',
		},
		{
			id: 'us-gap-fill-rate-mid-volume',
			market: 'US' as const,
			instruments: ['E-mini S&P', 'mini-Dow'] as const,
			measure: 'gap fill rate at 30,000-70,000 shares (~85% partial fill)',
			value: '~60%',
			fingerprints: ['us-gap-fill-rate-mid-volume'] as const,
			usage: 'METADATA_ONLY' as const,
			decisionInput: false as const,
			source: 'docs/FNO_MARKET_REFERENCE.md',
		},
		{
			id: 'us-reward-risk-rule',
			market: 'US' as const,
			instruments: ['E-mini S&P', 'mini-Dow'] as const,
			measure: 'reward/risk rule for small vs large gaps',
			value: '1:1.5 for gaps < 40 mini-Dow pts or 4 E-mini S&P pts; 1:1 for larger',
			fingerprints: ['us-reward-risk-rule', '1:1.5'] as const,
			usage: 'METADATA_ONLY' as const,
			decisionInput: false as const,
			source: 'docs/FNO_MARKET_REFERENCE.md',
		},
		{
			id: 'us-down-gap-backtest',
			market: 'US' as const,
			instruments: ['E-mini S&P', 'mini-Dow'] as const,
			measure: 'experimental backtest: long the day after a down gap > 20-bar ATR, hold to the pre-gap low',
			value: 'no protective stops',
			fingerprints: ['us-down-gap-backtest', '20-bar ATR'] as const,
			usage: 'METADATA_ONLY' as const,
			decisionInput: false as const,
			source: 'docs/FNO_MARKET_REFERENCE.md',
		},
	].map((e) => Object.freeze(e)),
);

export const BENCHMARK_USAGE_POLICY = Object.freeze({
	usage: 'METADATA_ONLY' as BenchmarkUsage,
	decisionInput: false as const,
	rule:
		'The U.S. gap statistics are benchmark METADATA. No research or production module may read them as an ' +
		'input to a signal, candidate, score, expected value or decision. They exist only to compare against, ' +
		'never to act on; the NSE desk decides from its own measured features.',
	/** The module that is ALLOWED to define them. Every other consumer is a misuse. */
	authoritativeModule: 'src/trading/gap-engine/benchmark-metadata.ts',
	consumers: [] as readonly string[],
});

export const GAP_BENCHMARK_SPEC = {
	feature: 'GapBenchmarkMetadata',
	version: GAP_BENCHMARK_VERSION,
	invariant: 'the old U.S. gap statistics are BENCHMARK METADATA ONLY — never a decision input',
	policy: BENCHMARK_USAGE_POLICY.rule,
	control: 'one authoritative declaration + detectBenchmarkMisuse(), run over the real src/trading tree by the gate-4 suite',
	source: 'docs/FNO_MARKET_REFERENCE.md',
	missingOrMisuse: 'a source that imports this module or hard-codes a benchmark fingerprint is flagged in CI rather than allowed to become a second, unmeasured source of edge',
};

export const describeGapBenchmarks = (): string =>
	[
		`${GAP_BENCHMARK_VERSION}: ${US_GAP_BENCHMARKS.length} U.S. gap statistics held as ${BENCHMARK_USAGE_POLICY.usage} (decisionInput=${BENCHMARK_USAGE_POLICY.decisionInput}).`,
		BENCHMARK_USAGE_POLICY.rule,
		`Source: ${GAP_BENCHMARK_SPEC.source}. The misuse detector flags any other module that imports this file or hard-codes a benchmark fingerprint.`,
	].join(' ');

/** True only for a well-formed metadata declaration — never a path into a decision. */
export const isBenchmarkMetadata = (e: Pick<BenchmarkStatistic, 'usage' | 'decisionInput'>): boolean =>
	e.usage === 'METADATA_ONLY' && e.decisionInput === false;

export interface BenchmarkMisuse {
	/** The offending source path. */
	file: string;
	/** Which fingerprint (or the import) matched. */
	fingerprint: string;
	/** 1-based line of the first match. */
	line: number;
}

/**
 * The control. Flag every source that consumes the benchmarks as code: an import of this module, or a
 * hard-coded benchmark fingerprint. The metadata module itself and its own test are ignored by the caller
 * (they must reference the fingerprints); a legitimate comparison doc is not source and is not scanned.
 */
export function detectBenchmarkMisuse(
	files: ReadonlyArray<{ path: string; content: string }>,
	opts: { ignore?: readonly string[] } = {},
): BenchmarkMisuse[] {
	const ignore = opts.ignore ?? [];
	const fingerprints = [
		...new Set([
			...US_GAP_BENCHMARKS.flatMap((e) => [...e.fingerprints]),
			'benchmark-metadata',
			'US_GAP_BENCHMARKS',
			'BENCHMARK_USAGE_POLICY',
		]),
	];
	const hits: BenchmarkMisuse[] = [];
	for (const file of files ?? []) {
		if (ignore.some((p) => file.path === p || file.path.endsWith(p))) continue;
		const lines = String(file.content ?? '').split('\n');
		for (let i = 0; i < lines.length; i += 1) {
			const line = lines[i];
			for (const fp of fingerprints) {
				if (line.includes(fp)) {
					hits.push({ file: file.path, fingerprint: fp, line: i + 1 });
					break;
				}
			}
		}
	}
	return hits;
}
