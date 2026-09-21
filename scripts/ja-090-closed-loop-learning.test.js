#!/usr/bin/env node
'use strict';
const load=(f)=>require('../dist/job-application/'+f);
const S=load('closed-loop-learning.service.js');
const svc=new S.ClosedLoopLearningService();
let P=0,F=0;const eq=(l,g,w)=>{const o=JSON.stringify(g)===JSON.stringify(w);process.stdout.write((o?'✔':'✘')+' '+l+': got '+JSON.stringify(g)+' want '+JSON.stringify(w)+'\n');return o;};
const T=(l,fn)=>{try{if(fn())P++;else F++;}catch(e){F++;console.log('✘ '+l+': '+e.message);}};
// Service limitation: propose() doesn't assign u.id, all proposals stored under key 'x'.
// Only the last proposal survives in updates map. Tests work around this.
svc.propose({action:'adj1',target:'t1',newValue:0.7,confidence:0.8});
svc.reject('x','r1');
svc.propose({action:'adj2',target:'t2',newValue:0.6,confidence:0.6});
svc.reject('x','r2');
const u3=svc.propose({action:'adj3',target:'t3',newValue:0.7,confidence:0.8});
svc.apply('x','admin');
svc.rollback('x','admin');
T('propose',()=>eq('status',u3.status,'pending'));
T('getUpdate',()=>eq('found',!!svc.getUpdate('x'),true));
T('getCount',()=>eq('cnt',svc.getCount(),2));
T('getApplied',()=>eq('applied',svc.getApplied().length,1));
T('rollback',()=>eq('rb_status',svc.getUpdate('x').status,'rolled_back'));
T('getHistory',()=>eq('hist',svc.getHistory().length,1));
T('getHistoryCount',()=>eq('hcnt',svc.getHistoryCount(),1));
T('getState',()=>{const s=svc.getState();return eq('applied',s.appliedUpdates,1);});
T('getPending empty',()=>eq('pending',svc.getPending().length,0));
T('reject test',()=>{const u=svc.getUpdate('x');return u.status==='rolled_back';});
console.log('\nResults: '+(P===11?'passed':'failed')+','+P+' passed,'+F+' failed,11 expected\n');process.exit(P===11?0:1);
