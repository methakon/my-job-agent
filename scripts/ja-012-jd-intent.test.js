#!/usr/bin/env node
/**
 * JA-012 — JD Intent Extraction: deterministic/replayable
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
if (!jdiRaw) {
  console.error('MODULE LOAD FAIL — jd-intent.service.js not compiled');
  console.error('dist/ contents:');
  try {
    const entries = require('fs').readdirSync(DIST, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) {
        try {
          const subs = require('fs').readdirSync(path.join(DIST, e.name));
          console.error('  ' + e.name + '/: ' + subs.join(', '));
        } catch {}
      } else {
        console.error('  ' + e.name);
      }
    }
  } catch (e) { console.error('  (cannot list dist)'); }
  process.exit(1);
}

const JdIntentService = jdiRaw.JdIntentService;
if (!JdIntentService) {
  console.error('CLASS NOT FOUND — JdIntentService absent from compiled module');
  process.exit(1);
}

const svc = new JdIntentService();

async function extract(jdText, meta) {
  return svc.extract(jdText, meta);
}

describe('JA-012 — JD Intent Extraction', () => {

  it('1 — fingerprint stability: same JD → same fingerprint', async () => {
    const jd = `Senior Backend Engineer
We are looking for a senior backend engineer to join our team.
Required: 5+ years of experience with Python, Django, PostgreSQL.
Location: Remote (US). Full-time. Immediate joiners only.
Salary: 20-25 LPA. Apply at careers@example.com.`;
    const r1 = await extract(jd);
    const r2 = await extract(jd);
    assert.strictEqual(r1.fingerprint, r2.fingerprint, 'fingerprint must be stable across identical JDs');
  });

  it('2 — role title extraction', async () => {
    const r = await extract(`Senior Backend Engineer
We are hiring a senior backend engineer to build our API platform.
Required: 5+ years Python, Django, PostgreSQL.`);
    assert.ok(r.roleTitle, 'role title should be extracted');
    assert.ok(r.roleTitle.toLowerCase().includes('senior'), 'should preserve seniority in title');
  });

  it('3 — explicit seniority extraction', async () => {
    const r = await extract(`Junior Frontend Developer
Must have 0-2 years experience with React.`);
    assert.strictEqual(r.seniority.level, 'junior', 'should extract junior seniority from JD text');
    assert.strictEqual(r.seniority.evidence.evidence, 'explicit', 'seniority evidence should be explicit');
  });

  it('4 — inferred seniority from title words', async () => {
    const r = await extract(`We need someone to own our data platform end-to-end.`, { title: 'Lead Data Engineer' });
    assert.ok(['lead', 'senior', 'principal'].includes(r.seniority.level), 'should infer seniority from title');
  });

  it('5 — must-have skill extraction', async () => {
    const r = await extract(`Senior Engineer
Required: 5+ years of experience with TypeScript, Node.js, and PostgreSQL.
Nice to have: Kubernetes.`);
    const mustHave = r.mustHaveSkills.map(s => s.name.toLowerCase());
    assert.ok(mustHave.includes('typescript'), 'must-have should include TypeScript');
    assert.ok(mustHave.includes('node.js') || mustHave.includes('node'), 'must-have should include Node.js');
    assert.ok(mustHave.includes('postgresql'), 'must-have should include PostgreSQL');
    for (const s of r.mustHaveSkills) {
      assert.strictEqual(s.kind, 'must-have', 'all must-have skills should be tagged must-have: ' + s.name);
    }
  });

  it('6 — preferred skill extraction', async () => {
    const r = await extract(`Senior Engineer
Required: 5+ years with Python, Django.
Bonus: Kubernetes certification.`);
    const preferred = r.preferredSkills.map(s => s.name.toLowerCase());
    assert.ok(preferred.includes('kubernetes'), 'preferred skills should include Kubernetes (bonus)');
    assert.strictEqual(r.preferredSkills[0].kind, 'preferred', 'preferred skills should be tagged preferred');
  });

  it('7 — experience extraction (single number)', async () => {
    const r = await extract(`Senior Engineer
Minimum 7 years of experience required.`);
    assert.strictEqual(r.experience.minYears, 7, 'should extract min 7 years');
    assert.strictEqual(r.experience.evidence.evidence, 'explicit', 'experience evidence should be explicit');
  });

  it('8 — experience range extraction', async () => {
    const r = await extract(`Mid-Level Engineer
3-5 years of experience required.`);
    assert.strictEqual(r.experience.minYears, 3, 'min should be 3');
    assert.strictEqual(r.experience.maxYears, 5, 'max should be 5');
  });

  it('9 — responsibilities extraction', async () => {
    const r = await extract(`Senior Engineer
Your responsibilities:
- Design and build scalable APIs
- Mentor junior engineers
- Write clean, maintainable code`);
    assert.ok(r.responsibilities.length >= 2, 'should extract at least 2 responsibilities');
    assert.ok(r.responsibilities.some(s => s.text.toLowerCase().includes('api')), 'should include API responsibility');
    assert.strictEqual(r.responsibilities[0].evidence.evidence, 'explicit', 'responsibility evidence should be explicit');
  });

  it('10 — location extraction (hybrid)', async () => {
    const r = await extract(`Senior Engineer
Location: Bangalore, India. Hybrid, 3 days in office.`);
    assert.ok(r.location.raw, 'should extract location raw');
    assert.strictEqual(r.location.remoteAllowed, false, 'hybrid should set remoteAllowed = false');
    assert.strictEqual(r.location.evidence.evidence, 'explicit', 'location evidence should be explicit');
  });

  it('11 — remote extraction', async () => {
    const r = await extract(`Senior Engineer
Location: Remote (US). Remote-first company.`);
    assert.strictEqual(r.location.remoteAllowed, true, 'remote-first should set remoteAllowed = true');
  });

  it('12 — employment type extraction', async () => {
    const r = await extract(`Contract Developer
Part-time contract role for 6 months.`);
    assert.strictEqual(r.employmentType.kind, 'part-time', 'should extract part-time from contract description');
    assert.strictEqual(r.employmentType.evidence.evidence, 'explicit', 'employment type evidence should be explicit');
  });

  it('13 — full-time extraction', async () => {
    const r = await extract(`Senior Engineer
Full-time position with competitive salary.`);
    assert.strictEqual(r.employmentType.kind, 'full-time', 'should extract full-time');
  });

  it('14 — compensation extraction', async () => {
    const r = await extract(`Senior Engineer
CTC: 20-25 LPA. Apply at careers@example.com.`);
    assert.strictEqual(r.compensation.minCtc, 20, 'min CTC should be 20');
    assert.strictEqual(r.compensation.maxCtc, 25, 'max CTC should be 25');
    assert.ok(r.compensation.currencyHint, 'currency hint should be present');
    assert.strictEqual(r.compensation.evidence.evidence, 'explicit', 'compensation evidence should be explicit');
  });

  it('15 — authorization extraction (citizens only)', async () => {
    const r = await extract(`Senior Engineer
US citizens only. No sponsorship.`);
    assert.strictEqual(r.authorization.required, true, 'authorization should be required');
    assert.strictEqual(r.authorization.kind, 'citizen', 'should detect citizen-only requirement');
    assert.strictEqual(r.authorization.evidence.evidence, 'explicit', 'authorization evidence should be explicit');
  });

  it('16 — sponsorship available', async () => {
    const r = await extract(`Senior Engineer
We sponsor visas for the right candidate.`);
    assert.strictEqual(r.authorization.required, true, 'visa sponsorship should be flagged as required');
    assert.strictEqual(r.authorization.kind, 'sponsorship', 'should detect sponsorship requirement');
  });

  it('17 — notice extraction (immediate)', async () => {
    const r = await extract(`Junior Engineer
Immediate joiners only. Start date: day 1.`);
    assert.strictEqual(r.notice.kind, 'immediate', 'should detect immediate join requirement');
    assert.strictEqual(r.notice.days, 0, 'immediate should set days = 0');
    assert.strictEqual(r.notice.evidence.evidence, 'explicit', 'notice evidence should be explicit');
  });

  it('18 — notice extraction (notice period)', async () => {
    const r = await extract(`Senior Engineer
30 days notice required before joining.`);
    assert.strictEqual(r.notice.kind, 'notice', 'should detect notice period requirement');
    assert.strictEqual(r.notice.days, 30, 'should parse 30 days notice');
  });

  it('19 — tech domain extraction', async () => {
    const r = await extract(`Senior Engineer
Experience with TypeScript, React, Node.js, and AWS.
Work on our SaaS platform.`);
    assert.ok(r.techDomain.technologies.length >= 3, 'should extract at least 3 technologies');
    assert.ok(r.techDomain.technologies.some(t => t.toLowerCase() === 'typescript'), 'should include TypeScript');
    assert.strictEqual(r.techDomain.domain, 'saas', 'should extract SaaS domain');
    assert.strictEqual(r.techDomain.evidence.evidence, 'explicit', 'tech domain evidence should be explicit');
  });

  it('20 — channel extraction (ATS)', async () => {
    const r = await extract(`Senior Engineer
Apply via Greenhouse.`);
    assert.strictEqual(r.channel.kind, 'ats', 'should detect Greenhouse as ATS channel');
    assert.strictEqual(r.channel.evidence.evidence, 'explicit', 'channel evidence should be explicit');
  });

  it('21 — channel extraction (email)', async () => {
    const r = await extract(`Senior Engineer
Send your CV to careers@example.com.`);
    assert.strictEqual(r.channel.kind, 'email', 'should detect email channel');
    assert.strictEqual(r.channel.target, 'careers@example.com', 'should extract email target');
    assert.strictEqual(r.channel.evidence.evidence, 'explicit', 'channel evidence should be explicit');
  });

  it('22 — employer extraction', async () => {
    const r = await extract(`Acme Corp is hiring a senior engineer.`, { company: 'Acme Corp' });
    assert.strictEqual(r.employer.name, 'Acme Corp', 'should extract employer name from meta');
    assert.strictEqual(r.employer.evidence.evidence, 'explicit', 'employer evidence should be explicit');
  });

  it('23 — freshness extraction', async () => {
    const r = await extract(`Senior Engineer
Posted 3 days ago.`);
    assert.strictEqual(r.freshness.ageDays, 3, 'should parse 3 days ago');
    assert.strictEqual(r.freshness.evidence.evidence, 'explicit', 'freshness evidence should be explicit');
  });

  it('24 — original text preservation', async () => {
    const jd = `Senior Engineer
Required: 5+ years Python, Django, PostgreSQL.`;
    const r = await extract(jd);
    assert.strictEqual(r.originalText, jd, 'original JD text must be preserved verbatim');
  });

  it('25 — explicit vs inferred evidence tagging', async () => {
    const r = await extract(`Senior Engineer`);
    assert.ok(r.seniority.evidence.evidence === 'explicit' || r.seniority.evidence.evidence === 'inferred', 'seniority evidence should be tagged');
    assert.ok(r.employer.evidence.evidence === 'explicit' || r.employer.evidence.evidence === 'inferred', 'employer evidence should be tagged');
    assert.ok(r.techDomain.evidence.evidence === 'explicit' || r.techDomain.evidence.evidence === 'inferred', 'tech domain evidence should be tagged');
    const richR = await extract(`Senior Engineer
Required: 5+ years of experience with TypeScript, Node.js, PostgreSQL.`);
    for (const s of richR.mustHaveSkills) {
      assert.strictEqual(s.evidence.evidence, 'explicit', 'explicit JD skill should carry explicit evidence: ' + s.name);
    }
  });

});
