#!/usr/bin/env node
/**
 * Gate 374 — Review Process
 * Verify review infrastructure: acceptance-criteria.md, gate-close-allow.json,
 * at least one gate-check script exists.
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

// 1. docs/acceptance-criteria.md exists and has content
check('acceptance-criteria.md exists with content', () => {
  const p = path.join(REPO, 'docs/acceptance-criteria.md');
  return fs.existsSync(p) && fs.statSync(p).size > 200;
});

// 2. docs/gate-close-allow.json exists and is valid JSON
check('gate-close-allow.json exists and valid', () => {
  const p = path.join(REPO, 'docs/gate-close-allow.json');
  if (!fs.existsSync(p)) return false;
  try {
    JSON.parse(fs.readFileSync(p, 'utf8'));
    return true;
  } catch { return false; }
});

// 3. At least one gate-check script exists
check('at least one gate-check script in scripts/gate-checks/', () => {
  const dir = path.join(REPO, 'scripts/gate-checks');
  if (!fs.existsSync(dir)) return false;
  const files = fs.readdirSync(dir).filter(f => f.startsWith('gate-') && f.endsWith('.js'));
  return files.length >= 1;
});

// 4. docs/ directory has multiple doc files (review infrastructure)
check('docs/ has multiple documentation files', () => {
  const dir = path.join(REPO, 'docs');
  if (!fs.existsSync(dir)) return false;
  const files = fs.readdirSync(dir);
  return files.length >= 3;
});

// 5. agent-buffers.md exists (deployment documentation)
check('docs/agent-buffers.md exists', () => {
  return fs.existsSync(path.join(REPO, 'docs/agent-buffers.md'));
});

// 6. execution-protocol.md exists (execution documentation)
check('docs/execution-protocol.md exists', () => {
  return fs.existsSync(path.join(REPO, 'docs/execution-protocol.md'));
});

// 7. acceptance-criteria.md contains checklist items
check('acceptance-criteria.md contains checklist items', () => {
  const content = fs.readFileSync(path.join(REPO, 'docs/acceptance-criteria.md'), 'utf8');
  return /doneWhen|acceptance|criteria/i.test(content) && content.length > 500;
});

// 8. gate-close-allow.json contains allowed gates
check('gate-close-allow.json has gate entries', () => {
  const data = JSON.parse(fs.readFileSync(path.join(REPO, 'docs/gate-close-allow.json'), 'utf8'));
  const keys = Object.keys(data);
  return keys.length > 0;
});

if (reasons.length > 0) {
  console.log('GATE 374 — Review Process: FAIL');
  reasons.forEach(r => console.log('  ' + r));
  process.exit(1);
}

console.log('GATE 374 — Review Process: PASS');
console.log('  All 8 checks passed: acceptance-criteria.md, gate-close-allow.json, gate-check scripts, docs infrastructure all present.');
process.exit(0);
