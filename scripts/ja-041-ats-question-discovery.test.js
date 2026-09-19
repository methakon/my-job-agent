#!/usr/bin/env node
'use strict';
// JA-041 — Generic ATS question discovery
// Pure function test — no DB required.
const fs = require('fs'); const path = require('path');
function load(r){const p=path.join(__dirname,'..','dist',r);if(!fs.existsSync(p)){console.error(`LOAD FAIL ${p}`);return null;}try{return require(p);}catch(e){return null;}}
function ok(l){console.log(`  ✔ ${l}`);} function fail(l){console.log(`  ✘ ${l}`);global.failed++;}
function eq(l,g,w){if(JSON.stringify(g)===JSON.stringify(w))ok(l);else fail(`${l}: got ${JSON.stringify(g)} want ${JSON.stringify(w)}`);}
global.expected=0;global.failed=0;

const S = load('job-application/ats-question-discovery.service.js');
if (!S) { console.error('FATAL'); process.exit(1); }
const service = new S.ATSQuestionDiscoveryService();

function field(overrides={}){
  return {
    id: overrides.id || 'f1',
    label: overrides.label || 'Experience',
    name: overrides.name || 'experience',
    type: overrides.type || 'free_text',
    options: overrides.options || undefined,
    riskLevel: overrides.riskLevel || 'safe',
    requiresAnswer: overrides.requiresAnswer ?? true,
    ...overrides,
  };
}

function profile(overrides={}){
  return {
    skills: overrides.skills || 'python, react, sql',
    headline: overrides.headline || 'Senior Engineer',
    experienceYears: overrides.experienceYears ?? 5,
    currentLocation: overrides.currentLocation || 'Bangalore',
    ...overrides,
  };
}

function evidence(overrides={}){
  return {
    location: overrides.location || 'Bangalore',
    education: overrides.education || 'B.Tech',
    ...overrides,
  };
}

async function run(){
  // T1: Detect field type — dropdown with options
  console.log('\nT1: Detect field type — dropdown');
  {global.expected++;
    const f = field({label:'Country', name:'country', options:['India','USA','UK']});
    const type = service.detectFieldType(f.label, f.name, f.options);
    eq('type','dropdown',type);
  }

  // T2: Detect field type — radio with few options
  console.log('\nT2: Detect field type — radio');
  {global.expected++;
    const f = field({label:'Employment Type', name:'employment_type', options:['Full-time','Part-time','Contract']});
    const type = service.detectFieldType(f.label, f.name, f.options);
    eq('type','radio',type);
  }

  // T3: Detect field type — multi-select with many options
  console.log('\nT3: Detect field type — multi-select');
  {global.expected++;
    const f = field({label:'Skills', name:'skills', options:['python','java','go','rust','js','ts','react','vue','angular','node','express','mongo']});
    const type = service.detectFieldType(f.label, f.name, f.options);
    eq('type','multi_select',type);
  }

  // T4: Detect field type — free text
  console.log('\nT4: Detect field type — free text');
  {global.expected++;
    const f = field({label:'Cover Letter', name:'cover_letter'});
    const type = service.detectFieldType(f.label, f.name);
    eq('type','free_text',type);
  }

  // T5: Detect field type — hidden
  console.log('\nT5: Detect field type — hidden');
  {global.expected++;
    const f = field({label:'__token', name:'__token'});
    const type = service.detectFieldType(f.label, f.name);
    eq('type','hidden',type);
  }

  // T6: Assess risk — SSN is high risk
  console.log('\nT6: Assess risk — SSN');
  {global.expected++;
    const f = field({label:'Social Security Number', name:'ssn'});
    const risk = service.assessRisk(f);
    eq('risk','high_risk',risk);
  }

  // T7: Assess risk — citizenship is high risk
  console.log('\nT7: Assess risk — citizenship');
  {global.expected++;
    const f = field({label:'Citizenship Status', name:'citizenship'});
    const risk = service.assessRisk(f);
    eq('risk','high_risk',risk);
  }

  // T8: Assess risk — experience is safe
  console.log('\nT8: Assess risk — experience');
  {global.expected++;
    const f = field({label:'Years of Experience', name:'experience'});
    const risk = service.assessRisk(f);
    eq('risk','safe',risk);
  }

  // T9: Answer from evidence — skill match in dropdown
  console.log('\nT9: Answer from evidence — skill match');
  {global.expected++;
    const f = field({label:'Primary Skill', name:'primary_skill', type:'dropdown', options:['python','java','go']});
    const result = service.canAnswerFromEvidence(f, profile({skills:'python, sql'}), {});
    ok('can answer', result.canAnswer);
    eq('answer','python',result.answer);
    eq('source','evidence',result.source);
  }

  // T10: High-risk field — stopped
  console.log('\nT10: High-risk field — stopped');
  {global.expected++;
    const f = field({label:'SSN', name:'ssn', riskLevel:'high_risk'});
    const result = service.canAnswerFromEvidence(f, profile(), {});
    ok('cannot answer', !result.canAnswer);
    eq('source','stopped',result.source);
    ok('reason mentions high-risk', result.reason.toLowerCase().includes('high-risk'));
  }

  // T11: Unknown field — flagged
  console.log('\nT11: Unknown field — flagged');
  {global.expected++;
    const f = field({label:'Unknown Field', name:'unknown_field', type:'unknown', requiresAnswer:false});
    const result = service.canAnswerFromEvidence(f, profile(), {});
    eq('source','flagged',result.source);
    ok('reason mentions flagged', result.reason.toLowerCase().includes('flagged'));
  }

  // T12: Evaluate fields — mix of answered, stopped, flagged
  console.log('\nT12: Evaluate fields — mixed');
  {global.expected++;
    const fields = [
      field({label:'Experience', name:'experience', type:'free_text'}),
      field({label:'SSN', name:'ssn', riskLevel:'high_risk', requiresAnswer:false}),
      field({label:'Country', name:'country', type:'dropdown', options:['India','USA'], requiresAnswer:false}),
    ];
    const result = service.evaluateFields(fields, profile({skills:'python'}), evidence({location:'Bangalore'}));
    eq('answered count',1,result.answers.filter(a=>a.answerStatus==='answered').length);
    eq('stopped count',1,result.answers.filter(a=>a.answerStatus==='stopped').length);
    eq('flagged count',1,result.answers.filter(a=>a.answerStatus==='flagged').length);
    ok('hasStopped', result.hasStopped);
    ok('hasFlagged', result.hasFlagged);
    ok('summary mentions stopped', result.summary.toLowerCase().includes('stopped'));
  }

  // T13: Unknown field with requiresAnswer — flagged
  console.log('\nT13: Unknown field with requiresAnswer — flagged');
  {global.expected++;
    const f = field({label:'Mystery Field', name:'mystery', type:'unknown', requiresAnswer:true});
    const result = service.canAnswerFromEvidence(f, profile(), {});
    eq('source','flagged',result.source);
  }

  console.log('\n'+'='.repeat(50));
  console.log(`Results: passed, ${global.failed} failed, ${global.expected} expected`);
  if(global.failed>0){console.log(`FAIL: ${global.failed} of ${global.expected} checks failed`);process.exit(1);}
  console.log(`PASS: all ${global.expected} checks passed`);
  process.exit(0);
}
run().catch(e=>{console.error(e);process.exit(1);});
