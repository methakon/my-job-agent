#!/usr/bin/env node
'use strict';
// JA-031 — CV strategy selection
// Pure function test — no DB required.
const fs = require('fs'); const path = require('path');
function load(r){const p=path.join(__dirname,'..','dist',r);if(!fs.existsSync(p)){console.error(`LOAD FAIL ${p}`);return null;}try{return require(p);}catch(e){return null;}}
function ok(l){console.log(`  ✔ ${l}`);} function fail(l){console.log(`  ✘ ${l}`);global.failed++;}
function eq(l,g,w){if(JSON.stringify(g)===JSON.stringify(w))ok(l);else fail(`${l}: got ${JSON.stringify(g)} want ${JSON.stringify(w)}`);}
global.expected=0;global.failed=0;

const S = load('job-application/cv-strategy.service.js');
if (!S) { console.error('FATAL'); process.exit(1); }
const service = new S.CVStrategyService();

function mockLead(overrides={}){
  return {
    id: 'lead1',
    source: 'remoteok',
    externalId: '123',
    title: overrides.title || 'Senior Software Engineer',
    company: overrides.company || 'Tech Corp',
    location: overrides.location || 'Bangalore, India',
    description: overrides.description || '',
    salary: overrides.salary || null,
    currency: overrides.currency || null,
    remote: overrides.remote || null,
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
    skills: overrides.skills || 'python, react, sql, nodejs',
    headline: overrides.headline || 'Senior Software Engineer',
    experienceYears: overrides.experienceYears ?? 5,
    ...overrides,
  };
}

async function run(){
  // T1: data scientist → data strategy
  console.log('\nT1: Data Scientist → data strategy');
  {global.expected++;
    const lead = mockLead({title:'Data Scientist'});
    const profile = mockProfile({skills:'python, sql, ml, tensorflow'});
    const sel = service.selectStrategy(lead, profile);
    eq('strategy','data',sel.strategy);
    eq('confidence','high',sel.confidence);
    eq('has data_role_detected factor',true,sel.factors.includes('data_role_detected'));
  }

  // T2: DevOps engineer → devops strategy
  console.log('\nT2: DevOps Engineer → devops strategy');
  {global.expected++;
    const lead = mockLead({title:'DevOps Engineer'});
    const profile = mockProfile({skills:'docker, kubernetes, aws, terraform'});
    const sel = service.selectStrategy(lead, profile);
    eq('strategy','devops',sel.strategy);
    eq('confidence','high',sel.confidence);
  }

  // T3: Mobile developer → mobile strategy
  console.log('\nT3: iOS Developer → mobile strategy');
  {global.expected++;
    const lead = mockLead({title:'iOS Developer'});
    const profile = mockProfile({skills:'swift, ios, mobile'});
    const sel = service.selectStrategy(lead, profile);
    eq('strategy','mobile',sel.strategy);
    eq('confidence','high',sel.confidence);
  }

  // T4: Engineering Manager (senior) → management strategy
  console.log('\nT4: Engineering Manager (10yr exp) → management strategy');
  {global.expected++;
    const lead = mockLead({title:'Engineering Manager'});
    const profile = mockProfile({skills:'python, leadership, architecture', experienceYears:10});
    const sel = service.selectStrategy(lead, profile);
    eq('strategy','management',sel.strategy);
    eq('confidence','high',sel.confidence);
    eq('has senior_leadership factor',true,sel.factors.includes('senior_leadership'));
  }

  // T5: Frontend Engineer with frontend skills → frontend strategy
  console.log('\nT5: Frontend Engineer with FE skills → frontend strategy');
  {global.expected++;
    const lead = mockLead({title:'Frontend Engineer'});
    const profile = mockProfile({skills:'react, css, typescript, javascript'});
    const sel = service.selectStrategy(lead, profile);
    eq('strategy','frontend',sel.strategy);
    eq('confidence','high',sel.confidence);
    eq('has frontend_match factor',true,sel.factors.includes('frontend_match'));
  }

  // T6: Backend Engineer with backend skills → backend strategy
  console.log('\nT6: Backend Engineer with BE skills → backend strategy');
  {global.expected++;
    const lead = mockLead({title:'Backend Engineer'});
    const profile = mockProfile({skills:'python, sql, django, api'});
    const sel = service.selectStrategy(lead, profile);
    eq('strategy','backend',sel.strategy);
    eq('confidence','high',sel.confidence);
  }

  // T7: Full Stack Engineer with both stacks → fullstack strategy
  console.log('\nT7: Full Stack Engineer with both stacks → fullstack strategy');
  {global.expected++;
    const lead = mockLead({title:'Full Stack Engineer'});
    const profile = mockProfile({skills:'react, python, nodejs, sql, css'});
    const sel = service.selectStrategy(lead, profile);
    eq('strategy','fullstack',sel.strategy);
    eq('confidence','high',sel.confidence);
    eq('has fullstack_match factor',true,sel.factors.includes('fullstack_match'));
  }

  // T8: Developer with both stacks → fullstack
  console.log('\nT8: Developer with both stacks → fullstack');
  {global.expected++;
    const lead = mockLead({title:'Developer'});
    const profile = mockProfile({skills:'react, python, sql'});
    const sel = service.selectStrategy(lead, profile);
    eq('strategy','fullstack',sel.strategy);
    eq('has general_fullstack factor',true,sel.factors.includes('general_fullstack'));
  }

  // T9: Developer with only backend → backend
  console.log('\nT9: Developer with only backend → backend');
  {global.expected++;
    const lead = mockLead({title:'Developer'});
    const profile = mockProfile({skills:'python, sql, django'});
    const sel = service.selectStrategy(lead, profile);
    eq('strategy','backend',sel.strategy);
    eq('has general_backend factor',true,sel.factors.includes('general_backend'));
  }

  // T10: ATS-sensitive region
  console.log('\nT10: US location → ATS factor');
  {global.expected++;
    const lead = mockLead({title:'Software Engineer', location:'San Francisco, United States'});
    const profile = mockProfile({skills:'python, react'});
    const sel = service.selectStrategy(lead, profile);
    eq('has ats_sensitive_region factor',true,sel.factors.includes('ats_sensitive_region'));
  }

  // T11: recordStrategy (idempotency)
  console.log('\nT11: recordStrategy returns same object');
  {global.expected++;
    const lead = mockLead({title:'Software Engineer'});
    const profile = mockProfile({skills:'python'});
    const sel = service.selectStrategy(lead, profile);
    const recorded = service.recordStrategy(sel);
    eq('same strategy', sel.strategy, recorded.strategy);
    eq('same rationale', sel.rationale, recorded.rationale);
  }

  // T12: notes are non-empty
  console.log('\nT12: strategy notes are non-empty');
  {global.expected++;
    const lead = mockLead({title:'Software Engineer'});
    const profile = mockProfile({skills:'python'});
    const sel = service.selectStrategy(lead, profile);
    ok('notes non-empty', sel.notes && sel.notes.length > 0);
  }

  console.log('\n'+'='.repeat(50));
  console.log(`Results: passed, ${global.failed} failed, ${global.expected} expected`);
  if(global.failed>0){console.log(`FAIL: ${global.failed} of ${global.expected} checks failed`);process.exit(1);}
  console.log(`PASS: all ${global.expected} checks passed`);
  process.exit(0);
}
run().catch(e=>{console.error(e);process.exit(1);});
