#!/usr/bin/env node
/**
 * GATE 7 #9 (roadmap row 81) — "high IV = sell" is NOT a rule: the DELIBERATE NEGATIVE TEST.
 *
 * doneWhen: "A deliberate negative test demonstrates that the prohibited behavior is rejected."
 *
 * [A] contract: the prohibited rule and the closed rejection vocabulary live in CODE
 * [B] THE DELIBERATE NEGATIVE TEST — the prohibited behaviour is rejected at the boundary
 * [C] the control is targeted, not a blanket block on IV-aware reasoning
 * [D] an unrecognised dimension cannot smuggle the pattern through
 * [E] determinism + purity + research-only
 */
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');

const M = require(path.join(REPO, 'dist', 'trading', 'options', 'iv-rule-guard'));
const SRC = path.join(REPO, 'src', 'trading', 'options', 'iv-rule-guard.ts');

let pass = 0;
const failures = [];
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  PASS ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`); }
};
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);

const V = (r) => M.guardIvRule(r).verdict;
const R = (r) => M.guardIvRule(r).rejection;

// ── [A] ─────────────────────────────────────────────────────────────────────
console.log('\n[A] contract — the control lives in code');
{
  eq('version', M.IV_RULE_GUARD_VERSION, 'ivrule-v1');
  eq('the prohibited rule id is pinned', [...M.PROHIBITED_IV_RULES], ['HIGH_IV_IMPLIES_SELL']);
  ok('the prohibited rule has a published statement (the words a reviewer checks against)', /NEVER sufficient reason to sell/.test(M.PROHIBITED_IV_RULE_STATEMENTS.HIGH_IV_IMPLIES_SELL));
  eq('the closed rejection vocabulary is the documented set', [...M.IV_RULE_REJECTIONS], ['NO_RATIONALE', 'IV_REGIME_ALONE', 'PROHIBITED_RULE_CITED']);
  eq('the spec documents the prohibited rule and every rejection', [M.IV_RULE_GUARD_SPEC.prohibited, M.IV_RULE_GUARD_SPEC.refuses], [['HIGH_IV_IMPLIES_SELL'], [...M.IV_RULE_REJECTIONS]]);
  eq('the guard is exported as a function (not a prompt)', typeof M.guardIvRule, 'function');
  ok('the spec states the guard tests STRUCTURE, never a numeric IV level', /never a numeric IV level/.test(M.IV_RULE_GUARD_SPEC.thresholds));
}

// ── [B] ─────────────────────────────────────────────────────────────────────
console.log('\n[B] THE DELIBERATE NEGATIVE TEST — the prohibited behaviour is rejected');
{
  // the exact pattern the row forbids: "IV is high, therefore sell"
  const highIvSell = { dimensions: ['ivRegime'], note: 'IV 20.0 vs RV 12.0 → sell premium' };
  eq('an IV-regime-only rationale is REJECTED', [V(highIvSell), R(highIvSell)], ['REJECTED', 'IV_REGIME_ALONE']);
  ok('...and the detail names the prohibition', /NEVER sufficient reason to sell/.test(M.guardIvRule(highIvSell).detail));
  eq('...and the matched prohibited rule is reported', M.guardIvRule(highIvSell).prohibitedRuleMatched, 'HIGH_IV_IMPLIES_SELL');
  eq('a differently-worded IV-only rationale is still REJECTED', R({ dimensions: ['ivRegime'], note: 'rich vol, short the straddle' }), 'IV_REGIME_ALONE');
  eq('a rationale that NAMES the rule is REJECTED', [V({ dimensions: ['direction'], citesRule: 'HIGH_IV_IMPLIES_SELL' }), R({ dimensions: ['direction'], citesRule: 'HIGH_IV_IMPLIES_SELL' })], ['REJECTED', 'PROHIBITED_RULE_CITED']);
  eq('an empty rationale is REJECTED', [V({ dimensions: [] }), R({ dimensions: [] })], ['REJECTED', 'NO_RATIONALE']);
  eq('no rationale at all is REJECTED', [V(null), R(null)], ['REJECTED', 'NO_RATIONALE']);
  ok('the prohibited behaviour is rejected even when other text is present', V({ dimensions: ['ivRegime'], note: 'momentum says buy but IV is high so sell' }) === 'REJECTED');
}

// ── [C] ─────────────────────────────────────────────────────────────────────
console.log('\n[C] targeted, not a blanket block');
{
  eq('direction + ivRegime is ALLOWED (IV informs, direction justifies)', V({ dimensions: ['direction', 'ivRegime'] }), 'ALLOWED');
  eq('direction alone is ALLOWED', V({ dimensions: ['direction'] }), 'ALLOWED');
  eq('all four dimensions are ALLOWED', V({ dimensions: ['direction', 'expectedMovement', 'ivRegime', 'holdingPeriod'] }), 'ALLOWED');
  eq('movement + holding is ALLOWED', V({ dimensions: ['expectedMovement', 'holdingPeriod'] }), 'ALLOWED');
  eq('an allowed rationale reports no rejection', R({ dimensions: ['direction', 'ivRegime'] }), null);
}

// ── [D] ─────────────────────────────────────────────────────────────────────
console.log('\n[D] an unrecognised dimension cannot smuggle the pattern through');
{
  eq('an unknown dimension name alone ⇒ NO_RATIONALE (not a pass)', [V({ dimensions: ['volHigh'] }), R({ dimensions: ['volHigh'] })], ['REJECTED', 'NO_RATIONALE']);
  eq('an unknown dimension alongside ivRegime ⇒ still IV_REGIME_ALONE', R({ dimensions: ['volHigh', 'ivRegime'] }), 'IV_REGIME_ALONE');
  eq('recognised dimensions are echoed for the audit trail', M.guardIvRule({ dimensions: ['ivRegime', 'bogus'] }).citedDimensions, ['ivRegime']);
}

// ── [E] ─────────────────────────────────────────────────────────────────────
console.log('\n[E] determinism + purity + research-only');
{
  const r = { dimensions: ['direction', 'ivRegime'], note: 'x' };
  eq('repeated calls are identical', M.guardIvRule(r), M.guardIvRule(r));
  const off = M.guardIvRule({ dimensions: ['ivRegime'] }, { enabled: false });
  eq('the disabled path is explicit, not a silent pass', [off.verdict, off.rejection, /disabled/.test(off.detail)], ['ALLOWED', null, true]);
  const code = fs.readFileSync(SRC, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok('no clock read', !/Date\.now\(\)/.test(code));
  ok('no randomness', !/Math\.random/.test(code));
  ok('no DB or HTTP client', !/mysql|fetch\(|axios|http\./.test(code));
  ok('no model/AI client', !/openai|anthropic|bedrock|\bgpt-|claude|\bllm\b/i.test(code));
  ok('research/shadow only: no production importer', prodImporters().length === 0, prodImporters().join(','));
  function prodImporters() {
    const hits = [];
    const RESEARCH = ['gap-engine', 'value-profile', 'microstructure', 'options'];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (!RESEARCH.includes(e.name)) walk(p); }
        else if (e.name.endsWith('.ts') && !RESEARCH.some((d) => p.includes(path.join('trading', d)))) {
          if (/iv-rule-guard|guardIvRule/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(REPO, p));
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
