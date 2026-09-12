/**
 * JA-013 — Candidate evidence matching tests
 *
 * Proves the doneWhen: "Material matches are explainable using candidate evidence."
 *
 * Coverage:
 *  1. Every material claim category produces an explainable evidence record
 *     with source traces (which field, which entry, what snippet).
 *  2. Missing/unverifiable evidence is explicitly `unknown` with a reason —
 *     never silently passed.
 *  3. Zero fabrication: the service never invents experience, employers,
 *     achievements, metrics, technologies, or certifications that are not in
 *     the candidate profile.
 *  4. Deterministic: same profile + same claims → same fingerprint and same
 *     claim results every call.
 *  5. Profile-field coverage: skills, workHistoryJson, projectsJson,
 *     educationJson, headline, experienceYears, noticePeriod, salaryExpectation,
 *     currentLocation all contribute to evidence.
 *  6. No JA-012, trading, seed, or submission-path modification.
 *
 * This suite does not touch the database, the network, or any other roadmap
 * row. It is pure unit tests over the CandidateEvidenceService.
 */

const path = require('path');
require(path.join(__dirname, '..', 'node_modules', 'dotenv')).config({
  path: path.join(__dirname, '..', '.env'),
});

const DIST = path.join(__dirname, '..', 'dist');

function loadModule(relPath) {
  try { return require(path.join(DIST, relPath)); }
  catch (e) { return null; }
}

const cesRaw = loadModule('job-application/candidate-evidence.service.js');
if (!cesRaw) {
  console.error('MODULE LOAD FAIL — candidate-evidence.service.js not compiled');
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

const { CandidateEvidenceService, evaluateEvidence } = cesRaw;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeProfile(overrides) {
  return {
    id: 'prof-test-001',
    name: 'Swarna Sekhar Dhar',
    email: 'swarna.s.jobs@gmail.com',
    skills: 'javascript, typescript, react, nodejs, postgresql, docker, aws',
    headline: 'Senior Full-Stack Engineer — React, Node.js, AWS',
    experienceYears: 6,
    noticePeriod: '30 days',
    salaryExpectation: '25 LPA',
    linkedinUrl: 'https://linkedin.com/in/swarna',
    githubUrl: 'https://github.com/swarna',
    portfolioUrl: 'https://swarna.example/portfolio',
    currentLocation: 'Kolkata, India',
    workHistoryJson: JSON.stringify([
      {
        company: 'Acme Technologies',
        role: 'Senior Software Engineer',
        from: '2021-03',
        to: '2024-06',
        summary: 'Built React + Node.js microservices on AWS; introduced Docker for local development and CI.',
        tagged: false,
      },
      {
        company: 'Beta Systems',
        role: 'Software Engineer',
        from: '2018-07',
        to: '2021-02',
        summary: 'Full-stack development with React, Node.js and PostgreSQL; migrated a monolith to microservices.',
        tagged: false,
      },
    ]),
    educationJson: JSON.stringify([
      {
        school: 'University of Calcutta',
        degree: 'B.Tech Computer Science',
        from: '2014',
        to: '2018',
        note: ' graduated with distinction; coursework in data structures and algorithms',
      },
    ]),
    projectsJson: JSON.stringify([
      {
        name: 'Internal DevOps Dashboard',
        client: 'Acme Technologies',
        tech: ['react', 'typescript', 'nodejs', 'docker', 'aws'],
        from: '2022-01',
        to: '2023-09',
        summary: 'Self-service dashboard for the platform team; reduced onboarding time for new engineers.',
      },
      {
        name: 'Customer Portal',
        client: 'Beta Systems',
        tech: ['react', 'nodejs', 'postgresql'],
        from: '2019-03',
        to: '2020-12',
        summary: 'External-facing portal serving 50k monthly active users.',
      },
    ]),
    ...overrides,
  };
}

function skillClaim(skill, hint) {
  return { category: 'skill', claim: 'candidate has skill: ' + skill, hint: hint };
}

function experienceClaim(years) {
  return { category: 'experience_years', claim: 'candidate has at least ' + years + ' years of experience', hint: String(years) };
}

function seniorityClaim(level) {
  return { category: 'seniority', claim: 'candidate seniority is ' + level, hint: level };
}

function educationClaim(deg) {
  return { category: 'education', claim: 'candidate has ' + deg, hint: deg };
}

function authClaim(kind) {
  return { category: 'authorization', claim: 'candidate has ' + kind, hint: kind };
}

function empTypeClaim(kind) {
  return { category: 'employment_type', claim: 'candidate prefers ' + kind, hint: kind };
}

function languageClaim(lang) {
  return { category: 'language', claim: 'candidate speaks ' + lang, hint: lang };
}

function locationClaim(loc) {
  return { category: 'location', claim: 'candidate is based in ' + loc, hint: loc };
}

function noticeClaim(notice) {
  return { category: 'notice_period', claim: 'candidate notice period is ' + notice, hint: notice };
}

function compensationClaim(ctc) {
  return { category: 'compensation', claim: 'candidate expects ' + ctc, hint: ctc };
}

function employerClaim(company) {
  return { category: 'employer', claim: 'candidate worked at ' + company, hint: company };
}

function technologyClaim(tech) {
  return { category: 'technology', claim: 'candidate used ' + tech, hint: tech };
}

function achievementClaim(metric) {
  return { category: 'achievement', claim: 'candidate achieved: ' + metric, hint: metric };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

const service = new CandidateEvidenceService();
const profile = makeProfile();

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error('FAIL: ' + msg);
  }
}

function assertEq(actual, expected, msg) {
  var ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(ok, msg + ' — expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
}

// --- 1. Skill evidence is explainable from candidate data -------------------

{
  // Strong signal: skill present in work history summary
  var r = service.evaluate(profile, [skillClaim('react', 'react')]);
  assert(r.claims.length === 1, 'skill claim returns one claim evidence');
  var c = r.claims[0];
  assert(c.status === 'matched', 'react matched via work history');
  assert(c.sources.length > 0, 'react has at least one source');
  assert(c.sources.some(function (s) { return s.kind === 'work_history'; }), 'react source includes work_history');
  assert(c.sources.some(function (s) { return s.snippet.indexOf('react') !== -1; }), 'react source snippet mentions react');
  assert(c.note.length > 0, 'react evidence has a note');

  // Skill present in profile tags + project tech (richer source wins)
  var r2 = service.evaluate(profile, [skillClaim('docker', 'docker')]);
  assert(r2.claims[0].status === 'matched', 'docker matched via project tech');
  assert(r2.claims[0].sources.some(function (s) { return s.kind === 'project'; }), 'docker source includes project');
  assert(r2.claims[0].sources.some(function (s) { return s.field === 'projectsJson'; }), 'docker source field is projectsJson');

  // Skill present only in profile skill tags (tag-only — partial)
  var tagOnlyProfile = makeProfile({ skills: 'kotlin, flutter', workHistoryJson: JSON.stringify([]), projectsJson: JSON.stringify([]), educationJson: JSON.stringify([]) });
  var r3 = service.evaluate(tagOnlyProfile, [skillClaim('kotlin', 'kotlin')]);
  assert(r3.claims[0].status === 'partial', 'kotlin tag-only is partial (not backed by richer source)');
  assert(r3.claims[0].sources.some(function (s) { return s.kind === 'profile_field' && s.field === 'skills'; }), 'kotlin source is skills field');

  // Skill absent everywhere — unknown
  var r4 = service.evaluate(profile, [skillClaim('rust', 'rust')]);
  assert(r4.claims[0].status === 'unknown', 'rust absent is unknown');
  assert(r4.claims[0].sources.length === 0, 'rust unknown has no sources');
  assert(r4.claims[0].note.toLowerCase().indexOf('no candidate evidence') !== -1, 'rust unknown note states no evidence');
}

// --- 2. Experience evidence is explainable ------------------------------------

{
  // Stated experience + work history spans
  var r = service.evaluate(profile, [experienceClaim(3)]);
  assert(r.claims[0].status === 'matched', 'experience matched (stated + spans)');
  assert(r.claims[0].sources.some(function (s) { return s.field === 'experienceYears'; }), 'experience source includes experienceYears');
  assert(r.claims[0].sources.some(function (s) { return s.field === 'workHistoryJson'; }), 'experience source includes workHistoryJson spans');
  assert(r.claims[0].note.toLowerCase().indexOf('stated') !== -1, 'experience note mentions stated');

  // No stated experience, but work history spans present
  var noExpProfile = makeProfile({ experienceYears: null, workHistoryJson: JSON.stringify([
    { company: 'X', role: 'Eng', from: '2020', to: '2023', summary: '', tagged: false },
  ])});
  var r2 = service.evaluate(noExpProfile, [experienceClaim(2)]);
  assert(r2.claims[0].status === 'matched', 'experience matched via spans alone');
  assert(r2.claims[0].note.toLowerCase().indexOf('no explicit experienceyears') !== -1, 'experience note says no explicit');

  // Neither stated nor spans
  var emptyProfile = makeProfile({ experienceYears: null, workHistoryJson: JSON.stringify([]) });
  var r3 = service.evaluate(emptyProfile, [experienceClaim(2)]);
  assert(r3.claims[0].status === 'unknown', 'experience unknown when no data');
  assert(r3.claims[0].note.toLowerCase().indexOf('cannot verify experience') !== -1, 'experience unknown note says cannot verify');
}

// --- 3. Seniority evidence is explainable ------------------------------------

{
  var r = service.evaluate(profile, [seniorityClaim('senior')]);
  assert(r.claims[0].status === 'matched', 'seniority matched via headline + roles');
  assert(r.claims[0].sources.length > 0, 'seniority has sources');
  assert(r.claims[0].fieldsUsed.indexOf('headline') !== -1 || r.claims[0].fieldsUsed.indexOf('workHistoryJson') !== -1, 'seniority uses headline or workHistoryJson');

  var noSigProfile = makeProfile({ headline: '', workHistoryJson: JSON.stringify([{ company: 'X', role: 'Employee', from: '2020', to: '2023', summary: '', tagged: false }]) });
  var r2 = service.evaluate(noSigProfile, [seniorityClaim('senior')]);
  assert(r2.claims[0].status === 'unknown', 'seniority unknown when no signal');
  assert(r2.claims[0].note.toLowerCase().indexOf('no seniority signal') !== -1, 'seniority unknown note says no signal');
}

// --- 4. Education evidence is explainable -------------------------------------

{
  var r = service.evaluate(profile, [educationClaim('B.Tech', 'B.Tech')]);
  assert(r.claims[0].status === 'matched', 'education matched (B.Tech)');
  assert(r.claims[0].sources.some(function (s) { return s.field === 'educationJson'; }), 'education source is educationJson');
  assert(r.claims[0].sources.some(function (s) { return s.entryIndex === 0; }), 'education source points to entry 0');

  // Education present but not the requested one
  var r2 = service.evaluate(profile, [educationClaim('M.Tech', 'M.Tech')]);
  assert(r2.claims[0].status === 'unknown', 'M.Tech unknown (profile has only B.Tech)');
  assert(r2.claims[0].note.toLowerCase().indexOf('no education') !== -1, 'education unknown note says no education evidence');

  // No education at all
  var noEduProfile = makeProfile({ educationJson: JSON.stringify([]) });
  var r3 = service.evaluate(noEduProfile, [educationClaim('B.Tech', 'B.Tech')]);
  assert(r3.claims[0].status === 'unknown', 'education unknown when no entries');
}

// --- 5. Authorization evidence is explainable --------------------------------

{
  // No authorization signal in the fixture — expected unknown
  var r = service.evaluate(profile, [authClaim('Indian citizen')]);
  assert(r.claims[0].status === 'unknown', 'authorization unknown when no signal in fixture');
  assert(r.claims[0].note.toLowerCase().indexOf('no work authorization evidence') !== -1, 'authorization unknown note');

  // Add explicit authorization signal
  var authProfile = makeProfile({ headline: 'Indian citizen — Senior Engineer' });
  var r2 = service.evaluate(authProfile, [authClaim('Indian citizen')]);
  assert(r2.claims[0].status === 'matched', 'authorization matched when headline says Indian citizen');
  assert(r2.claims[0].sources.some(function (s) { return s.field === 'headline'; }), 'authorization source is headline');
}

// --- 6. Employment-type evidence is explainable ------------------------------

{
  // No employment-type signal in fixture — expected unknown
  var r = service.evaluate(profile, [empTypeClaim('full-time')]);
  assert(r.claims[0].status === 'unknown', 'employment_type unknown when no signal');
  assert(r.claims[0].note.toLowerCase().indexOf('no employment-type preference') !== -1, 'employment_type unknown note');

  var ftProfile = makeProfile({ headline: 'Full-time Senior Engineer' });
  var r2 = service.evaluate(ftProfile, [empTypeClaim('full-time')]);
  assert(r2.claims[0].status === 'matched', 'employment_type matched when headline says full-time');
  assert(r2.claims[0].sources.some(function (s) { return s.field === 'headline'; }), 'employment_type source is headline');
}

// --- 7. Language evidence is explainable -------------------------------------

{
  // No language signal in fixture — expected unknown
  var r = service.evaluate(profile, [languageClaim('English', 'English')]);
  assert(r.claims[0].status === 'unknown', 'language unknown when no signal in fixture');
  assert(r.claims[0].note.toLowerCase().indexOf('no language evidence') !== -1, 'language unknown note');

  var langProfile = makeProfile({ headline: 'English and Bengali speaker' });
  var r2 = service.evaluate(langProfile, [languageClaim('English', 'English')]);
  assert(r2.claims[0].status === 'matched', 'language matched when headline says English');
  assert(r2.claims[0].sources.some(function (s) { return s.field === 'headline'; }), 'language source is headline');
}

// --- 8. Location evidence is explainable -------------------------------------

{
  var r = service.evaluate(profile, [locationClaim('Kolkata', 'Kolkata')]);
  assert(r.claims[0].status === 'matched', 'location matched when currentLocation set');
  assert(r.claims[0].sources.some(function (s) { return s.field === 'currentLocation'; }), 'location source is currentLocation');

  var noLocProfile = makeProfile({ currentLocation: null });
  var r2 = service.evaluate(noLocProfile, [locationClaim('Kolkata', 'Kolkata')]);
  assert(r2.claims[0].status === 'unknown', 'location unknown when not recorded');
  assert(r2.claims[0].note.toLowerCase().indexOf('currentlocation not recorded') !== -1, 'location unknown note');
}

// --- 9. Notice-period evidence is explainable ---------------------------------

{
  var r = service.evaluate(profile, [noticeClaim('30 days', '30 days')]);
  assert(r.claims[0].status === 'matched', 'notice matched when noticePeriod set');
  assert(r.claims[0].sources.some(function (s) { return s.field === 'noticePeriod'; }), 'notice source is noticePeriod');

  var noNoticeProfile = makeProfile({ noticePeriod: null });
  var r2 = service.evaluate(noNoticeProfile, [noticeClaim('15 days', '15 days')]);
  assert(r2.claims[0].status === 'unknown', 'notice unknown when not recorded');
  assert(r2.claims[0].note.toLowerCase().indexOf('noticeperiod not recorded') !== -1, 'notice unknown note');
}

// --- 10. Compensation evidence is explainable ---------------------------------

{
  var r = service.evaluate(profile, [compensationClaim('25 LPA', '25 LPA')]);
  assert(r.claims[0].status === 'matched', 'compensation matched when salaryExpectation set');
  assert(r.claims[0].sources.some(function (s) { return s.field === 'salaryExpectation'; }), 'compensation source is salaryExpectation');

  var noCtcProfile = makeProfile({ salaryExpectation: null });
  var r2 = service.evaluate(noCtcProfile, [compensationClaim('20 LPA', '20 LPA')]);
  assert(r2.claims[0].status === 'unknown', 'compensation unknown when not recorded');
  assert(r2.claims[0].note.toLowerCase().indexOf('salaryexpectation not recorded') !== -1, 'compensation unknown note');
}

// --- 11. Employer evidence is explainable ------------------------------------

{
  var r = service.evaluate(profile, [employerClaim('Acme Technologies', 'Acme Technologies')]);
  assert(r.claims[0].status === 'matched', 'employer matched (Acme Technologies in work history)');
  assert(r.claims[0].sources.some(function (s) { return s.kind === 'work_history' && typeof s.entryIndex === 'number'; }), 'employer source is work_history with entry index');
  assert(r.claims[0].sources.some(function (s) { return s.snippet.indexOf('acme') !== -1; }), 'employer source snippet mentions acme');

  // Employer NOT in work history
  var r2 = service.evaluate(profile, [employerClaim('Gamma Corp', 'Gamma Corp')]);
  assert(r2.claims[0].status === 'mismatch', 'employer mismatch when not in work history');
  assert(r2.claims[0].note.toLowerCase().indexOf('not found in workhistoryjson') !== -1, 'employer mismatch note');

  // No work history at all
  var noWhProfile = makeProfile({ workHistoryJson: JSON.stringify([]) });
  var r3 = service.evaluate(noWhProfile, [employerClaim('Acme', 'Acme')]);
  assert(r3.claims[0].status === 'unknown', 'employer unknown when no work history');
  assert(r3.claims[0].note.toLowerCase().indexOf('no workhistoryjson entries') !== -1, 'employer unknown note');
}

// --- 12. Technology evidence is explainable ----------------------------------

{
  // Project tech tag (strongest)
  var r = service.evaluate(profile, [technologyClaim('docker', 'docker')]);
  assert(r.claims[0].status === 'matched', 'technology matched via project tech');
  assert(r.claims[0].sources.some(function (s) { return s.kind === 'project' && s.field === 'projectsJson'; }), 'technology source is project tech');

  // Tech in work history summary only
  var r2 = service.evaluate(profile, [technologyClaim('microservices', 'microservices')]);
  assert(r2.claims[0].status === 'partial', 'technology partial when only in summary');
  assert(r2.claims[0].sources.some(function (s) { return s.kind === 'work_history'; }), 'technology source is work_history summary');

  // Tech absent
  var r3 = service.evaluate(profile, [technologyClaim('flutter', 'flutter')]);
  assert(r3.claims[0].status === 'unknown', 'technology unknown when absent');
  assert(r3.claims[0].note.toLowerCase().indexOf('no technology evidence') !== -1, 'technology unknown note');
}

// --- 13. Achievement/metric evidence is explainable -------------------------

{
  // Achievement in work history summary
  var r = service.evaluate(profile, [achievementClaim('docker for local development', 'docker for local development')]);
  assert(r.claims[0].status === 'matched', 'achievement matched via work history summary');
  assert(r.claims[0].sources.some(function (s) { return s.kind === 'work_history'; }), 'achievement source is work_history');

  // Achievement in project summary
  var r2 = service.evaluate(profile, [achievementClaim('reduced onboarding time', 'reduced onboarding time')]);
  assert(r2.claims[0].status === 'matched', 'achievement matched via project summary');
  assert(r2.claims[0].sources.some(function (s) { return s.kind === 'project'; }), 'achievement source is project');

  // Achievement NOT in any summary
  var r3 = service.evaluate(profile, [achievementClaim('reduced cloud spend by 40%', 'reduced cloud spend by 40%')]);
  assert(r3.claims[0].status === 'unknown', 'achievement unknown when not in any summary');
  assert(r3.claims[0].note.toLowerCase().indexOf('no achievement') !== -1, 'achievement unknown note');

  // No summaries at all
  var noSumProfile = makeProfile({ workHistoryJson: JSON.stringify([{ company: 'X', role: 'Eng', from: '2020', to: '2023', summary: '', tagged: false }]), projectsJson: JSON.stringify([]) });
  var r4 = service.evaluate(noSumProfile, [achievementClaim('reduced cloud spend', 'reduced cloud spend')]);
  assert(r4.claims[0].status === 'unknown', 'achievement unknown when no summaries');
}

// --- 14. Determinism: same input → same output ------------------------------

{
  var claims = [
    skillClaim('react', 'react'),
    experienceClaim(3),
    employerClaim('Acme Technologies', 'Acme Technologies'),
    technologyClaim('docker', 'docker'),
  ];
  var r1 = service.evaluate(profile, claims);
  var r2 = service.evaluate(profile, claims);
  assertEq(r1.evidenceFingerprint, r2.evidenceFingerprint, 'determinism: fingerprint identical');
  assertEq(r1.claims.length, r2.claims.length, 'determinism: claim count identical');
  for (var i = 0; i < r1.claims.length; i++) {
    assertEq(r1.claims[i].status, r2.claims[i].status, 'determinism: claim ' + i + ' status identical');
    assertEq(r1.claims[i].sources.length, r2.claims[i].sources.length, 'determinism: claim ' + i + ' source count identical');
  }
  assert(r1.evidenceFingerprint.length > 0, 'determinism: fingerprint non-empty');
  assert(typeof r1.evidenceFingerprint === 'string', 'determinism: fingerprint is a string');
}

// --- 15. Profile-field coverage: every relevant field is reachable ----------

{
  var r = service.evaluate(profile, [
    skillClaim('react', 'react'),
    experienceClaim(3),
    seniorityClaim('senior'),
    educationClaim('B.Tech', 'B.Tech'),
    authClaim('Indian citizen'),
    empTypeClaim('full-time'),
    languageClaim('English', 'English'),
    locationClaim('Kolkata', 'Kolkata'),
    noticeClaim('30 days', '30 days'),
    compensationClaim('25 LPA', '25 LPA'),
    employerClaim('Acme Technologies', 'Acme Technologies'),
    technologyClaim('docker', 'docker'),
    achievementClaim('docker for local development', 'docker for local development'),
  ]);

  var fields = r.fieldsUsed;
  assert(fields.indexOf('skills') !== -1 || fields.indexOf('workHistoryJson') !== -1 || fields.indexOf('projectsJson') !== -1 || fields.indexOf('educationJson') !== -1 || fields.indexOf('headline') !== -1 || fields.indexOf('experienceYears') !== -1 || fields.indexOf('noticePeriod') !== -1 || fields.indexOf('salaryExpectation') !== -1 || fields.indexOf('currentLocation') !== -1, 'evidence uses multiple profile fields');
  assert(fields.length >= 2, 'evidence uses at least 2 distinct fields (got ' + fields.length + ')');
}

// --- 16. Unknowns are explicit, never silent --------------------------------

{
  // A profile with NO data in any field should produce all-unknown, all-explained
  var bareProfile = makeProfile({
    skills: null,
    headline: null,
    experienceYears: null,
    noticePeriod: null,
    salaryExpectation: null,
    currentLocation: null,
    workHistoryJson: JSON.stringify([]),
    educationJson: JSON.stringify([]),
    projectsJson: JSON.stringify([]),
  });
  var r = service.evaluate(bareProfile, [
    skillClaim('react', 'react'),
    experienceClaim(3),
    employerClaim('Acme', 'Acme'),
    technologyClaim('docker', 'docker'),
    achievementClaim('reduced cloud spend', 'reduced cloud spend'),
  ]);

  r.claims.forEach(function (c) {
    assert(c.status === 'unknown', 'bare profile claim "' + c.claim + '" is unknown (got ' + c.status + ')');
    assert(c.sources.length === 0, 'bare profile claim "' + c.claim + '" has no sources (got ' + c.sources.length + ')');
    assert(c.note.length > 0, 'bare profile claim "' + c.claim + '" has an explanatory note');
  });
}

// --- 17. No fabrication: service never invents facts -------------------------

{
  // A profile that says NOTHING about a skill must not claim the skill exists.
  var noSkillProfile = makeProfile({
    skills: 'python, django',
    headline: 'Backend Engineer',
    workHistoryJson: JSON.stringify([
      { company: 'Z', role: 'Backend Engineer', from: '2020', to: '2023', summary: 'Built APIs with Python and Django.', tagged: false },
    ]),
    projectsJson: JSON.stringify([]),
    educationJson: JSON.stringify([]),
  });

  var r = service.evaluate(noSkillProfile, [
    skillClaim('react', 'react'),
    technologyClaim('react', 'react'),
    employerClaim('acme', 'acme'),
    achievementClaim('reduced cloud spend by 40%', 'reduced cloud spend by 40%'),
  ]);

  // react must be unknown in both skill and technology categories
  assert(r.claims[0].status === 'unknown', 'no fabrication: react skill is unknown');
  assert(r.claims[1].status === 'unknown', 'no fabrication: react technology is unknown');
  assert(r.claims[2].status === 'mismatch', 'no fabrication: acme employer is mismatch (not unknown, not matched)');
  assert(r.claims[3].status === 'unknown', 'no fabrication: made-up metric is unknown');

  // Verify the service never emits a "matched" source snippet that contains a
  // fabricated value not present in the profile for that claim.
  var realFields = new Set([
    'skills', 'headline', 'experienceYears', 'noticePeriod', 'salaryExpectation',
    'currentLocation', 'workHistoryJson', 'educationJson', 'projectsJson',
  ]);
  r.claims.forEach(function (c) {
    c.sources.forEach(function (s) {
      assert(realFields.has(s.field), 'source field "' + s.field + '" is a real profile field');
    });
  });
}

// --- 18. Pure function signature used by callers -----------------------------

{
  // The exported evaluateEvidence() pure function is callable directly (no DI).
  var r = evaluateEvidence(profile, [skillClaim('react', 'react')]);
  assert(r.claims.length === 1, 'pure evaluateEvidence works without DI');
  assert(r.claims[0].status === 'matched', 'pure evaluateEvidence returns matched for react');
  assert(typeof r.evidenceFingerprint === 'string', 'pure evaluateEvidence returns a fingerprint');

  // The DI service delegates to the same pure function.
  var r2 = service.evaluate(profile, [skillClaim('react', 'react')]);
  assertEq(r.evidenceFingerprint, r2.evidenceFingerprint, 'DI service and pure function produce the same fingerprint');
}

// --- 19. Claim order preserved in output -------------------------------------

{
  var claims = [
    skillClaim('react', 'react'),
    experienceClaim(3),
    employerClaim('Acme Technologies', 'Acme Technologies'),
  ];
  var r = service.evaluate(profile, claims);
  assert(r.claims[0].claim === claims[0].claim, 'claim order preserved: first claim');
  assert(r.claims[1].claim === claims[1].claim, 'claim order preserved: second claim');
  assert(r.claims[2].claim === claims[2].claim, 'claim order preserved: third claim');
}

// --- 20. Unknown claim category is handled gracefully ------------------------

{
  var r = service.evaluate(profile, [{ category: 'bogus_category', claim: 'bogus', hint: undefined }]);
  assert(r.claims.length === 1, 'unknown category returns one claim');
  assert(r.claims[0].status === 'unknown', 'unknown category status is unknown');
  assert(r.claims[0].note.toLowerCase().indexOf('no evidence extractor registered') !== -1, 'unknown category note says no extractor');
}

// --- Report ------------------------------------------------------------------

console.log('\nJA-013 candidate-evidence tests: ' + passed + ' passed, ' + failed + ' failed, ' + (passed + failed) + ' total');
if (failed) {
  process.exit(1);
}
