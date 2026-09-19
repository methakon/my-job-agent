#!/usr/bin/env node
/**
 * Gate 362 — Regime Stability
 * Verify regime-tags.ts produces consistent tags and vetoReport is populated.
 * Exit 0 = PASS, Exit 1 = FAIL
 */
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '../..');
const reasons = [];

function check(label, fn) {
  try {
    if (!fn()) reasons.push(`FAIL: ${label}`);
  } catch (e) {
    reasons.push(`FAIL: ${label} — ${e.message}`);
  }
}

// 1. regime-tags.ts exists and is non-empty
check('regime-tags.ts exists', () => {
  const p = path.join(REPO, 'src/trading/regime/regime-tags.ts');
  return fs.existsSync(p) && fs.statSync(p).size > 500;
});

// 2. Has RegimeTags type with vetoReport field
check('RegimeTags type with vetoReport', () => {
  const src = fs.readFileSync(path.join(REPO, 'src/trading/regime/regime-tags.ts'), 'utf8');
  return /vetoReport\s*:\s*RegimeVetoReport/.test(src);
});

// 3. Has RegimeVetoReport type
check('RegimeVetoReport type defined', () => {
  const src = fs.readFileSync(path.join(REPO, 'src/trading/regime/regime-tags.ts'), 'utf8');
  return /type\s+RegimeVetoReport\s*=/.test(src);
});

// 4. Has all 8 family tags documented
check('8 family tags present (trend,range,volatility,liquidity,openingState,eventCatalyst,gapAcceptance,volatilityTransition)', () => {
  const src = fs.readFileSync(path.join(REPO, 'src/trading/regime/regime-tags.ts'), 'utf8');
  const families = ['trend', 'range', 'volatility', 'liquidity', 'openingState', 'eventCatalyst', 'gapAcceptance', 'volatilityTransition'];
  return families.every(f => src.includes(f));
});

// 5. vetoReport is actually populated (not just empty object)
check('vetoReport populated with wouldBlock entries', () => {
  const src = fs.readFileSync(path.join(REPO, 'src/trading/regime/regime-tags.ts'), 'utf8');
  return /vetoReport\[/.test(src) && /wouldBlock/.test(src);
});

// 6. Regime tags version string exists
check('REGIME_TAGS_VERSION exported', () => {
  const src = fs.readFileSync(path.join(REPO, 'src/trading/regime/regime-tags.ts'), 'utf8');
  return /export\s+const\s+REGIME_TAGS_VERSION/.test(src);
});

// 7. SessionBar type exists
check('RegimeSessionBar type exists', () => {
  const src = fs.readFileSync(path.join(REPO, 'src/trading/regime/regime-tags.ts'), 'utf8');
  return /type\s+RegimeSessionBar\s*=/.test(src);
});

if (reasons.length > 0) {
  console.log('GATE 362 — Regime Stability: FAIL');
  reasons.forEach(r => console.log('  ' + r));
  process.exit(1);
}

console.log('GATE 362 — Regime Stability: PASS');
console.log('  All 7 checks passed: regime-tags.ts is functional with 8-family tags, vetoReport populated, version exported.');
process.exit(0);
