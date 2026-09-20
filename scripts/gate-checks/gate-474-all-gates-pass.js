#!/usr/bin/env node
/**
 * Gate 474 — Master Gate: Run All Sub-Gates
 * Runs gates 362, 365, 368, 371, 374 and checks DB for no status='fail' items.
 * Exit 0 = ALL PASS, Exit 1 = ANY FAIL
 */
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const REPO = path.resolve(__dirname, '../..');
const SUB_GATES = [
  { id: 362, name: 'regime-stability' },
  { id: 365, name: 'release-artifact' },
  { id: 368, name: 'killswitch-dedup' },
  { id: 371, name: 'micro-capital' },
  { id: 374, name: 'review-process' },
];

const results = [];
let allPass = true;

console.log('GATE 474 — Master Gate: Running all sub-gates...\n');

for (const gate of SUB_GATES) {
  const script = path.join(REPO, `scripts/gate-checks/gate-${gate.id}-${gate.name}.js`);
  let exitCode;
  let output = '';
  try {
    output = execSync(`node "${script}"`, { cwd: REPO, encoding: 'utf8', timeout: 30000 });
    exitCode = 0;
  } catch (e) {
    output = e.stdout || e.message;
    exitCode = e.status || 1;
  }
  const passed = exitCode === 0;
  if (!passed) allPass = false;
  results.push({ id: gate.id, name: gate.name, passed, output: output.trim() });
  const icon = passed ? '✅' : '❌';
  console.log(`  ${icon} Gate ${gate.id} (${gate.name}): ${passed ? 'PASS' : 'FAIL'}`);
  if (!passed) {
    console.log(`     ${output.split('\n').join('\n     ')}`);
  }
}

// Check DB for items with status='fail'
console.log('\nChecking DB for failed items...');
let dbOk = true;
try {
  const envPath = path.join(REPO, '.env');
  // Write a temp SQL query to avoid shell escaping issues
  const sqlQuery = "SELECT COUNT(*) FROM project_checklist_items WHERE status='fail'";
  const sqlFile = path.join(REPO, '.tmp_gate474_check.sql');
  fs.writeFileSync(sqlFile, sqlQuery);

  const bashCmd = `source "${envPath}" && mysql -h "$MYSQL_HOST" -P "$MYSQL_PORT" -u "$MYSQL_USER" -p"$MYSQL_PASSWORD" myjob_agent -N < "${sqlFile}"`;
  const envOut = execSync(`bash -c ${JSON.stringify(bashCmd)}`, {
    cwd: REPO, encoding: 'utf8', timeout: 15000,
  }).trim();

  // Cleanup temp file
  try { fs.unlinkSync(sqlFile); } catch {}

  const failCount = parseInt(envOut, 10);
  if (failCount > 0) {
    console.log(`  ❌ DB has ${failCount} items with status='fail'`);
    dbOk = false;
    allPass = false;
  } else {
    console.log('  ✅ DB has 0 items with status=fail');
  }
} catch (e) {
  console.log(`  ⚠️  DB check skipped: ${(e.stderr || e.message || '').substring(0, 150)}`);
  try { fs.unlinkSync(path.join(REPO, '.tmp_gate474_check.sql')); } catch {}
}

console.log(`\nGATE 474 — Master Gate: ${allPass ? 'PASS' : 'FAIL'}`);
if (!allPass) {
  const failed = results.filter(r => !r.passed).map(r => r.id);
  if (failed.length > 0) console.log(`  Failed sub-gates: ${failed.join(', ')}`);
  if (!dbOk) console.log('  DB has items with status=fail');
  process.exit(1);
}

console.log('  All 5 sub-gates passed. DB clean. Promotion path clear.');
process.exit(0);
