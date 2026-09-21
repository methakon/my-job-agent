#!/usr/bin/env node
'use strict';
const fs=require('fs'); const path=require('path');
function load(r){const p=path.join(__dirname,'..','dist',r);if(!fs.existsSync(p)){console.error('LOAD FAIL '+p);return null;}try{return require(p);}catch(e){console.error('LOAD ERROR '+r+':',e.message);return null;}}
function ok(l){console.log('  ✔ '+l);} function fail(l){console.log('  ✘ '+l);global.failed++;}
function eq(l,g,w){if(JSON.stringify(g)===JSON.stringify(w))ok(l);else fail(l+': got '+JSON.stringify(g)+' want '+JSON.stringify(w));}
global.expected=0;global.failed=0;
const S=load('job-application/browser-field-mapping.service.js');
if(!S){console.error('FATAL');process.exit(1);}
function form(o={}){return{portalName:o.portalName||'remoteok',formId:o.formId||'job-form',fieldNames:o.fieldNames||['name','email','resume'],fieldTypes:o.fieldTypes||{},actionUrl:o.actionUrl||'',};}
async function run(){
  console.log('\nT1: generateSignature');{global.expected++;
    const svc=new S.BrowserFieldMappingService();const f=form({portalName:'Indeed',fieldNames:['email','name','resume']});
    eq('sig',svc.generateSignature(f),'Indeed|job-form|email|name|resume');}
  console.log('\nT2: learnMapping');{global.expected++;
    const svc=new S.BrowserFieldMappingService();const f=form({portalName:'RemoteOK',fieldNames:['name','email']});
    const s=svc.generateSignature(f);const m=svc.learnMapping(s,{name:'full_name',email:'email_addr'},'RemoteOK');
    eq('portal',m.portalName,'RemoteOK');eq('sig',m.formSignature,s);eq('count',m.mappingCount,2);eq('status',m.validationStatus,'valid');}
  console.log('\nT3: validateForm all mapped');{global.expected++;
    const svc=new S.BrowserFieldMappingService();const f={portalName:'RemoteOK',formId:'job-form',fieldNames:['name','email','resume_url']};
    const s=svc.generateSignature(f);svc.learnMapping(s,{name:'full_name',email:'email_addr','resume_url':'resume'},'RemoteOK');
    const r=svc.validateForm(f,s);eq('status',r.status,'valid');
    eq('mapped',Object.keys(r.mapped).length,3);eq('unmapped',r.unmapped.length,0);}
  console.log('\nT4: validateForm partial');{global.expected++;
    const svc=new S.BrowserFieldMappingService();const f={portalName:'RemoteOK',formId:'job-form',fieldNames:['name','email','phone']};
    const s=svc.generateSignature(f);svc.learnMapping(s,{name:'full_name',email:'email_addr'},'RemoteOK');
    const r=svc.validateForm(f,s);eq('status',r.status,'partial');eq('unmapped',r.unmapped,['phone']);}
  console.log('\nT5: validateForm changed (different formId)');{global.expected++;
    const svc=new S.BrowserFieldMappingService();
    const fLearn={portalName:'RemoteOK',formId:'job-form',fieldNames:['name','email']};
    const sLearn=svc.generateSignature(fLearn);
    svc.learnMapping(sLearn,{name:'full_name',email:'email_addr'},'RemoteOK');
    const fVal={portalName:'RemoteOK',formId:'new-form',fieldNames:['name','email']};
    const r=svc.validateForm(fVal,sLearn);
    eq('status',r.status,'changed');ok('notes changed',r.notes.toLowerCase().includes('changed'));}
  console.log('\nT6: validateForm unknown');{global.expected++;
    const svc=new S.BrowserFieldMappingService();const f=form({portalName:'UnknownPortal'});
    const r=svc.validateForm(f,'nonexistent');eq('status',r.status,'unknown');
    ok('no known',r.notes.toLowerCase().includes('no known'));}
  console.log('\nT7: unmapped fields');{global.expected++;
    const svc=new S.BrowserFieldMappingService();const f={portalName:'X',formId:'f',fieldNames:['a','b','c']};
    const s=svc.generateSignature(f);svc.learnMapping(s,{a:'A'},'X');const r=svc.validateForm(f,s);
    eq('unmapped_count',r.unmapped.length,2);ok('b in unmapped',r.unmapped.includes('b'));
    ok('c in unmapped',r.unmapped.includes('c'));}
  console.log('\nT8: getMapping');{global.expected++;
    const svc=new S.BrowserFieldMappingService();const f=form({portalName:'RemoteOK',fieldNames:['name','email']});
    const s=svc.generateSignature(f);svc.learnMapping(s,{name:'full_name',email:'email_addr'},'RemoteOK');
    const m=svc.getMapping(s);ok('exists',!!m);eq('portal',m.portalName,'RemoteOK');}
  console.log('\nT9: getMappingCount');{global.expected++;
    const svc=new S.BrowserFieldMappingService();eq('count0',svc.getMappingCount(),0);
    svc.learnMapping(svc.generateSignature(form({portalName:'RemoteOK',fieldNames:['name','email']})),{name:'x'},'R');
    eq('count1',svc.getMappingCount(),1);}
  console.log('\nT10: empty sig');{global.expected++;
    const svc=new S.BrowserFieldMappingService();
    eq('sig',svc.generateSignature({portalName:'',formId:undefined,fieldNames:[],fieldTypes:{},actionUrl:undefined}),'default');}
  console.log('\nT11: overwrite mapping');{global.expected++;
    const svc=new S.BrowserFieldMappingService();const f=form({portalName:'RemoteOK',fieldNames:['name','email']});
    const s=svc.generateSignature(f);svc.learnMapping(s,{name:'new_name'},'NewPortal');
    const m=svc.getMapping(s);eq('portal',m.portalName,'NewPortal');eq('name',m.fieldMappings.name,'new_name');}
  console.log('\nT12: listMappings');{global.expected++;
    const svc=new S.BrowserFieldMappingService();
    svc.learnMapping(svc.generateSignature(form({portalName:'A',fieldNames:['a']})),{a:'A'},'A');
    svc.learnMapping(svc.generateSignature(form({portalName:'B',fieldNames:['b']})),{b:'B'},'B');
    const list=svc.listMappings();eq('count',list.length,2);
    ok('has A',list.some(m=>m.portalName==='A'));ok('has B',list.some(m=>m.portalName==='B'));}
  console.log('\n'+'='.repeat(50));
  console.log('Results: passed, '+global.failed+' failed, '+global.expected+' expected');
  if(global.failed>0){console.log('FAIL: '+global.failed+' of '+global.expected+' checks failed');process.exit(1);}
  console.log('PASS: all '+global.expected+' checks passed');
  process.exit(0);
}
run().catch(e=>{console.error(e);process.exit(1);});
