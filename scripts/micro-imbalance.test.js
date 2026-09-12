#!/usr/bin/env node
/**
 * GATE 5 #4 (roadmap row 53) — microprice and queue-imbalance features.
 *
 * doneWhen: "The same inputs produce the same result in replay, and edge cases return a safe explicit state
 *            rather than a fabricated value."
 *
 * [A] contract: version, pinned formula/window/units, closed refusal vocabulary, coverage
 * [B] the math is exact (mid/spread/microprice/queue imbalance, both lean directions)
 * [C] every edge case returns a safe explicit state — never 0/NaN/Infinity
 * [D] the disabled path computes nothing
 * [E] determinism + per-observation independence (no look-ahead by construction)
 * [F] provenance is echoed unchanged, including the EVENT/SNAPSHOT basis
 * [G] purity + research-only
 */
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');

const M = require(path.join(REPO, 'dist', 'trading', 'microstructure', 'micro-imbalance'));
const SRC = path.join(REPO, 'src', 'trading', 'microstructure', 'micro-imbalance.ts');

let pass = 0;
const failures = [];
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  PASS ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`); }
};
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);

const q = (over = {}) => ({ instrumentKey: 'BSE:SENSEX17SEP74800PE', source: 'UPSTOX', basis: 'SNAPSHOT', bid: 100, ask: 102, bidQty: 300, askQty: 100, sourceTimestamp: '2026-09-11T09:15:00+05:30', receivedTimestamp: '2026-09-11T09:15:01+05:30', sequenceNumber: 7, payloadHash: 'abc', dataQuality: 'GOOD', ...over });
const one = (over) => M.evaluateMicroImbalance([q(over)]).observations[0];
const vals = (over) => one(over).values;

// ── [A] ─────────────────────────────────────────────────────────────────────
console.log('\n[A] contract');
{
  const rep = M.evaluateMicroImbalance([q()]);
  eq('version', rep.version, 'microimb-v1');
  eq('the config is just the switch', Object.keys(M.DEFAULT_MICRO_IMBALANCE_CONFIG), ['enabled']);
  eq('the closed refusal vocabulary is the documented set', [...M.MICRO_REFUSALS], ['NO_QUOTES', 'INVALID_QUOTE', 'CROSSED_BOOK', 'NO_SIZES', 'NEGATIVE_SIZE', 'ZERO_SIZE', 'NOT_A_NUMBER']);
  eq('the spec documents every refusal token', M.MICRO_IMBALANCE_SPEC.refuses, [...M.MICRO_REFUSALS]);
  eq('the status vocabulary is pinned', [...M.MICRO_STATUSES], ['OK', 'UNAVAILABLE', 'DISABLED']);
  eq('the basis vocabulary is pinned', [...M.QUOTE_BASES], ['EVENT', 'SNAPSHOT', 'UNKNOWN']);
  ok('the spec pins formula, units, window and edges', ['formula', 'units', 'window', 'edges'].every((k) => typeof M.MICRO_IMBALANCE_SPEC[k] === 'string' && M.MICRO_IMBALANCE_SPEC[k].length > 0));
  ok('the spec says there is no look-ahead', /no look-ahead|no lookback/i.test(M.MICRO_IMBALANCE_SPEC.window));
  ok('the spec says multi-level depth and event OFI are NOT inputs', /NOT inputs/.test(M.MICRO_IMBALANCE_SPEC.note));
  eq('the coverage block reports the sample size', [rep.coverage.quotesIn, rep.coverage.ok], [1, 1]);
}

// ── [B] ─────────────────────────────────────────────────────────────────────
console.log('\n[B] the math is exact');
{
  const v = vals();
  eq('mid = (bid+ask)/2', v.mid, 101);
  eq('spread = ask − bid', v.spread, 2);
  eq('relative spread = spread/mid', v.relativeSpread, Number((2 / 101).toFixed(6)));
  eq('queueImbalance = (bidQty−askQty)/(bidQty+askQty)', v.queueImbalance, 0.5);
  eq('microprice = (bid×askQty + ask×bidQty)/(total)', v.microprice, 101.5);
  eq('micropriceOffsetPoints = microprice − mid', v.micropriceOffsetPoints, 0.5);
  eq('micropriceOffsetFraction = offset/mid', v.micropriceOffsetFraction, Number((0.5 / 101).toFixed(6)));

  const sym = vals({ bidQty: 200, askQty: 200 });
  eq('a balanced book ⇒ microprice == mid and zero imbalance', [sym.microprice, sym.micropriceOffsetPoints, sym.queueImbalance], [101, 0, 0]);

  const askHeavy = vals({ bidQty: 100, askQty: 300 });
  eq('an ask-heavy book ⇒ negative imbalance and microprice leaning to the bid', [askHeavy.queueImbalance, askHeavy.microprice], [-0.5, 100.5]);

  const noAsk = vals({ bidQty: 100, askQty: 0 });
  eq('zero ask size ⇒ queueImbalance +1 and microprice = ask', [noAsk.queueImbalance, noAsk.microprice], [1, 102]);
  const noBid = vals({ bidQty: 0, askQty: 100 });
  eq('zero bid size ⇒ queueImbalance −1 and microprice = bid', [noBid.queueImbalance, noBid.microprice], [-1, 100]);

  const flat = vals({ bid: 100, ask: 100, bidQty: 50, askQty: 50 });
  eq('bid == ask is a valid zero spread', [flat.spread, flat.mid, Number(flat.relativeSpread.toFixed(6))], [0, 100, 0]);
  ok('the imbalance always lies in [−1, +1]', [noBid.queueImbalance, askHeavy.queueImbalance, sym.queueImbalance, noAsk.queueImbalance].every((x) => x >= -1 && x <= 1));
}

// ── [C] ─────────────────────────────────────────────────────────────────────
console.log('\n[C] every edge case is safe and explicit');
{
  eq('no observation ⇒ NO_QUOTES', M.evaluateMicroImbalance([null]).observations[0].reason, 'NO_QUOTES');
  eq('an absent bid ⇒ INVALID_QUOTE', one({ bid: null }).reason, 'INVALID_QUOTE');
  eq('a 0 bid is not a price ⇒ INVALID_QUOTE', one({ bid: 0 }).reason, 'INVALID_QUOTE');
  eq('a negative ask ⇒ INVALID_QUOTE', one({ ask: -1 }).reason, 'INVALID_QUOTE');
  eq('bid > ask ⇒ CROSSED_BOOK', one({ bid: 103, ask: 102 }).reason, 'CROSSED_BOOK');
  eq('absent sizes (the FYERS case) ⇒ NO_SIZES', one({ bidQty: null }).reason, 'NO_SIZES');
  eq('a non-finite size ⇒ NOT_A_NUMBER', one({ bidQty: NaN }).reason, 'NOT_A_NUMBER');
  eq('a negative size ⇒ NEGATIVE_SIZE', one({ askQty: -5 }).reason, 'NEGATIVE_SIZE');
  eq('both sizes 0 ⇒ ZERO_SIZE', one({ bidQty: 0, askQty: 0 }).reason, 'ZERO_SIZE');
  const refusals = [one({ bid: null }), one({ bidQty: null }), one({ bidQty: 0, askQty: 0 })];
  ok('every refusal carries null values, never 0/NaN/Infinity', refusals.every((r) => r.values === null && r.status === 'UNAVAILABLE'));
  ok('...with a human detail', refusals.every((r) => typeof r.reasonDetail === 'string' && r.reasonDetail.length > 0));
  const rep = M.evaluateMicroImbalance([q(), q({ bidQty: null }), q({ bid: 0 })]);
  eq('the counts separate decided from refused', [rep.counts.OK, rep.counts.UNAVAILABLE], [1, 2]);
  eq('the sample size counts only the OK rows', rep.coverage.ok, 1);
  eq('the refusal count map is in vocabulary order', Object.keys(rep.refusalCounts), [...M.MICRO_REFUSALS]);
  eq('withSizes counts the quotes that SUPPLY both sizes, whatever else is wrong', rep.coverage.withSizes, 2);
}

// ── [D] ─────────────────────────────────────────────────────────────────────
console.log('\n[D] the disabled path computes nothing');
{
  const off = M.evaluateMicroImbalance([q()], { enabled: false });
  eq('disabled ⇒ DISABLED with null values', [off.observations[0].status, off.observations[0].values], ['DISABLED', null]);
  eq('disabled ⇒ no refusal invented and sample size 0', [Object.values(off.refusalCounts).reduce((a, b) => a + b, 0), off.coverage.ok], [0, 0]);
  ok('the summary says it is disabled', /enabled=false/.test(off.reviewerSummary));
}

// ── [E] ─────────────────────────────────────────────────────────────────────
console.log('\n[E] determinism and per-observation independence');
{
  const quotes = [q({ sourceTimestamp: '2026-09-11T09:15:00+05:30', sequenceNumber: 1, bidQty: 10, askQty: 20 }), q({ sourceTimestamp: '2026-09-11T09:15:10+05:30', sequenceNumber: 2, bidQty: 30, askQty: 5 }), q({ sourceTimestamp: '2026-09-11T09:15:20+05:30', sequenceNumber: 3, bidQty: 40, askQty: 40 })];
  const fwd = M.evaluateMicroImbalance(quotes);
  const rev = M.evaluateMicroImbalance([...quotes].reverse());
  eq('reversed input ⇒ identical digest', rev.digest, fwd.digest);
  eq('reversed input ⇒ identical row order', rev.observations.map((o) => o.evidence.sequenceNumber), fwd.observations.map((o) => o.evidence.sequenceNumber));
  ok('repeated identical runs are byte-identical', M.evaluateMicroImbalance(quotes).digest === fwd.digest);

  // no look-ahead: a quote's value is identical whether evaluated alone or inside a batch
  const alone = M.evaluateMicroImbalance([quotes[1]]).observations[0].values;
  const inBatch = fwd.observations.find((o) => o.evidence.sequenceNumber === 2).values;
  eq('a quote evaluates identically alone and in a batch (no look-ahead)', alone, inBatch);
  // ...and inserting a later quote does not change an earlier one
  const withLater = M.evaluateMicroImbalance([quotes[1], q({ sourceTimestamp: '2026-09-11T15:29:00+05:30', sequenceNumber: 9, bidQty: 1, askQty: 1 })]).observations.find((o) => o.evidence.sequenceNumber === 2).values;
  eq('...and adding a later quote leaves an earlier one unchanged', withLater, inBatch);
}

// ── [F] ─────────────────────────────────────────────────────────────────────
console.log('\n[F] provenance is echoed unchanged');
{
  const o = one();
  eq('source and instrumentKey travel', [o.source, o.instrumentKey], ['UPSTOX', 'BSE:SENSEX17SEP74800PE']);
  eq('the source timestamp is preserved as ISO', o.evidence.sourceTimestamp, '2026-09-11T03:45:00.000Z');
  eq('the received timestamp is preserved as ISO', o.evidence.receivedTimestamp, '2026-09-11T03:45:01.000Z');
  eq('the sequence number, payload hash and data quality travel', [o.evidence.sequenceNumber, o.evidence.payloadHash, o.evidence.dataQuality], [7, 'abc', 'GOOD']);
  eq('the observation basis is recorded, not assumed', o.basis, 'SNAPSHOT');
  eq('an unstated basis is UNKNOWN', one({ basis: undefined }).basis, 'UNKNOWN');
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
          if (/micro-imbalance|evaluateMicroImbalance/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(REPO, p));
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
