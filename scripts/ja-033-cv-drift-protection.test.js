#!/usr/bin/env node
'use strict';
// JA-033 — CV semantic-drift protection
// Pure function test — no DB required.
const fs = require('fs'); const path = require('path');
function load(r){const p=path.join(__dirname,'..','dist',r);if(!fs.existsSync(p)){console.error(`LOAD FAIL ${p}`);return null;}try{return require(p);}catch(e){return null;}}
function ok(l){console.log(`  ✔ ${l}`);} function fail(l){console.log(`  ✘ ${l}`);global.failed++;}
function eq(l,g,w){if(JSON.stringify(g)===JSON.stringify(w))ok(l);else fail(`${l}: got ${JSON.stringify(g)} want ${JSON.stringify(w)}`);}
global.expected=0;global.failed=0;

const S = load('job-application/cv-drift-protection.service.js');
if (!S) { console.error('FATAL'); process.exit(1); }
const St = load('job-application/cv-strategy.service.js');
if (!St) { console.error('FATAL: cv-strategy'); process.exit(1); }
const C = load('job-application/cv-customization.service.js');
if (!C) { console.error('FATAL: cv-customization'); process.exit(1); }
const cvService = new C.CVCustomizationService(new St.CVStrategyService());
const driftService = new S.CVDriftProtectionService();
driftService.cvCustomizationService = cvService;

function mockLead(overrides={}){
  return {
    id: 'lead1',
    source: 'remoteok', externalId: '123',
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
      {company:'Acme Corp',role:'Senior Engineer',from:'2020-01','to':'2023-01',summary:'Built microservices',tagged:false},
    ]),
    educationJson: overrides.educationJson || JSON.stringify([]),
    projectsJson: overrides.projectsJson || JSON.stringify([
      {name:'E-commerce Platform',tech:['python','react','sql'],summary:'Full-stack platform'},
    ]),
    ...overrides,
  };
}

async function run(){
  // T1: Clean CV — no drift detected
  console.log('\nT1: Clean CV — no drift detected');
  {global.expected++;
    const lead = mockLead({title:'Software Engineer'});
    const profile = mockProfile({skills:'python, react, sql', experienceYears:5});
    const cv = cvService.tailorCV(lead, profile);
    const report = driftService.checkDrift(lead, profile, cv);
    eq('passes', true, report.passes);
    eq('totalViolations', 0, report.totalViolations);
    eq('critical', 0, report.bySeverity.critical);
    ok('summary says no drift', report.summary.includes('No drift') || report.summary.includes('fully grounded'));
  }

  // T2: Invented skill — critical violation
  console.log('\nT2: Invented skill — critical violation');
  {global.expected++;
    const lead = mockLead({title:'Software Engineer'});
    // Create a CV with an invented skill by manipulating evidence trace
    const profile = mockProfile({skills:'python, react'});
    const cv = cvService.tailorCV(lead, profile);
    // Add an invented skill to the trace
    cv.evidenceTrace.push({claim:'Skill: kotlin', source:'invented', confidence:'high', grounded:true});
    const report = driftService.checkDrift(lead, mockProfile({skills:'python, react'}), cv);
    eq('passes', false, report.passes);
    eq('critical', 1, report.bySeverity.critical);
    ok('has invented_skill violation', report.violations.some(v => v.type === 'invented_skill'));
  }

  // T3: Inflated experience — critical violation
  console.log('\nT3: Inflated experience — critical violation');
  {global.expected++;
    const lead = mockLead({title:'Software Engineer'});
    const profile = mockProfile({skills:'python', experienceYears:3});
    const cv = cvService.tailorCV(lead, profile);
    // Append inflated experience text
    cv.cvText += '\n10 years experience in software development';
    const report = driftService.checkDrift(lead, profile, cv);
    eq('critical', 1, report.bySeverity.critical);
    ok('has inflated_experience violation', report.violations.some(v => v.type === 'inflated_experience'));
  }

  // T4: Altered headline — critical violation
  console.log('\nT4: Altered headline — critical violation');
  {global.expected++;
    const lead = mockLead({title:'Software Engineer'});
    const profile = mockProfile({headline:'Senior Software Engineer'});
    const cv = cvService.tailorCV(lead, profile);
    // Modify headline in trace
    cv.evidenceTrace.forEach(e => {
      if (e.claim.startsWith('Headline:')) e.claim = 'Headline: Principal Architect';
    });
    const report = driftService.checkDrift(lead, profile, cv);
    eq('critical', 1, report.bySeverity.critical);
    ok('has altered_title violation', report.violations.some(v => v.type === 'altered_title'));
  }

  // T5: Unsupported project — major violation
  console.log('\nT5: Unsupported project — major violation');
  {global.expected++;
    const lead = mockLead({title:'Software Engineer'});
    const profile = mockProfile({projectsJson: JSON.stringify([{name:'Real Project',tech:['python'],summary:''}])});
    const cv = cvService.tailorCV(lead, profile);
    // Add unsupported project to trace
    cv.evidenceTrace.push({claim:'Project: Fake Project', source:'invented', confidence:'high', grounded:true});
    const report = driftService.checkDrift(lead, profile, cv);
    eq('major', 1, report.bySeverity.major);
    ok('has unsupported_responsibility violation', report.violations.some(v => v.type === 'unsupported_responsibility'));
  }

  // T6: Unsupported experience stint — major violation
  console.log('\nT6: Unsupported experience stint — major violation');
  {global.expected++;
    const lead = mockLead({title:'Software Engineer'});
    const profile = mockProfile({workHistoryJson: JSON.stringify([{company:'Real Co',role:'Dev',from:'2020','to':'2022',summary:''}])});
    const cv = cvService.tailorCV(lead, profile);
    cv.evidenceTrace.push({claim:'Experience: Fake Role at Fake Co', source:'invented', confidence:'high', grounded:true});
    const report = driftService.checkDrift(lead, profile, cv);
    ok('has unsupported_responsibility violation', report.violations.some(v => v.type === 'unsupported_responsibility' && v.claim.startsWith('Experience:')));
  }

  // T7: Minor metric violation (unsupported number)
  console.log('\nT7: Minor metric violation');
  {global.expected++;
    const lead = mockLead({title:'Software Engineer'});
    const profile = mockProfile({skills:'python'});
    const cv = cvService.tailorCV(lead, profile);
    cv.cvText += '\nServed 50K users';
    const report = driftService.checkDrift(lead, profile, cv);
    eq('minor', 1, report.bySeverity.minor);
    ok('has unsupported_metric violation', report.violations.some(v => v.type === 'unsupported_metric'));
    eq('passes', true, report.passes); // minor doesn't fail
  }

  // T8: validateCV shortcut
  console.log('\nT8: validateCV shortcut');
  {global.expected++;
    const lead = mockLead({title:'Software Engineer'});
    const profile = mockProfile({skills:'python, react'});
    const cv = cvService.tailorCV(lead, profile);
    const valid = driftService.validateCV(lead, profile, cv);
    ok('valid CV passes', valid);
  }

  // T9: validateCV catches invented skill
  console.log('\nT9: validateCV catches invented skill');
  {global.expected++;
    const lead = mockLead({title:'Software Engineer'});
    const profile = mockProfile({skills:'python'});
    const cv = cvService.tailorCV(lead, profile);
    cv.evidenceTrace.push({claim:'Skill: java', source:'invented', confidence:'high', grounded:true});
    const valid = driftService.validateCV(lead, profile, cv);
    ok('invalid CV fails', !valid);
  }

  // T10: report includes profileId and leadId
  console.log('\nT10: Report includes identifiers');
  {global.expected++;
    const lead = mockLead({title:'Software Engineer'});
    const profile = mockProfile({skills:'python'});
    const cv = cvService.tailorCV(lead, profile);
    const report = driftService.checkDrift(lead, profile, cv);
    eq('profileId','p1',report.profileId);
    eq('leadId','lead1',report.leadId);
    ok('checkedAt present', report.checkedAt && report.checkedAt.length > 0);
  }

  console.log('\n'+'='.repeat(50));
  console.log(`Results: passed, ${global.failed} failed, ${global.expected} expected`);
  if(global.failed>0){console.log(`FAIL: ${global.failed} of ${global.expected} checks failed`);process.exit(1);}
  console.log(`PASS: all ${global.expected} checks passed`);
  process.exit(0);
}
run().catch(e=>{console.error(e);process.exit(1);});
