#!/usr/bin/env node
/**
 * Gate 368 — Kill Switch & Order Deduplication
 * Verify KillSwitchState type, killSwitch field, and duplicateOrderWindowMs exist
 * in independent-risk-engine.ts.
 * Exit 0 = PASS, Exit 1 = FAIL
 */
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '../..');
const ENGINE_PATH = path.join(REPO, 'src/trading/independent-risk-engine.ts');
const reasons = [];

function check(label, fn) {
  try {
    if (!fn()) reasons.push(`FAIL: ${label}`);
  } catch (e) {
    reasons.push(`FAIL: ${label} — ${e.message}`);
  }
}

// 1. File exists and is non-trivial
check('independent-risk-engine.ts exists', () => {
  return fs.existsSync(ENGINE_PATH) && fs.statSync(ENGINE_PATH).size > 1000;
});

const src = fs.readFileSync(ENGINE_PATH, 'utf8');

// 2. KillSwitchState type defined
check('KillSwitchState type defined', () => {
  return /type\s+KillSwitchState\s*=/.test(src);
});

// 3. killSwitch field in config/state interface
check('killSwitch field present', () => {
  return /killSwitch\s*:\s*KillSwitchState/.test(src);
});

// 4. duplicateOrderWindowMs field present
check('duplicateOrderWindowMs field present', () => {
  return /duplicateOrderWindowMs\s*:\s*number/.test(src);
});

// 5. Kill switch active check exists
check('Kill switch active check logic', () => {
  return /killSwitch\.active/.test(src) || /killSwitch.*active/.test(src);
});

// 6. Kill switch transition function exists
check('Kill switch transition/update function', () => {
  return /KillSwitchState.*=>\s*KillSwitchState/.test(src);
});

// 7. Order deduplication window is configurable (not hardcoded 0)
check('duplicateOrderWindowMs has non-zero default', () => {
  const match = src.match(/duplicateOrderWindowMs\s*[:=]\s*(\d+)/);
  if (!match) return false;
  return parseInt(match[1]) > 0;
});

// 8. Kill switch has reason field
check('Kill switch has reason field', () => {
  return /reason/.test(src) && /killSwitch/i.test(src);
});

if (reasons.length > 0) {
  console.log('GATE 368 — Kill Switch & Dedup: FAIL');
  reasons.forEach(r => console.log('  ' + r));
  process.exit(1);
}

console.log('GATE 368 — Kill Switch & Dedup: PASS');
console.log('  All 8 checks passed: KillSwitchState type, killSwitch field, duplicateOrderWindowMs all present in independent-risk-engine.ts.');
process.exit(0);
