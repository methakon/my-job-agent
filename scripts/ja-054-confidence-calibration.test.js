#!/usr/bin/env node
'use strict';
const load=(f)=>require('../dist/job-application/'+f);
const S=load('confidence-calibration.service.js');
const svc=new S.ConfidenceCalibrationService();
let P=0,F=0;const eq=(l,g,w)=>{const o=JSON.stringify(g)===JSON.stringify(w);process.stdout.write((o?'✔':'✘')+' '+l+': got '+JSON.stringify(g)+' want '+JSON.stringify(w)+'\n');return o;};
const T=(l,fn)=>{try{if(fn())P++;else F++;}catch(e){F++;console.log('✘ '+l+': '+e.message);}};

// 3 entries initially
const e1=svc.record({predictedConfidence:0.8,predictedLabel:'positive'});
const e2=svc.record({predictedConfidence:0.9,predictedLabel:'positive'});
svc.resolve(e2.id,'positive');
const e3=svc.record({predictedConfidence:0.3,predictedLabel:'negative'});
// 3 entries, 1 resolved (e2)
T('record',()=>eq('id',!!e1.id,true));
T('resolve',()=>eq('outcome',svc.resolve(e2.id,'positive').outcome,'positive'));
T('metrics',()=>{const m=svc.computeMetrics();return eq('total',m.totalPredictions,3);});
T('count',()=>eq('count',svc.getCount(),3));
const m1=svc.computeMetrics();
T('types',()=>typeof m1.avgPredictedConfidence==='number'&&typeof m1.brierScore==='number'&&typeof m1.falsePositiveRate==='number');
T('uncertainty',()=>eq('uncertainty',m1.uncertaintyLevel,'high'));
T('calibrated',()=>eq('calibrated',m1.calibrated,false));
T('actualPosRate',()=>typeof m1.actualPositiveRate==='number');

// Add 1 more entry (total = 4) and resolve it
const eAdd=svc.record({predictedConfidence:0.7,predictedLabel:'positive'});
svc.resolve(eAdd.id,'positive');
// Now 4 entries, 2 resolved (e2, eAdd)
T('after resolve',()=>{const m=svc.computeMetrics();return eq('total',m.totalPredictions,4);});

// For low uncertainty: need 20+ resolved entries. 
// Current: 4 entries, 2 resolved. Add 18 more low-conf resolved.
for(let i=0;i<18;i++){const e=svc.record({predictedConfidence:0.5,predictedLabel:'positive'});svc.resolve(e.id,'positive');}
// Total = 4 + 18 = 22 entries, all resolved (since we resolved the 2 unresolved above? No, we didn't!)
// Wait: e1 is unresolved, e3 is unresolved. We have: e1(unres), e2(res), e3(unres), eAdd(res), 18 new(res) = 22 total, 20 resolved
// resolvedCount = 20 → >= 10 and gap < 0.15? gap = |avgConf - actualPosRate|. avgConf with 20 positives at 0.5 and e1=0.8, e3=0.3 (unresolved don't count), e2=0.9, eAdd=0.7 = ...
// Actually unresolved are NOT counted in metrics. So resolved: e2(0.9), eAdd(0.7), 18 at 0.5 = 20 entries, all positive
// avgConf = (0.9+0.7+18*0.5)/20 = (1.6+9)/20 = 10.6/20 = 0.53
// actualPosRate = 20/20 = 1.0
// gap = |0.53 - 1.0| = 0.47 > 0.15 → NOT calibrated
// But gap > 0.1 → uncertainty = 'medium'! Not 'low'!
// To get 'low' we need: resolvedCount >= 20 AND gap <= 0.1
// With all 0.5 predictions and all positive outcomes: gap = |0.5 - 1.0| = 0.5
// That's way > 0.1. 
// The only way to get gap < 0.1 with positive outcomes is to predict ~1.0 confidence.
// Or predict ~0.0 for negative outcomes.
// Let me use: predict 0.9 for positive, get positive outcomes → gap = |0.9 - 1.0| = 0.1 (borderline)
// Or predict 0.95 for positive → gap = 0.05

// Redo: resolve e1 and e3 as well, then add entries with 0.9 confidence all positive
svc.resolve(e1.id,'positive');
svc.resolve(e3.id,'positive'); // e3 was predicted negative but outcome positive → gap contribution
// Now: e1(0.8,pos), e2(0.9,pos), e3(0.3,pos), eAdd(0.7,pos), 18 new → need to redo
// Actually let me start over for the low test. Just create 20 entries with 0.95 confidence, all positive resolved.
const svc2=new S.ConfidenceCalibrationService();
for(let i=0;i<20;i++){const e=svc2.record({predictedConfidence:0.95,predictedLabel:'positive'});svc2.resolve(e.id,'positive');}
const mLow=svc2.computeMetrics();
T('uncertainty low',()=>eq('uncertainty',mLow.uncertaintyLevel,'low'));

console.log('\nResults: '+(P===10?'passed':'failed')+','+P+' passed,'+F+' failed,10 expected\n');process.exit(P===10?0:1);
