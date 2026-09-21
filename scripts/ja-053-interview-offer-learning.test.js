#!/usr/bin/env node
'use strict';
const load=(f)=>require('../dist/job-application/'+f);
const S=load('interview-offer-learning.service.js');
const svc=new S.InterviewOfferLearningService();
let P=0,F=0;const eq=(l,g,w)=>{const o=JSON.stringify(g)===JSON.stringify(w);process.stdout.write((o?'✔':'✘')+' '+l+': got '+JSON.stringify(g)+' want '+JSON.stringify(w)+'\n');return o;};
const T=(l,fn)=>{try{if(fn())P++;else F++;}catch(e){F++;console.log('✘ '+l+': '+e.message);}};

const rec1=svc.record({applicationId:'a1',recName:'Jane',employerName:'TechCo',stage:'screening'});
const id1=rec1.id;
svc.addStage(id1,'screening');
svc.recordOffer(id1,120000);
svc.recordReject(id1,'filled');

const rec2=svc.record({applicationId:'a2',stage:'screening'});
svc.addStage(rec2.id,'screening');
svc.recordOffer(rec2.id,100000);
svc.recordReject('a1','x');

T('record',()=>svc.addStage(id1,'screening')&&eq('id',!!id1,true)&&eq('stage',svc.get(id1).currentStage,'screening'));
T('addStage',()=>{svc.addStage(id1,'technical');const g=svc.get(id1);return eq('stages',g.stages.length,2)&&eq('current',g.currentStage,'technical');});
T('offer',()=>eq('offered',svc.get(id1).offerReceivedAt!==undefined,true));
T('reject',()=>eq('rejected',svc.get(id1).notes,'filled'));
T('get',()=>eq('found',!!svc.get(id1),true));
T('count',()=>eq('count',svc.getCount(),2));
T('aggregate',()=>{const a=svc.aggregate();return eq('total',a.interviewCount,2);});
T('empty',()=>eq('empty',svc.get('unknown'),undefined));
console.log('\nResults: '+(P===8?'passed':'failed')+','+P+' passed,'+F+' failed,8 expected\n');process.exit(P===8?0:1);
