#!/usr/bin/env node
/**
 * Queue item 76 — IMAP crash-safety + exponential backoff.
 *
 * The production defect this locks down (2026-09-12 evidence):
 *   `Error: Socket timeout ... throw er; // Unhandled 'error' event`
 *   → the whole NestJS process exited, 62 times between 2026-09-07 and 2026-09-12,
 *     taking the trading desks' HTTP routes and the project-status control plane with it.
 *
 * The crash is an EMITTER event, not a rejected promise, so `try/catch` around
 * `connect()`/`fetch()` never sees it. The proof below drives a real ImapFlow
 * instance: without the guard, emitting 'error' throws (fatal); with the guard it
 * does not, and the socket cause is retained for the poll's own catch block.
 *
 *   [1] the unguarded shape is fatal, the guarded shape is not;
 *   [2] the guard can be attached before connect() and remembers the last error;
 *   [3] backoff = 2^(n-1) hours after n consecutive failures;
 *   [4] skip rule: hard disable, never-succeeded, inside/outside the backoff window;
 *   [5] outcome recording: success resets, failure counts, auto-disable at 5 only when allowed;
 *   [6] STATIC: both IMAP services guard every client and share one backoff rule.
 */
const path = require('path');
const fs = require('fs');

const IMAP_SAFETY = require(path.join(__dirname, '..', 'dist', 'applications', 'imap-safety'));
const { ImapFlow } = require('imapflow');

let pass = 0;
const failures = [];
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  PASS ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`); }
};
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
const near = (name, actual, expected, tol = 1e-9) => ok(name, Math.abs(actual - expected) < tol, `got ${actual} want ~${expected}`);

const SRC_DIR = path.join(__dirname, '..', 'src', 'applications');
const readSrc = (f) => fs.readFileSync(path.join(SRC_DIR, f), 'utf8');
const INBOX = readSrc('inbox-reader.service.ts');
const TRACKER = readSrc('email-tracker.service.ts');

const newClient = () => new ImapFlow({ host: 'imap.invalid', port: 993, secure: true, auth: { user: 'x@example.com', pass: 'nope' }, logger: false });

// ---------------------------------------------------------------- [1][2] crash
console.log('\n[1] the unguarded client is fatal, the guarded client is not');
{
  const raw = newClient();
  let threw = null;
  try { raw.emit('error', new Error('Socket timeout')); } catch (e) { threw = e; }
  ok('an unguarded ImapFlow error event throws (this is the production crash)', threw !== null && /Socket timeout/.test(threw.message));
  ok('the thrown error is the socket error itself (unhandled event)', threw && threw.message === 'Socket timeout');

  const guarded = newClient();
  const trap = IMAP_SAFETY.guardImapClient(guarded, undefined);
  let threw2 = null;
  try { guarded.emit('error', new Error('Socket timeout')); } catch (e) { threw2 = e; }
  ok('the guarded client survives the same error event', threw2 === null);
  ok('the trap remembers the socket cause', trap.lastError() && trap.lastError().message === 'Socket timeout');

  guarded.emit('error', 'string-not-an-error');
  ok('a non-Error payload is normalised, not rethrown', trap.lastError() instanceof Error);
}

console.log('\n[2] the guard is attached before connect() and reports through a callback');
{
  let seen = null;
  const c = newClient();
  const trap = IMAP_SAFETY.guardImapClient(c, (err) => { seen = err; });
  ok('no error recorded before anything happens', trap.lastError() === null);
  c.emit('error', new Error('ETIMEOUT'));
  ok('the onError callback fired with the error', seen !== null && seen.message === 'ETIMEOUT');
  ok('lastError() returns the same instance', trap.lastError() === seen);

  const { client, trap: t2 } = IMAP_SAFETY.createGuardedImapClient({ host: 'imap.invalid', port: 993, secure: true, auth: { user: 'x@example.com', pass: 'nope' }, logger: false });
  ok('createGuardedImapClient returns the client', client && typeof client.connect === 'function');
  let threw = null;
  try { client.emit('error', new Error('boom')); } catch (e) { threw = e; }
  ok('factory-made client cannot throw on an async error', threw === null && t2.lastError().message === 'boom');
}

// ------------------------------------------------------------------ [3] backoff
console.log('\n[3] exponential backoff = 2^(n-1) hours');
{
  eq('1 failure -> 1h', IMAP_SAFETY.imapBackoffHours(1), 1);
  eq('2 failures -> 2h', IMAP_SAFETY.imapBackoffHours(2), 2);
  eq('3 failures -> 4h', IMAP_SAFETY.imapBackoffHours(3), 4);
  eq('4 failures -> 8h', IMAP_SAFETY.imapBackoffHours(4), 8);
  eq('5 failures -> 16h', IMAP_SAFETY.imapBackoffHours(5), 16);
  eq('0/negative are clamped to the first step', [IMAP_SAFETY.imapBackoffHours(0), IMAP_SAFETY.imapBackoffHours(-3)], [1, 1]);
  eq('auto-disable threshold is 5', IMAP_SAFETY.IMAP_AUTO_DISABLE_AFTER, 5);
}

// ---------------------------------------------------------------- [4] skip rule
console.log('\n[4] skip rule (hard disable / never succeeded / backoff window)');
{
  const now = Date.parse('2026-09-12T10:00:00+05:30');
  const hoursAgo = (h) => new Date(now - h * 3_600_000);

  ok('healthy account is polled', IMAP_SAFETY.imapSkipReason({ useImap: true, imapFailureCount: 0 }, now) === null);
  ok('no counter at all is polled', IMAP_SAFETY.imapSkipReason({}, now) === null);
  ok('useImap=false is a hard skip', /disabled/.test(IMAP_SAFETY.imapSkipReason({ useImap: false, imapFailureCount: 0 }, now) || ''));
  ok('useImap=1 (MySQL boolean) is NOT a skip', IMAP_SAFETY.imapSkipReason({ useImap: 1, imapFailureCount: 0 }, now) === null);

  const oneFailureRecent = { useImap: true, imapFailureCount: 1, lastImapSuccess: hoursAgo(0.5) };
  ok('1 failure + success 30min ago -> inside the 1h window (skip)', /wait 1h/.test(IMAP_SAFETY.imapSkipReason(oneFailureRecent, now) || ''));
  const oneFailureOld = { useImap: true, imapFailureCount: 1, lastImapSuccess: hoursAgo(3) };
  ok('1 failure + success 3h ago -> past the window (poll)', IMAP_SAFETY.imapSkipReason(oneFailureOld, now) === null);

  const neverSucceeded = { useImap: true, imapFailureCount: 2, lastImapSuccess: null };
  ok('never succeeded -> still probed (no success to measure a window from)', IMAP_SAFETY.imapSkipReason(neverSucceeded, now) === null);
  const olderString = { useImap: true, imapFailureCount: 3, lastImapSuccess: new Date(now - 5 * 3_600_000).toISOString() };
  ok('an ISO-string lastImapSuccess is understood', IMAP_SAFETY.imapSkipReason(olderString, now) === null);
  const threeRecent = { useImap: true, imapFailureCount: 3, lastImapSuccess: hoursAgo(1) };
  const threeReason = IMAP_SAFETY.imapSkipReason(threeRecent, now) || '';
  ok('the reason names the failure count', /3 consecutive failure/.test(threeReason));
  ok('the reason names the backoff window (3 failures -> 4h)', /wait 4h/.test(threeReason));
  ok('the reason identifies it as backoff, not a hard disable', /backoff/i.test(threeReason) && !/disabled/i.test(threeReason));
}

// ------------------------------------------------------------- [5] outcome write
console.log('\n[5] outcome recording: reset on success, count on failure, auto-disable at 5');
(async () => {
  const calls = [];
  const repo = { update: async (id, patch) => { calls.push({ id, patch }); return { id, ...patch }; } };

  calls.length = 0;
  let r = await IMAP_SAFETY.recordImapOutcome(repo, { id: 'a', email: 'a@x.com', imapFailureCount: 3 }, true);
  eq('success resets the counter', r.failureCount, 0);
  ok('success stamps lastImapSuccess', calls[0].patch.lastImapSuccess instanceof Date);
  ok('success clears imapFailureCount', calls[0].patch.imapFailureCount === 0);
  ok('success writes exactly one update', calls.length === 1);

  calls.length = 0;
  r = await IMAP_SAFETY.recordImapOutcome(repo, { id: 'b', email: 'b@x.com', imapFailureCount: 1 }, false);
  eq('failure increments the counter', r.failureCount, 2);
  ok('failure does not disable below the threshold', r.autoDisabled === false && calls.length === 1);

  calls.length = 0;
  let disabledEmail = null;
  r = await IMAP_SAFETY.recordImapOutcome(repo, { id: 'c', email: 'c@x.com', imapFailureCount: 4 }, false, { onAutoDisable: (e) => { disabledEmail = e; } });
  eq('the 5th consecutive failure reports the count', r.failureCount, 5);
  ok('the 5th failure auto-disables', r.autoDisabled === true);
  ok('useImap=false is persisted', calls.some((c) => c.patch.useImap === false));
  eq('the auto-disable callback names the account', disabledEmail, 'c@x.com');

  calls.length = 0;
  r = await IMAP_SAFETY.recordImapOutcome(repo, { id: 'd', email: 'd@x.com', imapFailureCount: 9 }, false, { allowAutoDisable: false });
  eq('counting-only mode still counts', r.failureCount, 10);
  ok('counting-only mode never disables', r.autoDisabled === false && !calls.some((c) => c.patch.useImap === false));

  // the two rules compose into a terminating loop: a never-succeeded account keeps
  // being probed, and the 5th failure is what finally stops it.
  const now2 = Date.now();
  ok('before the threshold a never-succeeded account is probed', IMAP_SAFETY.imapSkipReason({ useImap: true, imapFailureCount: 4, lastImapSuccess: null }, now2) === null);
  ok('after auto-disable it is skipped', /disabled/.test(IMAP_SAFETY.imapSkipReason({ useImap: false, imapFailureCount: 5, lastImapSuccess: null }, now2) || ''));

  // ------------------------------------------------------------------- [6] static
  console.log('\n[6] STATIC: both services guard every client, and share ONE backoff rule');
  ok('inbox-reader no longer constructs an unguarded client', !/new ImapFlow\(/.test(INBOX));
  ok('email-tracker no longer constructs an unguarded client', !/new ImapFlow\(/.test(TRACKER));
  ok('inbox-reader uses the guarded factory', /createGuardedImapClient\(/.test(INBOX));
  ok('email-tracker uses the guarded factory', /createGuardedImapClient\(/.test(TRACKER));
  ok('inbox-reader imports the shared skip rule', /imapSkipReason/.test(INBOX));
  ok('email-tracker imports the shared skip rule', /imapSkipReason/.test(TRACKER));
  ok('neither service re-implements the backoff exponent', !/Math\.pow\(2,/.test(INBOX) && !/Math\.pow\(2,/.test(TRACKER));
  ok('inbox-reader records outcomes through the shared writer', /recordImapOutcome\(/.test(INBOX));
  ok('email-tracker records outcomes through the shared writer', /recordImapOutcome\(/.test(TRACKER));
  ok('email-tracker never auto-disables an account', /allowAutoDisable: false/.test(TRACKER));

  // ordering inside each poll body: skip-check -> guard -> connect
  const orderIn = (src, anchor) => {
    const start = src.indexOf(anchor);
    const body = src.slice(start);
    const iSkip = body.indexOf('imapSkipReason(account)');
    const iGuard = body.indexOf('createGuardedImapClient(');
    const iConnect = body.indexOf('await client.connect()');
    return { iSkip, iGuard, iConnect };
  };
  const trackerOrder = orderIn(TRACKER, 'for (const account of accounts) {');
  ok('tracker: skip check precedes client creation', trackerOrder.iSkip >= 0 && trackerOrder.iSkip < trackerOrder.iGuard, JSON.stringify(trackerOrder));
  ok('tracker: the guard is in place before connect()', trackerOrder.iGuard >= 0 && trackerOrder.iGuard < trackerOrder.iConnect, JSON.stringify(trackerOrder));

  const inboxGuard = INBOX.indexOf('createGuardedImapClient(');
  const inboxConnect = INBOX.indexOf('await client.connect()');
  ok('inbox-reader: the guard is attached before connect()', inboxGuard >= 0 && inboxGuard < inboxConnect);
  ok('inbox-reader returns client+trap from connect()', /Promise<\{ client: ImapFlow; trap: ImapErrorTrap \}>/.test(INBOX));
  ok('documents the crash class it prevents', /Unhandled 'error' event|unhandled/i.test(readSrc('imap-safety.ts')));

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log('FAILED:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error('TEST HARNESS ERROR', e); process.exit(1); });
