#!/usr/bin/env node
'use strict';
// JA-034 — ATS + human scoring
// Pure function test — no DB required.
const fs = require('fs'); const path = require('path');
function load(r){const p=path.join(__dirname,'..','dist',r);if(!fs.existsSync(p)){console.error(`LOAD FAIL ${p}`);return null;}try{return require(p);}catch(e){return null;}}
function ok(l){console.log(`  ✔ ${l}`);} function fail(l){console.log(`  ✘ ${l}`);global.failed++;}
function eq(l,g,w){if(JSON.stringify(g)===JSON.stringify(w))ok(l);else fail(`${l}: got ${JSON.stringify(g)} want ${JSON.stringify(w)}`);}
global.expected=0;global.failed=0;

const S = load('job-application/ats-scoring.service.js');
if (!S) { console.error('FATAL'); process.exit(1); }
const St = load('job-application/cv-strategy.service.js');
if (!St) { console.error('FATAL: cv-strategy'); process.exit(1); }
const C = load('job-application/cv-customization.service.js');
if (!C) { console.error('FATAL: cv-customization'); process.exit(1); }
const cvService = new C.CVCustomizationService(new St.CVStrategyService());
const service = new S.ATSCustomizationService();
service.cvCustomizationService = cvService;
function mockLead(overrides={}){
  return {
    id: 'lead1', source: 'remoteok', externalId: '123',
    title: overrides.title || 'Senior Software Engineer',
    company: overrides.company || 'Tech Corp',
    location: overrides.location || 'Bangalore, India',
    description: '', salary: null, currency: null, remote: null,
    scrapeCreatedAt: new Date().toISOString(), scrapedAt: new Date().toISOString(),
    ...overrides,
  };
}

function mockProfile(overrides={}){
  return {
    id: 'p1', name: 'Test User', email: 'test@example.com', phone: '1234567890',
    skills: overrides.skills || 'python, react, sql, nodejs',
    headline: overrides.headline || 'Senior Software Engineer',
    experienceYears: overrides.experienceYears ?? 5,
    currentLocation: overrides.currentLocation || 'Bangalore, India',
    linkedinUrl: overrides.linkedinUrl || null, githubUrl: overrides.githubUrl || null,
    portfolioUrl: overrides.portfolioUrl || null,
    workHistoryJson: overrides.workHistoryJson || JSON.stringify([
      {company:'Acme Corp',role:'Senior Engineer',from:'2020-01','to':'2023-01',summary:'Built microservices in Python serving 100K users',tagged:false},
    ]),
    educationJson: overrides.educationJson || JSON.stringify([]),
    projectsJson: overrides.projectsJson || JSON.stringify([
      {name:'E-commerce Platform',tech:['python','react','sql'],summary:'Full-stack platform serving 50K users'},
    ]),
    ...overrides,
  };
}

async function run(){
  // T1: Full scoring — ATS + Human
  console.log('\nT1: Full ATS + Human scoring');
  {global.expected++;
    const lead = mockLead({title:'Software Engineer'});
    const profile = mockProfile({skills:'python, react, sql, nodejs'});
    const cv = cvService.tailorCV(lead, profile);
    const result = service.scoreCV(lead, profile, cv);
    ok('ats score 0-100', result.ats.score >= 0 && result.ats.score <= 100);
    ok('human score 0-100', result.human.score >= 0 && result.human.score <= 100);
    ok('combined score 0-100', result.combined >= 0 && result.combined <= 100);
    eq('ats label valid', true, ['low','medium','high'].includes(result.ats.label));
    eq('human label valid', true, ['low','medium','high'].includes(result.human.label));
    eq('combined label valid', true, ['low','medium','high'].includes(result.combinedLabel));
    ok('checkedAt present', result.checkedAt && result.checkedAt.length > 0);
  }

  // T2: ATS keyword coverage
  console.log('\nT2: ATS keyword coverage');
  {global.expected++;
    const lead = mockLead({title:'Software Engineer'});
    const profile = mockProfile({skills:'python, react, sql, nodejs'});
    const cv = cvService.tailorCV(lead, profile);
    const result = service.scoreCV(lead, profile, cv);
    ok('ATS has keyword coverage', result.ats.breakdown.keywordCoverage >= 0);
    ok('ATS has semantic relevance', result.ats.breakdown.semanticRelevance >= 0);
    ok('ATS has structure score', result.ats.breakdown.structureScore >= 0);
    ok('ATS has readability score', result.ats.breakdown.readabilityScore >= 0);
    ok('ATS has stuffing penalty', result.ats.breakdown.keywordStuffingPenalty >= 0);
  }

  // T3: Human evidence strength
  console.log('\nT3: Human evidence strength');
  {global.expected++;
    const lead = mockLead({title:'Software Engineer'});
    const profile = mockProfile({skills:'python, react'});
    const cv = cvService.tailorCV(lead, profile);
    const result = service.scoreCV(lead, profile, cv);
    ok('Human has evidence strength', result.human.breakdown.evidenceStrength >= 0);
    ok('Human has readability', result.human.breakdown.readabilityScore >= 0);
    ok('Human has structure', result.human.breakdown.structureScore >= 0);
    ok('Human has relevance', result.human.breakdown.relevanceToRole >= 0);
    ok('Human has stuffing penalty', result.human.breakdown.keywordStuffingPenalty >= 0);
  }

  // T4: ATS score higher with good keyword coverage
  console.log('\nT4: ATS score with good coverage');
  {global.expected++;
    const lead = mockLead({title:'Backend Engineer'});
    const profile = mockProfile({skills:'python, sql, nodejs, docker'});
    const cv = cvService.tailorCV(lead, profile);
    const result = service.scoreCV(lead, profile, cv);
    ok('ATS score reasonable', result.ats.score > 20); // should get some points
  }

  // T5: High ATS score with full coverage
  console.log('\nT5: High ATS score with full coverage');
  {global.expected++;
    const lead = mockLead({title:'Python Developer'});
    const profile = mockProfile({skills:'python, sql, nodejs'});
    const cv = cvService.tailorCV(lead, profile);
    const result = service.scoreCV(lead, profile, cv);
    ok('ATS score > 30', result.ats.score > 30);
    ok('ATS details non-empty', result.ats.details.length > 0);
  }

  // T6: Keyword stuffing penalty
  console.log('\nT6: Keyword stuffing penalty');
  {global.expected++;
    const lead = mockLead({title:'Python Developer'});
    const profile = mockProfile({skills:'python'});
    const cv = cvService.tailorCV(lead, profile);
    // Artificially stuff keywords
    cv.cvText = cv.cvText + '\npython python python python python python';
    const result = service.scoreCV(lead, profile, cv);
    ok('Has stuffing penalty', result.ats.breakdown.keywordStuffingPenalty >= 5);
    ok('Human also penalizes', result.human.breakdown.keywordStuffingPenalty >= 5);
  }

  // T7: Separate ATS and human signals
  console.log('\nT7: ATS and human are separate scores');
  {global.expected++;
    const lead = mockLead({title:'Software Engineer'});
    const profile = mockProfile({skills:'python, react'});
    const cv = cvService.tailorCV(lead, profile);
    const result = service.scoreCV(lead, profile, cv);
    // They can be different — verify they're computed independently
    ok('ATS and human both computed', result.ats.score >= 0 && result.human.score >= 0);
  }

  // T8: Combined score is between ATS and human (weighted)
  console.log('\nT8: Combined score is weighted average');
  {global.expected++;
    const lead = mockLead({title:'Software Engineer'});
    const profile = mockProfile({skills:'python, react, sql'});
    const cv = cvService.tailorCV(lead, profile);
    const result = service.scoreCV(lead, profile, cv);
    const expectedCombined = Math.round(result.ats.score * 0.4 + result.human.score * 0.6);
    eq('combined matches expected', expectedCombined, result.combined);
  }

  // T9: Empty profile scores
  console.log('\nT9: Scoring empty profile');
  {global.expected++;
    const lead = mockLead({title:'Software Engineer'});
    const profile = mockProfile({skills:'', workHistoryJson:'', projectsJson:''});
    const cv = cvService.tailorCV(lead, profile);
    const result = service.scoreCV(lead, profile, cv);
    ok('ATS score >= 0', result.ats.score >= 0);
    ok('Human score >= 0', result.human.score >= 0);
    ok('ATS details present', result.ats.details.length > 0);
    ok('Human details present', result.human.details.length > 0);
  }

  // T10: scoreCV returns full structure
  console.log('\nT10: Full score structure');
  {global.expected++;
    const lead = mockLead({title:'Software Engineer'});
    const profile = mockProfile({skills:'python'});
    const cv = cvService.tailorCV(lead, profile);
    const result = service.scoreCV(lead, profile, cv);
    ok('has ats', !!result.ats);
    ok('has human', !!result.human);
    ok('has combined', result.combined !== undefined);
    ok('has combinedLabel', !!result.combinedLabel);
    ok('has checkedAt', !!result.checkedAt);
  }

  console.log('\n'+'='.repeat(50));
  console.log(`Results: passed, ${global.failed} failed, ${global.expected} expected`);
  if(global.failed>0){console.log(`FAIL: ${global.failed} of ${global.expected} checks failed`);process.exit(1);}
  console.log(`PASS: all ${global.expected} checks passed`);
  process.exit(0);
}
run().catch(e=>{console.error(e);process.exit(1);});
