/**
 * gate-status.js — the ONLY sanctioned way to move a /project-status row.
 *
 * Why this exists (2026-09-10 incident): implementation, tests and git were
 * current while project_checklist_items sat a day behind, because nothing in
 * the commit/test/deploy path writes the control plane and the update depended
 * on an agent session remembering to call the API. That made the control plane
 * model-dependent. This script makes the write a single mechanical command with
 * enforced evidence and a render-verified result, so ANY model/session runs the
 * same procedure.
 *
 * Contract:
 *   - resolves the row from its ACTUAL identity (item text match, printed with
 *     the row's own doneWhen) — never from a conversational gate number;
 *   - refuses to write `done` without evidence containing a commit SHA and a
 *     verification marker (test/http/route/endpoint/verified) — committing code
 *     is not completion;
 *   - APPENDS a timestamped evidence block to the note, never overwrites it;
 *   - writes through the existing authenticated /project-status API (operator
 *     session from the encrypted portal_users row), not raw SQL;
 *   - never inserts rows: it can only UPDATE an existing checklist item;
 *   - after writing, GETs /project-status and asserts the row renders with the
 *     new status and the new note; exits non-zero if it does not.
 *
 * Usage:
 *   npm run gate:status -- --find "strict future-only labels" --status in_progress \
 *       --evidence "test: pattern-engine.test.js 10b pass; commit: c98a7b4; runtime: 22:18 IST after-hours label verified" \
 *       --gap "frozen FEATURE cutoffs on the general ML dataset still open"
 *   npm run gate:status -- --find "..." --status done --evidence "..." --dry-run
 */
const path = require('path');
const crypto = require('crypto');
const ROOT = '/home/swarna-sekhar-dhar/projects/my-job-agent';
require(path.join(ROOT, 'node_modules/dotenv')).config({ path: path.join(ROOT, '.env') });
const mysql = require(path.join(ROOT, 'node_modules/mysql2/promise'));

const BASE = process.env.PROJECT_STATUS_BASE || process.env.DESK_API_BASE || 'http://127.0.0.1:3010';
const STATUSES = ['pending', 'in_progress', 'done', 'blocked', 'n/a'];
const NOTE_MAX = 500; // matches ProjectStatusService.setNote() slice
const DONE_VERIFY_RE = /test|http|\broute\b|endpoint|verified|verify|GET |POST |render/i;
const SHA_RE = /\b[0-9a-f]{7,40}\b/;

const argv = process.argv.slice(2);
const arg = (name) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : undefined;
};
const flag = (name) => argv.includes(`--${name}`);

const find = arg('find');
const idArg = arg('id');
const target = arg('status');
const evidence = arg('evidence') ?? '';
const gap = arg('gap') ?? '';
const by = arg('by') ?? process.env.GATE_BY ?? 'agent';
const dryRun = flag('dry-run');

const die = (msg, code = 2) => {
	console.error(`\nABORT: ${msg}\n`);
	process.exit(code);
};

if (!target && !dryRun) die('missing --status');
if (target && !STATUSES.includes(target)) die(`--status must be one of ${STATUSES.join('|')} (got "${target}")`);
if (!find && !idArg) die('missing --find "<substring of the checklist item>" (or --id <n>)');
if (target === 'done') {
	if (!evidence.trim()) die('`done` requires --evidence — a committed change is NOT completion.');
	if (!SHA_RE.test(evidence)) die(`\`done\` evidence must name the commit SHA — got: "${evidence}"`);
	if (!DONE_VERIFY_RE.test(evidence)) {
		die(`\`done\` evidence must state the verification (test result / endpoint or runtime check) — got: "${evidence}"`);
	}
}

const istStamp = () => {
	const d = new Date(Date.now() + 5.5 * 3600 * 1000);
	return d.toISOString().slice(0, 16).replace('T', ' ') + ' IST';
};
const machineTag = () => 'gate-sync ' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

/** Append-only, newest evidence preserved even when the 500-char column overflows. */
const TRIM_MARK = '[…earlier notes trimmed]';
const appendNote = (prev, block) => {
	const clean = String(prev ?? '').trim();
	const joined = clean ? `${clean}\n\n${block}` : block;
	if (joined.length <= NOTE_MAX) return joined;
	const room = NOTE_MAX - TRIM_MARK.length - 1; // room for the mark plus its newline
	return `${TRIM_MARK}\n${joined.slice(joined.length - room)}`;
};

const stripTags = (html) => html.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();

(async () => {
	const conn = await mysql.createConnection({
		host: process.env.MYSQL_HOST,
		port: Number(process.env.MYSQL_PORT || 3307),
		user: process.env.MYSQL_USER,
		password: process.env.MYSQL_PASSWORD,
		// One database only: Oracle Cloud MySQL, reached through the SSH tunnel
		// (MYSQL_* env). There is no local database for this project.
		database: process.env.DATABASE_NAME || 'myjob_agent',
	});
	const q = async (sql, args = []) => (await conn.query(sql, args))[0];

	// ── 1. resolve the row by its real identity ───────────────────────────────
	let rows;
	if (idArg) {
		rows = await q('SELECT id, grp, grp_order, item_order, item, status, note, doneWhen FROM project_checklist_items WHERE id = ?', [Number(idArg)]);
	} else {
		rows = await q(
			'SELECT id, grp, grp_order, item_order, item, status, note, doneWhen FROM project_checklist_items WHERE item LIKE ? ORDER BY grp_order, item_order',
			[`%${find}%`],
		);
	}
	if (!rows.length) die(`no checklist row matches "${find}" — do NOT invent a gate number or a new row; widen the --find text.`);
	if (rows.length > 1) {
		console.error(`\n${rows.length} rows match "${find}" — narrow it (or pass --id):\n`);
		for (const r of rows) console.error(`  [${r.id}] ${r.grp} / #${r.item_order} — ${r.item}\n       doneWhen: ${r.doneWhen ?? '(none)'}`);
		die('ambiguous identity — refusing to guess which row to write.');
	}
	const row = rows[0];
	console.log(`\nrow   [${row.id}] ${row.grp} / #${row.item_order}`);
	console.log(`item  ${row.item}`);
	console.log(`doneWhen  ${row.doneWhen ?? '(none — judge honestly from the item text)'}`);
	console.log(`status: ${row.status}${target && !dryRun ? ` -> ${target}` : ''}`);
	console.log(`note  : ${(row.note || '(empty)').replace(/\n/g, ' | ')}`);

	// ── 2. compose the appended evidence block ────────────────────────────────
	const tag = machineTag(); // ONE tag: written into the note and used to verify it rendered
	const parts = [`[${istStamp()} ${target ?? row.status} by ${by}]`];
	if (evidence.trim()) parts.push(evidence.trim());
	if (gap.trim()) parts.push(`GAP: ${gap.trim()}`);
	parts.push(`(${tag})`);
	const block = parts.join(' ');
	const note = appendNote(row.note, block);
	if (!note.includes(tag)) die('internal: the evidence tag did not survive the note trim — shorten --evidence');
	console.log(`\nnote to write (${note.length}/${NOTE_MAX} chars):\n${note}\n`);

	if (dryRun) {
		console.log('dry-run: nothing written.\n');
		await conn.end();
		return;
	}

	// ── 3. operator auth (the app's own server-to-server path) ───────────────
	// `x-operator-password` is verified by ConditionalAuthGuard on any protected
	// route; /auth/login is rate limited to 10/15min, so we never use it here.
	const gateAuth = require('./lib/gate-auth');
	const authHeaders = await gateAuth.authHeaders();

	const post = async (route, body) => {
		const res = await fetch(`${BASE}/project-status/item/${row.id}/${route}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...authHeaders },
			body: new URLSearchParams(body).toString(),
			redirect: 'manual',
		});
		if (res.status === 401) die('operator auth refused (x-operator-password) — check portal_users.passwordEnc vs ENCRYPTION_KEY.');
		if (res.status >= 400) die(`POST ${route} failed: HTTP ${res.status} ${await res.text()}`);
		return res.status;
	};

	const statusHttp = await post('status', { status: target });
	const noteHttp = await post('note', { note });
	console.log(`wrote : POST /project-status/item/${row.id}/status -> HTTP ${statusHttp}`);
	console.log(`wrote : POST /project-status/item/${row.id}/note   -> HTTP ${noteHttp}`);

	// ── 4. independent verification through the rendered page ─────────────────
	let res = await fetch(`${BASE}/project-status`, { headers: authHeaders });
	const html = await res.text();
	const chunk = html.split('<tr ').find((c) => c.includes(`/project-status/item/${row.id}/status`)) ?? '';
	const marker = tag;
	const rendered = stripTags(chunk);
	const hasStatus = chunk.includes(`value="${target}" selected`) || chunk.includes(`>${target}<`) || rendered.includes(target);
	const hasNote = stripTags(chunk).includes(marker) || chunk.includes(marker);
	const readBack = (await q('SELECT id, status, note FROM project_checklist_items WHERE id = ?', [row.id]))[0];

	const checks = [
		[res.status === 200, `GET /project-status renders (HTTP ${res.status})`],
		[chunk.length > 0, `row [${row.id}] present in the rendered page`],
		[hasStatus, `rendered row shows status "${target}"`],
		[hasNote, `rendered row shows this write (marker ${marker})`],
		[readBack.status === target, `DB read-back status = ${target} (got ${readBack.status})`],
		[readBack.note.includes(marker), 'DB read-back note contains this write'],
	];
	let bad = 0;
	console.log('\nverification:');
	for (const [okc, label] of checks) {
		console.log(`${okc ? '  ok  ' : ' FAIL '} ${label}`);
		if (!okc) bad += 1;
	}
	console.log(`\nrendered note: ${stripTags(chunk).slice(0, 260)}\n`);
	await conn.end();
	if (bad) {
		console.error(`NOT SYNCED — ${bad} verification check(s) failed. The control plane does not reflect this work.\n`);
		process.exit(1);
	}
	console.log(`SYNCED — row [${row.id}] now ${target}, render-verified on ${BASE}/project-status\n`);
})().catch((e) => {
	console.error('ERR', e && e.message ? e.message : e);
	process.exit(1);
});
