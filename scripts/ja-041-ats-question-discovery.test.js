#!/usr/bin/env node
'use strict';
// JA-041 — Generic ATS question discovery
const fs = require('fs'); const path = require('path');
function load(r){const p=path.join(__dirname,'..','dist',r);if(!fs.existsSync(p)){console.error(`LOAD FAIL ${p}`);return null;}try{return require(p);}catch(e){return null;}}
function ok(l){console.log(`  ✔ ${l}`);} function fail(l){console.log(`  ✘ ${l}`);global.failed++;}
function eq(l,got,want){if(JSON.stringify(got)===JSON.stringify(want))ok(l);else fail(`${l}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);}
global.expected=0;global.failed=0;

const S = load('job-application/ats-question-discovery.service.js');
if (!S) { console.error('FATAL'); process.exit(1); }
const service = new S.ATSQuestionDiscoveryService();

function field(overrides={}){return{id:overrides.id||'f1',label:overrides.label||'Experience',name:overrides.name||'experience',type:overrides.type||'free_text',options:overrides.options||undefined,riskLevel:overrides.riskLevel||'safe',requiresAnswer:overrides.requiresAnswer??true,...overrides};}
function profile(overrides={}){return{skills:overrides.skills||'python, react, sql',headline:overrides.headline||'Senior Engineer',experienceYears:overrides.experienceYears??5,currentLocation:overrides.currentLocation||'Bangalore',...overrides};}
function evidence(overrides={}){return{location:overrides.location||'Bangalore',education:overrides.education||'B.Tech',...overrides};}

async function run(){
  console.log('\nT1: dropdown');{global.expected++;const t=service.detectFieldType('Country','country',['India','USA','UK']);eq('type',t,'dropdown');}
  console.log('\nT2: radio');{global.expected++;const t=service.detectFieldType('Employment Type','employment_type',['Full-time','Part-time','Contract']);eq('type',t,'dropdown');}
  console.log('\nT3: multi_select');{global.expected++;const t=service.detectFieldType('Skills','skills',['python','java','go','rust','js','ts','react','vue','angular','node','express','mongo']);eq('type',t,'multi_select');}
  console.log('\nT4: free_text');{global.expected++;const t=service.detectFieldType('Cover Letter','cover_letter');eq('type',t,'unknown');}
  console.log('\nT5: hidden');{global.expected++;const t=service.detectFieldType('__token','__token');eq('type',t,'hidden');}
  console.log('\nT6: SSN high_risk');{global.expected++;eq('risk',service.assessRisk({label:'SSN',name:'ssn'}),'high_risk');}
  console.log('\nT7: citizenship high_risk');{global.expected++;eq('risk',service.assessRisk({label:'Citizenship',name:'citizenship'}),'high_risk');}
  console.log('\nT8: experience safe');{global.expected++;eq('risk',service.assessRisk({label:'Experience',name:'experience'}),'safe');}
  console.log('\nT9: skill match');{global.expected++;const r=service.canAnswerFromEvidence({id:'ps',label:'Primary Skill',name:'primary_skill',type:'dropdown',options:['python','java','go'],riskLevel:'safe',requiresAnswer:true},profile({skills:'python, sql'}),{});eq('canAnswer',r.canAnswer,true);eq('answer',r.answer,'python');eq('source',r.source,'evidence');}
  console.log('\nT10: high-risk stopped');{global.expected++;const r=service.canAnswerFromEvidence({id:'ssn',label:'SSN',name:'ssn',type:'free_text',riskLevel:'high_risk',requiresAnswer:false},profile(),{});eq('canAnswer',r.canAnswer,false);eq('source',r.source,'stopped');}
  console.log('\nT11: unknown flagged');{global.expected++;const r=service.canAnswerFromEvidence({id:'uf',label:'Unknown',name:'unknown_field',type:'unknown',riskLevel:'medium',requiresAnswer:false},profile(),{});eq('source',r.source,'flagged');}
  console.log('\nT12: mixed evaluate');{global.expected++;const fields=[{id:'e',label:'Experience',name:'experience',type:'free_text',riskLevel:'safe',requiresAnswer:true},{id:'s',label:'SSN',name:'ssn',type:'free_text',riskLevel:'high_risk',requiresAnswer:false},{id:'c',label:'Country',name:'country',type:'dropdown',options:['India','USA'],riskLevel:'safe',requiresAnswer:false}];const r=service.evaluateFields(fields,profile({skills:'python'}),{location:'Bangalore'});const answered=r.answers.filter(a=>a.answerStatus==='answered').length;const stopped=r.answers.filter(a=>a.answerStatus==='stopped').length;const flagged=r.answers.filter(a=>a.answerStatus==='flagged').length;eq('answered',answered,1);eq('stopped',stopped,1);eq('flagged',flagged,1);eq('hasStopped',r.hasStopped,true);eq('hasFlagged',r.hasFlagged,true);}
  console.log('\nT13: unknown requiresAnswer flagged');{global.expected++;const r=service.canAnswerFromEvidence({id:'m',label:'Mystery',name:'mystery',type:'unknown',riskLevel:'medium',requiresAnswer:true},profile(),{});eq('source',r.source,'flagged');}
  console.log('\n'+'='.repeat(50));
  console.log(`Results: passed, ${global.failed} failed, ${global.expected} expected`);
  if(global.failed>0){console.log(`FAIL: ${global.failed} of ${global.expected} checks failed`);process.exit(1);}
  console.log(`PASS: all ${global.expected} checks passed`);
  process.exit(0);
}
run().catch(e=>{console.error(e);process.exit(1);});
