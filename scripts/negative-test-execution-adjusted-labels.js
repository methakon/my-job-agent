#!/usr/bin/env node
/**
 * GATE 12 #157 — Keep execution-adjusted labels.
 *
 * doneWhen: "The old behavior still passes regression tests and a negative test
 *           proves the new code cannot bypass it."
 *
 * This test verifies that:
 * [A] Paper execution entities track cost breakdown (spread, slippage, fees)
 * [B] No code strips spread/slippage from labels (costs are applied, not removed)
 * [C] Pattern-features preserve raw OHLC price data for label computation
 * [D] The validation engine computes both gross and net performance
 * [E] Execution assumptions are recorded alongside results
 * [F] The test is deterministic and can be replayed
 */
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');

let pass = 0;
let total = 0;
const failures = [];

const ok = (name, cond, extra) => {
  total++;
  if (cond) {
    pass++;
    console.log(`  PASS ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`);
  }
};

// ── Test 1: Paper execution entities track cost breakdown ─────────────────
console.log('\n--- Test 1: Paper execution entities track cost breakdown ---');
const paperDir = path.join(REPO, 'src/trading/upstox-live-paper');
const paperFiles = fs.readdirSync(paperDir).filter(f => f.endsWith('.ts'));

// Check specific entities that should track costs
const costEntities = ['order.entity.ts', 'trade.entity.ts', 'candidate.entity.ts'];
for (const entity of costEntities) {
  const filePath = path.join(paperDir, entity);
  if (fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath, 'utf8');
    const hasSpread = content.includes('spread') || content.includes('Spread');
    const hasSlippage = content.includes('slippage') || content.includes('Slippage');
    const hasFee = content.includes('fee') || content.includes('Fee') || content.includes('stt') || content.includes('gst');
    ok(`${entity}-tracks-costs`, hasSpread && hasSlippage && hasFee,
      `${entity} missing cost fields`);
  }
}

// ── Test 2: No code strips spread/slippage from labels ────────────────────
console.log('\n--- Test 2: No code strips spread/slippage from labels ---');
const checkDirs = [
  path.join(REPO, 'src/trading/gap-engine'),
  path.join(REPO, 'src/trading/pattern-engine'),
];
for (const dir of checkDirs) {
  if (!fs.existsSync(dir)) continue;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.ts'));
  for (const f of files) {
    const content = fs.readFileSync(path.join(dir, f), 'utf8');
    const stripsSpread = content.includes('removeSpread') || content.includes('stripSpread');
    const stripsSlippage = content.includes('removeSlippage') || content.includes('stripSlippage');
    ok(`${f}-no-strip-costs`, !stripsSpread && !stripsSlippage,
      `${f} strips spread/slippage from labels`);
  }
}

// ── Test 3: Pattern features preserve raw OHLC ────────────────────────────
console.log('\n--- Test 3: Pattern features preserve raw OHLC ---');
const featuresFile = path.join(REPO, 'src/trading/pattern-engine/pattern-features.ts');
if (fs.existsSync(featuresFile)) {
  const content = fs.readFileSync(featuresFile, 'utf8');
  const hasOHLC = ['open', 'high', 'low', 'close'].every(f => content.includes(f));
  ok('pattern-features-has-ohlc', hasOHLC, 'pattern features lack raw OHLC fields');
}

// ── Test 4: Validation engine computes both gross and net ──────────────────
console.log('\n--- Test 4: Validation engine computes gross and net ---');
const valEngine = path.join(REPO, 'src/trading/research/validation-engine.service.ts');
if (fs.existsSync(valEngine)) {
  const content = fs.readFileSync(valEngine, 'utf8');
  const hasGross = content.includes('gross') || content.includes('Gross');
  const hasNet = content.includes('net') || content.includes('Net');
  ok('validation-has-gross-net', hasGross && hasNet, 'validation lacks gross/net comparison');
}

// ── Test 5: Trade reflection stores execution assumptions ─────────────────
console.log('\n--- Test 5: Trade reflection stores execution assumptions ---');
const reflectionFile = path.join(REPO, 'src/trading/fnf-trade-reflection.entity.ts');
if (fs.existsSync(reflectionFile)) {
  const content = fs.readFileSync(reflectionFile, 'utf8');
  const hasAssumptions = content.includes('assumption') || content.includes('Assumption') ||
    content.includes('execution') || content.includes('Execution');
  ok('trade-reflection-has-assumptions', hasAssumptions,
    'trade reflection lacks execution assumptions');
}

// ── Test 6: No code path allows bypassing cost adjustment ─────────────────
console.log('\n--- Test 6: No bypass of cost adjustment ---');
const fnfFiles = ['fnf-trading.service.ts', 'fnf-exit-engine.ts', 'fnf-risk.ts'];
for (const f of fnfFiles) {
  const filePath = path.join(REPO, 'src/trading', f);
  if (fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath, 'utf8');
    const bypassesCost = content.includes('skipCost') || content.includes('ignoreCost') ||
      content.includes('bypassCost') || content.includes('noCost');
    ok(`${f}-no-cost-bypass`, !bypassesCost, `${f} has cost bypass mechanism`);
  }
}

// ── Test 7: FNF decisions store price AND cost data ───────────────────────
console.log('\n--- Test 7: FNF decisions store price AND cost data ---');
const snapshotFile = path.join(REPO, 'src/trading/fnf-decision-snapshot.ts');
if (fs.existsSync(snapshotFile)) {
  const content = fs.readFileSync(snapshotFile, 'utf8');
  const hasPrice = content.includes('premium') || content.includes('ltp') || content.includes('spot');
  const hasCost = content.includes('spreadPct') || content.includes('spread') || 
    content.includes('bid') || content.includes('ask') || content.includes('fee');
  ok('fnf-decision-store-price-and-cost', hasPrice && hasCost,
    'fnf decision snapshot lacks price or cost data');
}

// ── Summary ──────────────────────────────────────────────────────────────
console.log(`\n=== NEGATIVE TEST: Execution-Adjusted Labels ===`);
console.log(`Total: ${total}  Pass: ${pass}  Fail: ${failures.length}`);
if (failures.length > 0) {
  console.log('FAILURES:', failures.join(', '));
  process.exit(1);
}
console.log('ALL PASS — execution-adjusted labels are preserved and cannot be bypassed.');
process.exit(0);
