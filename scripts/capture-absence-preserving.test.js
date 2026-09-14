#!/usr/bin/env node
/**
 * Capture-path absence-preservation guard.
 *
 * The evaluated OI features (and every future one) depend on ONE property of the
 * capture path: a field the provider did not publish must be stored as NULL and
 * never as a real 0. Measured 2026-09-14, `fnf_option_quotes_history` held
 * 3,900,914 zeros and only 3 real OI values in 3,900,917 rows — the archive was
 * unusable for OI research precisely because "absent" had been written as 0.
 *
 * This test asserts the property twice, because either half can regress alone:
 *   1. the DATABASE can store absence (column is NULLable, no fabricated default);
 *   2. the WRITE PATH does not manufacture a 0 for a missing provider field.
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = '/home/swarna-sekhar-dhar/projects/my-job-agent';
require(ROOT + '/node_modules/dotenv').config({ path: ROOT + '/.env', override: true });
const mysql = require(ROOT + '/node_modules/mysql2/promise');

// Columns that must be able to say "unknown".
const REQUIRED_NULLABLE = [
  ['upstox_live_paper_option_quotes', 'volume'],
  ['upstox_live_paper_option_quotes', 'openInterest'],
  ['upstox_live_paper_option_quotes', 'oiChange'],
  ['upstox_live_paper_market_snapshots', 'volume'],
  ['fnf_option_quotes', 'volume'],
  ['fnf_option_quotes', 'openInterest'],
  ['fnf_option_quotes_history', 'volume'],
  ['fnf_option_quotes_history', 'openInterest'],
];

// Anti-patterns: a missing provider field coerced into a manufactured 0.
const WRITE_PATH = 'src/trading/upstox-live-paper/upstox-live-paper-market.service.ts';
const FORBIDDEN = [
  [/finite\(md\.volume\)\s*\?\?\s*0/, 'live chain: absent volume coerced to 0'],
  [/Math\.trunc\(oi\s*\?\?\s*0\)/, 'live chain: absent OI coerced to 0'],
  [/oi !== null && prevOi !== null \? Math\.trunc\(oi - prevOi\) : 0/, 'live chain: unknown ΔOI recorded as 0'],
  [/finite\(row\.volume\)\s*\?\?\s*0/, 'common store: absent volume coerced to 0'],
  [/Math\.trunc\(finite\(row\.oi\)\s*\?\?\s*0\)/, 'common store: absent OI coerced to 0'],
];
// The entity must declare the columns nullable, not defaulted.
const ENTITY_MUST_NOT_MATCH = [
  ['src/trading/upstox-live-paper/upstox-live-paper-option-quote.entity.ts', /@Column\(\{ type: 'bigint', default: 0 \}\)\s*\n\s*(volume|openInterest|oiChange)/],
  ['src/trading/upstox-live-paper/upstox-live-paper-market-snapshot.entity.ts', /@Column\(\{ type: 'bigint', default: 0 \}\)\s*\n\s*volume/],
  ['src/trading/fnf-option-quote.entity.ts', /@Column\(\{ type: 'decimal', precision: 18, scale: 2, default: 0 \}\)/],
  ['src/trading/fnf-option-quote-history.entity.ts', /@Column\(\{ type: 'decimal', precision: 18, scale: 2, default: 0 \}\)/],
];

let checks = 0;
(async () => {
  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT || 3307),
    user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD,
    database: process.env.DATABASE_NAME || 'myjob_agent',
  });
  const [cols] = await conn.query(
    `SELECT TABLE_NAME, COLUMN_NAME, IS_NULLABLE, COLUMN_DEFAULT FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()`,
  );
  const index = new Map(cols.map((c) => [`${c.TABLE_NAME}.${c.COLUMN_NAME}`, c]));

  console.log('== 1. the database can STORE absence (schema) ==');
  for (const [table, column] of REQUIRED_NULLABLE) {
    const c = index.get(`${table}.${column}`);
    assert.ok(c, `missing column ${table}.${column}`);
    assert.equal(c.IS_NULLABLE, 'YES', `${table}.${column} must be NULLable, else absence is unstorable`);
    assert.equal(c.COLUMN_DEFAULT, null, `${table}.${column} must have NO default, else a missing write becomes that default`);
    console.log(`   ${table.padEnd(34)} ${column.padEnd(14)} NULLable, no default`);
    checks += 2;
  }

  console.log('\n== 2. the write path does not MANUFACTURE a zero ==');
  const src = fs.readFileSync(path.join(ROOT, WRITE_PATH), 'utf8');
  for (const [pattern, label] of FORBIDDEN) {
    assert.ok(!pattern.test(src), `${label} — pattern ${pattern} must not appear in ${WRITE_PATH}`);
    console.log(`   absent: ${label}`);
    checks += 1;
  }
  // and the nullable form IS present, so the guard cannot pass vacuously.
  assert.match(src, /openInterest: oi === null \? null : Math\.max\(0, Math\.trunc\(oi\)\)/, 'null-preserving OI assignment must be present');
  assert.match(src, /oiChange: oi !== null && prevOi !== null \? Math\.trunc\(oi - prevOi\) : null/, 'unknown ΔOI must resolve to null');
  checks += 2;

  console.log('\n== 3. entities declare the columns nullable ==');
  for (const [file, pattern] of ENTITY_MUST_NOT_MATCH) {
    const p = path.join(ROOT, file);
    // A rename must fail this guard rather than silently pass on an empty read.
    assert.ok(fs.existsSync(p), `guarded file is missing (renamed?): ${file}`);
    const body = fs.readFileSync(p, 'utf8');
    assert.ok(!pattern.test(body), `${file} still declares a 0 default: ${pattern}`);
    console.log(`   ${file} : no NOT NULL DEFAULT 0`);
    checks += 1;
  }

  await conn.end();
  console.log(`\nCAPTURE ABSENCE-PRESERVATION GUARD PASSED (${checks} checks)`);
})().catch((e) => { console.error('GUARD FAILED:', e.message); process.exit(1); });
