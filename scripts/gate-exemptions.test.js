#!/usr/bin/env node
/**
 * gate-exemptions.test.js — proves the drift guard's exemption mechanism stays
 * NARROW and AUDITABLE.
 *
 * What is being defended (the 2026-09-11 governance decision): a legitimate commit
 * from a SEPARATELY-tracked workstream (job-application-roadmap, which keeps its
 * own job_application_roadmap_items control plane) must clear the trading
 * control-plane drift check WITHOUT inventing a trading roadmap row and WITHOUT
 * weakening the guard for anything else.
 *
 * In-process only: no DB, no network, no running app.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const LIB = path.join(ROOT, 'scripts', 'lib', 'gate-exemptions.js');
const GUARD = path.join(ROOT, 'scripts', 'gate-close-check.js');
const ALLOW_FILE = path.join(ROOT, 'docs', 'gate-close-allow.json');
const LEGACY_FILE = path.join(ROOT, 'docs', 'gate-close-legacy-baseline.json');
const JA_SHA = 'd80e0bad00747b54a7c85574be78b1af1b98d57c';
const JA2_SHA = '4d65f3a511a2e5f0b5116e50e54c95f3bcb58844';
// Appended 2026-09-12: the separate job-application workstream kept shipping while this
// tripwire still listed the first two SHAs, so the suite was red before the third entry
// was added. Growing this list is the deliberate act the tripwire exists to force.
const JA3_SHA = '6b2431ae134f14bcd81fd5937eba92f2f279e4e6'; // JA-002 submission sandbox safety
const JA4_SHA = 'bfaa1776345a0986f6a45ea2ec1d6af3068c2f5c'; // JA-003 regression baseline
const JA5_SHA = '4ce0ab84717faa3b9849f93e632881cafb6d1966'; // IMAP crash safety (agent queue item 76)
const AUDITED = [JA_SHA, JA2_SHA, JA3_SHA, JA4_SHA, JA5_SHA];

const { loadExemptions, findExemption, classifyCommit, isControlPlaneCommit } = require(LIB);

let pass = 0;
let fail = 0;
const t = (name, fn) => {
	try {
		fn();
		pass++;
		console.log(`  ok  ${name}`);
	} catch (e) {
		fail++;
		console.log(`  FAIL ${name}\n       ${e && e.message}`);
	}
};

const tmp = (name, body) => {
	const p = path.join(os.tmpdir(), `gate-exempt-${process.pid}-${name}`);
	fs.writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
	return p;
};

console.log('\ngate-exemptions — the committed exemption source for the drift guard\n');

// ── the committed file ───────────────────────────────────────────────────────
const live = loadExemptions(ALLOW_FILE);

t('the committed allow-list loads with no problems', () => {
	assert.deepEqual(live.problems, [], `problems: ${JSON.stringify(live.problems)}`);
	assert.ok(live.exists, 'docs/gate-close-allow.json must exist (tracked, reviewable)');
});

t('it exempts exactly the audited JA SHAs — the file cannot silently grow', () => {
	const expected = [...AUDITED].sort();
	assert.deepEqual([...live.entries.keys()].sort(), expected, `expected exactly ${expected.length} exemptions`);
});

t('EVERY entry is auditable: reason + workstream + authority + recorded', () => {
	for (const [sha, e] of live.entries) {
		assert.ok(e.reason && e.reason.length > 40, `${sha}: reason must be substantive`);
		assert.match(e.workstream, /job-application/i, `${sha}: workstream must name the separate workstream`);
		assert.match(e.authority, /operator/i, `${sha}: authority must cite the operator`);
		assert.ok(e.recorded, `${sha}: a recorded date/timestamp must be present`);
	}
});

t('the exemption does NOT route through the forbidden legacy baseline', () => {
	const legacy = JSON.parse(fs.readFileSync(LEGACY_FILE, 'utf8')).commits || {};
	for (const sha of AUDITED) {
		assert.ok(!legacy[sha] && !legacy[sha.slice(0, 7)], `${sha.slice(0, 7)} must never be silenced as "legacy baseline"`);
	}
});

// ── narrowness: exact matches only ───────────────────────────────────────────
const listed = { sha: JA_SHA, short: JA_SHA.slice(0, 7) };

t('an unlisted commit is NOT exempt (drift detection stays on)', () => {
	assert.equal(findExemption(live.entries, { sha: 'a'.repeat(40), short: 'aaaaaaa' }), null);
});

t('a one-character mutation of the exempt SHA is NOT exempt', () => {
	const mutated = `e${JA_SHA.slice(1)}`;
	assert.equal(findExemption(live.entries, { sha: mutated, short: mutated.slice(0, 7) }), null);
});

t('a shorter-than-7 prefix is NOT exempt (no fuzzy prefix matching)', () => {
	assert.equal(findExemption(live.entries, { sha: JA_SHA.slice(0, 6), short: JA_SHA.slice(0, 6) }), null);
});

t('the exempt commit resolves by full SHA and by its 7-char short form', () => {
	assert.ok(findExemption(live.entries, { sha: JA_SHA, short: JA_SHA.slice(0, 7) }));
	assert.ok(findExemption(live.entries, { sha: JA_SHA.toUpperCase(), short: JA_SHA.slice(0, 7) }), 'case-insensitive SHA');
});

// ── auditable-or-ignored ─────────────────────────────────────────────────────
t('an entry without a reason is IGNORED (a blank reason cannot exempt)', () => {
	const f = tmp('no-reason.json', { exemptions: { [JA_SHA]: { workstream: 'x', authority: 'y' } } });
	const r = loadExemptions(f);
	assert.equal(r.entries.size, 0);
	assert.match(r.problems.join(' '), /missing reason/);
});

t('an entry without an authority is IGNORED', () => {
	const f = tmp('no-authority.json', { exemptions: { [JA_SHA]: { reason: 'a real reason', workstream: 'x' } } });
	const r = loadExemptions(f);
	assert.equal(r.entries.size, 0);
	assert.match(r.problems.join(' '), /authority/);
});

t('a glob/path/range key is IGNORED (no bulk exemptions)', () => {
	const f = tmp('glob.json', { exemptions: { 'scripts/job-application-roadmap/*': { reason: 'r', workstream: 'w', authority: 'a' } } });
	const r = loadExemptions(f);
	assert.equal(r.entries.size, 0);
	assert.match(r.problems.join(' '), /non-SHA key/);
});

t('a malformed or missing file exempts nothing and does not crash', () => {
	const broken = tmp('broken.json', '{ not json');
	const r1 = loadExemptions(broken);
	assert.equal(r1.entries.size, 0);
	assert.ok(r1.problems.length >= 1);
	const missing = loadExemptions(path.join(os.tmpdir(), 'gate-exempt-does-not-exist.json'));
	assert.equal(missing.entries.size, 0);
	assert.deepEqual(missing.problems, [], 'a missing file is not a problem, it just exempts nothing');
});

t('an array-shaped exemptions list is also honoured (both shapes valid)', () => {
	const f = tmp('array.json', { exemptions: [{ sha: JA_SHA, reason: 'r', workstream: 'w', authority: 'a' }] });
	assert.equal(loadExemptions(f).entries.size, 1);
});

// ── classification precedence ────────────────────────────────────────────────
t('an unlisted commit with no evidence is DRIFT even when an exemption exists for another SHA', () => {
	const exemption = findExemption(live.entries, listed);
	assert.equal(classifyCommit({ hasOwner: false, isControlPlane: false, legacyReason: null, exemption }), 'allowed');
	assert.equal(
		classifyCommit({ hasOwner: false, isControlPlane: false, legacyReason: null, exemption: findExemption(live.entries, { sha: 'b'.repeat(40), short: 'bbbbbbb' }) }),
		'drift',
		'a commit that is not listed must still classify as drift',
	);
});

t('recorded evidence beats an exemption (a synced row is never downgraded)', () => {
	assert.equal(classifyCommit({ hasOwner: true, isControlPlane: false, legacyReason: null, exemption: listed }), 'synced');
});

t('precedence is unchanged: legacy > control-plane > exemption > drift', () => {
	assert.equal(classifyCommit({ hasOwner: false, isControlPlane: true, legacyReason: 'pre-guard', exemption: listed }), 'legacy');
	assert.equal(classifyCommit({ hasOwner: false, isControlPlane: true, legacyReason: null, exemption: listed }), 'cp');
	assert.equal(classifyCommit({ hasOwner: false, isControlPlane: false, legacyReason: null, exemption: null }), 'drift');
});

// ── control-plane scope stays name-scoped (not a global weakening) ───────────
t('control-plane scope covers the guard family only — including its own tests', () => {
	assert.equal(isControlPlaneCommit(['scripts/gate-close-check.js']), true);
	assert.equal(isControlPlaneCommit(['scripts/gate-status.js']), true);
	assert.equal(isControlPlaneCommit(['scripts/lib/gate-exemptions.js']), true);
	assert.equal(isControlPlaneCommit(['scripts/gate-exemptions.test.js']), true, "the guard family's own tests are tracking-layer tooling");
	assert.equal(isControlPlaneCommit(['docs/gate-close-allow.json']), true);
	assert.equal(isControlPlaneCommit(['package.json']), true);
	assert.equal(isControlPlaneCommit(['AGENTS.md']), true);
});

t('control-plane scope does NOT cover feature code, feature tests or other scripts', () => {
	assert.equal(isControlPlaneCommit(['src/trading/upstox-live-paper/upstox-live-paper-auth.service.ts']), false);
	assert.equal(isControlPlaneCommit(['src/job-application-roadmap/job-application-roadmap.service.ts']), false);
	assert.equal(isControlPlaneCommit(['scripts/pre-open-window-capture.js']), false);
	assert.equal(isControlPlaneCommit(['scripts/gate0-regression.test.js']), false, 'only the gate-* family is tracking layer');
	assert.equal(isControlPlaneCommit(['scripts/gate-close-check.js', 'src/trading/x.ts']), false, 'a mixed commit is NOT control-plane-only');
	assert.equal(isControlPlaneCommit([]), false, 'an empty changeset is not control-plane tooling');
});

// ── the guard actually uses it, and the drift branch is intact ───────────────
const guardSrc = fs.readFileSync(GUARD, 'utf8');

t('the guard uses the shared control-plane pattern (no divergent copy)', () => {
	assert.match(guardSrc, /isControlPlaneCommit\(changed\)/);
	assert.ok(!/const CONTROL_PLANE =/.test(guardSrc), 'the old inline regex must be gone, not duplicated');
});

t('the guard loads the committed source into its EXISTING allow set', () => {
	assert.match(guardSrc, /require\('\.\/lib\/gate-exemptions'\)/);
	assert.match(guardSrc, /loadExemptions\(\)/);
	assert.match(guardSrc, /FILE_EXEMPTIONS\.entries\.keys\(\)\) ALLOW\.add/, 'committed SHAs must feed the same ALLOW set as --allow');
});

t('the guard still pushes every non-exempt, non-owner commit to DRIFT', () => {
	assert.match(guardSrc, /const kind = classifyCommit\(/);
	assert.match(guardSrc, /unsynced\.push\(c\)/);
	assert.match(guardSrc, /if \(unsynced\.length\)/, 'the DRIFT exit must remain wired');
});

t('the committed-file exemption is still reported by name + reason (never silent)', () => {
	assert.match(guardSrc, /allow-listed exemption/);
	assert.match(guardSrc, /allow-list:/);
});

console.log(`\ngate-exemptions: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
