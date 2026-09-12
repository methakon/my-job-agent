#!/usr/bin/env node
/**
 * GATE 5 input-capture (rows 50/51/52) — FYERS depth mapping prototype.
 *
 * Proves the OFFLINE mapping is deterministic, preserves provenance, never pads or invents a level, and
 * refuses an unknown shape — WITHOUT claiming any live availability (the module is unwired).
 *
 * [A] contract: version, depth-v1, closed refusal vocabulary
 * [B] the array form maps to a best level + a canonical block, best-first
 * [C] the object form maps, with absent `orders` kept null
 * [D] every refusal: NO_DEPTH / UNKNOWN_SHAPE / EMPTY_SIDE / MALFORMED_LEVEL / NON_FINITE / CROSSED_BOOK
 * [E] no padding and no invention (short side kept short; long side truncated)
 * [F] determinism, ordering independence, provenance echoed
 * [G] purity + research-only (not wired into production)
 */
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');

const M = require(path.join(REPO, 'dist', 'trading', 'microstructure', 'capture', 'fyers-depth-mapping'));
const SRC = path.join(REPO, 'src', 'trading', 'microstructure', 'capture', 'fyers-depth-mapping.ts');

let pass = 0;
const failures = [];
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  PASS ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`); }
};
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);

const arrays = () => ({ bid: [[24000, 75, 3], [23999.5, 150, 5]], ask: [[24000.5, 50, 2], [24001, 120, 4]] });
const map = (over) => M.mapFyersDepth({ providerInstrumentId: 'NSE:NIFTY26SEP24000CE', providerPayloadHash: 'hash1', ...arrays(), ...over });

// ── [A] ─────────────────────────────────────────────────────────────────────
console.log('\n[A] contract');
{
  eq('version', M.FYERS_DEPTH_MAPPING_VERSION, 'fyersdepth-v1');
  eq('the emitted depth block is versioned', M.DEPTH_VERSION, 'depth-v1');
  eq('the closed refusal vocabulary is the documented set', [...M.DEPTH_REFUSALS], ['NO_DEPTH', 'UNKNOWN_SHAPE', 'EMPTY_SIDE', 'MALFORMED_LEVEL', 'NON_FINITE', 'CROSSED_BOOK']);
  eq('the spec documents every refusal token', M.FYERS_DEPTH_MAPPING_SPEC.refuses, [...M.DEPTH_REFUSALS]);
  eq('the spec pins the accepted shape and the no-manufacture rule', [M.FYERS_DEPTH_MAPPING_SPEC.depthVersion, /never padded/.test(M.FYERS_DEPTH_MAPPING_SPEC.neverManufactures)], ['depth-v1', true]);
}

// ── [B] ─────────────────────────────────────────────────────────────────────
console.log('\n[B] the array form maps to a best level + a canonical block');
{
  const r = map();
  eq('status OK', r.status, 'OK');
  eq('the best level is bids[0]/asks[0]', r.best, { bid: 24000, ask: 24000.5, bidQty: 75, askQty: 50 });
  eq('the block is depth-v1 with both sides', [r.depth.depthVersion, r.depth.bidLevels, r.depth.askLevels], ['depth-v1', 2, 2]);
  eq('bids are best-first (descending price) with 1-based level index', r.depth.bids.map((l) => [l.level, l.price, l.qty, l.orders]), [[1, 24000, 75, 3], [2, 23999.5, 150, 5]]);
  eq('asks are best-first (ascending price)', r.depth.asks.map((l) => [l.level, l.price, l.qty, l.orders]), [[1, 24000.5, 50, 2], [2, 24001, 120, 4]]);
  eq('timestamp semantics are QUOTE', r.depth.sourceTimestampSemantics, 'QUOTE');
  eq('a zero size is a REAL size, not absent', map({ bid: [[24000, 0]], ask: [[24001, 5]] }).best.bidQty, 0);
}

// ── [C] ─────────────────────────────────────────────────────────────────────
console.log('\n[C] the object form maps');
{
  const r = map({ bid: [{ price: 24000, quantity: 75, numOrders: 3 }], ask: [{ price: 24001, size: 50 }] });
  eq('the object form is accepted', [r.status, r.best], ['OK', { bid: 24000, ask: 24001, bidQty: 75, askQty: 50 }]);
  eq('an absent orders field stays null', [r.depth.bids[0].orders, r.depth.asks[0].orders], [3, null]);
}

// ── [D] ─────────────────────────────────────────────────────────────────────
console.log('\n[D] every refusal is safe and explicit');
{
  eq('no payload ⇒ NO_DEPTH', M.mapFyersDepth(undefined).reason, 'NO_DEPTH');
  eq('scalar bid/ask (the QUOTE form) ⇒ NO_DEPTH', map({ bid: 24000, ask: 24001 }).reason, 'NO_DEPTH');
  eq('an empty side ⇒ EMPTY_SIDE', map({ bid: [] }).reason, 'EMPTY_SIDE');
  eq('a non-finite level price ⇒ NON_FINITE', map({ bid: [['x', 5]] }).reason, 'NON_FINITE');
  eq('a negative level price ⇒ MALFORMED_LEVEL', map({ bid: [[-1, 5]] }).reason, 'MALFORMED_LEVEL');
  eq('a negative size ⇒ MALFORMED_LEVEL', map({ ask: [[24001, -5]] }).reason, 'MALFORMED_LEVEL');
  eq('a crossed book ⇒ CROSSED_BOOK', map({ bid: [[24001, 10]], ask: [[24000, 10]] }).reason, 'CROSSED_BOOK');
  eq('an unrecognised level shape ⇒ MALFORMED_LEVEL', map({ bid: [42] }).reason, 'MALFORMED_LEVEL');
  const refusals = [M.mapFyersDepth(undefined), map({ bid: [] }), map({ bid: [[-1, 5]] })];
  ok('every refusal carries a null best AND a null depth block (no partial book)', refusals.every((r) => r.status === 'UNAVAILABLE' && r.best === null && r.depth === null));
  ok('...with a human detail', refusals.every((r) => typeof r.reasonDetail === 'string' && r.reasonDetail.length > 0));
}

// ── [E] ─────────────────────────────────────────────────────────────────────
console.log('\n[E] no padding, no invention');
{
  const short = map({ bid: [[24000, 10]], ask: [[24000.5, 10], [24001, 20], [24002, 30]] });
  eq('a one-level bid side stays one level (never padded)', [short.depth.bidLevels, short.depth.askLevels], [1, 3]);
  eq('...and only the levels actually received are present', [short.depth.bids.length, short.depth.asks.length], [1, 3]);
  const long = map({ bid: [[24000, 1], [23999, 2], [23998, 3]], ask: [[24001, 1], [24002, 2], [24003, 3]], maxLevels: 2 });
  eq('a book longer than maxLevels is truncated (not summarised/fabricated)', [long.depth.bidLevels, long.depth.askLevels], [2, 2]);
  eq('...keeping the BEST levels', [long.depth.bids.map((l) => l.price), long.depth.asks.map((l) => l.price)], [[24000, 23999], [24001, 24002]]);
}

// ── [F] ─────────────────────────────────────────────────────────────────────
console.log('\n[F] determinism, ordering independence, provenance');
{
  const fwd = map();
  const shuffled = map({ bid: [[23999.5, 150, 5], [24000, 75, 3]], ask: [[24001, 120, 4], [24000.5, 50, 2]] });
  eq('a shuffled level order yields the SAME block', shuffled.depth, fwd.depth);
  eq('repeated identical runs are identical', JSON.stringify(map().depth), JSON.stringify(fwd.depth));
  eq('provenance is carried on the block', [fwd.depth.providerInstrumentId, fwd.depth.providerPayloadHash], ['NSE:NIFTY26SEP24000CE', 'hash1']);
  eq('absent provenance stays null, never invented', [M.mapFyersDepth({ bid: [[1, 1]], ask: [[2, 1]] }).depth.providerInstrumentId, M.mapFyersDepth({ bid: [[1, 1]], ask: [[2, 1]] }).depth.providerPayloadHash], [null, null]);
}

// ── [G] ─────────────────────────────────────────────────────────────────────
console.log('\n[G] purity + research-only');
{
  const code = fs.readFileSync(SRC, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok('no clock read', !/Date\.now\(\)/.test(code));
  ok('no randomness', !/Math\.random/.test(code));
  ok('no DB or HTTP client', !/mysql|fetch\(|axios|http\./.test(code));
  ok('no model/AI client', !/openai|anthropic|bedrock|\bgpt-|claude|\bllm\b/i.test(code));
  ok('research/shadow only: no production importer', prodImporters().length === 0, prodImporters().join(','));
  function prodImporters() {
    const hits = [];
    const RESEARCH = ['gap-engine', 'value-profile', 'microstructure'];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (!RESEARCH.includes(e.name)) walk(p); }
        else if (e.name.endsWith('.ts') && !RESEARCH.some((d) => p.includes(path.join('trading', d)))) {
          if (/fyers-depth-mapping|mapFyersDepth/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(REPO, p));
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
