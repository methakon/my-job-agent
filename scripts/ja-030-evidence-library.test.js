#!/usr/bin/env node
'use strict';
// JA-030 — Master candidate evidence library
// Pure function test — no DB required.
const fs = require('fs'); const path = require('path');
function load(r){const p=path.join(__dirname,'..','dist',r);if(!fs.existsSync(p)){console.error(`LOAD FAIL ${p}`);return null;}try{return require(p);}catch(e){return null;}}
function ok(l){console.log(`  ✔ ${l}`);} function fail(l){console.log(`  ✘ ${l}`);global.failed++;}
function eq(l,g,w){if(JSON.stringify(g)===JSON.stringify(w))ok(l);else fail(`${l}: got ${JSON.stringify(g)} want ${JSON.stringify(w)}`);}
global.expected=0;global.failed=0;

// Build a mock CandidateProfile
function mockProfile(overrides={}){
  return {
    id: overrides.id || 'p1',
    name: overrides.name || 'Test User',
    email: 'test@example.com',
    phone: '1234567890',
    skills: overrides.skills || 'python, sql, react, nodejs',
    headline: overrides.headline || 'Senior Software Engineer',
    experienceYears: overrides.experienceYears ?? 5,
    noticePeriod: overrides.noticePeriod || '15 days',
    salaryExpectation: overrides.salaryExpectation || '1500000 INR',
    linkedinUrl: overrides.linkedinUrl || 'https://linkedin.com/in/test',
    githubUrl: overrides.githubUrl || 'https://github.com/test',
    portfolioUrl: overrides.portfolioUrl || null,
    currentLocation: overrides.currentLocation || 'Bangalore, India',
    workHistoryJson: overrides.workHistoryJson || JSON.stringify([
      {company:'Acme Corp',role:'Senior Engineer',from:'2020-01','to':'2023-01',summary:'Built microservices',tagged:false},
      {company:'StartUp Inc',role:'Junior Developer',from:'2017-06','to':'2019-12',summary:'Web apps',tagged:true},
    ]),
    educationJson: overrides.educationJson || JSON.stringify([
      {school:'IIT Bombay',degree:'BTech Computer Science',from:'2013-07','to':'2017-05',note:''},
    ]),
    projectsJson: overrides.projectsJson || JSON.stringify([
      {name:'E-commerce Platform',tech:['python','react','sql'],summary:'Full-stack e-commerce'},
    ]),
    ...overrides,
  };
}

const S = load('job-application/candidate-evidence-library.service.js');
if (!S) { console.error('FATAL: cannot load service'); process.exit(1); }
const service = new S.CandidateEvidenceLibraryService();

async function run(){
  // T1: build full evidence library
  console.log('\nT1: build full evidence library');
  {global.expected++;
    const p = mockProfile();
    const lib = await service.buildEvidenceLibrary(p);
    eq('profileId', 'p1', lib.profileId);
    eq('profileName', 'Test User', lib.profileName);
    eq('headline', 'Senior Software Engineer', lib.headline);
    eq('skills count', 4, lib.skills.length);
    eq('skills has python', true, lib.skills.includes('python'));
    eq('experienceYears', 5, lib.experienceYears);
    eq('employment count', 2, lib.employment.length);
    eq('employment[0].company', 'Acme Corp', lib.employment[0].company);
    eq('employment[1].tagged', true, lib.employment[1].tagged);
    eq('projects count', 1, lib.projects.length);
    eq('education count', 1, lib.education.length);
    eq('location', 'Bangalore, India', lib.location);
    eq('noticePeriod', '15 days', lib.noticePeriod);
    eq('salaryExpectation', '1500000 INR', lib.salaryExpectation);
    eq('links count', 2, lib.links.length);
    eq('has linkedin', true, lib.links.some(l => l.kind === 'linkedin'));
    eq('has github', true, lib.links.some(l => l.kind === 'github'));
    ok('retrievedAt present', lib.retrievedAt && lib.retrievedAt.length > 0);
  }

  // T2: get skills
  console.log('\nT2: get skills');
  {global.expected++;
    const p = mockProfile({skills:'python, sql, react'});
    const result = await service.getSkills(p);
    eq('skills count', 3, result.skills.length);
    eq('source', 'profile.skills', result.source);
    eq('confidence', 'high', result.confidence);
  }

  // T3: get employment (untagged only)
  console.log('\nT3: get employment (untagged only)');
  {global.expected++;
    const p = mockProfile();
    const emp = await service.getEmployment(p, true);
    eq('count', 1, emp.length);
    eq('company', 'Acme Corp', emp[0].company);
    eq('tagged', false, emp[0].tagged);
  }

  // T4: get employment (all)
  console.log('\nT4: get employment (all)');
  {global.expected++;
    const p = mockProfile();
    const emp = await service.getEmployment(p, false);
    eq('count', 2, emp.length);
  }

  // T5: get projects
  console.log('\nT5: get projects');
  {global.expected++;
    const p = mockProfile();
    const projs = await service.getProjects(p);
    eq('count', 1, projs.length);
    eq('name', 'E-commerce Platform', projs[0].name);
    eq('tech includes python', true, projs[0].tech.includes('python'));
  }

  // T6: get education
  console.log('\nT6: get education');
  {global.expected++;
    const p = mockProfile();
    const edu = await service.getEducation(p);
    eq('count', 1, edu.length);
    eq('school', 'IIT Bombay', edu[0].school);
    eq('degree', 'BTech Computer Science', edu[0].degree);
  }

  // T7: get links
  console.log('\nT7: get links');
  {global.expected++;
    const p = mockProfile({portfolioUrl:null});
    const links = await service.getLinks(p);
    eq('count', 2, links.length);
    eq('linkedin url', 'https://linkedin.com/in/test', links[0].url);
  }

  // T8: empty profile
  console.log('\nT8: empty profile (no skills, history, etc.)');
  {global.expected++;
    const p = mockProfile({skills:'', workHistoryJson:'', educationJson:'', projectsJson:'', linkedinUrl:null, githubUrl:null, portfolioUrl:null});
    const lib = await service.buildEvidenceLibrary(p);
    eq('skills count', 0, lib.skills.length);
    eq('employment count', 0, lib.employment.length);
    eq('projects count', 0, lib.projects.length);
    eq('education count', 0, lib.education.length);
    eq('links count', 0, lib.links.length);
  }

  // T9: parse errors (malformed JSON)
  console.log('\nT9: malformed JSON handling');
  {global.expected++;
    const p = mockProfile({workHistoryJson:'not-json', educationJson:'also-not-json'});
    const lib = await service.buildEvidenceLibrary(p);
    eq('employment count', 0, lib.employment.length);
    eq('education count', 0, lib.education.length);
  }

  console.log('\n'+'='.repeat(50));
  console.log(`Results: passed, ${global.failed} failed, ${global.expected} expected`);
  if(global.failed>0){console.log(`FAIL: ${global.failed} of ${global.expected} checks failed`);process.exit(1);}
  console.log(`PASS: all ${global.expected} checks passed`);
  process.exit(0);
}
run().catch(e=>{console.error(e);process.exit(1);});
