#!/usr/bin/env node
'use strict';
// JA-040 — Channel learning
// Pure function test — no DB required.
const fs = require('fs'); const path = require('path');
function load(r){const p=path.join(__dirname,'..','dist',r);if(!fs.existsSync(p)){console.error(`LOAD FAIL ${p}`);return null;}try{return require(p);}catch(e){return null;}}
function ok(l){console.log(`  ✔ ${l}`);} function fail(l){console.log(`  ✘ ${l}`);global.failed++;}
function eq(l,g,w){if(JSON.stringify(g)===JSON.stringify(w))ok(l);else fail(`${l}: got ${JSON.stringify(g)} want ${JSON.stringify(w)}`);}
global.expected=0;global.failed=0;

const S = load('job-application/channel-learning.service.js');
if (!S) { console.error('FATAL'); process.exit(1); }
const service = new S.ChannelLearningService();

function outcome(overrides={}){
  return {
    id: overrides.id || 'o1',
    channel: overrides.channel || 'ats',
    status: overrides.status || 'applied',
    appliedAt: overrides.appliedAt || new Date().toISOString(),
    rejectedAt: overrides.rejectedAt || null,
    interviewedAt: overrides.interviewedAt || null,
    offeredAt: overrides.offeredAt || null,
    acceptedAt: overrides.acceptedAt || null,
    ...overrides,
  };
}

async function run(){
  // T1: Record outcome
  console.log('\nT1: Record outcome');
  {global.expected++;
    const o = await service.recordOutcome(outcome({channel:'ats', status:'interview'}));
    ok('recordedAt present', o.recordedAt && o.recordedAt.length > 0);
    eq('channel','ats',o.channel);
    eq('status','interview',o.status);
  }

  // T2: Compute stats — ATS channel
  console.log('\nT2: Compute stats for ATS channel');
  {global.expected++;
    const outcomes = [
      outcome({channel:'ats', status:'applied'}),
      outcome({channel:'ats', status:'applied'}),
      outcome({channel:'ats', status:'interview'}),
      outcome({channel:'ats', status:'rejected'}),
    ];
    const stats = service.computeStats(outcomes);
    eq('channel','ats',stats[0].channel);
    eq('appliedCount',2,stats[0].appliedCount);
    eq('interviewCount',1,stats[0].interviewCount);
    eq('offerCount',0,stats[0].offerCount);
    eq('rejectionCount',1,stats[0].rejectionCount);
  }

  // T3: Compute stats — multiple channels
  console.log('\nT3: Compute stats for multiple channels');
  {global.expected++;
    const outcomes = [
      outcome({channel:'ats', status:'interview'}),
      outcome({channel:'ats', status:'rejected'}),
      outcome({channel:'recruiter', status:'offer'}),
      outcome({channel:'recruiter', status:'applied'}),
      outcome({channel:'easy_apply', status:'applied'}),
    ];
    const stats = service.computeStats(outcomes);
    eq('stat count',3,stats.length);
    eq('top channel','recruiter',stats[0].channel); // recruiter has offer
    eq('effectiveness',0.6666666666666666,stats[0].effectivenessScore);
  }

  // T4: Select channel with no history
  console.log('\nT4: Select channel with no history');
  {global.expected++;
    const sel = service.selectChannel([], {});
    eq('recommended','ats',sel.recommendedChannel);
    ok('scores present', sel.scores && typeof sel.scores === 'object');
    ok('rational present', sel.rational && sel.rational.length > 0);
  }

  // T5: Select channel with history — picks best
  console.log('\nT5: Select channel with history — picks best');
  {global.expected++;
    const stats = [
      {channel:'ats', appliedCount:10, interviewCount:2, offerCount:0, rejectionCount:8, interviewRate:0.2, offerRate:0, effectivenessScore:0.36},
      {channel:'recruiter', appliedCount:5, interviewCount:4, offerCount:2, rejectionCount:1, interviewRate:0.8, offerRate:0.4, effectivenessScore:1.33},
    ];
    const sel = service.selectChannel(stats, {});
    eq('recommended','recruiter',sel.recommendedChannel);
    ok('recruiter has higher score', sel.scores.recruiter > sel.scores.ats);
  }

  // T6: Effectiveness formula (interview + 2*offer) / (total + 1)
  console.log('\nT6: Effectiveness formula');
  {global.expected++;
    const outcomes = [
      outcome({channel:'referral', status:'applied'}),
      outcome({channel:'referral', status:'interview'}),
      outcome({channel:'referral', status:'offer'}),
    ];
    const stats = service.computeStats(outcomes);
    eq('stat count',1,stats.length);
    eq('channel','referral',stats[0].channel);
    // (1 interview + 2*1 offer) / (3 + 1) = 3/4 = 0.75
    eq('effectiveness',0.75,stats[0].effectivenessScore);
  }

  // T7: Empty outcomes returns empty stats
  console.log('\nT7: Empty outcomes');
  {global.expected++;
    const stats = service.computeStats([]);
    eq('stat count',0,stats.length);
  }

  // T8: Select channel with empty stats returns default
  console.log('\nT8: Select with empty stats');
  {global.expected++;
    const sel = service.selectChannel([], {role:'Software Engineer'});
    eq('recommended','ats',sel.recommendedChannel);
  }

  console.log('\n'+'='.repeat(50));
  console.log(`Results: passed, ${global.failed} failed, ${global.expected} expected`);
  if(global.failed>0){console.log(`FAIL: ${global.failed} of ${global.expected} checks failed`);process.exit(1);}
  console.log(`PASS: all ${global.expected} checks passed`);
  process.exit(0);
}
run().catch(e=>{console.error(e);process.exit(1);});
