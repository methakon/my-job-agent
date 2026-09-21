#!/usr/bin/env node
'use strict';
// JA-050 — Employer intelligence
const fs = require('fs'); const path = require('path');
function load(r){const p=path.join(__dirname,'..','dist',r);if(!fs.existsSync(p)){console.error('LOAD FAIL '+p);return null;}try{return require(p);}catch(e){console.error('LOAD ERROR '+r+':',e.message);return null;}}
function ok(l){console.log('  ✔ '+l);} function fail(l){console.log('  ✘ '+l);global.failed++;}
function eq(l,g,w){if(JSON.stringify(g)===JSON.stringify(w))ok(l);else fail(l+': got '+JSON.stringify(g)+' want '+JSON.stringify(w));}
global.expected=0;global.failed=0;

const S = load('job-application/employer-intelligence.service.js');
if (!S) { console.error('FATAL'); process.exit(1); }
const service = new S.EmployerIntelligenceService();

function employer(overrides={}){return{enployerName:overrides.employerName||'Tech Corp',employerDomain:overrides.employerDomain||'techcorp.com',ats:overrides.ats||'workday',channel:overrides.channel||'ats',firstSeen:overrides.firstSeen||new Date().toISOString(),lastSeen:overrides.lastSeen||new Date().toISOString(),applicationCount:overrides.applicationCount||0,interviewCount:overrides.interviewCount||0,offerCount:overrides.offerCount||0,rejectionCount:overrides.rejectionCount||0,repostCount:overrides.repostCount||0,responseRate:overrides.responseRate||0,offerRate:overrides.offerRate||0,riskLevel:overrides.riskLevel||'unknown',notes:overrides.notes||undefined,};}

async function run(){
  console.log('\nT1: recordApplication');{global.expected++;const e=service.recordApplication({employerName:'Acme',employerDomain:'acme.com'});eq('employerName',e.employerName,'Acme');eq('applicationCount',e.applicationCount,1);ok('firstSeen present',e.firstSeen&&e.firstSeen.length>0);ok('lastSeen present',e.lastSeen&&e.lastSeen.length>0);}
  console.log('\nT2: recordOutcome interview');{global.expected++;const e=service.recordOutcome(employer({applicationCount:3}),'interview');eq('interviewCount',e.interviewCount,1);ok('responseRate > 0',e.responseRate>0);}
  console.log('\nT3: recordOutcome offer');{global.expected++;const e=service.recordOutcome(employer({applicationCount:5,interviewCount:2}),'offer');eq('offerCount',e.offerCount,1);eq('riskLevel',e.riskLevel,'low');}
  console.log('\nT4: recordOutcome rejection high');{global.expected++;const e=service.recordOutcome(employer({applicationCount:10,rejectionCount:8}),'rejection');eq('rejectionCount',e.rejectionCount,9);eq('riskLevel',e.riskLevel,'high');}
  console.log('\nT5: computeRiskLevel unknown (<3 apps)');{global.expected++;const e=employer({applicationCount:2});eq('riskLevel',service.computeRiskLevel(e),'unknown');}
  console.log('\nT6: computeRiskLevel low (has offer)');{global.expected++;const e=employer({applicationCount:5,offerCount:1});eq('riskLevel',service.computeRiskLevel(e),'low');}
  console.log('\nT7: computeRiskLevel medium (reposts)');{global.expected++;const e=employer({applicationCount:6,repostCount:3,interviewCount:0});eq('riskLevel',service.computeRiskLevel(e),'medium');}
  console.log('\nT8: computeRiskLevel medium (no interviews)');{global.expected++;const e=employer({applicationCount:8,interviewCount:0,rejectionCount:6});eq('riskLevel',service.computeRiskLevel(e),'medium');}
  console.log('\nT9: assess low risk');{global.expected++;const d=service.assess(employer({applicationCount:5,offerCount:1,interviewCount:2}));eq('riskLevel',d.riskLevel,'low');eq('recommendation',d.recommendation,'safe_to_apply');ok('rational mentions positive',d.rational.includes('positive'));}
  console.log('\nT10: assess high risk');{global.expected++;const d=service.assess(employer({applicationCount:10,rejectionCount:9}));eq('riskLevel',d.riskLevel,'high');eq('recommendation',d.recommendation,'avoid_or_flag');}
  console.log('\nT11: assess unknown');{global.expected++;const d=service.assess(employer({applicationCount:1}));eq('riskLevel',d.riskLevel,'unknown');eq('recommendation',d.recommendation,'collect_more_data');}
  console.log('\n'+'='.repeat(50));
  console.log('Results: passed, '+global.failed+' failed, '+global.expected+' expected');
  if(global.failed>0){console.log('FAIL: '+global.failed+' of '+global.expected+' checks failed');process.exit(1);}
  console.log('PASS: all '+global.expected+' checks passed');
  process.exit(0);
}
run().catch(e=>{console.error(e);process.exit(1);});
