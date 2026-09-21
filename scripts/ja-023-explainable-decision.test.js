#!/usr/bin/env node
'use strict';
// JA-023 — Explainable decision: operator can understand the decision.
// Pure function test — no DB required.
//
// Run: node scripts/ja-023-explainable-decision.test.js

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

// Create a mock instance with the prototype chain so private methods work
const mockInstance = Object.create(QualificationService.prototype);
const buildExplanation = mockInstance.buildExplanation.bind(mockInstance);

function makeLead(overrides = {}) {
  return {
    id: 'test-lead-' + Math.random().toString(36).slice(2, 8),
    title: overrides.title ?? 'Software Engineer',
    company: overrides.company ?? 'Tech Corp',
    location: overrides.location ?? 'Bengaluru',
    description: overrides.description ?? 'Full-stack software engineer role with competitive compensation.',
    url: overrides.url ?? 'https://example.com/job',
    scrapedAt: overrides.scrapedAt ?? new Date(),
    status: overrides.status ?? 'active',
    source: overrides.source ?? 'scout',
    matchScore: overrides.matchScore ?? null,
    matchedSkills: overrides.matchedSkills ?? null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeProfile(overrides = {}) {
  return {
    id: 'test-profile-' + Math.random().toString(36).slice(2, 8),
    name: overrides.name ?? 'Test Candidate',
    email: 'test@example.com',
    skills: 'JavaScript,TypeScript,React,Node.js,Python',
    experienceYears: overrides.experienceYears ?? 5,
    currentLocation: 'Bengaluru',
    noticePeriod: '30 days',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeEvidence(overrides = {}) {
  const evidenceBase = {
    passed: true, score: overrides.evScore ?? 70, reasons: [], skillMatches: 3, totalProfileSkills: 10, requiredSkillCount: 5, titleRelevance: 0.6, matchedTags: ['javascript', 'typescript', 'react'], gapMissingMustHave: [], gapMissingPreferred: [], gapCovered: [], gapReasons: [], gapSeverity: 'NON_BLOCKING',
  };
  return {
    eligibility: { passed: true, score: 100, reasons: [] },
    evidence: { ...evidenceBase, ...overrides.extra?.evidence },
    jobQuality: { passed: true, score: overrides.jqScore ?? 70, reasons: [], label: overrides.jqLabel ?? 'medium', source: 'job_quality' },
    careerFit: { passed: true, score: overrides.cfScore ?? 60, reasons: [], overlapTags: ['javascript', 'react'], gapTags: ['python'], aligned: overrides.cfAligned ?? true },
    channelReady: { passed: true, score: 100, reasons: [], missing: [], hasAnswerBank: true, hasCv: true, hasAdapter: true },
    applicationRoi: { expectedValue: overrides.ev ?? 2000 },
    ...overrides.extra,
  };
}

async function run() {
  // Test 1: QUALIFIED decision has explanation
  console.log('\nTest 1: QUALIFIED decision has explanation');
  {
    global.expected++;
    const lead = makeLead({ title: 'Software Engineer', company: 'Tech Corp' });
    const profile = makeProfile({ name: 'Test Candidate' });
    const ev = makeEvidence({ evScore: 80, jqScore: 80, cfScore: 80, jqLabel: 'high', cfAligned: true });
    const reasons = ['skill match strong', 'career fit aligned'];
    const explanation = buildExplanation('QUALIFIED', 85, ev, lead, profile, { channelInfo: { hasAnswerBank: true, hasCv: true, source: 'scout' } }, reasons);

    if (explanation) ok('has explanation'); else fail('has explanation');
    eq('explanation.decision', explanation.decision, 'QUALIFIED');
    eq('explanation.compositeScore', explanation.compositeScore, 85);
    if (explanation.confidence >= 50) ok(`confidence ≥ 50 (got ${explanation.confidence})`); else fail(`confidence ≥ 50 (got ${explanation.confidence})`);
    if (explanation.strongestMatches.length > 0) ok('has strongestMatches'); else fail('has strongestMatches');
    if (explanation.blockers.length === 0) ok('no blockers for QUALIFIED'); else fail('no blockers for QUALIFIED');
    if (explanation.summary) ok('has summary'); else fail('has summary');
    if (explanation.summary.includes('QUALIFIED')) ok('summary mentions QUALIFIED'); else fail('summary mentions QUALIFIED');
  }

  // Test 2: Explanation includes expected value and channel
  console.log('\nTest 2: Explanation includes expected value and channel');
  {
    global.expected++;
    const lead = makeLead({ company: 'Google', url: 'https://careers.google.com/job' });
    const profile = makeProfile();
    const ev = makeEvidence({ evScore: 90, jqScore: 90, cfScore: 90, jqLabel: 'high', cfAligned: true, ev: 3370 });
    const reasons = ['strong match'];
    const explanation = buildExplanation('QUALIFIED', 92, ev, lead, profile, { channelInfo: { hasAnswerBank: true, hasCv: true, source: 'linkedin' } }, reasons);

    if (explanation.expectedValue > 0) ok(`EV > 0 (got ${explanation.expectedValue})`); else fail(`EV > 0 (got ${explanation.expectedValue})`);
    eq('explanation.channel', explanation.channel, 'linkedin');
    if (explanation.cvStrategy) ok('has cvStrategy'); else fail('has cvStrategy');
    if (explanation.evidenceRefs.length === 2) ok('has 2 evidenceRefs'); else fail(`has 2 evidenceRefs (got ${explanation.evidenceRefs.length})`);
  }

  // Test 3: REJECT decision has blockers
  console.log('\nTest 3: REJECT decision shows blockers');
  {
    global.expected++;
    const lead = makeLead({ title: 'Senior Python Architect' });
    const profile = makeProfile();
    const ev = makeEvidence({ evScore: 20, cfScore: 20, jqLabel: 'low', cfAligned: false, extra: { evidence: { gapSeverity: 'BLOCKING', gapReasons: ['missing required skill: Python (must-have)'], skillMatches: 0, totalProfileSkills: 10, requiredSkillCount: 5, titleRelevance: 0.1, matchedTags: [] } } });
    const reasons = ['REJECT: skill-gap severity BLOCKING — missing required skill: Python (must-have)'];
    const explanation = buildExplanation('REJECT', 15, ev, lead, profile, { channelInfo: { hasAnswerBank: true, hasCv: true, source: 'scout' } }, reasons);

    if (explanation.blockers.length > 0) ok(`has blockers (got ${explanation.blockers.length})`); else fail(`has blockers (got ${explanation.blockers.length})`);
    if (explanation.summary.includes('REJECTED')) ok('summary mentions REJECTED'); else fail('summary mentions REJECTED');
  }

  // Test 4: NEAR_MISS decision has gaps
  console.log('\nTest 4: NEAR_MISS decision shows gaps');
  {
    global.expected++;
    const lead = makeLead({ title: 'Senior Python Engineer' });
    const profile = makeProfile();
    const ev = makeEvidence({ evScore: 40, cfScore: 40, jqLabel: 'medium', cfAligned: false, extra: { careerFit: { gapTags: ['python', 'django', 'ml', 'data engineering', 'devops'], aligned: false } } });
    const reasons = ['NEAR_MISS: 5 skill gap(s) — upskill candidate'];
    const explanation = buildExplanation('NEAR_MISS', 45, ev, lead, profile, { channelInfo: { hasAnswerBank: true, hasCv: true, source: 'scout' } }, reasons);

    if (explanation.gaps.length > 0) ok(`has gaps (got ${explanation.gaps.length})`); else fail(`has gaps (got ${explanation.gaps.length})`);
    if (explanation.summary.includes('NEAR_MISS')) ok('summary mentions NEAR_MISS'); else fail('summary mentions NEAR_MISS');
  }

  // Test 5: Uncertainty for missing data
  console.log('\nTest 5: Uncertainty for missing data');
  {
    global.expected++;
    const lead = makeLead({ scrapedAt: null, company: '', url: '', description: 'x' });
    const profile = makeProfile();
    const ev = makeEvidence({ jqLabel: 'unknown', extra: {
      jobQuality: { label: 'unknown', reasons: ['posting age unknown (no scrapedAt)'] },
      channelReady: { passed: false, missing: ['no portal adapter registered'] },
    }});
    const reasons = ['posting age unknown (no scrapedAt)'];
    const explanation = buildExplanation('CONDITIONAL', 30, ev, lead, profile, { channelInfo: { hasAnswerBank: true, hasCv: true, source: 'scout' } }, reasons);

    if (explanation.uncertainty.length > 0) ok(`has uncertainty (got ${explanation.uncertainty.length})`); else fail(`has uncertainty (got ${explanation.uncertainty.length})`);
  }

  // Test 6: Confidence varies with signal strength
  console.log('\nTest 6: Confidence varies with signal strength');
  {
    global.expected++;
    const ev1 = makeEvidence({ evScore: 80, jqScore: 80, cfScore: 80, jqLabel: 'high', cfAligned: true });
    const explanation1 = buildExplanation('QUALIFIED', 85, ev1, makeLead(), makeProfile(), { channelInfo: { hasAnswerBank: true, hasCv: true, source: 'scout' } }, ['strong match']);
    
    const ev2 = makeEvidence({ evScore: 20, jqScore: 20, cfScore: 20, jqLabel: 'unknown', cfAligned: false, extra: {
      jobQuality: { label: 'unknown' },
      channelReady: { passed: false, missing: ['no adapter'] },
    }});
    const explanation2 = buildExplanation('CONDITIONAL', 25, ev2, makeLead(), makeProfile(), { channelInfo: { hasAnswerBank: true, hasCv: true, source: 'scout' } }, ['weak match']);
    
    if (explanation1.confidence > explanation2.confidence) ok(`strong confidence (${explanation1.confidence}) > weak (${explanation2.confidence})`); else fail(`strong confidence (${explanation1.confidence}) > weak (${explanation2.confidence})`);
  }

  // Test 7: CV strategy recommendations
  console.log('\nTest 7: CV strategy recommendations');
  {
    global.expected++;
    const ev1 = {
      eligibility: { passed: true, score: 100, reasons: [] },
      evidence: { passed: true, score: 70, reasons: [], skillMatches: 0, totalProfileSkills: 10, requiredSkillCount: 5, titleRelevance: 0.0, matchedTags: [], gapMissingMustHave: [], gapMissingPreferred: [], gapCovered: [], gapReasons: ['missing required skill: Python (must-have)'], gapSeverity: 'BLOCKING' },
      jobQuality: { passed: true, score: 70, reasons: [], label: 'medium', source: 'job_quality' },
      careerFit: { passed: true, score: 60, reasons: [], overlapTags: [], gapTags: [], aligned: true },
      channelReady: { passed: true, score: 100, reasons: [], missing: [], hasAnswerBank: true, hasCv: true, hasAdapter: true },
      applicationRoi: { expectedValue: 2000 },
    };
    const expl1 = buildExplanation('REJECT', 10, ev1, makeLead(), makeProfile(), { channelInfo: { hasAnswerBank: true, hasCv: true, source: 'scout' } }, ['BLOCKING']);
    eq('blocking → cvStrategy do_not_apply', expl1.cvStrategy, 'do_not_apply');

    const ev2 = {
      eligibility: { passed: true, score: 100, reasons: [] },
      evidence: { passed: true, score: 70, reasons: [], skillMatches: 3, totalProfileSkills: 10, requiredSkillCount: 5, titleRelevance: 0.6, matchedTags: ['javascript', 'react'], gapMissingMustHave: [], gapMissingPreferred: [], gapCovered: [], gapReasons: [], gapSeverity: 'NON_BLOCKING' },
      jobQuality: { passed: true, score: 70, reasons: [], label: 'medium', source: 'job_quality' },
      careerFit: { passed: true, score: 40, reasons: [], overlapTags: ['javascript', 'react'], gapTags: ['python', 'sql', 'ml', 'devops', 'kubernetes'], aligned: false },
      channelReady: { passed: true, score: 100, reasons: [], missing: [], hasAnswerBank: true, hasCv: true, hasAdapter: true },
      applicationRoi: { expectedValue: 2000 },
    };
    const expl2 = buildExplanation('NEAR_MISS', 40, ev2, makeLead(), makeProfile(), { channelInfo: { hasAnswerBank: true, hasCv: true, source: 'scout' } }, ['gaps']);
    eq('many gaps → cvStrategy tailored', expl2.cvStrategy, 'tailored_with_gap_remediation');

    const ev3 = makeEvidence({ cfAligned: false });
    const expl3 = buildExplanation('CONDITIONAL', 60, ev3, makeLead(), makeProfile(), { channelInfo: { hasAnswerBank: true, hasCv: true, source: 'scout' } }, ['career fit misaligned']);
    eq('career misaligned → cvStrategy reorientation', expl3.cvStrategy, 'career_fit_reorientation');
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Results: ${global.passed} passed, ${global.failed} failed, ${global.expected} expected`);
  if (global.failed > 0) { console.log(`FAIL: ${global.failed} of ${global.expected} checks failed`); process.exit(1); }
  console.log(`PASS: all ${global.expected} checks passed`);
  process.exit(0);
}

run().catch(err => { console.error('Test error:', err); process.exit(1); });
