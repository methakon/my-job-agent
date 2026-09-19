#!/usr/bin/env node
'use strict';
// JA-022 — Application ROI: expected value scoring.
// Verifies ranking incorporates expected value, not only match score.
//
// Run: node scripts/ja-022-application-roi.test.js

const fs = require('fs');
const path = require('path');

function loadModule(relPath) {
  const p = path.join(__dirname, '..', 'dist', relPath);
  if (!fs.existsSync(p)) { console.error(`MODULE LOAD FAIL — ${p}`); return null; }
  try { return require(p); } catch (e) { console.error(e.message); return null; }
}

function ok(l) { console.log(`  ✔ ${l}`); }
function fail(l) { console.log(`  ✘ ${l}`); global.failed++; }
function eq(l, g, w) { if (JSON.stringify(g) === JSON.stringify(w)) ok(l); else fail(`${l}: got ${JSON.stringify(g)} want ${JSON.stringify(w)}`); }

global.expected = 0; global.failed = 0; global.passed = 0;

const qualRaw = loadModule('job-application/qualification.service.js');
if (!qualRaw) { console.error('FATAL'); process.exit(1); }

const QualificationService = qualRaw.QualificationService;
const assessApplicationRoi = QualificationService.prototype.assessApplicationRoi;

function makeEvidence(overrides = {}) {
  return {
    eligibility: { passed: true, score: 100, reasons: [] },
    evidence: { passed: true, score: overrides.evScore ?? 70, reasons: [], skillMatches: 3, totalProfileSkills: 10, requiredSkillCount: 5, titleRelevance: 0.6, matchedTags: [] },
    jobQuality: { passed: true, score: overrides.jqScore ?? 70, reasons: [], label: overrides.jqLabel ?? 'medium', source: 'job_quality' },
    careerFit: { passed: true, score: overrides.cfScore ?? 60, reasons: [], overlapTags: ['javascript','react'], gapTags: ['python'], aligned: overrides.cfAligned ?? true },
    channelReady: { passed: true, score: 100, reasons: [], missing: [], hasAnswerBank: true, hasCv: true, hasAdapter: true },
    ...overrides.extra,
  };
}

function makeLead(overrides = {}) {
  return {
    title: 'Software Engineer', company: 'Tech Corp', location: 'Bengaluru',
    description: 'Full-stack software engineer role with competitive compensation.',
    url: 'https://example.com/job', scrapedAt: new Date(), status: 'active', source: 'scout',
    ...overrides,
  };
}

async function run() {
  // Test 1: High EV with strong signals
  console.log('\nTest 1: High EV with strong signals');
  {
    global.expected++;
    const ev = makeEvidence({ evScore: 80, jqScore: 80, cfScore: 80, jqLabel: 'high' });
    const lead = makeLead();
    const result = assessApplicationRoi.call({}, ev, lead);
    if (result.expectedValue >= 2000) ok(`high signals → EV ≥ 2000 (got ${result.expectedValue})`); else fail(`high signals → EV ≥ 2000 (got ${result.expectedValue})`);
    if (result.passed === true) ok('high signals → passed'); else fail('high signals → passed');
    if (result.valueBreakdown.some(b => b.includes('expected value'))) ok('valueBreakdown includes EV'); else fail('valueBreakdown includes EV');
  }

  // Test 2: Low EV with weak signals (channelReady passed, no gap severity → effort stays low)
  console.log('\nTest 2: Low EV with weak signals');
  {
    global.expected++;
    const ev = makeEvidence({ evScore: 20, jqScore: 20, cfScore: 20, jqLabel: 'low', cfAligned: false });
    const lead = makeLead();
    const result = assessApplicationRoi.call({}, ev, lead);
    if (result.expectedValue < 1000) ok(`low signals → EV < 1000 (got ${result.expectedValue})`); else fail(`low signals → EV < 1000 (got ${result.expectedValue})`);
    // effort: baseline 2, channelReady hasAnswerBank=true → no +1, hasCv=true → no +1, jqLabel='low' not 'unknown' → no +1, no gapSeverity → no +1 = 2
    if (result.effortEstimate === 2) ok('low signals → effort = 2 (baseline, channel ready)'); else fail(`low signals → effort = 2 (got ${result.effortEstimate})`);
    if (result.tailoringCost >= 3) ok('low signals → tailoringCost ≥ 3'); else fail('low signals → tailoringCost ≥ 3');
  }

  // Test 3: Channel failure — need all three false for channelProb=15
  console.log('\nTest 3: Channel failure reduces EV');
  {
    global.expected++;
    const ev = makeEvidence({ extra: { channelReady: { passed: false, score: 34, reasons: [], missing: ['no adapter'], hasAnswerBank: false, hasCv: false, hasAdapter: false } } });
    const lead = makeLead();
    const result = assessApplicationRoi.call({}, ev, lead);
    if (result.channelSuccessProb === 15) ok('no channel at all → channelProb = 15%'); else fail(`no channel → channelProb = 15% (got ${result.channelSuccessProb})`);
    if (result.expectedValue < 1500) ok('no channel → EV reduced (got ' + result.expectedValue + ')'); else fail('no channel → EV reduced');
  }

  // Test 4: High effort — blocking gap severity increases effort
  console.log('\nTest 4: High effort job (blocking gap)');
  {
    global.expected++;
    const ev = makeEvidence({ evScore: 40, jqScore: 40, cfScore: 40, jqLabel: 'unknown', cfAligned: false, extra: { evidence: { ...makeEvidence().evidence, gapSeverity: 'BLOCKING' } } });
    const lead = makeLead();
    const result = assessApplicationRoi.call({}, ev, lead);
    // effort: baseline 2, !hasAnswerBank? no (true), !hasCv? no (true), jqLabel='unknown' → +1 = 3, gapSeverity='BLOCKING' → +1 = 4
    if (result.effortEstimate >= 4) ok(`blocking gap → effort ≥ 4 (got ${result.effortEstimate})`); else fail(`blocking gap → effort ≥ 4 (got ${result.effortEstimate})`);
  }

  // Test 5: Fresh high-quality job gets high EV
  console.log('\nTest 5: Fresh high-quality job');
  {
    global.expected++;
    const ev = makeEvidence({ evScore: 90, jqScore: 90, cfScore: 90, jqLabel: 'high', cfAligned: true });
    const lead = makeLead();
    const result = assessApplicationRoi.call({}, ev, lead);
    if (result.expectedValue >= 2500) ok(`strong signals → EV ≥ 2500 (got ${result.expectedValue})`); else fail(`strong signals → EV ≥ 2500 (got ${result.expectedValue})`);
    if (result.passed === true) ok('strong signals → passed'); else fail('strong signals → passed');
    if (result.channelSuccessProb === 65) ok('channel ready → channelProb = 65%'); else fail(`channel ready → channelProb = 65% (got ${result.channelSuccessProb})`);
  }

  // Test 6: EV reasons include all components
  console.log('\nTest 6: EV reasons include qualification probability');
  {
    global.expected++;
    const ev = makeEvidence({ evScore: 70 });
    const lead = makeLead();
    const result = assessApplicationRoi.call({}, ev, lead);
    if (result.reasons.some(r => r.includes('qualification probability'))) ok('reasons include qualProb'); else fail('reasons include qualProb');
    if (result.reasons.some(r => r.includes('channel success'))) ok('reasons include channelProb'); else fail('reasons include channelProb');
    if (result.reasons.some(r => r.includes('response likelihood'))) ok('reasons include responseLikely'); else fail('reasons include responseLikely');
    if (result.reasons.some(r => r.includes('effort estimate'))) ok('reasons include effort'); else fail('reasons include effort');
    if (result.reasons.some(r => r.includes('tailoring cost'))) ok('reasons include tailoring'); else fail('reasons include tailoring');
  }

  // Test 7: Stale job increases tailoring cost
  console.log('\nTest 7: Stale job increases tailoring cost');
  {
    global.expected++;
    const ev = makeEvidence({ jqLabel: 'low', extra: { jobQuality: { ...makeEvidence().jobQuality, label: 'low', flags: ['stale'] } } });
    const lead = makeLead();
    const result = assessApplicationRoi.call({}, ev, lead);
    if (result.tailoringCost >= 3) ok('stale → tailoringCost ≥ 3'); else fail(`stale → tailoringCost ≥ 3 (got ${result.tailoringCost})`);
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Results: ${global.passed} passed, ${global.failed} failed, ${global.expected} expected`);
  if (global.failed > 0) { console.log(`FAIL: ${global.failed} of ${global.expected} checks failed`); process.exit(1); }
  console.log(`PASS: all ${global.expected} checks passed`);
  process.exit(0);
}

run().catch(err => { console.error('Test error:', err); process.exit(1); });
