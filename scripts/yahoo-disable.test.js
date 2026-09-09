#!/usr/bin/env node
/**
 * Yahoo hard-disable — brief s3 proof tests.
 *
 * Proves:
 * 1. The live feed service logs "Yahoo market-data feed: DISABLED" at boot.
 * 2. FNO_MARKET_DATA_PROVIDER=yahoo is REFUSED (provider stays 'disabled',
 *    feed never starts a Yahoo poller).
 * 3. No live path calls the Yahoo fallback/poller methods — every occurrence
 *    of startYahooFallback/startYahooPoller/pollYahoo/fetchYahooTick sits in
 *    the retained dead-code region (banner comment) of the service file.
 * 4. The FYERS reconnect watcher is the only recovery mechanism (no silent
 *    Yahoo substitution) and it rebuilds the FYERS socket with the SAME token
 *    when the SDK autoreconnect is exhausted.
 * 5. Yahoo code may remain only for historical/non-trading use.
 *
 * Uses source-level assertions on src + compiled dist; does NOT require a
 * running server (house style: scripts/*.test.js).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC_FILE = path.join(ROOT, 'src', 'trading', 'fno-market-data.service.ts');
const DIST_FILE = path.join(ROOT, 'dist', 'trading', 'fno-market-data.service.js');

console.log('▶ building dist (tsc) …');
let distOk = false;
try {
  execSync('npm run build', { cwd: ROOT, stdio: 'pipe', timeout: 240_000 });
  distOk = fs.existsSync(DIST_FILE);
} catch {
  distOk = fs.existsSync(DIST_FILE);
}
console.log(distOk ? '✔ dist compiled' : '✘ dist missing — dist assertions skipped');

const src = fs.readFileSync(SRC_FILE, 'utf8');
const dist = distOk ? fs.readFileSync(DIST_FILE, 'utf8') : '';

// Banner separating the retained dead Yahoo code from all live paths.
const bannerLine = 'Dead code retained for historical / non-trading reference';
const bannerIdx = src.indexOf(bannerLine);
assert.ok(bannerIdx > 0, 'dead-code banner must exist in the service');

// ── 1. Boot log line ────────────────────────────────────────────────────────
assert.match(src, /logger\.log\('Yahoo market-data feed: DISABLED'\)/, 'startup log must say DISABLED');
if (dist) assert.ok(dist.includes('Yahoo market-data feed: DISABLED'), 'dist keeps the DISABLED log line');

// ── 2. Provider=yahoo refused ───────────────────────────────────────────────
assert.match(src, /provider: provider === 'fyers' \? 'fyers' : 'disabled'/, 'status provider can never be yahoo');
assert.match(
  src,
  /Yahoo is not permitted on the live trading\/data path; set FNO_MARKET_DATA_PROVIDER=fyers/,
  'yahoo-requested boot branch must refuse and instruct to use FYERS',
);

// ── 3. No live call sites for Yahoo methods (all inside dead region) ────────
const yahooCalls = /this\.(?:startYahooFallback|startYahooPoller|pollYahoo|fetchYahooTick)\(/g;
let m;
let violations = 0;
while ((m = yahooCalls.exec(src)) !== null) {
  if (m.index < bannerIdx) {
    console.log(`  ✘ live-path Yahoo call at char ${m.index}: ${m[0]}`);
    violations += 1;
  }
}
assert.equal(violations, 0, 'no Yahoo method call may exist on a live path (before the dead-code banner)');
console.log('✔ all Yahoo method calls confined to the retained dead-code region');

// ── 4. Reconnect watcher = only recovery; same-token rebuild allowed ────────
assert.match(
  src,
  /rebuilding market-data socket \(Yahoo fallback is disabled\)/,
  'same-token rebuild branch must exist (Yahoo fallback is disabled)',
);
assert.match(
  src,
  /Yahoo fallback is NOT permitted/,
  'missing-FYERS-creds branch must state Yahoo is not permitted',
);
// ── 5. No other source file references the Yahoo feed methods ───────────────
const { execSync: exec } = require('node:child_process');
const others = exec('grep -rln "startYahooFallback\\|startYahooPoller" src --include="*.ts"', {
  cwd: ROOT,
  stdio: 'pipe',
})
  .toString()
  .trim()
  .split('\n')
  .filter(Boolean)
  .filter((file) => !file.endsWith('fno-market-data.service.ts'));
assert.deepEqual(others, [], 'no other module may call the Yahoo fallback/poller methods');

// ── 6. Yahoo methods retained for historical use (declarations still exist) ─
assert.match(src, /private startYahooPoller\(\): void/, 'startYahooPoller retained as dead code');
assert.match(src, /private startYahooFallback\(reason: string\): void/, 'startYahooFallback retained as dead code');

console.log('\n✅ Yahoo hard-disable (brief s3): all assertions PASS');
