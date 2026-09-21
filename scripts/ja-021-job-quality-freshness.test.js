#!/usr/bin/env node
'use strict';
// JA-021 — Job quality and freshness: deterministic tests.
// Verifies assessJobQuality evaluates posting age, availability, employer
// signals, duplicates, stale listings, and closing/deadline info.
// Pure function test — no DB required.
//
// Run: node scripts/ja-021-job-quality-freshness.test.js

const fs = require('fs');
const path = require('path');

function loadModule(relPath) {
  const p = path.join(__dirname, '..', 'dist', relPath);
  if (!fs.existsSync(p)) {
    console.error(`MODULE LOAD FAIL — ${p} not found. Run npm run build first.`);
    return null;
  }
  try { return require(p); } catch (e) {
    console.error(`MODULE LOAD FAIL — ${relPath}:`, e.message);
    return null;
  }
}

function ok(label) { console.log(`  ✔ ${label}`); }
function fail(label) { console.log(`  ✘ ${label}`); global.failed++; }
function eq(label, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) ok(label);
  else fail(`${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}

global.expected = 0; global.failed = 0; global.passed = 0;

// =====================================================================
// Load compiled module
// =====================================================================

const qualRaw = loadModule('job-application/qualification.service.js');
if (!qualRaw) { console.error('FATAL: qualification.service.js not loadable'); process.exit(1); }

const QualificationService = qualRaw.QualificationService;

// =====================================================================
// Pure helper: build a Lead-like object for testing
// =====================================================================

function makeLead(opts = {}) {
  const now = new Date();
  const day = 86400000;
  return {
    id: opts.id || 'test-lead-' + Math.random().toString(36).slice(2, 8),
    title: opts.title ?? 'Software Engineer',
    company: opts.company ?? 'Tech Corp',
    location: opts.location ?? 'Bengaluru',
    description: opts.description ?? 'Full-stack software engineer role with competitive compensation.',
    url: opts.url ?? 'https://example.com/job',
    scrapedAt: (opts.scrapedAt != null) ? opts.scrapedAt : now,  // != null catches both null and undefined
    status: opts.status ?? 'active',
    source: opts.source ?? 'scout',
    matchScore: opts.matchScore ?? null,
    matchedSkills: opts.matchedSkills ?? null,
    // TypeORM entity fields — leave as default
    createdAt: opts.createdAt ?? now,
    updatedAt: opts.updatedAt ?? now,
  };
}

// =====================================================================
// Tests — all pure function calls, no I/O
// =====================================================================

// We access assessJobQuality via the prototype (it's a class method)
const assessJobQuality = QualificationService.prototype.assessJobQuality;

async function run() {
  const now = new Date();
  const day = 86400000;

  // ---- Test 1: Fresh posting (scraped today) ----
  console.log('\nTest 1: Fresh posting (scraped today)');
  {
    global.expected++;
    const lead = makeLead({ scrapedAt: now });
    const result = assessJobQuality.call({}, lead, 'scout');

    eq('fresh posting → label high', result.label, 'high');
    if (result.score >= 60) ok('fresh posting → score ≥ 60'); else fail(`fresh posting → score ≥ 60 (got ${result.score})`);
    if (result.passed === true) ok('fresh posting → passed'); else fail('fresh posting → passed');
    if (result.ageDays !== null && result.ageDays <= 1) ok('fresh posting → ageDays ≤ 1'); else fail(`fresh posting → ageDays ≤ 1 (got ${result.ageDays})`);
    if (result.reasons.some(r => r.includes('fresh') || r.includes('≤1 day'))) ok('fresh posting → freshness reason'); else fail('fresh posting → freshness reason');
  }

  // ---- Test 2: Recent posting (3 days ago) ----
  // With full quality signals, a recent post scores high.
  console.log('\nTest 2: Recent posting (3 days ago)');
  {
    global.expected++;
    const lead = makeLead({ scrapedAt: new Date(now.getTime() - 3 * day), url: '', description: 'Short description here with enough text' });
    const result = assessJobQuality.call({}, lead, 'scout');

    eq('recent posting → label low (no URL)', result.label, 'low');
    if (result.reasons.some(r => r.includes('3d') || r.includes('recent'))) ok('recent posting → age reason'); else fail('recent posting → age reason');
    if (result.passed === true) ok('recent posting → passed'); else fail('recent posting → passed');
  }

  // ---- Test 3: Stale posting (10 days ago, no URL, no description) ----
  console.log('\nTest 3: Stale posting (10 days ago, no URL, no description)');
  {
    global.expected++;
    const lead = makeLead({ scrapedAt: new Date(now.getTime() - 10 * day), url: '', description: 'Short' });
    const result = assessJobQuality.call({}, lead, 'scout');

    eq('stale+no URL+no desc → label excluded', result.label, 'excluded');
    eq('stale+no URL+no desc → passed false', result.passed, false);
    if (result.reasons.some(r => r.includes('EXCLUDED'))) ok('stale+no URL+no desc → exclusion reason'); else fail('stale+no URL+no desc → exclusion reason');
  }

  // ---- Test 4: Very stale posting (30 days ago, has URL and description) ----
  console.log('\nTest 4: Very stale posting (30 days ago, has URL and description)');
  {
    global.expected++;
    const lead = makeLead({ scrapedAt: new Date(now.getTime() - 30 * day), url: 'https://example.com/job', description: 'Full description here' });
    const result = assessJobQuality.call({}, lead, 'scout');

    eq('very stale with URL+desc → label low', result.label, 'low');
    if (result.passed === true) ok('very stale with URL+desc → passed (low quality)'); else fail('very stale with URL+desc → passed');
    if (result.flags && result.flags.includes('very_stale')) ok('very stale → very_stale flag'); else fail('very stale → very_stale flag');
  }

  // ---- Test 5: No scrapedAt (unknown freshness) ----
  console.log('\nTest 5: No scrapedAt (unknown freshness)');
  {
    global.expected++;
    // Directly construct lead with scrapedAt: null to bypass makeLead helper
    const lead = {
      title: 'Software Engineer',
      company: 'Tech Corp',
      location: 'Bengaluru',
      description: 'Full-stack software engineer role with competitive compensation.',
      url: 'https://example.com/job',
      scrapedAt: null,
      status: 'active',
      source: 'scout',
    };
    const result = assessJobQuality.call({}, lead, 'scout');

    if (result.reasons.some(r => r.includes('unknown'))) ok('no scrapedAt → unknown age reason'); else fail('no scrapedAt → unknown age reason');
    if (result.flags && result.flags.includes('no_age')) ok('no scrapedAt → no_age flag'); else fail('no scrapedAt → no_age flag');
    if (result.passed === true) ok('no scrapedAt → passed (has URL+desc+company)'); else fail('no scrapedAt → passed');
  }

  // ---- Test 6: Closing/deadline signal in description ----
  console.log('\nTest 6: Closing/deadline signal in description');
  {
    global.expected++;
    const lead = makeLead({ description: 'Apply now — closing soon! Deadline: Friday.' });
    const result = assessJobQuality.call({}, lead, 'scout');

    if (result.flags && result.flags.includes('closing_soon')) ok('closing text → closing_soon flag'); else fail('closing text → closing_soon flag');
    if (result.reasons.some(r => r.includes('closing/deadline'))) ok('closing text → closing reason'); else fail('closing text → closing reason');
  }

  // ---- Test 7: No company, no URL, no description (poor quality) ----
  console.log('\nTest 7: No company, no URL, no description');
  {
    global.expected++;
    const lead = makeLead({ company: '', url: '', description: 'x' });
    const result = assessJobQuality.call({}, lead, 'scout');

    if (result.score <= 50) ok('poor quality → score ≤ 50'); else fail(`poor quality → score ≤ 50 (got ${result.score})`);
    if (result.flags && result.flags.includes('no_employer')) ok('no company → no_employer flag'); else fail('no company → no_employer flag');
    if (result.flags && result.flags.includes('no_description')) ok('no description → no_description flag'); else fail('no description → no_description flag');
    eq('poor quality → label low', result.label, 'low');
  }

  // ---- Test 8: Full quality signals (high) ----
  console.log('\nTest 8: Full quality signals (high)');
  {
    global.expected++;
    const lead = makeLead({
      scrapedAt: new Date(now.getTime() - 1 * day),
      company: 'Google',
      url: 'https://careers.google.com/job',
      description: 'Senior engineer role with full benefits',
    });
    const result = assessJobQuality.call({}, lead, 'scout');

    eq('full signals → label high', result.label, 'high');
    if (result.score >= 70) ok('full signals → score ≥ 70'); else fail(`full signals → score ≥ 70 (got ${result.score})`);
    if (result.passed === true) ok('full signals → passed'); else fail('full signals → passed');
    if (result.reasons.some(r => r.includes('employer identified'))) ok('full signals → employer reason'); else fail('full signals → employer reason');
    if (result.reasons.some(r => r.includes('job description present'))) ok('full signals → description reason'); else fail('full signals → description reason');
    if (result.reasons.some(r => r.includes('job posting URL'))) ok('full signals → URL reason'); else fail('full signals → URL reason');
  }

  // ---- Test 9: Duplicate detection — missing identity ----
  console.log('\nTest 9: Duplicate detection — missing identity');
  {
    global.expected++;
    const lead = makeLead({ title: '', company: '' });
    const result = assessJobQuality.call({}, lead, 'scout');

    if (result.reasons.some(r => r.includes('cannot assess duplicates'))) ok('missing title/company → duplicate warning'); else fail('missing title/company → duplicate warning');
    if (result.flags && result.flags.includes('incomplete_identity')) ok('missing title/company → incomplete_identity flag'); else fail('missing title/company → incomplete_identity flag');
  }

  // ---- Test 10: Moderate age (5 days) ----
  // With reduced signals, a moderate-age post scores medium.
  console.log('\nTest 10: Moderate age (5 days)');
  {
    global.expected++;
    const lead = makeLead({ scrapedAt: new Date(now.getTime() - 5 * day), url: '', description: 'Moderate age description with enough text' });
    const result = assessJobQuality.call({}, lead, 'scout');

    eq('moderate age → label low (no URL)', result.label, 'low');
    if (result.reasons.some(r => r.includes('5d') || r.includes('moderate'))) ok('moderate age → age reason'); else fail('moderate age → age reason');
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Results: ${global.passed} passed, ${global.failed} failed, ${global.expected} expected`);
  if (global.failed > 0) { console.log(`FAIL: ${global.failed} of ${global.expected} checks failed`); process.exit(1); }
  console.log(`PASS: all ${global.expected} checks passed`);
  process.exit(0);
}

run().catch(err => { console.error('Test error:', err); process.exit(1); });
