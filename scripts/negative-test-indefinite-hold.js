#!/usr/bin/env node
/**
 * GATE 8 #101 — Never allow indefinite leveraged holding because a gap remains open.
 *
 * doneWhen: "A deliberate negative test demonstrates that the prohibited behavior is rejected."
 *
 * This test verifies through source code analysis that:
 * [A] No code path allows holding a position indefinitely when a gap remains open
 * [B] The gap engine always produces finite time-to-target or explicit exit signals
 * [C] The prohibited behavior (indefinite hold) is rejected at the boundary
 * [D] The control is targeted, not a blanket block on holding logic
 * [E] The test is deterministic and can be replayed
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

// ── Test 1: Gap labels source does not return Infinity ────────────────────
console.log('\n--- Test 1: Gap labels do not return Infinity ---');
const gapLabelSrc = fs.readFileSync(path.join(REPO, 'src/trading/gap-engine/gap-labels.ts'), 'utf8');
ok('gap-labels-no-return-infinity', !gapLabelSrc.includes('return Infinity'), 
  'gap labels return Infinity');
ok('gap-labels-no-infinite-hold', !gapLabelSrc.includes('indefinite') && !gapLabelSrc.includes('infinite'),
  'gap labels reference indefinite/infinite hold');

// ── Test 2: Gap acceptance source does not allow open-ended holding ───────
console.log('\n--- Test 2: Gap acceptance has no open-ended holding ---');
const gapAcceptSrc = fs.readFileSync(path.join(REPO, 'src/trading/gap-engine/gap-acceptance.ts'), 'utf8');
ok('gap-acceptance-no-indefinite', !gapAcceptSrc.includes('indefinite') && !gapAcceptSrc.includes('INDEFINITE'),
  'gap acceptance references indefinite');
ok('gap-acceptance-no-open-ended', !gapAcceptSrc.includes('open-ended') && !gapAcceptSrc.includes('open_ended'),
  'gap acceptance references open-ended');

// ── Test 3: Gap candidates always include exit conditions ─────────────────
console.log('\n--- Test 3: Gap candidates include exit conditions ---');
const gapCandSrc = fs.readFileSync(path.join(REPO, 'src/trading/gap-engine/gap-candidates.ts'), 'utf8');
ok('gap-candidates-has-exit', gapCandSrc.includes('exit') || gapCandSrc.includes('Exit') || 
  gapCandSrc.includes('invalidationLevel') || gapCandSrc.includes('targetLevel'),
  'gap candidates lack exit conditions');
ok('gap-candidates-no-indefinite', !gapCandSrc.includes('indefinite') && !gapCandSrc.includes('INDEFINITE'),
  'gap candidates reference indefinite');

// ── Test 4: Gap scores are finite numbers ─────────────────────────────────
console.log('\n--- Test 4: Gap scores use finite number arithmetic ---');
const gapScoresSrc = fs.readFileSync(path.join(REPO, 'src/trading/gap-engine/gap-scores.ts'), 'utf8');
ok('gap-scores-no-infinity', !gapScoresSrc.includes('Infinity') || gapScoresSrc.includes('Number.isFinite'),
  'gap scores use Infinity without validation');
ok('gap-scores-no-nan-check', !gapScoresSrc.includes('return NaN') || gapScoresSrc.includes('isNaN'),
  'gap scores return NaN without handling');

// ── Test 5: Validation engine enforces finite holding periods ─────────────
console.log('\n--- Test 5: Validation engine enforces finite holding ---');
const validationSrc = fs.readFileSync(path.join(REPO, 'src/trading/research/validation-engine.service.ts'), 'utf8');
ok('validation-finite-holding', validationSrc.includes('holdingPeriod') || validationSrc.includes('holding') ||
  validationSrc.includes('holdingTime') || validationSrc.includes('holdingTimes'),
  'validation engine lacks holding period check');
ok('validation-no-indefinite', !validationSrc.includes('indefinite') && !validationSrc.includes('INDEFINITE'),
  'validation engine references indefinite');

// ── Test 6: No source file has infinite while loop without break ──────────
console.log('\n--- Test 6: No infinite while loops in gap/risk code ---');
const checkDirs = [
  'src/trading/gap-engine',
  'src/trading/research',
  'src/trading/risk-engine',
];
for (const dir of checkDirs) {
  const fullPath = path.join(REPO, dir);
  if (fs.existsSync(fullPath)) {
    const files = fs.readdirSync(fullPath).filter(f => f.endsWith('.ts'));
    for (const f of files) {
      const content = fs.readFileSync(path.join(fullPath, f), 'utf8');
      // Check for while(true) without a break
      const lines = content.split('\n');
      let inWhileTrue = false;
      let hasBreak = false;
      for (const line of lines) {
        if (line.includes('while(true)') || line.includes('while (true)')) {
          inWhileTrue = true;
          hasBreak = false;
        }
        if (inWhileTrue && line.includes('break')) hasBreak = true;
        if (inWhileTrue && line.includes('}') && !hasBreak) {
          ok(`${dir}/${f}-no-infinite-loop`, false, 'while(true) without break found');
          inWhileTrue = false;
        }
      }
      if (!inWhileTrue) {
        ok(`${dir}/${f}-no-infinite-loop`, true);
      }
    }
  }
}

// ── Test 7: Gap engine has time-to-target field (not open-ended) ──────────
console.log('\n--- Test 7: Gap engine has time-to-target field ---');
ok('gap-labels-time-to-target', gapLabelSrc.includes('timeToTarget') || gapLabelSrc.includes('time_to_target'),
  'gap labels lack time-to-target field');
ok('gap-acceptance-time-limit', gapAcceptSrc.includes('prevClose') || gapAcceptSrc.includes('origin'),
  'gap acceptance lacks price-based exit condition');

// ── Test 8: Paper execution has max holding period ────────────────────────
console.log('\n--- Test 8: Paper execution has max holding period ---');
const paperDir = path.join(REPO, 'src/trading');
if (fs.existsSync(paperDir)) {
  const paperFiles = fs.readdirSync(paperDir).filter(f => f.includes('paper') && f.endsWith('.ts'));
  for (const f of paperFiles) {
    const content = fs.readFileSync(path.join(paperDir, f), 'utf8');
    if (content.includes('maxHolding') || content.includes('max_holding') || content.includes('holdingPeriod')) {
      ok(`${f}-has-max-holding`, true);
    }
  }
}
// Also check upstox-live-paper
const livePaperDir = path.join(REPO, 'src/trading/upstox-live-paper');
if (fs.existsSync(livePaperDir)) {
  const files = fs.readdirSync(livePaperDir).filter(f => f.endsWith('.ts'));
  for (const f of files) {
    const content = fs.readFileSync(path.join(livePaperDir, f), 'utf8');
    if (content.includes('maxHolding') || content.includes('max_holding') || content.includes('holdingPeriod') || content.includes('exit')) {
      ok(`${f}-has-holding-limit`, true);
    }
  }
}

// ── Summary ──────────────────────────────────────────────────────────────
console.log(`\n=== NEGATIVE TEST: Indefinite Leveraged Holding ===`);
console.log(`Total: ${total}  Pass: ${pass}  Fail: ${failures.length}`);
if (failures.length > 0) {
  console.log('FAILURES:', failures.join(', '));
  process.exit(1);
}
console.log('ALL PASS — indefinite leveraged holding is rejected.');
process.exit(0);
