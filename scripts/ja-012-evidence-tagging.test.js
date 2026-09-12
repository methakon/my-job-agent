#!/usr/bin/env node
/**
 * JA-012 — explicit vs inferred evidence tagging (non-regression)
 *
 * doneWhen: "Same JD produces a stable representation traceable to source text
 * or labelled inference."
 */

'use strict';

const assert = require('assert');
const path = require('path');

const DIST = path.join(__dirname, '..', 'dist');

function loadModule(relPath) {
  try { return require(path.join(DIST, relPath)); }
  catch (e) { return null; }
}

const jdiRaw = loadModule('job-application/jd-intent.service.js');
if (!jdiRaw) { console.error('MODULE LOAD FAIL'); process.exit(1); }
const JdIntentService = jdiRaw.JdIntentService;
if (!JdIntentService) { console.error('CLASS NOT FOUND'); process.exit(1); }

const svc = new JdIntentService();
async function extract(jdText, meta) { return svc.extract(jdText, meta); }

describe('JA-012 — evidence tagging integrity', () => {

  it('skills parsed from range text carry explicit evidence', async () => {
    const r = await extract(`Senior Engineer
Required: 5+ years of experience with TypeScript, Node.js, PostgreSQL.`);
    for (const s of r.mustHaveSkills) {
      assert.strictEqual(
        s.evidence.evidence,
        'explicit',
        'explicit JD skill should carry explicit evidence: ' + s.name + ' (got ' + s.evidence.evidence + ')'
      );
    }
  });

  it('compensation parsed from range text carries explicit evidence', async () => {
    const r = await extract(`Senior Engineer
CTC: 20-25 LPA. Apply at careers@example.com.`);
    for (const field of ['minCtc', 'maxCtc', 'currencyHint']) {
      const ev = r.compensation.evidence;
      assert.strictEqual(ev.evidence, 'explicit', 'compensation evidence must remain explicit (field ' + field + ')');
    }
  });

});

process.on('unhandledRejection', (err) => { console.error('UNHANDLED:', err); process.exit(1); });
