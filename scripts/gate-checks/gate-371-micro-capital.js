#!/usr/bin/env node
/**
 * Gate 371 — Micro-Capital & Loss Limits
 * Verify paper-risk.ts has position size limits, stop-loss, and loss-limit config.
 * Exit 0 = PASS, Exit 1 = FAIL
 */
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '../..');
const RISK_PATH = path.join(REPO, 'src/trading/upstox-live-paper/paper-risk.ts');
const reasons = [];

function check(label, fn) {
  try {
    if (!fn()) reasons.push(`FAIL: ${label}`);
  } catch (e) {
    reasons.push(`FAIL: ${label} — ${e.message}`);
  }
}

// 1. paper-risk.ts exists
check('paper-risk.ts exists', () => {
  return fs.existsSync(RISK_PATH) && fs.statSync(RISK_PATH).size > 500;
});

const src = fs.readFileSync(RISK_PATH, 'utf8');

// 2. maxLotsPerPosition (position size limit)
check('maxLotsPerPosition (position size limit)', () => {
  return /maxLotsPerPosition/.test(src);
});

// 3. maxLossPct (session loss limit percentage)
check('maxLossPct (session loss limit)', () => {
  return /maxLossPct/.test(src);
});

// 4. maxLossAmount (session loss limit amount)
check('maxLossAmount (session loss limit amount)', () => {
  return /maxLossAmount/.test(src);
});

// 5. maxLossHit flag
check('maxLossHit flag computed', () => {
  return /maxLossHit/.test(src);
});

// 6. maxRiskPerTrade (risk per trade limit)
check('maxRiskPerTrade (risk per trade)', () => {
  return /maxRiskPerTrade/.test(src);
});

// 7. Stop loss logic exists (stopPerUnit or stopLoss)
check('stop loss logic present', () => {
  return /stopPerUnit/.test(src) || /stopLoss/.test(src);
});

// 8. Refusal/blocking on loss limit
check('loss limit blocks further trades', () => {
  return /maxLossHit.*refusals/i.test(src) || /session loss limit/.test(src);
});

// 9. Policy struct with configurable limits
check('policy struct with configurable limits', () => {
  return /interface.*Policy|type.*Policy/.test(src);
});

if (reasons.length > 0) {
  console.log('GATE 371 — Micro-Capital & Loss Limits: FAIL');
  reasons.forEach(r => console.log('  ' + r));
  process.exit(1);
}

console.log('GATE 371 — Micro-Capital & Loss Limits: PASS');
console.log('  All 9 checks passed: position size limits, loss limits, stop loss, and refusal logic all present in paper-risk.ts.');
process.exit(0);
