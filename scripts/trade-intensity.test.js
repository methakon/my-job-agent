#!/usr/bin/env node
/**
 * GATE 5 #8 (roadmap row 57) — track trade intensity / activity regime.
 *
 * doneWhen: "A report can reproduce the metric from archived data and shows the sample size/coverage used."
 *
 * [A] contract: version, pinned metric/window/units, closed refusal vocabulary, coverage
 * [B] the intensity and the regime baseline are exact (delta, median, prior-only)
 * [C] every edge case is a safe explicit state (never 0/NaN/Infinity, never a fabricated activity)
 * [D] the disabled path computes nothing
 * [E] determinism + no look-ahead (a regime uses PRIOR intervals only)
 * [F] sessions never share a baseline; provenance and the observed window are echoed
 * [G] purity + research-only
 */
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');

const M = require(path.join(REPO, 'dist', 'trading', 'microstructure', 'trade-intensity'));
const SRC = path.join(REPO, 'src', 'trading', 'microstructure', 'trade-intensity.ts');

let pass = 0;
const failures = [];
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  PASS ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`); }
};
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);

const S = '2026-09-11';
const T0 = Date.parse('2026-09-11T09:15:00+05:30');
const at = (seconds) => new Date(T0 + seconds * 1000).toISOString();
const snap = (over = {}) => ({ instrumentKey: 'NSE_FO|47290', source: 'UPSTOX', sessionDate: S, ts: at(0), volume: 1000, sequenceNumber: 1, ...over });
// volumes at 60 s spacing => a delta of D is exactly D contracts per minute
const series = (volumes, over = {}) => volumes.map((v, i) => snap({ ts: at(i * 60), volume: v, sequenceNumber: i + 1, ...over }));
const run = (s, c) => M.evaluateTradeIntensity(s, c);
const flat = (n, delta = 100) => { const v = [1000]; for (let i = 1; i <= n; i += 1) v.push(1000 + i * delta); return v; };

// ── [A] ─────────────────────────────────────────────────────────────────────
console.log('\n[A] contract');
{
  const rep = run(series(flat(6)));
  eq('version', rep.version, 'tradeint-v1');
  eq('the config is the switch plus the three pinned bounds', Object.keys(M.DEFAULT_TRADE_INTENSITY_CONFIG), ['enabled', 'minHistory', 'quietFactor', 'activeFactor']);
  eq('the closed refusal vocabulary is the documented set', [...M.INTENSITY_REFUSALS], ['NO_VOLUME', 'NO_TIMESTAMP', 'NO_VOLUME_PROGRESS', 'VOLUME_RESET', 'INSUFFICIENT_HISTORY', 'NO_SESSION_DATE', 'SOURCE_MIXED']);
  eq('the spec documents every refusal token', M.TRADE_INTENSITY_SPEC.refuses, [...M.INTENSITY_REFUSALS]);
  ok('the spec pins the metric, the observation window and the units', ['metric', 'observationWindow', 'units'].every((k) => typeof M.TRADE_INTENSITY_SPEC[k] === 'string' && M.TRADE_INTENSITY_SPEC[k].length > 0));
  eq('the metric is contracts per minute', M.TRADE_INTENSITY_SPEC.units, 'contracts per minute');
  ok('the spec declares there is no look-ahead', /NONE/.test(M.TRADE_INTENSITY_SPEC.lookahead));
  ok('the spec never assumes market hours', /never assumed/.test(M.TRADE_INTENSITY_SPEC.observationWindow));
  ok('the spec marks this research/shadow only', /RESEARCH \/ SHADOW ONLY/.test(M.TRADE_INTENSITY_SPEC.scope));
  eq('the coverage block reports the sample size and the observed windows', [rep.coverage.sessions, rep.coverage.instruments, rep.coverage.sources], [1, 1, ['UPSTOX']]);
  eq('the reviewer summary is populated', typeof rep.reviewerSummary === 'string' && rep.reviewerSummary.length > 0, true);
}

// ── [B] ─────────────────────────────────────────────────────────────────────
console.log('\n[B] the intensity and the regime baseline are exact');
{
  const rep = run(series([1000, 1100, 1200]));
  const first = rep.observations[0];
  eq('deltaVolume is the archived cumulative difference', first.deltaVolume, 100);
  eq('dtSeconds is the snapshot gap', first.dtSeconds, 60);
  eq('intensity = delta/dt × 60 ⇒ 100 contracts/min', first.intensity, 100);
  eq('the observation is decided, not refused', [first.status, first.reason], ['OK', null]);

  const thirty = run(series([1000, 1050], { ts: null }).map((s, i) => ({ ...s, ts: at(i * 30) })));
  eq('a 30 s gap doubles the per-minute rate (50 in 30 s ⇒ 100/min)', thirty.observations[0].intensity, 100);
  const half = run(series([1000, 1100]).map((s, i) => ({ ...s, ts: at(i * 120) })));
  eq('a 120 s gap halves the per-minute rate (100 in 120 s ⇒ 50/min)', half.observations[0].intensity, 50);

  const warm = run(series(flat(6)));
  eq('...the first interval has no priors, so no regime', [warm.observations[0].regime, warm.observations[0].regimeReason, warm.observations[0].priorObservations], [null, 'INSUFFICIENT_HISTORY', 0]);
  eq('...the 6th interval is the first with 5 priors', [warm.observations[5].priorObservations, warm.observations[5].regime], [5, 'NORMAL']);
  eq('...and its baseline is the MEDIAN of the 5 PRIOR intensities', warm.observations[5].baselineMedian, 100);
  eq('...the interval itself is excluded from its own baseline (5 priors, not 6)', warm.observations[5].priorObservations, 5);

  const active = run(series([...flat(6), 2600]));
  eq('a 10× interval is ACTIVE against a 100/min prior median', [active.observations[6].intensity, active.observations[6].regime, active.observations[6].baselineMedian], [1000, 'ACTIVE', 100]);
  const quiet = run(series([...flat(6), 1610]));
  eq('a 0.1× interval is QUIET against a 100/min prior median', [quiet.observations[6].intensity, quiet.observations[6].regime], [10, 'QUIET']);
  const normal = run(series([...flat(6), 1700]));
  eq('an interval inside the band is NORMAL', [normal.observations[6].intensity, normal.observations[6].regime], [100, 'NORMAL']);

  const windowed = run(series(flat(8)), { minHistory: 3 });
  eq('minHistory is configurable — 3 priors is enough at index 3', [windowed.observations[3].priorObservations, windowed.observations[3].regime], [3, 'NORMAL']);
  const strict = run(series(flat(8)), { minHistory: 20 });
  ok('minHistory above the available priors ⇒ every regime refused for history', windowed.observations.length > 0 && run(series(flat(8)), { minHistory: 20 }).observations.every((o) => o.regime === null && o.regimeReason === 'INSUFFICIENT_HISTORY'));
  eq('...while the intensity itself is still decided', strict.observations[0].status, 'OK');
}

// ── [C] ─────────────────────────────────────────────────────────────────────
console.log('\n[C] every edge case is safe and explicit');
{
  const eqVol = run(series([1000, 1000, 1100]));
  eq('an unchanged cumulative volume ⇒ NO_VOLUME_PROGRESS (not a fabricated 0)', [eqVol.observations[0].reason, eqVol.observations[0].intensity], ['NO_VOLUME_PROGRESS', null]);
  eq('...and the next interval still decides normally', [eqVol.observations[1].reason, eqVol.observations[1].intensity], [null, 100]);

  const reset = run(series([1000, 1100, 900, 1000]));
  eq('a backwards cumulative volume ⇒ VOLUME_RESET', [reset.observations[1].reason, reset.observations[1].deltaVolume, reset.observations[1].intensity], ['VOLUME_RESET', -200, null]);
  eq('...a reset does not corrupt the following interval', [reset.observations[2].reason, reset.observations[2].intensity], [null, 100]);

  const noVol = run([snap({ ts: at(0), volume: null }), snap({ ts: at(60), volume: 1100, sequenceNumber: 2 })]);
  eq('a missing volume ⇒ NO_VOLUME', [noVol.observations[0].reason, noVol.observations[0].deltaVolume], ['NO_VOLUME', null]);

  const noTs = run([snap({ ts: null }), snap({ ts: null, volume: 1100, sequenceNumber: 2 })]);
  eq('a missing timestamp ⇒ NO_TIMESTAMP', noTs.observations[0].reason, 'NO_TIMESTAMP');
  const sameTs = run([snap({ ts: at(0) }), snap({ ts: at(0), volume: 1100, sequenceNumber: 2 })]);
  eq('a non-advancing (dt = 0) timestamp ⇒ NO_TIMESTAMP (never ÷0)', [sameTs.observations[0].reason, sameTs.observations[0].dtSeconds], ['NO_TIMESTAMP', null]);

  const mixed = run([snap({ ts: at(0), source: 'UPSTOX' }), snap({ ts: at(60), volume: 1100, source: 'UPSTOX_LIVE', sequenceNumber: 2 })]);
  eq('two sources inside one instrument session ⇒ SOURCE_MIXED', [mixed.observations[0].reason, mixed.sessions[0].refusedForSourceMix], ['SOURCE_MIXED', true]);

  const unkeyed = run([snap({ sessionDate: null, ts: null })]);
  eq('no session date and no usable timestamp ⇒ NO_SESSION_DATE', unkeyed.observations[0].reason, 'NO_SESSION_DATE');

  const refused = run([snap({ volume: null }), snap({ ts: at(60), volume: 1000, sequenceNumber: 2 })].map((s, i) => ({ ...s, ts: i === 0 ? at(0) : s.ts })));
  ok('every refusal carries null intensity AND null regime', refused.observations.every((o) => o.status === 'UNAVAILABLE' && o.intensity === null && o.regime === null && o.reason !== null));
  eq('counts separate decided from refused', [refused.counts.decided, refused.counts.refused], [0, 1]);
  eq('the refusal count map is in vocabulary order', Object.keys(refused.refusalCounts), [...M.INTENSITY_REFUSALS]);
  ok('no observation ever carries NaN/Infinity', eqVol.observations.concat(reset.observations, noVol.observations, sameTs.observations).every((o) => (o.intensity === null || Number.isFinite(o.intensity)) && (o.deltaVolume === null || Number.isFinite(o.deltaVolume)) && (o.dtSeconds === null || Number.isFinite(o.dtSeconds))));
}

// ── [D] ─────────────────────────────────────────────────────────────────────
console.log('\n[D] the disabled path computes nothing');
{
  const off = run(series(flat(6)), { enabled: false });
  eq('disabled ⇒ no observations at all', [off.observations.length, off.counts.decided, off.counts.refused], [0, 0, 0]);
  eq('disabled ⇒ no refusal invented and no regime counted', [Object.values(off.refusalCounts).reduce((a, b) => a + b, 0), off.regimeCounts], [0, { QUIET: 0, NORMAL: 0, ACTIVE: 0 }]);
  eq('disabled ⇒ sample size 0', [off.snapshotsIn, off.coverage.sessions], [0, 0]);
  ok('the summary says it is disabled', /disabled/.test(off.reviewerSummary));
}

// ── [E] ─────────────────────────────────────────────────────────────────────
console.log('\n[E] determinism and no look-ahead');
{
  const qs = series([1000, 1100, 1250, 1300, 1200, 1400, 1500, 2400]);
  const fwd = run(qs);
  const rev = run([...qs].reverse());
  eq('reversed input ⇒ identical digest', rev.digest, fwd.digest);
  eq('reversed input ⇒ identical interval order', rev.observations.map((o) => o.toTs), fwd.observations.map((o) => o.toTs));
  eq('repeated identical runs are byte-identical', run(qs).digest, fwd.digest);

  const before = run(series([1000, 1100, 1200, 1300, 1400, 1500, 1600]));
  const after = run(series([1000, 1100, 1200, 1300, 1400, 1500, 1600, 5000]));
  eq('adding a LATER snapshot does not change any EARLIER interval', after.observations.slice(0, 6).map((o) => [o.intensity, o.regime]), before.observations.slice(0, 6).map((o) => [o.intensity, o.regime]));
  eq('...including the earlier baselines', after.observations.slice(0, 6).map((o) => o.baselineMedian), before.observations.slice(0, 6).map((o) => o.baselineMedian));
  ok('a later interval IS judged against its predecessors', after.observations[6].regime !== null);
  const mutated = run(series([1000, 1100, 1200, 1300, 1400, 1500, 1600, 999999]));
  eq('mutating ONLY the future value leaves all earlier regimes unchanged', mutated.observations.slice(0, 6).map((o) => o.regime), before.observations.slice(0, 6).map((o) => o.regime));
}

// ── [F] ─────────────────────────────────────────────────────────────────────
console.log('\n[F] sessions never share a baseline; provenance and window echoed');
{
  const day1 = series([1000, 1100, 1200, 1300, 1400, 1500, 1600]);
  const day2 = day1.map((s, i) => ({ ...s, sessionDate: '2026-09-12', ts: new Date(Date.parse(s.ts) + 86400000).toISOString() }));
  const rep = run([...day1, ...day2]);
  eq('the report counts both sessions', rep.coverage.sessions, 2);
  const d2 = rep.observations.filter((o) => o.sessionDate === '2026-09-12');
  eq('a new session starts with no inherited priors', d2[0].priorObservations, 0);
  eq('...so its first interval has no regime', [d2[0].regime, d2[0].regimeReason], [null, 'INSUFFICIENT_HISTORY']);
  ok('the two sessions are reported separately', rep.sessions.length === 2 && rep.sessions.every((s) => [1, 6].includes(s.intervals)));

  const o = run(series([1000, 1100])).observations[0];
  eq('instrumentKey is echoed verbatim, including its internal "|"', o.instrumentKey, 'NSE_FO|47290');
  eq('source is echoed verbatim', o.source, 'UPSTOX');
  eq('from/to timestamps are echoed as ISO UTC of the raw archive value', [o.fromTs, o.toTs], ['2026-09-11T03:45:00.000Z', '2026-09-11T03:46:00.000Z']);

  const inHours = run(series([1000, 1100]));
  eq('a 09:15-15:30 IST window is counted inside market hours', inHours.coverage.observedWindowOutsideMarketHours, 0);
  const evening = run(series([1000, 1100]).map((s, i) => ({ ...s, ts: new Date(Date.parse('2026-09-11T20:32:00+05:30') + i * 60000).toISOString() })));
  eq('an evening window is flagged OUTSIDE market hours (never assumed)', evening.coverage.observedWindowOutsideMarketHours, 1);
  eq('the observed windows are reported with their first/last snapshot', evening.coverage.observedWindows[0].sessionDate, '2026-09-11');
  ok('the median cadence is reported for fair comparison', typeof inHours.coverage.medianDtSecondsAcrossSessions === 'number');

  const live = run([snap({ source: 'UPSTOX_LIVE', ts: at(0) }), snap({ source: 'UPSTOX_LIVE', ts: at(60), volume: 1000, sequenceNumber: 2 }), snap({ source: 'UPSTOX_LIVE', ts: at(120), volume: 1000, sequenceNumber: 3 })]);
  eq('a source whose cumulative volume never advances is recorded as NOT advancing', [live.sourceProgression.UPSTOX_LIVE.advances, live.sourceProgression.UPSTOX_LIVE.zeroDeltas], [false, 2]);
  eq('...and yields no intensity at all', live.counts.decided, 0);
  eq('an advancing source is recorded as advancing', run(series([1000, 1100])).sourceProgression.UPSTOX.advances, true);
}

// ── [G] ─────────────────────────────────────────────────────────────────────
console.log('\n[G] purity + research-only');
{
  const code = fs.readFileSync(SRC, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok('no clock read', !/Date\.now\(\)/.test(code));
  ok('no randomness', !/Math\.random/.test(code));
  ok('no DB or HTTP client', !/mysql|fetch\(|axios|http\./.test(code));
  ok('no model/AI client', !/openai|anthropic|bedrock|\bgpt-|claude|\bllm\b/i.test(code));
  ok('no ranking/optimisation of results', !/optimis|optimiz|\brank\b/i.test(code));
  ok('research/shadow only: no production importer yet', prodImporters().length === 0, prodImporters().join(','));
  function prodImporters() {
    const hits = [];
    const RESEARCH = ['gap-engine', 'value-profile', 'microstructure'];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (!RESEARCH.includes(e.name)) walk(p); }
        else if (e.name.endsWith('.ts') && !RESEARCH.some((d) => p.includes(path.join('trading', d)))) {
          if (/trade-intensity|evaluateTradeIntensity|TRADE_INTENSITY/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(REPO, p));
        }
      }
    };
    walk(path.join(REPO, 'src'));
    return hits;
  }
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log('FAILED:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
process.exit(0);
