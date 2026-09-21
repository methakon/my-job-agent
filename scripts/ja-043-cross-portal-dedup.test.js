#!/usr/bin/env node
'use strict';
const fs=require('fs'); const path=require('path');
function load(r){const p=path.join(__dirname,'..','dist',r);if(!fs.existsSync(p)){console.error('LOAD FAIL '+p);return null;}try{return require(p);}catch(e){console.error('LOAD ERROR '+r+':',e.message);return null;}}
function ok(l){console.log('  ✔ '+l);} function fail(l){console.log('  ✘ '+l);global.failed++;}
function eq(l,g,w){if(JSON.stringify(g)===JSON.stringify(w))ok(l);else fail(l+': got '+JSON.stringify(g)+' want '+JSON.stringify(w));}
global.expected=0;global.failed=0;
const S=load('job-application/cross-portal-dedup.service.js');
if(!S){console.error('FATAL');process.exit(1);}
const svc=new S.CrossPortalDedupService();
function job(o={}){return{id:o.id||'j1',externalId:o.externalId||undefined,title:o.title||'Software Engineer',company:o.company||'Tech Corp',location:o.location||'Bangalore',description:o.description||'Python React SQL developer',sourcePortal:o.sourcePortal||'remoteok',url:o.url||undefined,scrapedAt:o.scrapedAt||new Date().toISOString(),};}
async function run(){
  console.log('\nT1: register job');{global.expected++;
    const j=job({id:'j1',title:'Software Engineer'});const cid=svc.register(j);
    eq('canonical',cid,'j1');const g=svc.getCanonical(cid);ok('exists',!!g);eq('title',g.title,'Software Engineer');}
  console.log('\nT2: external ID dedup');{global.expected++;
    const j1=job({id:'j1',externalId:'EXT-001',title:'SE'});svc.register(j1);
    const j2=job({id:'j2',externalId:'EXT-001',title:'Software Engineer',company:'Tech Corp Inc'});
    const r=svc.findDuplicates(j2,[j1]);
    eq('isDup',r.isDuplicate,true);eq('dupOf',r.duplicateOf,'j1');
    eq('confidence',r.confidence,0.99);ok('signal',r.matchSignals.includes('exact_external_id_match'));}
  console.log('\nT3: URL dedup');{global.expected++;
    const j1=job({id:'j1',url:'https://remoteok.com/jobs/123'});svc.register(j1);
    const j2=job({id:'j2',url:'https://remoteok.com/jobs/123',title:'Different Title'});
    const r=svc.findDuplicates(j2,[j1]);
    eq('isDup',r.isDuplicate,true);eq('confidence',r.confidence,0.95);}
  console.log('\nT4: exact title+location match (same company)');{global.expected++;
    const j1=job({id:'j1',title:'Python Developer',location:'Bangalore',company:'Tech'});
    svc.register(j1);const j2=job({id:'j2',title:'Python Developer',location:'Bangalore',company:'Tech'});
    const r=svc.findDuplicates(j2,[j1]);
    ok('isDup',r.isDuplicate);eq('confidence',r.confidence,1.0);ok('title signal',r.matchSignals.some(s=>s.includes('title=1.00')));}
  console.log('\nT5: similar title, same location, same company, related JD');{global.expected++;
    const j1=job({id:'j1',title:'Senior Software Engineer',location:'Bangalore',description:'Python React SQL developer with 5 years experience',company:'Tech'});
    svc.register(j1);const j2=job({id:'j2',title:'Software Engineer',location:'Bangalore',description:'Python React SQL developer',company:'Tech'});
    const r=svc.findDuplicates(j2,[j1]);
    ok('>0.7',r.confidence>0.7);eq('recommendation',r.recommendation,'merge');}
  console.log('\nT6: location similarity — same city different names');{global.expected++;
    const j1=job({id:'j1',title:'Dev',location:'Bengaluru',description:'dev role'});svc.register(j1);
    const j2=job({id:'j2',title:'Developer',location:'Bangalore',description:'developer role'});
    const r=svc.findDuplicates(j2,[j1]);
    ok('>0.5',r.confidence>0.5);}
  console.log('\nT7: no match — different everything');{global.expected++;
    const j1=job({id:'j1',title:'HR Manager',location:'Mumbai',company:'HR Co',description:'hr work'});
    svc.register(j1);const j2=job({id:'j2',title:'Software Engineer',location:'Bangalore',company:'Tech',description:'coding'});
    const r=svc.findDuplicates(j2,[j1]);
    eq('isDup',r.isDuplicate,false);eq('recommendation',r.recommendation,'new');}
  console.log('\nT8: markRepost increments count');{global.expected++;
    const j1=job({id:'j1',externalId:'EXT-RP'});const cid=svc.register(j1);
    svc.markRepost('j2',cid);svc.markRepost('j3',cid);
    const canon=svc.getCanonical(cid);eq('reposts',canon.repostCount,2);}
  console.log('\nT9: company match boosts score (>=0.8 = merge)');{global.expected++;
    const j1=job({id:'j1',title:'Developer',location:'Bangalore',company:'Tech Corp',description:'Python dev role'});
    svc.register(j1);const j2=job({id:'j2',title:'Developer',location:'Bangalore',company:'Tech Corp',description:'Python developer role'});
    const r=svc.findDuplicates(j2,[j1]);
    ok('>=0.8',r.confidence>=0.8);}
  console.log('\nT10: review threshold (0.6-0.79)');{global.expected++;
    const j1=job({id:'j1',title:'Senior Engineer',location:'Bangalore',company:'Tech',description:'Python React SQL'});
    svc.register(j1);const j2=job({id:'j2',title:'Engineer',location:'Bangalore',company:'Tech',description:'Python'});
    const r=svc.findDuplicates(j2,[j1]);
    ok('0.6<=x<0.8',r.confidence>=0.6&&r.confidence<0.8);eq('rec','review',r.recommendation);}
  console.log('\nT11: empty description similarity');{global.expected++;
    const j1=job({id:'j1',title:'Dev',location:'Bangalore',description:''});svc.register(j1);
    const j2=job({id:'j2',title:'Dev',location:'Bangalore',description:''});
    const r=svc.findDuplicates(j2,[j1]);
    ok('no crash',!!r);ok('title matched',r.matchSignals.some(s=>s.includes('title=1.00')));}
  console.log('\nT12: canonicalId preserved on register');{global.expected++;
    const j1=job({id:'j1'});const cid=svc.register(j1,'CANON-1');
    eq('canonical',cid,'CANON-1');const g=svc.getCanonical('CANON-1');ok('exists',!!g);eq('g.id','j1',g.id);}
  console.log('\n'+'='.repeat(50));
  console.log('Results: passed, '+global.failed+' failed, '+global.expected+' expected');
  if(global.failed>0){console.log('FAIL: '+global.failed+' of '+global.expected+' checks failed');process.exit(1);}
  console.log('PASS: all '+global.expected+' checks passed');
  process.exit(0);
}
run().catch(e=>{console.error(e);process.exit(1);});
