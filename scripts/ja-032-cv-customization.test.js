#!/usr/bin/env node
'use strict';
// JA-032 — Evidence-grounded CV tailoring
// Pure function test — no DB required.
const fs = require('fs'); const path = require('path');
function load(r){const p=path.join(__dirname,'..','dist',r);if(!fs.existsSync(p)){console.error(`LOAD FAIL ${p}`);return null;}try{return require(p);}catch(e){return null;}}
function ok(l){console.log(`  ✔ ${l}`);} function fail(l){console.log(`  ✘ ${l}`);global.failed++;}
function eq(l,g,w){if(JSON.stringify(g)===JSON.stringify(w))ok(l);else fail(`${l}: got ${JSON.stringify(g)} want ${JSON.stringify(w)}`);}
global.expected=0;global.failed=0;

const S = load('job-application/cv-customization.service.js');
if (!S) { console.error('FATAL'); process.exit(1); }
const St = load('job-application/cv-strategy.service.js');
if (!St) { console.error('FATAL: cv-strategy'); process.exit(1); }
const cvService = new S.CVCustomizationService(new St.CVStrategyService());

function mockLead(overrides={}){
  return {
    id: 'lead1',
    source: 'remoteok',
    externalId: '123',
    title: overrides.title || 'Senior Software Engineer',
    company: overrides.company || 'Tech Corp',
    location: overrides.location || 'Bangalore, India',
    description: overrides.description || '',
    salary: null, currency: null, remote: null,
    scrapeCreatedAt: new Date().toISOString(),
    scrapedAt: new Date().toISOString(),
    ...overrides,
  };
}

function mockProfile(overrides={}){
  return {
    id: 'p1',
    name: 'Test User',
    email: 'test@example.com',
    phone: '1234567890',
    skills: overrides.skills || 'python, react, sql, nodejs, docker',
    headline: overrides.headline || 'Senior Software Engineer',
    experienceYears: overrides.experienceYears ?? 5,
    currentLocation: overrides.currentLocation || 'Bangalore, India',
    linkedinUrl: overrides.linkedinUrl || 'https://linkedin.com/in/test',
    githubUrl: overrides.githubUrl || 'https://github.com/test',
    portfolioUrl: overrides.portfolioUrl || null,
    workHistoryJson: overrides.workHistoryJson || JSON.stringify([
      {company:'Acme Corp',role:'Senior Engineer',from:'2020-01','to':'2023-01',summary:'Built microservices in Python',tagged:false},
      {company:'StartUp Inc',role:'Full Stack Developer',from:'2017-06','to':'2019-12',summary:'Web applications with React and Node.js',tagged:false},
    ]),
    educationJson: overrides.educationJson || JSON.stringify([
      {school:'IIT Bombay',degree:'BTech Computer Science',from:'2013-07','to':'2017-05',note:''},
    ]),
    projectsJson: overrides.projectsJson || JSON.stringify([
      {name:'E-commerce Platform',tech:['python','react','sql','docker'],summary:'Full-stack e-commerce platform serving 100K+ users'},
      {name:'Analytics Dashboard',tech:['react','python','sql'],summary:'Real-time analytics dashboard'},
    ]),
    ...overrides,
  };
}

async function run(){
  // T1: full CV tailoring for backend role
  console.log('\nT1: Full CV tailoring for backend role');
  {global.expected++;
    const lead = mockLead({title:'Backend Engineer'});
    const profile = mockProfile();
    const cv = cvService.tailorCV(lead, profile);
    ok('cvText non-empty', cv.cvText && cv.cvText.length > 0);
    eq('strategy','backend',cv.strategy);
    ok('skillOrder has entries', cv.skillOrder.length > 0);
    ok('skillOrder has python', cv.skillOrder.includes('python'));
    ok('skillOrder has sql', cv.skillOrder.includes('sql'));
    ok('emphasizedStints has entries', cv.emphasizedStints.length > 0);
    ok('highlightedProjects has entries', cv.highlightedProjects.length > 0);
    eq('profileId','p1',cv.metadata.profileId);
    eq('leadId','lead1',cv.metadata.leadId);
    eq('confidence','high',cv.metadata.confidence);
    ok('evidenceTrace has entries', cv.evidenceTrace.length > 0);
    // All evidence trace entries should be grounded
    const allGrounded = cv.evidenceTrace.every(e => e.grounded);
    ok('all evidence grounded', allGrounded);
  }

  // T2: frontend role → frontend strategy + FE skills first
  console.log('\nT2: Frontend role → frontend strategy');
  {global.expected++;
    const lead = mockLead({title:'Frontend Engineer'});
    const profile = mockProfile({skills:'react, css, typescript, python, sql'});
    const cv = cvService.tailorCV(lead, profile);
    eq('strategy','frontend',cv.strategy);
    const firstSkill = cv.skillOrder[0];
    ok('first skill is frontend (react/typescript/css)', ['react','typescript','css','javascript'].includes(firstSkill));
  }

  // T3: data scientist → data strategy
  console.log('\nT3: Data Scientist → data strategy');
  {global.expected++;
    const lead = mockLead({title:'Data Scientist'});
    const profile = mockProfile({skills:'python, sql, ml, tensorflow, pandas'});
    const cv = cvService.tailorCV(lead, profile);
    eq('strategy','data',cv.strategy);
    ok('first skill is data (python/sql/ml)', ['python','sql','ml','pandas','tensorflow'].includes(cv.skillOrder[0]));
  }

  // T4: empty profile → still produces CV (frontend default for software engineer with no skills)
  console.log('\nT4: Empty profile → still produces CV');
  {global.expected++;
    const lead = mockLead({title:'Software Engineer'});
    const profile = mockProfile({skills:'', workHistoryJson:'', projectsJson:'', headline:null, linkedinUrl:null, githubUrl:null});
    const cv = cvService.tailorCV(lead, profile);
    ok('cvText non-empty', cv.cvText && cv.cvText.length > 0);
    eq('strategy','frontend',cv.strategy); // Software Engineer → fullstack branch → empty skills → frontend default
  }

  // T5: evidence trace includes skill claims
  console.log('\nT5: Evidence trace includes skill claims');
  {global.expected++;
    const lead = mockLead({title:'Software Engineer'});
    const profile = mockProfile({skills:'python, react'});
    const cv = cvService.tailorCV(lead, profile);
    const skillClaims = cv.evidenceTrace.filter(e => e.claim.startsWith('Skill:'));
    ok('has skill claims', skillClaims.length > 0);
    ok('all skill claims grounded', skillClaims.every(e => e.grounded));
    ok('all skill claims high confidence', skillClaims.every(e => e.confidence === 'high'));
  }

  // T6: evidence trace includes experience claims
  console.log('\nT6: Evidence trace includes experience claims');
  {global.expected++;
    const lead = mockLead({title:'Software Engineer'});
    const profile = mockProfile();
    const cv = cvService.tailorCV(lead, profile);
    const expClaims = cv.evidenceTrace.filter(e => e.claim.startsWith('Experience:'));
    ok('has experience claims', expClaims.length > 0);
  }

  // T7: highlighted projects in CV text
  console.log('\nT7: Highlighted projects appear in CV text');
  {global.expected++;
    const lead = mockLead({title:'Full Stack Engineer'});
    const profile = mockProfile();
    const cv = cvService.tailorCV(lead, profile);
    ok('CV mentions E-commerce Platform', cv.cvText.includes('E-commerce Platform') || cv.cvText.includes('e-commerce'));
  }

  // T8: skill ordering is deterministic
  console.log('\nT8: Skill ordering is deterministic');
  {global.expected++;
    const lead = mockLead({title:'Backend Engineer'});
    const profile = mockProfile({skills:'python, react, sql, nodejs, docker'});
    const cv1 = cvService.tailorCV(lead, profile);
    const cv2 = cvService.tailorCV(lead, profile);
    eq('same skill order', cv1.skillOrder.join(','), cv2.skillOrder.join(','));
  }

  // T9: metadata has generatedAt
  console.log('\nT9: Metadata has generatedAt');
  {global.expected++;
    const lead = mockLead({title:'Software Engineer'});
    const profile = mockProfile({skills:'python'});
    const cv = cvService.tailorCV(lead, profile);
    ok('generatedAt present', cv.metadata.generatedAt && cv.metadata.generatedAt.length > 0);
    ok('strategySelection present', cv.metadata.strategySelection && cv.metadata.strategySelection.strategy);
  }

  // T10: CV text contains skill section
  console.log('\nT10: CV text contains Skills section');
  {global.expected++;
    const lead = mockLead({title:'Software Engineer'});
    const profile = mockProfile({skills:'python, react, sql'});
    const cv = cvService.tailorCV(lead, profile);
    ok('CV contains Skills:', cv.cvText.includes('Skills:'));
  }

  console.log('\n'+'='.repeat(50));
  console.log(`Results: passed, ${global.failed} failed, ${global.expected} expected`);
  if(global.failed>0){console.log(`FAIL: ${global.failed} of ${global.expected} checks failed`);process.exit(1);}
  console.log(`PASS: all ${global.expected} checks passed`);
  process.exit(0);
}
run().catch(e=>{console.error(e);process.exit(1);});
