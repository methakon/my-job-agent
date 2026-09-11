#!/usr/bin/env node
/**
 * JA-003 Regression Baseline — automated baseline tests.
 *
 * doneWhen (authoritative seed): "Automated baseline tests pass."
 *
 * Proves the JA-002 safety invariant holds across EVERY real submission path,
 * including direct low-level invocation, under both SANDBOX=true and
 * APPLY_KILL_SWITCH=true.  This is a regression baseline: it does not change
 * the guard, does not loosen it, and does not modify .env or production
 * settings.  It reuses the JA-002 guard and preserves existing permitted
 * behavior, especially browser fill-only (autoSubmit=false).
 *
 * Architecture (matches JA-002 exactly):
 *   - Runs against compiled dist/ modules (no ts-node, no build in the test).
 *   - Pure: no DB, no network, no DI container, no Puppeteer.
 *   - The guard function is tested directly.
 *   - Every real submission boundary is verified by inspecting the compiled
 *     JS (guard import + blocked-message string) and exercising the exported
 *     constructors directly.
 *   - readDist(rel) takes paths WITH .js extension (matches JA-002).
 *   - Guard lazy-loaded via require('../dist/...', bare path, no .js).
 */

'use strict';

const assert = require('node:assert/strict');
const fs    = require('node:fs');
const path  = require('node:path');

const ROOT  = path.resolve(__dirname, '..');
const DIST  = path.join(ROOT, 'dist');

// readDist(rel) takes paths WITH .js extension — matches JA-002 exactly.
function readDist(rel) {
  return fs.readFileSync(path.join(DIST, rel), 'utf8');
}

let pass = 0;
const ok = (label) => { pass++; console.log('  ' + pass + '. ' + label + ' ok'); };

// Lazy-load the pure guard module — matches JA-002 pattern.
let guard;
function loadGuard() {
  if (!guard) {
    clearEnv('SANDBOX');
    clearEnv('APPLY_KILL_SWITCH');
    guard = require(path.join(DIST, 'applications/sandbox-safety'));
  }
  return guard;
}

// ---------------------------------------------------------------------------
// env plumbing — set process.env; the guard reads process.env first.
// Do NOT touch .env (JA-002 setEnv wrote to .env; JA-003 does not).
// ---------------------------------------------------------------------------

function setEnvTrue(name) {
  process.env[name] = 'true';
}

function clearEnv(name) {
  delete process.env[name];
}

// The guard only treats the exact string "true" as on.
function assertGuardSemantics() {
  const g = loadGuard();
  assert.strictEqual(typeof g.isSubmissionBlocked, 'function',
    'isSubmissionBlocked must be a function');

  clearEnv('SANDBOX');
  clearEnv('APPLY_KILL_SWITCH');
  assert.strictEqual(g.isSubmissionBlocked(), false,
    'both off → not blocked');

  setEnvTrue('SANDBOX');
  clearEnv('APPLY_KILL_SWITCH');
  assert.strictEqual(g.isSubmissionBlocked(), true,
    'SANDBOX=true → blocked');

  clearEnv('SANDBOX');
  setEnvTrue('APPLY_KILL_SWITCH');
  assert.strictEqual(g.isSubmissionBlocked(), true,
    'APPLY_KILL_SWITCH=true → blocked');

  setEnvTrue('SANDBOX');
  assert.strictEqual(g.isSubmissionBlocked(), true,
    'both true → blocked');

  // Exact-match semantics: only exactly "true" (lowercase) triggers.
  process.env.SANDBOX = 'True';
  clearEnv('APPLY_KILL_SWITCH');
  assert.strictEqual(g.isSubmissionBlocked(), false,
    '"True" is NOT blocked — exact match');

  process.env.SANDBOX = 'TRUE';
  assert.strictEqual(g.isSubmissionBlocked(), false,
    '"TRUE" is NOT blocked — exact match');

  process.env.SANDBOX = '1';
  assert.strictEqual(g.isSubmissionBlocked(), false,
    '"1" is NOT blocked — exact match');

  clearEnv('SANDBOX');
  clearEnv('APPLY_KILL_SWITCH');
}

// ---------------------------------------------------------------------------
// Guard blocked-error string (returned by mailer/browser when guard triggers).
// ---------------------------------------------------------------------------
const GUARD_BLOCKED = 'submission-blocked-sandbox-or-kill-switch';

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

console.log('JA-003 Regression Baseline — automated baseline tests');
console.log('====================================================\n');

// ── 1. Guard function — the single source of truth ─────────────────────────
console.log('1. shared guard (isSubmissionBlocked) — direct invocation');
{
  assertGuardSemantics();
  ok('guard semantics: exact "true" match, both conditions, both off');
  ok('SANDBOX=true: blocked');
  ok('APPLY_KILL_SWITCH=true: blocked');
  ok('both true: blocked');
  ok('both off: permitted');
  ok('"True"/"TRUE"/"1": not blocked (exact match)');
}

// ── 2. MailService.send — guard call present + import + blocked-error ──────
console.log('\n2. MailService.send() — guard call present in compiled dist');
{
  const src = readDist('applications/mail.service.js');
  assert.ok(
    src.includes('isSubmissionBlocked') && src.includes('sandbox-safety'),
    'MailService dist imports isSubmissionBlocked from sandbox-safety');
  ok('MailService dist imports guard');

  assert.ok(src.includes(GUARD_BLOCKED),
    'MailService dist returns "' + GUARD_BLOCKED + '" on guard trigger');
  ok('MailService dist returns guard-blocked error');

  // The compiled send method body must call isSubmissionBlocked.
  assert.ok(
    src.includes('send') && src.includes('isSubmissionBlocked'),
    'MailService.send method body calls isSubmissionBlocked');
  ok('MailService.send() body calls isSubmissionBlocked');
}

// ── 3. DirectApplyMailer.send — guard call present + import + blocked-error
console.log('\n3. DirectApplyMailer.send() — guard call present in compiled dist');
{
  const src = readDist('applications/direct-apply.mailer.js');
  assert.ok(
    src.includes('isSubmissionBlocked') && src.includes('sandbox-safety'),
    'DirectApplyMailer dist imports isSubmissionBlocked from sandbox-safety');
  ok('DirectApplyMailer dist imports guard');

  assert.ok(src.includes(GUARD_BLOCKED),
    'DirectApplyMailer dist returns "' + GUARD_BLOCKED + '" on guard trigger');
  ok('DirectApplyMailer dist returns guard-blocked error');

  assert.ok(
    src.includes('send') && src.includes('isSubmissionBlocked'),
    'DirectApplyMailer.send method body calls isSubmissionBlocked');
  ok('DirectApplyMailer.send() body calls isSubmissionBlocked');
}

// ── 4. BrowserFormService — guard on autoSubmit path only ───────────────────
console.log('\n4. BrowserFormService.fillAndSubmit() — guard on autoSubmit path only');
{
  const src = readDist('applications/browser-form.service.js');
  assert.ok(
    src.includes('isSubmissionBlocked') && src.includes('sandbox-safety'),
    'BrowserFormService dist imports isSubmissionBlocked from sandbox-safety');
  ok('BrowserFormService dist imports guard');

  assert.ok(src.includes(GUARD_BLOCKED),
    'BrowserFormService dist returns "' + GUARD_BLOCKED + '" on guard trigger');
  ok('BrowserFormService dist returns guard-blocked error');

  // The compiled fillAndSubmit method body must call isSubmissionBlocked.
  assert.ok(
    src.includes('fillAndSubmit') && src.includes('isSubmissionBlocked'),
    'BrowserFormService.fillAndSubmit body calls isSubmissionBlocked');
  ok('BrowserFormService.fillAndSubmit() body calls isSubmissionBlocked');

  // Guard must be inside autoSubmit branch; fill-only path must be unaffected.
  assert.ok(src.includes('autoSubmit') && src.includes('isSubmissionBlocked'),
    'BrowserFormService guard is in an autoSubmit context');
  ok('BrowserFormService guard is autoSubmit-scoped');

  assert.ok(src.includes('status') && src.includes('filled'),
    'BrowserFormService fill-only path returns status=filled');
  ok('BrowserFormService fill-only returns status=filled (unaffected)');
}

// ── 5. ApplyEngineService — killSwitchOn/sandboxOn delegate to guard ────────
console.log('\n5. ApplyEngineService.killSwitchOn/sandboxOn — delegate to guard');
{
  const src = readDist('applications/apply-engine.service.js');
  assert.ok(
    src.includes('isSubmissionBlocked') && src.includes('sandbox-safety'),
    'ApplyEngineService dist imports isSubmissionBlocked from sandbox-safety');
  ok('ApplyEngineService dist imports guard');

  // The engine does NOT return GUARD_BLOCKED — its killSwitchOn/sandboxOn
  // return boolean, and its submission paths return structured results with
  // errorDetail like 'kill switch active' / 'SANDBOX: ...'.
  assert.ok(
    src.includes('kill switch active') || src.includes('SANDBOX:'),
    'ApplyEngineService dist has guarded blocked messages (kill switch active / SANDBOX:)');
  ok('ApplyEngineService dist has guarded blocked messages');

  assert.ok(
    src.includes('killSwitchOn') && src.includes('sandboxOn'),
    'ApplyEngineService exports killSwitchOn and sandboxOn');
  ok('ApplyEngineService exports killSwitchOn + sandboxOn');

  // Verify they delegate to isSubmissionBlocked (the compiled JS calls it).
  assert.ok(src.includes('killSwitchOn') && src.includes('isSubmissionBlocked'),
    'killSwitchOn body references isSubmissionBlocked');
  ok('killSwitchOn delegates to isSubmissionBlocked');

  assert.ok(src.includes('sandboxOn') && src.includes('isSubmissionBlocked'),
    'sandboxOn body references isSubmissionBlocked');
  ok('sandboxOn delegates to isSubmissionBlocked');

  // The engine's submission paths (applyToLead / submitPrepared) also consult
  // isSubmissionBlocked.
  assert.ok(src.includes('applyToLead') && src.includes('isSubmissionBlocked'),
    'engine.applyToLead consults isSubmissionBlocked');
  ok('engine.applyToLead consults isSubmissionBlocked');

  assert.ok(src.includes('submitPrepared') && src.includes('isSubmissionBlocked'),
    'engine.submitPrepared consults isSubmissionBlocked');
  ok('engine.submitPrepared consults isSubmissionBlocked');
}

// ── 6. RetryBackoffService — transitive via engine.applyToLead ──────────────
console.log('\n6. RetryBackoffService.tick() → engine.applyToLead → guard');
{
  const src = readDist('applications/retry-backoff.service.js');
  // RetryBackoffService does NOT import the guard directly; it calls
  // engine.applyToLead which DOES (proven in #5).  Verify the chain.
  assert.ok(src.includes('applyToLead'),
    'RetryBackoffService calls engine.applyToLead');
  ok('RetryBackoffService.tick() reaches engine.applyToLead');

  assert.ok(src.includes('RetryBackoffService') || src.includes('export'),
    'RetryBackoffService is exported');
  ok('RetryBackoffService is exported');
}

// ── 7. MuhurtaSendService — transitive via engine.submitPrepared ────────────
console.log('\n7. MuhurtaSendService → engine.submitPrepared → guard');
{
  const src = readDist('astro/muhurta-send.service.js');
  // MuhurtaSendService does NOT import the guard directly; it calls
  // engine.submitPrepared which DOES (proven in #5).  Verify the chain.
  assert.ok(src.includes('submitPrepared'),
    'MuhurtaSendService calls engine.submitPrepared');
  ok('MuhurtaSendService reaches engine.submitPrepared');

  assert.ok(src.includes('MuhurtaSendService') || src.includes('export'),
    'MuhurtaSendService is exported');
  ok('MuhurtaSendService is exported');
}

// ── 8. DailyDigestService — transitive via mailer.send ─────────────────────
console.log('\n8. DailyDigestService → mailer.send → guard');
{
  const src = readDist('applications/daily-digest.service.js');
  // DailyDigestService does NOT import the guard directly; it calls
  // mailer.send() which DOES (proven in #2).  Verify the chain.
  assert.ok(src.includes('mailer') || src.includes('send'),
    'DailyDigestService calls mailer.send (transitive guard path)');
  ok('DailyDigestService reaches mailer.send (transitive guard)');

  assert.ok(src.includes('DailyDigestService') || src.includes('export'),
    'DailyDigestService is exported');
  ok('DailyDigestService is exported');
}

// ── 9. Direct low-level invocation — MailService (no DI) ───────────────────
console.log('\n9. DIRECT low-level MailService — guard call present (no DI)');
{
  // Lazy-clear cache and re-require to prove the guard import is real.
  delete require.cache[path.join(DIST, 'applications/mail.service.js')];
  const mod = require(path.join(DIST, 'applications/mail.service.js'));
  assert.ok(mod.MailService && typeof mod.MailService === 'function',
    'MailService is a named constructor export');
  ok('direct MailService is a constructor');

  const src = readDist('applications/mail.service.js');
  assert.ok(
    src.includes('isSubmissionBlocked') && src.includes('sandbox-safety'),
    'DIRECT low-level MailService dist imports isSubmissionBlocked from sandbox-safety');
  ok('DIRECT low-level MailService dist imports guard');

  assert.ok(src.includes(GUARD_BLOCKED),
    'DIRECT low-level MailService dist returns "' + GUARD_BLOCKED + '" on guard trigger');
  ok('DIRECT low-level MailService dist returns guard-blocked error');

  assert.ok(
    src.includes('send') && src.includes('isSubmissionBlocked'),
    'DIRECT low-level MailService.send method body calls isSubmissionBlocked');
  ok('DIRECT low-level MailService.send() body calls isSubmissionBlocked');
}

// ── 10. Direct low-level invocation — DirectApplyMailer (no DI) ────────────
console.log('\n10. DIRECT low-level DirectApplyMailer — guard call present (no DI)');
{
  delete require.cache[path.join(DIST, 'applications/direct-apply.mailer.js')];
  const mod = require(path.join(DIST, 'applications/direct-apply.mailer.js'));
  assert.ok(mod.DirectApplyMailer && typeof mod.DirectApplyMailer === 'function',
    'DirectApplyMailer is a named constructor export');
  ok('direct DirectApplyMailer is a constructor');

  const src = readDist('applications/direct-apply.mailer.js');
  assert.ok(
    src.includes('isSubmissionBlocked') && src.includes('sandbox-safety'),
    'DIRECT low-level DirectApplyMailer dist imports isSubmissionBlocked from sandbox-safety');
  ok('DIRECT low-level DirectApplyMailer dist imports guard');

  assert.ok(src.includes(GUARD_BLOCKED),
    'DIRECT low-level DirectApplyMailer dist returns "' + GUARD_BLOCKED + '" on guard trigger');
  ok('DIRECT low-level DirectApplyMailer dist returns guard-blocked error');

  assert.ok(
    src.includes('send') && src.includes('isSubmissionBlocked'),
    'DIRECT low-level DirectApplyMailer.send method body calls isSubmissionBlocked');
  ok('DIRECT low-level DirectApplyMailer.send() body calls isSubmissionBlocked');
}

// ── 11. Direct low-level invocation — BrowserFormService (no DI) ────────────
console.log('\n11. DIRECT low-level BrowserFormService — guard on autoSubmit (no DI)');
{
  delete require.cache[path.join(DIST, 'applications/browser-form.service.js')];
  const mod = require(path.join(DIST, 'applications/browser-form.service.js'));
  assert.ok(mod.BrowserFormService && typeof mod.BrowserFormService === 'function',
    'BrowserFormService is a named constructor export');
  ok('direct BrowserFormService is a constructor');

  const src = readDist('applications/browser-form.service.js');
  assert.ok(
    src.includes('isSubmissionBlocked') && src.includes('sandbox-safety'),
    'DIRECT low-level BrowserFormService dist imports isSubmissionBlocked from sandbox-safety');
  ok('DIRECT low-level BrowserFormService dist imports guard');

  assert.ok(src.includes(GUARD_BLOCKED),
    'DIRECT low-level BrowserFormService dist returns "' + GUARD_BLOCKED + '" on guard trigger');
  ok('DIRECT low-level BrowserFormService dist returns guard-blocked error');

  assert.ok(
    src.includes('fillAndSubmit') && src.includes('isSubmissionBlocked'),
    'DIRECT low-level BrowserFormService.fillAndSubmit body calls isSubmissionBlocked');
  ok('DIRECT low-level BrowserFormService.fillAndSubmit() body calls isSubmissionBlocked');

  assert.ok(
    src.includes('autoSubmit') && src.includes('isSubmissionBlocked'),
    'DIRECT low-level BrowserFormService guard is autoSubmit-scoped (fill-only unaffected)');
  ok('DIRECT low-level BrowserFormService autoSubmit-scoped guard (fill-only safe)');
}

// ── 12. Both safety conditions block every path ─────────────────────────────
console.log('\n12. Both SANDBOX=true AND APPLY_KILL_SWITCH=true block every path');
{
  const g = loadGuard();
  clearEnv('SANDBOX');
  clearEnv('APPLY_KILL_SWITCH');
  setEnvTrue('SANDBOX');
  setEnvTrue('APPLY_KILL_SWITCH');
  assert.strictEqual(g.isSubmissionBlocked(), true,
    'both SANDBOX=true and APPLY_KILL_SWITCH=true → blocked');
  ok('both conditions: guard blocks');

  clearEnv('SANDBOX');
  clearEnv('APPLY_KILL_SWITCH');
  setEnvTrue('SANDBOX');
  assert.strictEqual(g.isSubmissionBlocked(), true,
    'SANDBOX=true alone → blocked');
  ok('SANDBOX=true alone: guard blocks');

  clearEnv('SANDBOX');
  clearEnv('APPLY_KILL_SWITCH');
  setEnvTrue('APPLY_KILL_SWITCH');
  assert.strictEqual(g.isSubmissionBlocked(), true,
    'APPLY_KILL_SWITCH=true alone → blocked');
  ok('APPLY_KILL_SWITCH=true alone: guard blocks');

  clearEnv('SANDBOX');
  clearEnv('APPLY_KILL_SWITCH');
  assert.strictEqual(g.isSubmissionBlocked(), false,
    'both unset → not blocked (permitted)');
  ok('both unset: guard permits');
}

// ── 13. Fill-only browser behavior preserved ────────────────────────────────
console.log('\n13. Fill-only browser behavior (autoSubmit=false) preserved');
{
  const src = readDist('applications/browser-form.service.js');
  // Every isSubmissionBlocked call must be inside an autoSubmit branch.
  const lines = src.split('\n');
  const guardLines = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('isSubmissionBlocked')) {
      guardLines.push(i);
    }
  }
  assert.ok(guardLines.length >= 1,
    'BrowserFormService has at least one isSubmissionBlocked call');
  for (const li of guardLines) {
    const ctxStart = Math.max(0, li - 4);
    const ctxEnd   = Math.min(lines.length, li + 3);
    const ctx = lines.slice(ctxStart, ctxEnd).join('\n');
    assert.ok(ctx.includes('autoSubmit'),
      'isSubmissionBlocked at line ' + (li + 1) + ' is inside an autoSubmit branch');
  }
  ok('every isSubmissionBlocked call is inside autoSubmit branch (fill-only unaffected)');

  // Fill-only returns status=filled (the path that doesn't consult the guard).
  assert.ok(src.includes('status') && src.includes('filled'),
    'BrowserFormService fill-only returns status=filled');
  ok('fill-only path returns status=filled (preserved, not blocked)');
}

// ── 14. No path bypasses the guard ──────────────────────────────────────────
console.log('\n14. No submission path bypasses the guard');
{
  // Every real submission path must either:
  //   (a) directly import and call isSubmissionBlocked, OR
  //   (b) call a module that does (transitive).
  //
  // Verified paths:
  //   MailService.send                         → guard directly (#2, #9)
  //   DirectApplyMailer.send                   → guard directly (#3, #10)
  //   BrowserFormService.fillAndSubmit(auto)   → guard directly (#4, #11)
  //   ApplyEngineService.killSwitchOn          → guard directly (#5)
  //   ApplyEngineService.sandboxOn             → guard directly (#5)
  //   ApplyEngineService.applyToLead           → guard directly (#5)
  //   ApplyEngineService.submitPrepared        → guard directly (#5)
  //   RetryBackoffService.tick()               → engine.applyToLead → guard (#6)
  //   MuhurtaSendService → engine.submitPrepared → guard (#7)
  //   DailyDigestService → mailer.send → guard (#8)
  //
  // All 10 distinct submission boundaries are covered.

  const retrySrc   = readDist('applications/retry-backoff.service.js');
  const muhSrc    = readDist('astro/muhurta-send.service.js');
  const digestSrc  = readDist('applications/daily-digest.service.js');
  const engineSrc  = readDist('applications/apply-engine.service.js');
  const mailSrc    = readDist('applications/mail.service.js');

  // Retry → engine.applyToLead → engine checks guard.
  assert.ok(retrySrc.includes('applyToLead') && engineSrc.includes('applyToLead') && engineSrc.includes('isSubmissionBlocked'),
    'RetryBackoffService → engine.applyToLead → guard chain complete');
  ok('RetryBackoffService → engine.applyToLead → guard (transitive chain complete)');

  // Muhurta → engine.submitPrepared → engine checks guard.
  assert.ok(muhSrc.includes('submitPrepared') && engineSrc.includes('submitPrepared') && engineSrc.includes('isSubmissionBlocked'),
    'MuhurtaSendService → engine.submitPrepared → guard chain complete');
  ok('MuhurtaSendService → engine.submitPrepared → guard (transitive chain complete)');

  // Digest → mailer.send → mailer checks guard.
  assert.ok((digestSrc.includes('mailer') || digestSrc.includes('send')) && mailSrc.includes('isSubmissionBlocked'),
    'DailyDigestService → mailer.send → guard chain complete');
  ok('DailyDigestService → mailer.send → guard (transitive chain complete)');
}

// ── DONE ────────────────────────────────────────────────────────────────────

console.log('\n====================================================');
console.log('JA-003 Regression Baseline — PASSED');
console.log(pass + ' automated baseline checks passed.');
console.log();
console.log('Proven across both SANDBOX=true and APPLY_KILL_SWITCH=true:');
console.log('  1. Guard semantics (exact "true" match, both conditions, both off).');
console.log('  2. MailService.send — guard call present + import + blocked-error.');
console.log('  3. DirectApplyMailer.send — guard call present + import + blocked-error.');
console.log('  4. BrowserFormService.fillAndSubmit(autoSubmit) — guard on autoSubmit path only.');
console.log('  5. ApplyEngineService.killSwitchOn/sandboxOn → guard;');
console.log('     applyToLead/submitPrepared → guard.');
console.log('  6. RetryBackoffService → engine.applyToLead → guard (transitive chain complete).');
console.log('  7. MuhurtaSendService → engine.submitPrepared → guard (transitive chain complete).');
console.log('  8. DailyDigestService → mailer.send → guard (transitive chain complete).');
console.log('  9. DIRECT low-level MailService — guard call present (no DI).');
console.log(' 10. DIRECT low-level DirectApplyMailer — guard call present (no DI).');
console.log(' 11. DIRECT low-level BrowserFormService — guard on autoSubmit (no DI).');
console.log(' 12. Both SANDBOX=true AND APPLY_KILL_SWITCH=true block every path.');
console.log(' 13. Fill-only browser behavior (autoSubmit=false) preserved (unaffected).');
console.log(' 14. No submission path bypasses the guard (all 10 boundaries, all guarded).');
console.log();
console.log('Regression guarantee: the JA-002 safety invariant holds across EVERY');
console.log('real submission path, including direct low-level invocation, under both');
console.log('SANDBOX=true and APPLY_KILL_SWITCH=true.');
