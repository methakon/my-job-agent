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

// 2. KillSwitchState type/interface defined
check('KillSwitchState type or interface defined', () => {
  return /(?:type|interface)\s+KillSwitchState\s*[={]/.test(src);
});

// 3. KillSwitchState has active, activatedAtMs, reason fields
check('KillSwitchState has active, activatedAtMs, reason fields', () => {
  return /active\s*:\s*boolean/.test(src) && /activatedAtMs\s*:\s*number/.test(src) && /reason\s*:\s*string/.test(src);
});

// 4. killSwitch field in config/state interface
check('killSwitch field present in state/config', () => {
  return /killSwitch\s*:\s*KillSwitchState/.test(src);
});

// 5. duplicateOrderWindowMs field present
check('duplicateOrderWindowMs field present', () => {
  return /duplicateOrderWindowMs\s*:\s*number/.test(src);
});

// 6. Kill switch active check exists
check('Kill switch active check logic', () => {
  return /killSwitch\.active/.test(src) || /if\s*\(.*killSwitch.*active/.test(src);
});

// 7. Kill switch evaluation function exists
check('Kill switch evaluation function (evaluateKillSwitch)', () => {
  return /evaluateKillSwitch/.test(src);
});

// 8. Kill switch transition function returns KillSwitchState
check('evaluateKillSwitch returns KillSwitchState', () => {
  return /evaluateKillSwitch[\s\S]*?\):\s*KillSwitchState/.test(src);
});

// 9. DuplicateOrderRecord or dedup tracking type exists
check('DuplicateOrderRecord or dedup tracking type', () => {
  return /DuplicateOrderRecord/.test(src) || /duplicate.*order/i.test(src);
});

if (reasons.length > 0) {
  console.log('GATE 368 — Kill Switch & Dedup: FAIL');
  reasons.forEach(r => console.log('  ' + r));
  process.exit(1);
}

console.log('GATE 368 — Kill Switch & Dedup: PASS');
console.log('  All 9 checks passed: KillSwitchState type, killSwitch field, evaluateKillSwitch, duplicateOrderWindowMs all present.');
process.exit(0);
