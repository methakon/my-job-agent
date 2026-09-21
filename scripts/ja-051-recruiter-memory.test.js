#!/usr/bin/env node
'use strict';
const fs=require('fs'); const path=require('path');
function load(r){const p=path.join(__dirname,'..','dist',r);if(!fs.existsSync(p)){console.error('LOAD FAIL '+p);return null;}try{return require(p);}catch(e){console.error('LOAD ERROR '+r+':',e.message);return null;}}
function ok(l){console.log('  ✔ '+l);} function fail(l){console.log('  ✘ '+l);global.failed++;}
function eq(l,g,w){if(JSON.stringify(g)===JSON.stringify(w))ok(l);else fail(l+': got '+JSON.stringify(g)+' want '+JSON.stringify(w));}
global.expected=0;global.failed=0;
const S=load('job-application/recruiter-memory.service.js');
if(!S){console.error('FATAL');process.exit(1);}
const svc=new S.RecruiterMemoryService();
function contact(o={}){return{id:o.id||undefined,recruiterName:o.recruiterName||'John Doe',recruiterEmail:o.recruiterEmail||undefined,employerName:o.employerName||'Tech Corp',employerDomain:o.employerDomain||undefined,channels:o.channels||['email'],firstContacted:o.firstContacted||new Date().toISOString(),lastContacted:o.lastContacted||new Date().toISOString(),contactCount:o.contactCount||0,responseCount:o.responseCount||0,lastResponse:o.lastResponse||undefined,responseRate:o.responseRate||0,notes:o.notes||undefined,};}
async function run(){
  console.log('\nT1: recordContact');{global.expected++;const c=svc.recordContact(contact({recruiterName:'John',employerName:'Tech'}));eq('name',c.recruiterName,'John');eq('employer',c.employerName,'Tech');eq('count',c.contactCount,1);ok('firstContacted present',!!c.firstContacted);ok('lastContacted present',!!c.lastContacted);}
  console.log('\nT2: getContact');{global.expected++;const c=svc.getContact('John','Tech');ok('exists',!!c);eq('name',c.recruiterName,'John');}
  console.log('\nT3: duplicate key increments');{global.expected++;const c=svc.recordContact(contact({recruiterName:'John',employerName:'Tech'}));eq('count',c.contactCount,2);}
  console.log('\nT4: recordResponse');{global.expected++;const c=svc.recordContact(contact({recruiterName:'Jane',employerName:'Startup'}));const u=svc.recordResponse(c.id,'Interested');ok('updated',!!u);eq('respCount',u.responseCount,1);ok('respRate is 1',u.responseRate===1);ok('lastResp',u.lastResponse.includes('Interested'));}
  console.log('\nT5: no prior contact');{global.expected++;const r=svc.recommendOutreach('New','NewCo');eq('shouldContact',r.shouldContact,true);eq('rec',r.recommendation,'contact');eq('daysSince',r.daysSinceContact,Infinity);}
  console.log('\nT6: too soon');{global.expected++;const past=new Date(Date.now()-2*24*60*60*1000).toISOString();const c=svc.recordContact(contact({recruiterName:'Recent',employerName:'RecentCo',lastContacted:past}));const r=svc.recommendOutreach('Recent','RecentCo',7);eq('shouldContact',r.shouldContact,false);eq('rec',r.recommendation,'wait');ok('duplicate',r.duplicateOutreach);}
  console.log('\nT7: high-response contact (far past, no recordResponse)');{global.expected++;const c=svc.recordContact(contact({recruiterName:'Responsive',employerName:'GoodCo',contactCount:10,responseCount:8,lastContacted:new Date(Date.now()-14*24*60*60*1000).toISOString(),responseRate:8/10}));const r=svc.recommendOutreach('Responsive','GoodCo',7);eq('shouldContact',r.shouldContact,true);eq('rec',r.recommendation,'contact');ok('has rate',r.reason.includes('0.80'));}
  console.log('\nT8: listContacts has entries');{global.expected++;const list=svc.listContacts();ok('has John',list.some(c=>c.recruiterName==='John'));ok('has Jane',list.some(c=>c.recruiterName==='Jane'));ok('has Recent',list.some(c=>c.recruiterName==='Recent'));ok('has Responsive',list.some(c=>c.recruiterName==='Responsive'));ok('has ListTest',list.some(c=>c.recruiterName==='ListTest'));}
  console.log('\nT9: getContactCount');{global.expected++;eq('count',svc.getContactCount(),4);}
  console.log('\nT10: contactCount increments');{global.expected++;const c=svc.recordContact(contact({recruiterName:'CountTest',employerName:'CountCo'}));eq('c1',c.contactCount,1);svc.recordContact(contact({recruiterName:'CountTest',employerName:'CountCo'}));const c2=svc.getContact('CountTest','CountCo');eq('c2',c2.contactCount,2);}
  console.log('\nT11: responseRate via recordResponse');{global.expected++;const c=svc.recordContact(contact({recruiterName:'RateTest',employerName:'RateCo',contactCount:5}));svc.recordResponse(c.id,'R1');svc.recordResponse(c.id,'R2');const u=svc.getContact('RateTest','RateCo');ok('rate',u.responseRate===0.4);}
  console.log('\nT12: null safety');{global.expected++;const c=svc.recordContact({});ok('name default',c.recruiterName==='Unknown');ok('emp default',c.employerName==='Unknown');eq('count',c.contactCount,1);}
  console.log('\n'+'='.repeat(50));
  console.log('Results: passed, '+global.failed+' failed, '+global.expected+' expected');
  if(global.failed>0){console.log('FAIL: '+global.failed+' of '+global.expected+' checks failed');process.exit(1);}
  console.log('PASS: all '+global.expected+' checks passed');
  process.exit(0);
}
run().catch(e=>{console.error(e);process.exit(1);});
