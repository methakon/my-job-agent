/**
 * End-to-end verification of the /project-status clarification store.
 *
 * Proves, against the REAL HTTP surface with an operator session:
 *   - a pending clarification paints its checklist row YELLOW (class row-clarify)
 *   - the operator's saved answer clears the yellow and the item then reports how
 *     many clarifications have been given
 *   - the answer is persisted in MySQL (read back from project_clarifications)
 *   - form POSTs and the JSON API both work, and blank input is rejected
 * It creates ONE throwaway question on an item that has none, and deletes that
 * row at the end, so the seeded questions are left untouched.
 */
const path = require('path');
const crypto = require('crypto');
const ROOT = '/home/swarna-sekhar-dhar/projects/my-job-agent';
require(path.join(ROOT, 'node_modules/dotenv')).config({ path: path.join(ROOT, '.env') });
const mysql = require(path.join(ROOT, 'node_modules/mysql2/promise'));

const BASE = process.env.DESK_API_BASE || 'http://127.0.0.1:3010';
const fails = [];
const ok = (cond, label, extra = '') => {
	console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}${extra ? ` — ${extra}` : ''}`);
	if (!cond) fails.push(label);
};

const decrypt = (enc) => {
	try {
		const [ivHex, dataHex] = String(enc).split(':');
		const key = crypto.createHash('sha256').update(process.env.ENCRYPTION_KEY ?? '').digest();
		const d = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex, 'hex'));
		return Buffer.concat([d.update(Buffer.from(dataHex, 'hex')), d.final()]).toString('utf8');
	} catch {
		return '';
	}
};

(async () => {
	const conn = await mysql.createConnection({
		host: process.env.MYSQL_HOST,
		port: Number(process.env.MYSQL_PORT || 3307),
		user: process.env.MYSQL_USER,
		password: process.env.MYSQL_PASSWORD,
		database: process.env.LOCAL_DB_NAME || 'myjob_agent',
	});
	const q = async (sql, args = []) => (await conn.query(sql, args))[0];

	// ── 1. operator session ────────────────────────────────────────────────────
	const users = await q('SELECT email, passwordEnc FROM portal_users WHERE passwordEnc IS NOT NULL LIMIT 1');
	if (!users.length) throw new Error('no seeded portal user');
	const password = decrypt(users[0].passwordEnc);
	const login = await fetch(`${BASE}/auth/login`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ password }),
	});
	if (!login.ok) throw new Error(`login failed: HTTP ${login.status}`);
	const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
	console.log('1 login                        : ok (operator session, password never printed)');

	const page = async () => {
		const res = await fetch(`${BASE}/project-status`, { headers: { cookie } });
		return { status: res.status, html: await res.text() };
	};
	// the <tr ...> chunk that owns a given item id
	const rowChunk = (html, itemId) =>
		html.split('<tr ').find((c) => c.includes(`/project-status/item/${itemId}/status`)) ?? '';

	// ── 2. seeded questions are live and yellow ────────────────────────────────
	const seeded = await q(
		`SELECT c.id, c.itemId, c.stage, c.status, LEFT(c.question, 60) q, i.item
       FROM project_clarifications c
       LEFT JOIN project_checklist_items i ON i.id = c.itemId
      ORDER BY c.id`,
	);
	ok(seeded.length > 0, 'seeded clarifications exist', `${seeded.length} rows`);
	const pending = seeded.filter((r) => r.status !== 'answered');
	ok(pending.length > 0, 'seeded questions are pending', `${pending.length} pending`);
	ok(
		seeded.every((r) => r.itemId === null || r.item !== null),
		'every item-linked question points at a real checklist row',
	);
	seeded
		.filter((r) => r.itemId !== null)
		.forEach((r) => console.log(`       #${r.id} → item ${r.itemId}: ${String(r.item).slice(0, 70)}`));

	const p0 = await page();
	ok(p0.status === 200, 'GET /project-status', `HTTP ${p0.status}`);
	const linked = seeded.filter((r) => r.itemId !== null && r.status !== 'answered');
	ok(
		linked.every((r) => /row-clarify/.test(rowChunk(p0.html, r.itemId))),
		'the checklist rows with a PENDING question are yellow (row-clarify)',
		`${linked.length} row(s)`,
	);
	ok(p0.html.includes('awaiting clarification'), 'page shows the awaiting-clarification badge');
	ok(!/row-clarify[^>]*>\s*<td class="num">\s*<\/td>/.test(p0.html), 'no malformed yellow row markup');

	// ── 3. JSON view of the same store ─────────────────────────────────────────
	const j0 = await fetch(`${BASE}/project-status/clarifications.json?status=pending`, { headers: { cookie } });
	const j = await j0.json();
	ok(j0.status === 200 && j.stats, 'GET clarifications.json', `pending=${j.stats?.pending} given=${j.stats?.answered} total=${j.stats?.total}`);
	ok(j.stats.pending === pending.length, 'JSON pending count matches the table', `${j.stats.pending}`);
	ok(Array.isArray(j.byStage) && j.byStage.length > 0, 'stage-level counts present', `${j.byStage.length} stage(s)`);

	// ── 4. a throwaway question on an item that has none ───────────────────────
	const free = await q(
		`SELECT id, item_order, item FROM project_checklist_items
      WHERE id NOT IN (SELECT itemId FROM project_clarifications WHERE itemId IS NOT NULL)
      ORDER BY id LIMIT 1`,
	);
	if (!free.length) throw new Error('no free checklist item to test on');
	const itemId = free[0].id;
	const askRes = await fetch(`${BASE}/project-status/clarifications.json`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', cookie },
		body: JSON.stringify({ itemId, question: 'verification probe — answer me and the yellow must clear' }),
	});
	const asked = await askRes.json();
	ok([200, 201].includes(askRes.status) && asked.ok === true, 'POST clarifications.json files a question', `id=${asked.id}`);
	const cid = asked.id;

	const p1 = await page();
	ok(/row-clarify/.test(rowChunk(p1.html, itemId)), 'the new question turned its row yellow', `item ${itemId}`);

	// blank answer must be refused
	const blank = await fetch(`${BASE}/project-status/clarifications/${cid}/answer`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie },
		body: 'answer=',
		redirect: 'manual',
	});
	ok(blank.status === 400, 'a blank clarification is refused (HTTP 400)');

	// ── 5. the operator saves the clarification (form path, as the page does) ──
	const answerText = 'verification answer supplied through the project-status form';
	const saved = await fetch(`${BASE}/project-status/clarifications/${cid}/answer`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie },
		body: `answer=${encodeURIComponent(answerText)}`,
		redirect: 'manual',
	});
	ok(saved.status === 303, 'form POST saved the answer (303 back to the page)', `HTTP ${saved.status}`);

	const p2 = await page();
	const chunk2 = rowChunk(p2.html, itemId);
	ok(!/row-clarify/.test(chunk2), 'the yellow is GONE once the clarification is given');
	ok(/💬 1 clarification given/.test(chunk2), 'the item now shows the number of clarifications given', '💬 1 clarification given');

	const dbRow = await q('SELECT status, answer, answeredAt FROM project_clarifications WHERE id = ?', [cid]);
	ok(
		dbRow[0]?.status === 'answered' && dbRow[0]?.answer === answerText && !!dbRow[0]?.answeredAt,
		'the answer is persisted in MySQL (project_clarifications)',
		`status=${dbRow[0]?.status} answeredAt=${dbRow[0]?.answeredAt?.toISOString?.() ?? dbRow[0]?.answeredAt}`,
	);

	// ── 6. reopen sends it back to yellow; JSON answer closes it again ─────────
	const reopened = await fetch(`${BASE}/project-status/clarifications/${cid}/reopen`, {
		method: 'POST',
		headers: { cookie },
		redirect: 'manual',
	});
	ok(reopened.status === 303, 'reopen POST works', `HTTP ${reopened.status}`);
	ok(/row-clarify/.test(rowChunk(await page().then((p) => p.html), itemId)), 'a reopened question turns the row yellow again');

	const jsonAns = await fetch(`${BASE}/project-status/clarifications/${cid}/answer.json`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', cookie },
		body: JSON.stringify({ answer: 'second answer, JSON path' }),
	});
	const ja = await jsonAns.json();
	ok([200, 201].includes(jsonAns.status) && ja.ok === true && ja.status === 'answered', 'POST clarifications/:id/answer.json works', JSON.stringify(ja));

	const counts = await q(
		`SELECT COUNT(*) total, SUM(status = 'answered') given, SUM(status <> 'answered') pend FROM project_clarifications`,
	);
	console.log(`2 store                        : total=${counts[0].total} given=${counts[0].given} pending=${counts[0].pend}`);

	// ── 7. cleanup: remove only the throwaway probe ────────────────────────────
	const del = await q('DELETE FROM project_clarifications WHERE id = ? AND question LIKE ?', [cid, 'verification probe%']);
	ok((del.affectedRows ?? 0) === 1, 'probe removed (seeded questions untouched)');
	const left = await q('SELECT COUNT(*) n FROM project_clarifications');
	console.log(`3 cleanup                      : project_clarifications left=${left[0].n}`);

	await conn.end();
	if (fails.length) {
		console.error(`\nRESULT: FAILED — ${fails.length} check(s): ${fails.join(' | ')}`);
		process.exit(1);
	}
	console.log('\nRESULT: clarification store verified end-to-end (yellow while pending, count after the answer).');
})().catch((err) => {
	console.error('VERIFY FAILED:', err.message);
	process.exit(1);
});
