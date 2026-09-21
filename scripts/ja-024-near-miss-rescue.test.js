#!/usr/bin/env node
'use strict';
// JA-024 — Near-miss rescue: near misses separately identified.
// Pure function test — no DB required.
const fs = require('fs'); const path = require('path');
function load(r){const p=path.join(__dirname,'..','dist',r);if(!fs.existsSync(p)){console.error(`LOAD FAIL ${p}`);return null;}try{return require(p);}catch(e){return null;}}
function ok(l){console.log(`  ✔ ${l}`);} function fail(l){console.log(`  ✘ ${l}`);global.failed++;}
function eq(l,g,w){if(JSON.stringify(g)===JSON.stringify(w))ok(l);else fail(`${l}: got ${JSON.stringify(g)} want ${JSON.stringify(w)}`);}
global.expected=0;global.failed=0;
const Q=load('job-application/qualification.service.js'); if(!Q){console.error('FATAL');process.exit(1);}
const decideNearMiss=Q.decideNearMissRescue;
const classifyRescue=Q.classifyNearMissRescue;
const isNearMiss=Q.isNearMissScore;
async function run(){
  // T1: score 54 with 4 gaps → NEAR_MISS + rescue classification
  console.log('\nT1: score 54, 4 gaps → NEAR_MISS + rescue classification');
  {global.expected++;
    const r=decideNearMiss(54,{careerFit:{gapTags:['python','sql','ml','devops'],aligned:false},evidence:{gapSeverity:'NON_BLOCKING',gapReasons:[]}});
    eq('decision','NEAR_MISS',r.decision);
    eq('rescue_category','full_reskill',r.rescueCategory);
    if(r.rescueUrl)ok(`rescue URL present (${r.rescueUrl.length} chars)`);else fail('rescue URL present');
    if(r.rescueAction)ok(`rescue action: ${r.rescueAction}`);else fail('rescue action');
  }
  // T2: score 61 with 1 gap → NEAR_MISS + rescue (preferred-skill-upskill)
  console.log('\nT2: score 61, 1 gap → NEAR_MISS + rescue');
  {global.expected++;
    const r=decideNearMiss(61,{careerFit:{gapTags:['css'],aligned:true},evidence:{gapSeverity:'NON_BLOCKING',gapReasons:[]}},null,null);
    eq('decision','NEAR_MISS',r.decision);
    eq('rescue_category','preferred-skill-upskill',r.rescueCategory);
  }
  // T3: score 75 → not near miss (above 64)
  console.log('\nT3: score 75 → not near miss');
  {global.expected++;
    const r=decideNearMiss(75,{careerFit:{gapTags:[],aligned:true},evidence:{gapSeverity:'NON_BLOCKING',gapReasons:[]}},null,null);
    eq('decision','QUALIFIED',r.decision);
    eq('rescue_category',null,r.rescueCategory);
  }
  // T4: score 30 → not near miss (below 40)
  console.log('\nT4: score 30 → not near miss (too low)');
  {global.expected++;
    const r=decideNearMiss(30,{careerFit:{gapTags:['python'],aligned:false},evidence:{gapSeverity:'NON_BLOCKING',gapReasons:[]}},null,null);
    eq('decision','QUALIFIED',r.decision);
    eq('rescue_category',null,r.rescueCategory);
  }
  // T5: rescue classifier — 5 gaps → full_reskill
  console.log('\nT5: 5 gaps → full_reskill');
  {global.expected++;
    const c=classifyRescue(0,{careerFit:{gapTags:['python','sql','ml','devops','kubernetes'],aligned:false}},'Senior Python Engineer','Software Engineer');
    eq('category','full_reskill',c.category);
    if(c.relatedJobs && c.relatedJobs.length>0)ok(`related jobs: ${c.relatedJobs.length}`);else fail('related jobs');
  }
  // T6: rescue classifier — 2 gaps → preferred-skill-upskill
  console.log('\nT6: 2 gaps → preferred-skill-upskill');
  {global.expected++;
    const c=classifyRescue(0,{careerFit:{gapTags:['python','sql'],aligned:false}},'Senior Python Engineer','Software Engineer');
    eq('category','preferred-skill-upskill',c.category);
    if(c.reskillSuggestions && c.reskillSuggestions.length>0)ok(`suggestions: ${c.reskillSuggestions.length}`);else fail('suggestions');
  }
  // T7: rescue classifier — title mismatch → role-alternative
  console.log('\nT7: title mismatch → role-alternative');
  {global.expected++;
    const c=classifyRescue(0,{careerFit:{gapTags:[],aligned:true}},{title:'Data Scientist'},{headline:'Software Engineer',experienceYears:null});
    eq('category','role-alternative',c.category);
  }
  // T8: rescue classifier — same title, exp mismatch → experience-tweak
  console.log('\nT8: same title, junior exp → experience-tweak');
  {global.expected++;
    const profile={headline:'Senior Python Engineer',experienceYears:1};
    const c=classifyRescue(0,{careerFit:{gapTags:[],aligned:true}},{title:'Senior Python Engineer'},profile);
    eq('category','experience-tweak',c.category);
  }
  // T9: isNearMiss helper
  console.log('\nT9: isNearMiss helper');
  {global.expected++;
    ok('54 in range:',isNearMiss(54));
    ok('61 in range:',isNearMiss(61));
    ok('75 out of range:',!isNearMiss(75));
    ok('30 out of range:',!isNearMiss(30));
    ok('0 out of range:',!isNearMiss(0));
  }
  console.log('\n'+'='.repeat(50));
  console.log(`Results: passed, ${global.failed} failed, ${global.expected} expected`);
  if(global.failed>0){console.log(`FAIL: ${global.failed} of ${global.expected} checks failed`);process.exit(1);}
  console.log(`PASS: all ${global.expected} checks passed`);
  process.exit(0);
}
run().catch(e=>{console.error(e);process.exit(1);});
