#!/usr/bin/env node
/**
 * Capture-integrity guard for the Upstox OI capture.
 *
 * The OI research archive can only be used if a row says WHEN the market said it
 * and whether it is a genuine print. Measured 2026-09-14: 53.8% (NIFTY) to 71.6%
 * (SENSEX) of a weekday's captured rows fall outside 09:15-15:30 IST, and 100% of
 * the Saturday capture does, because the poller runs 24x7 and `ts` is CAPTURE
 * time. This test asserts the three facts that fix that, each of which can
 * regress alone:
 *
 *   1. the DATABASE can hold them (nullable, no fabricated default);
 *   2. the WRITE PATH records them and never manufactures a value;
 *   3. the CLASSIFIER derives genuine / repeated / outside-session from facts
 *      only, and fails closed when a fact is missing.
 *
 * The classifier is compiled in ISOLATION to a temp dir: shared `dist` is never
 * rebuilt or written here.
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ROOT = '/home/swarna-sekhar-dhar/projects/my-job-agent';
require(ROOT + '/node_modules/dotenv').config({ path: ROOT + '/.env', override: true });
const mysql = require(ROOT + '/node_modules/mysql2/promise');

const TABLE = 'upstox_live_paper_option_quotes';
const FACTS = ['providerTs', 'prevOi', 'payloadHash'];
const ENTITY = 'src/trading/upstox-live-paper/upstox-live-paper-option-quote.entity.ts';
const WRITE_PATH = 'src/trading/upstox-live-paper/upstox-live-paper-market.service.ts';
const CLASSIFIER = 'src/trading/research/capture-integrity.ts';

let checks = 0, failures = 0;
const check = (label, fn) => {
  checks++;
  try { fn(); console.log('  PASS  ' + label); }
  catch (e) { failures++; console.log('  FAIL  ' + label + '\n         ' + e.message); }
};
const source = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

(async () => {
  console.log('=== 1. DATABASE can hold the facts (migration applied) ===');
  const c = await mysql.createConnection({
    host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT || 3307),
    user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD,
    database: process.env.DATABASE_NAME || 'myjob_agent',
  });
  const [cols] = await c.query(
    `SELECT COLUMN_NAME n, IS_NULLABLE nul, COLUMN_DEFAULT def, DATA_TYPE t, CHARACTER_MAXIMUM_LENGTH len
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?`, [TABLE]);
  const byName = new Map(cols.map((r) => [r.n, r]));
  for (const f of FACTS) {
    check(`column ${TABLE}.${f} exists, is NULLable and has no default`, () => {
      const col = byName.get(f);
      assert.ok(col, `${f} column is MISSING — the capture-integrity migration was not applied`);
      assert.equal(col.nul, 'YES', `${f} must be nullable so "not published" survives as NULL`);
      assert.equal(col.def, null, `${f} must not carry a fabricated default`);
    });
  }
  check('payloadHash is wide enough for a sha256 hex digest (>=64)', () => {
    assert.ok(Number(byName.get('payloadHash').len) >= 64, 'payloadHash is too narrow for sha256');
  });
  check('the pre-existing absence-preserving columns are still NULLable', () => {
    for (const f of ['volume', 'openInterest', 'oiChange']) {
      assert.equal(byName.get(f) && byName.get(f).nul, 'YES', `${f} lost its NULLability`);
    }
  });

  console.log('\n=== 2. ENTITY declares the facts, and stops calling capture time "market time" ===');
  const ent = source(ENTITY);
  for (const f of FACTS) {
    check(`entity declares ${f} nullable`, () => {
      assert.match(ent, new RegExp(`${f}[^\\n]*nullable: true`), `${f} is not declared nullable in the entity`);
    });
  }
  check('the false "market time" label on ts is gone', () => {
    assert.doesNotMatch(ent, /Timestamp of the quote \(market time\)/,
      'ts is still documented as market time; it is CAPTURE time (host clock at parse time)');
  });
  check('ts is documented as capture time, with providerTs named as the market time', () => {
    assert.match(ent, /CAPTURE time/, 'ts must be documented as capture time');
    assert.match(ent, /providerTs/, 'the entity must name providerTs as the market-time field');
  });
  check('oiChange semantics record that it is NOT a snapshot delta', () => {
    assert.match(ent, /NOT a snapshot-to-snapshot delta/,
      'the oiChange doc must state it is not a snapshot-to-snapshot delta');
  });

  console.log('\n=== 3. WRITE PATH records the facts and invents nothing ===');
  const wp = source(WRITE_PATH);
  check('capture records the provider timestamp (never a copy of ts)', () => {
    assert.match(wp, /providerTs:\s*parseTs\(/, 'providerTs is not read from the provider payload');
    assert.doesNotMatch(wp, /providerTs:\s*ts\b/, 'providerTs must never be a copy of capture time ts');
  });
  check('capture records the provider previous-OI reference', () => {
    assert.match(wp, /prevOi:/, 'prevOi is not carried onto the tick');
  });
  check('capture records the payload identity', () => {
    assert.match(wp, /payloadHash:\s*payloadHash\(/, 'the raw leg hash is not recorded');
  });
  check('capture persists all three facts', () => {
    for (const f of FACTS) assert.match(wp, new RegExp(`${f}:\\s*tick\\.`), `${f} is not persisted`);
  });
  check('no fact is coerced to a fabricated 0', () => {
    assert.doesNotMatch(wp, /prevOi[^\n]*\?\?\s*0/, 'absent prevOi must stay NULL, not become 0');
    assert.doesNotMatch(wp, /providerTs[^\n]*\?\?\s*0/, 'absent providerTs must stay NULL');
  });

  console.log('\n=== 4. CLASSIFIER derives the three classes from facts only ===');
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-integrity-'));
  execFileSync(path.join(ROOT, 'node_modules/.bin/tsc'),
    [path.join(ROOT, CLASSIFIER), '--outDir', outDir, '--module', 'commonjs',
     '--target', 'es2020', '--skipLibCheck', '--strict'],
    { stdio: 'pipe' });
  const ci = require(path.join(outDir, 'capture-integrity.js'));
  const IST = (isoLocal) => new Date(isoLocal);
  const at = (s) => ci.classifyCaptureObservation(s);

  check('a post-close capture is OUTSIDE_SESSION no matter what it contains', () => {
    const v = at({ ts: IST('2026-09-11T18:30:00+05:30'), payloadHash: 'a', previousPayloadHash: 'b' });
    assert.equal(v.class, 'OUTSIDE_SESSION');
    assert.equal(v.insideSession, false);
  });
  check('a Saturday capture is OUTSIDE_SESSION even at midday (time-of-day alone is not enough)', () => {
    const v = at({ ts: IST('2026-09-12T12:00:00+05:30') });
    assert.equal(v.class, 'OUTSIDE_SESSION');
    assert.match(v.reason, /Saturday/);
  });
  check('a Sunday capture is OUTSIDE_SESSION', () => {
    const v = at({ ts: IST('2026-09-13T12:00:00+05:30') });
    assert.equal(v.class, 'OUTSIDE_SESSION');
    assert.match(v.reason, /Sunday/);
  });
  check('a weekday HOLIDAY is OUTSIDE_SESSION when the authoritative calendar says so', () => {
    const v = at({ ts: IST('2026-09-11T10:30:00+05:30'), isTradingSessionDate: () => false });
    assert.equal(v.class, 'OUTSIDE_SESSION');
    assert.equal(v.sessionCalendar, 'AUTHORITATIVE');
  });
  check('without a calendar the verdict admits it used the weekday rule only', () => {
    assert.equal(at({ ts: IST('2026-09-11T10:30:00+05:30') }).sessionCalendar, 'WEEKDAY_RULE_ONLY');
  });
  check('the session boundary is 09:15 -> 15:30 IST inclusive', () => {
    assert.equal(at({ ts: IST('2026-09-11T09:15:00+05:30') }).insideSession, true);
    assert.equal(at({ ts: IST('2026-09-11T09:14:00+05:30') }).insideSession, false);
    assert.equal(at({ ts: IST('2026-09-11T15:30:00+05:30') }).insideSession, true);
    assert.equal(at({ ts: IST('2026-09-11T15:31:00+05:30') }).insideSession, false);
  });
  check('in-session with an identical payload is REPEATED (never "the market did not move")', () => {
    const v = at({ ts: IST('2026-09-11T10:30:00+05:30'), payloadHash: 'same', previousPayloadHash: 'same' });
    assert.equal(v.class, 'REPEATED');
    assert.match(v.reason, /previous capture/, 'the reason must be about OUR capture, not the market');
  });
  check('in-session with a differing payload is GENUINE', () => {
    assert.equal(at({ ts: IST('2026-09-11T10:30:00+05:30'), payloadHash: 'n', previousPayloadHash: 'o' }).class, 'GENUINE');
  });
  check('in-session with an advanced provider timestamp is GENUINE', () => {
    const v = at({ ts: IST('2026-09-11T10:30:00+05:30'),
      providerTs: IST('2026-09-11T10:29:55+05:30'), previousProviderTs: IST('2026-09-11T10:29:30+05:30') });
    assert.equal(v.class, 'GENUINE');
  });
  check('in-session with an unchanged provider timestamp is REPEATED', () => {
    const v = at({ ts: IST('2026-09-11T10:30:00+05:30'),
      providerTs: IST('2026-09-11T10:29:30+05:30'), previousProviderTs: IST('2026-09-11T10:29:30+05:30') });
    assert.equal(v.class, 'REPEATED');
  });
  check('in-session with NO evidence fails closed to UNKNOWN (it is never guessed)', () => {
    const v = at({ ts: IST('2026-09-11T10:30:00+05:30'), providerTs: null, payloadHash: null });
    assert.equal(v.class, 'UNKNOWN');
    assert.match(v.reason, /cannot be told from a repeat/);
  });
  check('an unreadable capture timestamp is UNKNOWN, not outside-session', () => {
    assert.equal(at({ ts: 'not-a-date' }).class, 'UNKNOWN');
  });
  check('IST date is the market calendar date, not the host UTC date', () => {
    assert.equal(at({ ts: IST('2026-09-11T00:30:00+05:30') }).captureSessionDate, '2026-09-11');
  });

  console.log('\n=== 5. ΔOI semantics contract fails closed ===');
  check('the provider-reference reading is allowed', () => {
    assert.equal(ci.assertDeltaOiIntendedUse('PROVIDER_REFERENCE_RELATIVE').ok, true);
  });
  check('reading oiChange as a snapshot-to-snapshot delta is REFUSED', () => {
    const v = ci.assertDeltaOiIntendedUse('SNAPSHOT_TO_SNAPSHOT');
    assert.equal(v.ok, false);
    assert.match(v.reason, /PROVIDER_REFERENCE_RELATIVE/);
  });
  check('the semantics record the unestablished provider rollover rule', () => {
    assert.equal(ci.DELTA_OI_SEMANTICS.isSnapshotToSnapshotDelta, false);
    assert.match(ci.DELTA_OI_SEMANTICS.unknown, /not established/);
  });

  console.log('\n=== 6. REAL DATA: the semantics claim still holds on the archive ===');
  const [ev] = await c.query(
    `SELECT COUNT(*) n, COUNT(DISTINCT openInterest) ois, COUNT(DISTINCT openInterest - oiChange) refs
       FROM ${TABLE}
      WHERE contractSymbol = 'SENSEX26091774000CE'
        AND TIME(ts) >= '09:15:00' AND TIME(ts) <= '15:30:00'`);
  const row = ev[0];
  check(`archive confirms provider-reference ΔOI (n=${row.n}: distinct(OI)=${row.ois}, distinct(OI-oiChange)=${row.refs})`, () => {
    assert.ok(Number(row.n) >= 500, `not enough in-session rows to assert the semantics (n=${row.n})`);
    assert.ok(Number(row.ois) >= 20, `OI barely moves (${row.ois} distinct) — sample cannot discriminate`);
    assert.ok(Number(row.refs) <= 5,
      `distinct(OI - oiChange)=${row.refs} — if this approached distinct(OI)=${row.ois} the ΔOI would be a snapshot delta`);
  });

  await c.end();
  fs.rmSync(outDir, { recursive: true, force: true });
  console.log(`\n${failures === 0 ? 'ALL PASS' : 'FAILURES'}: ${checks - failures}/${checks} checks passed`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS ERROR: ' + (e && e.message)); process.exit(1); });
