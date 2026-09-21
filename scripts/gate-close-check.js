/**
 * gate-close-check.js — the drift guard for the /project-status control plane.
 *
 * Detects the precise failure of 2026-09-10: code/git moved ahead while
 * project_checklist_items stayed behind. It answers one question per recent
 * code commit — "is this commit's SHA recorded as evidence on some checklist
 * row, and does that row still render on the live page?" — and exits non-zero
 * when the answer is no, so a git hook (scripts/hooks/pre-push), a cron job or
 * any agent can enforce it without depending on model memory.
 *
 * Scope: commits touching code paths (default src/ scripts/ package.json) within
 * a bounded window (default: the 15 most recent, and never older than --since).
 *
 * Exit codes: 0 = control plane in sync (or unverifiable non-strict),
 *             1 = drift detected (a recent code commit is not reflected), 2 = usage error.
 *
 * Usage:
 *   npm run gate:check
 *   node scripts/gate-close-check.js --limit 30 --since 2026-09-01T00:00:00+05:30
 *   node scripts/gate-close-check.js --allow 4d3a500,7351d79     # explicit exemptions
 *   GATE_CLOSE_SKIP=1 <command>                                  # documented bypass
 *
 * Persistent exemptions (a push runs this from the pre-push hook, where no
 * operator flag exists): docs/gate-close-allow.json, exact SHAs with
 * reason/workstream/authority, loaded into the SAME allow set via
 * scripts/lib/gate-exemptions.js. It never disables drift detection.
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const ROOT = '/home/swarna-sekhar-dhar/projects/my-job-agent-job';
require(path.join(ROOT, 'node_modules/dotenv')).config({ path: path.join(ROOT, '.env') });
const mysql = require(path.join(ROOT, 'node_modules/mysql2/promise'));

const BASE = process.env.PROJECT_STATUS_BASE || process.env.DESK_API_BASE || 'http://127.0.0.1:3010';
const argv = process.argv.slice(2);
const arg = (n) => {
	const i = argv.indexOf(`--${n}`);
	return i >= 0 ? argv[i + 1] : undefined;
};
const flag = (n) => argv.includes(`--${n}`);

const LIMIT = Number(arg('limit') || 15);
const SINCE = arg('since') || null;
const STRICT = flag('strict');
const QUIET = flag('quiet');
const PATHS = (arg('paths') || 'src/ scripts/ package.json').split(/\s+/).filter(Boolean);
const ALLOW = new Set(
	(`${arg('allow') || ''},${process.env.GATE_CLOSE_ALLOW || ''}`
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean)),
);

// Persistent exemptions — the committed source for the SAME allow set. A push runs
// this from scripts/hooks/pre-push, where no --allow flag can be supplied, so an
// exemption covering a separately-tracked workstream has to live in the repo.
const { loadExemptions, findExemption, classifyCommit, isControlPlaneCommit } = require('./lib/gate-exemptions');
const FILE_EXEMPTIONS = loadExemptions();
for (const sha of FILE_EXEMPTIONS.entries.keys()) ALLOW.add(sha);

// Commits that predate the guard and have NO roadmap row to belong to. Documented,
// labelled and NOT evidence — they are excluded from DRIFT so the guard can enforce
// every commit from here on. Never add a sha here to silence a real drift.
const BASELINE_PATH = path.join(ROOT, 'docs/gate-close-legacy-baseline.json');
let LEGACY = {};
try {
	LEGACY = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')).commits || {};
} catch {
	LEGACY = {};
}
const legacyReason = (c) => LEGACY[c.sha] || LEGACY[c.short] || null;

const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();
const log = (...a) => {
	if (!QUIET) console.log(...a);
};

(async () => {
	const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
	const head = git('rev-parse', '--short', 'HEAD');

	// ── 1. recent code commits (bounded window) ───────────────────────────────
	const raw = git('log', `-${LIMIT}`, '--pretty=%H|%cI|%s', '--', ...PATHS);
	let commits = raw
		? raw.split('\n').map((l) => {
				const [sha, date, ...rest] = l.split('|');
				return { sha, short: sha.slice(0, 7), date, subject: rest.join('|') };
			})
		: [];
	if (SINCE) commits = commits.filter((c) => c.date >= SINCE);

	// Commits that only touch the control plane's own machinery (this guard, its docs,
	// the repo instructions, its own tests) cannot belong to a roadmap row — they ARE
	// the tracking layer. Labelled `cp-plan` in the report, never silent. The pattern
	// lives in lib/gate-exemptions.js so it can be tested directly.
	for (const c of commits) {
		const changed = git('show', '--pretty=format:', '--name-only', c.sha).split('\n').map((s) => s.trim()).filter(Boolean);
		c.files = changed;
		c.controlPlane = isControlPlaneCommit(changed);
	}

	// ── 2. what the control plane records ─────────────────────────────────────
	let rows = [];
	let dbError = null;
	let lastWrite = null;
	try {
		const conn = await mysql.createConnection({
			host: process.env.MYSQL_HOST,
			port: Number(process.env.MYSQL_PORT || 3307),
			user: process.env.MYSQL_USER,
			password: process.env.MYSQL_PASSWORD,
			database: process.env.DATABASE_NAME || 'myjob_agent', // Oracle Cloud MySQL (tunnel) — no local DB exists
		});
		[rows] = await conn.query('SELECT id, grp, item, status, note, updatedAt FROM project_checklist_items');
		const last = [...rows].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0];
		lastWrite = last ? new Date(last.updatedAt) : null;
		await conn.end();
	} catch (e) {
		dbError = e.message;
	}

	log(`\ngate-close check — branch ${branch} @ ${head}, window: last ${LIMIT} code commit(s)${SINCE ? ` since ${SINCE}` : ''}`);
	log(`code commits in scope: ${commits.length}`);

	if (dbError) {
		// Fail OPEN: a dead tunnel must not block a push. But say so, loudly.
		console.error(`WARN: cannot read project_checklist_items (${dbError}) — control-plane sync UNVERIFIED.`);
		if (STRICT) process.exit(1);
		process.exit(0);
	}
	log(`checklist rows: ${rows.length} | last control-plane write: ${lastWrite ? lastWrite.toISOString() : 'never'}`);

	// ── 3. per-commit evidence test ───────────────────────────────────────────
	const unsynced = [];
	for (const c of commits) {
		const owner = rows.find((r) => (r.note || '').includes(c.sha) || (r.note || '').includes(c.short));
		const legacy = legacyReason(c);
		const exemption =
			findExemption(FILE_EXEMPTIONS.entries, c) ||
			(ALLOW.has(c.sha) || ALLOW.has(c.short)
				? { sha: c.sha, reason: 'explicit --allow / GATE_CLOSE_ALLOW at invocation time', workstream: 'operator-supplied', authority: 'invocation flag' }
				: null);
		const kind = classifyCommit({ hasOwner: !!owner, isControlPlane: c.controlPlane, legacyReason: legacy, exemption });
		if (kind === 'legacy') {
			c.owner = { id: 'legacy' };
			c.legacy = legacy;
		} else if (kind === 'cp') {
			c.owner = { id: 'cp' };
		} else if (kind === 'allowed') {
			c.owner = { id: 'allowed' };
			c.exemption = exemption;
		} else if (kind === 'synced') {
			c.owner = owner;
		} else {
			unsynced.push(c);
		}
	}

	// ── 4. the recorded evidence must still RENDER on the live page ───────────
	let renderNote = 'not checked (no referenced commits, or app unreachable)';
	let renderBad = false;
	let renderWarn = false;
	const referenced = commits.filter((c) => c.owner && !['allowed', 'legacy', 'cp'].includes(c.owner.id));
	if (referenced.length) {
		try {
			const gateAuth = require('./lib/gate-auth');
			const authHeaders = await gateAuth.authHeaders();
			const res = await fetch(`${BASE}/project-status`, { headers: authHeaders });
			if (res.status === 401 || res.status === 403 || res.status === 429) {
				// Auth problem, NOT evidence drift: say so loudly, do not block.
				renderWarn = true;
				renderNote = `render check SKIPPED — page refused the operator auth (HTTP ${res.status}); this is not evidence drift`;
			} else {
				const html = (await res.text()).replace(/<[^>]*>/g, ' ');
				const missing = referenced.filter((c) => !html.includes(c.sha) && !html.includes(c.short));
				renderBad = res.status !== 200 || missing.length > 0;
				renderNote =
					res.status !== 200
						? `GET /project-status returned HTTP ${res.status}`
						: missing.length
							? `${missing.length} recorded commit(s) not visible on the rendered page: ${missing.map((m) => m.short).join(', ')}`
							: `${referenced.length} recorded commit(s) visible on the rendered page (HTTP 200)`;
			}
		} catch (e) {
			renderNote = `render check skipped: ${e.message}`;
		}
	}

	// ── 5. report ─────────────────────────────────────────────────────────────
	log('');
	for (const c of commits) {
		const kind = c.owner ? c.owner.id : 'drift';
		const mark =
			kind === 'allowed'
				? 'allow '
				: kind === 'legacy'
					? 'legacy'
					: kind === 'cp'
						? 'cp-plan'
						: kind === 'drift'
							? ' DRIFT'
							: ' synced';
		const where =
			kind === 'legacy'
				? `legacy baseline — no roadmap row: ${String(c.legacy).slice(0, 60)}`
				: kind === 'cp'
					? 'control-plane tooling only (guard / docs / AGENTS.md)'
					: kind === 'allowed'
						? `allow-listed exemption (${String((c.exemption && c.exemption.reason) || '').slice(0, 58)})`
						: c.owner
							? `row [${c.owner.id}] ${String(c.owner.item).slice(0, 46)}`
							: 'NO checklist row records this commit';
		log(`${mark} ${c.short} ${c.date.slice(0, 16)} ${where}  ${c.subject.slice(0, 52)}`);
	}
	const legacyList = commits.filter((c) => c.owner && c.owner.id === 'legacy');
	log(`\nrender verification: ${renderNote}`);
	if (renderWarn) {
		log(
			'WARN: the page read could not be authenticated just now, so the recorded evidence was NOT\n' +
				'      independently re-rendered (fail-open, deliberately loud). Re-run `npm run gate:check`\n' +
				'      to confirm the page still shows every recorded commit.',
		);
	}
	if (legacyList.length) {
		log(
			`legacy baseline: ${legacyList.length} commit(s) predate the guard and have no roadmap row — ` +
				`exempt, documented as NOT evidence in docs/gate-close-legacy-baseline.json`,
		);
	}
	if (FILE_EXEMPTIONS.entries.size || FILE_EXEMPTIONS.problems.length) {
		log(
			`allow-list: ${FILE_EXEMPTIONS.entries.size} commit(s) exempt via the committed source ` +
				`(${path.relative(ROOT, FILE_EXEMPTIONS.file)}) — each entry carries reason/workstream/authority; ` +
				'drift detection stays on for every commit not listed there',
		);
		for (const p of FILE_EXEMPTIONS.problems) console.error(`WARN: allow-list ${p}`);
	}

	if (unsynced.length) {
		console.error(`
DRIFT: ${unsynced.length} recent code commit(s) are NOT reflected in /project-status:
${unsynced.map((c) => `  ${c.short}  ${c.subject}`).join('\n')}

The control plane must not lag the work. Sync the row this work actually moved —
resolve it by the row's own item text/doneWhen, never by a conversational gate number:

  npm run gate:status -- --find "<substring of the item text>" --status in_progress \\
      --evidence "test: <suite result>; commit: ${unsynced[unsynced.length - 1].short}; runtime: <endpoint/render check>" \\
      --gap "<what is still missing>"

Only use --status done once that row's doneWhen is genuinely satisfied.
Deliberate exemption (docs-only/no-gate commit): --allow ${unsynced.map((c) => c.short).join(',')}
A commit that belongs to a SEPARATE, separately-tracked workstream: add an exact-SHA entry
carrying reason/workstream/authority to docs/gate-close-allow.json — never to silence real drift.
Emergency bypass: GATE_CLOSE_SKIP=1
`);
		process.exit(1);
	}
	if (renderBad) {
		console.error(`\nDRIFT: recorded evidence does not render on the page — ${renderNote}\n`);
		process.exit(1);
	}
	log(
		`\nIN SYNC — every recent code commit is recorded on a checklist row (and renders on the page),` +
			` or is control-plane tooling (${commits.filter((c) => c.owner && c.owner.id === 'cp').length} cp-plan),` +
			` or is documented in the legacy baseline (${commits.filter((c) => c.owner && c.owner.id === 'legacy').length} exempt, NOT evidence),` +
			` or is allow-listed for a separate workstream (${commits.filter((c) => c.owner && c.owner.id === 'allowed').length}).\n`,
	);
})().catch((e) => {
	console.error('ERR', e && e.message ? e.message : e);
	process.exit(1);
});
