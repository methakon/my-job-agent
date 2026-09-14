#!/usr/bin/env node
/**
 * Stage 1 (D6) — pre-open has ONE source of truth and no competing semantics.
 *
 * The risk this guards: auction-window prices are NOT tradable, so if any
 * pre-open path wrote them into `unified_option_quotes` / `unified_market_snapshots`
 * they would become indistinguishable from live tradable quotes (the desk's
 * sharedQuote()/latestQuote() read those tables and the in-memory cache).
 *
 * Two invariants:
 *   1. the pre-open path never invokes a canonical WRITE entry point
 *      (ingestQuote / ingestSnapshot) — no competing semantics, no contamination;
 *   2. exactly ONE producer constructs a PreOpenObservation row, and it stamps
 *      the canonical identity so pre-open joins the common store on one key.
 *
 * Static source scan + pure canonical-key checks. No DB, no network.
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { canonicalInstrumentKey } = require('../dist/trading/unified-market-data/canonical/canonical-tick.js');
const { getMetadataArgsStorage } = require('typeorm');
const { PreOpenObservation } = require('../dist/trading/pre-open/pre-open-observation.entity.js');

const PRE_OPEN_DIR = path.join(__dirname, '..', 'src', 'trading', 'pre-open');
const SRC_DIR = path.join(__dirname, '..', 'src');

function tsFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) tsFiles(full, out);
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

function main() {
  const preOpenFiles = tsFiles(PRE_OPEN_DIR).filter((f) => !f.endsWith('.spec.ts'));
  assert.ok(preOpenFiles.length > 0, 'pre-open sources found');

  // ── 1. No canonical WRITE from the pre-open path ─────────────────────────
  for (const file of preOpenFiles) {
    const src = fs.readFileSync(file, 'utf8');
    const rel = path.relative(SRC_DIR, file);
    assert.ok(!/\.ingestQuote\s*\(/.test(src), `${rel} must not call ingestQuote (auction ≠ tradable)`);
    assert.ok(!/\.ingestSnapshot\s*\(/.test(src), `${rel} must not call ingestSnapshot (auction ≠ tradable)`);
    assert.ok(!/UnifiedMarketDataService/.test(src), `${rel} must not depend on the canonical write service`);
  }

  // ── 2. Exactly one producer of pre-open rows ─────────────────────────────
  const constructors = tsFiles(SRC_DIR)
    .filter((f) => !f.endsWith('.spec.ts'))
    .filter((f) => /new\s+PreOpenObservation\s*\(/.test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(SRC_DIR, f));
  assert.equal(constructors.length, 1, `exactly one pre-open row producer, found: ${constructors.join(', ')}`);
  assert.equal(constructors[0], path.join('trading', 'pre-open', 'pre-open-capture.service.ts'));

  // ── 3. The single producer stamps the canonical identity ─────────────────
  const capture = fs.readFileSync(path.join(PRE_OPEN_DIR, 'pre-open-capture.service.ts'), 'utf8');
  assert.ok(
    /row\.canonicalKey\s*=\s*canonicalInstrumentKey\(/.test(capture),
    'the producer stamps canonicalKey via the canonical identity authority',
  );

  // ── 4. One identity space shared with the common store ───────────────────
  assert.equal(canonicalInstrumentKey('BSE_INDEX|SENSEX'), 'BSE:SENSEX', 'pre-open SENSEX key');
  assert.equal(canonicalInstrumentKey('NSE_INDEX|Nifty 50'), 'NSE:NIFTY50', 'pre-open NIFTY key');
  assert.equal(canonicalInstrumentKey('NSE:NIFTY50-INDEX'), 'NSE:NIFTY50', 'snapshot-table index key lands in the SAME space');
  assert.equal(canonicalInstrumentKey(''), null, 'unresolvable key stays NULL, never guessed');

  // ── 5. The column can hold it ────────────────────────────────────────────
  const column = getMetadataArgsStorage().columns.find(
    (c) => c.target === PreOpenObservation && c.propertyName === 'canonicalKey',
  );
  assert.ok(column, 'pre_open_observations declares canonicalKey');
  assert.equal(column.options.nullable, true, 'canonicalKey is nullable (NULL when unresolvable)');

  console.log('pre-open single-source guard (D6): ALL PASS');
}

try {
  main();
} catch (err) {
  console.error('FAIL:', err && err.message ? err.message : err);
  process.exit(1);
}
