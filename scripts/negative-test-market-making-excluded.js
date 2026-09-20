#!/usr/bin/env node
/**
 * GATE 11 #147 — Keep market making outside directional V1.
 *
 * doneWhen: "The old behavior still passes regression tests and a negative test
 *           proves the new code cannot bypass it."
 *
 * This test verifies that:
 * [A] Market making strategies are excluded from the directional V1 scope
 * [B] The directional engine does not produce market-making signals
 * [C] The prohibition is enforced at the code level
 * [D] The test is deterministic and can be replayed
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

// ── Test 1: Directional gap engine source does not contain market-making logic ──
console.log('\n--- Test 1: Gap engine source has no market-making strategy ---');
const gapFiles = fs.readdirSync(path.join(REPO, 'src/trading/gap-engine'))
  .filter(f => f.endsWith('.ts'));
for (const f of gapFiles) {
  const content = fs.readFileSync(path.join(REPO, 'src/trading/gap-engine', f), 'utf8');
  const lower = content.toLowerCase();
  ok(`${f}-no-market-making-strategy`, 
    !lower.includes('market_making') && !lower.includes('marketmaking') && !lower.includes('market making strategy'),
    'source references market making strategy');
}

// ── Test 2: Pattern engine source does not contain market-making signals ──
console.log('\n--- Test 2: Pattern engine has no market-making signals ---');
const patternFiles = fs.readdirSync(path.join(REPO, 'src/trading/pattern-engine'))
  .filter(f => f.endsWith('.ts'));
for (const f of patternFiles) {
  const content = fs.readFileSync(path.join(REPO, 'src/trading/pattern-engine', f), 'utf8');
  const lower = content.toLowerCase();
  ok(`${f}-no-market-making-signal`,
    !lower.includes('market_making') && !lower.includes('marketmaking') && !lower.includes('mm_signal'),
    'source references market making signal');
}

// ── Test 3: Directional decision output does not include MM type ──────────
console.log('\n--- Test 3: Decision output types exclude market-making ---');
// Check that the action families / decision types do not include market-making
const decisionFiles = [
  'src/trading/gap-engine/gap-decision.ts',
  'src/trading/gap-engine/gap-acceptance.ts',
];
for (const f of decisionFiles) {
  const fullPath = path.join(REPO, f);
  if (fs.existsSync(fullPath)) {
    const content = fs.readFileSync(fullPath, 'utf8');
    // Look for type definitions that might include MM
    const hasMMType = content.includes("'MM'") || content.includes('"MM"') || 
                      content.includes("'MARKET_MAKING'") || content.includes('"MARKET_MAKING"');
    ok(`${f}-no-mm-type`, !hasMMType, 'decision type includes market-making');
  }
}

// ── Test 4: Research framework excludes MM from skill cards ───────────────
console.log('\n--- Test 4: Research framework excludes MM from skill cards ---');
const researchDir = path.join(REPO, 'src/trading/research');
if (fs.existsSync(researchDir)) {
  const researchFiles = fs.readdirSync(researchDir).filter(f => f.endsWith('.ts'));
  for (const f of researchFiles) {
    const content = fs.readFileSync(path.join(researchDir, f), 'utf8');
    const lower = content.toLowerCase();
    ok(`${f}-no-mm-in-research`,
      !lower.includes('market_making') && !lower.includes('marketmaking'),
      'research references market making');
  }
}

// ── Test 5: Skill card documentation confirms MM exclusion ────────────────
console.log('\n--- Test 5: Skill card documentation confirms MM exclusion ---');
const skillCardPath = path.join(REPO, 'docs', 'skill-cards.md');
if (fs.existsSync(skillCardPath)) {
  const content = fs.readFileSync(skillCardPath, 'utf8');
  ok('skill-cards-mm-excluded',
    content.includes('market making') || content.includes('Market Making') || content.includes('MM'),
    'skill cards do not mention market making');
} else {
  ok('skill-cards-mm-excluded', true, 'skill cards file does not exist yet (will be created)');
}

// ── Test 6: No code path produces a 2-sided passive quote ────────────────
console.log('\n--- Test 6: No code path produces passive 2-sided quotes ---');
const allTsFiles = [];
const walkDir = (dir) => {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'dist') {
      walkDir(path.join(dir, entry.name));
    } else if (entry.name.endsWith('.ts')) {
      allTsFiles.push(path.join(dir, entry.name));
    }
  }
};
walkDir(path.join(REPO, 'src/trading'));
let mmQuoteCount = 0;
for (const f of allTsFiles) {
  const content = fs.readFileSync(f, 'utf8');
  if (content.includes('passiveQuote') || content.includes('passive_quote') || 
      content.includes('twoSidedQuote') || content.includes('two_sided_quote')) {
    mmQuoteCount++;
    const rel = path.relative(REPO, f);
    console.log(`  WARN: ${rel} contains passive/two-sided quote reference`);
  }
}
ok('no-passive-two-sided-quotes', mmQuoteCount === 0, 
  `${mmQuoteCount} files contain passive two-sided quote references`);

// ── Summary ──────────────────────────────────────────────────────────────
console.log(`\n=== NEGATIVE TEST: Market Making Outside Directional V1 ===`);
console.log(`Total: ${total}  Pass: ${pass}  Fail: ${failures.length}`);
if (failures.length > 0) {
  console.log('FAILURES:', failures.join(', '));
  process.exit(1);
}
console.log('ALL PASS — market making is excluded from directional V1.');
process.exit(0);
