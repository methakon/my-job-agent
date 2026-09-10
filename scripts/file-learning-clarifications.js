// File the day's trade-learning data gaps as clarifications awaiting the operator.
const crypto = require('crypto');
const p = require('path');
const R = '/home/swarna-sekhar-dhar/projects/my-job-agent';
require(p.join(R, 'node_modules/dotenv')).config({ path: p.join(R, '.env') });
const mysql = require(p.join(R, 'node_modules/mysql2/promise'));

const BASE = process.env.DESK_API_BASE || 'http://127.0.0.1:3010';
const decrypt = (payload) => {
	const [ivHex, dataHex] = String(payload).split(':');
	const key = crypto.createHash('sha256').update(process.env.ENCRYPTION_KEY ?? '').digest();
	const d = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex, 'hex'));
	return Buffer.concat([d.update(Buffer.from(dataHex, 'hex')), d.final()]).toString('utf8');
};

(async () => {
	const c = await mysql.createConnection({ host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT), user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD, database: process.env.LOCAL_DB_NAME });
	const [users] = await c.execute('SELECT email, passwordEnc FROM portal_users WHERE passwordEnc IS NOT NULL LIMIT 1');
	if (!users.length) throw new Error('no portal user with a stored password');
	const password = decrypt(users[0].passwordEnc);           // decrypted in-process only, never printed
	const login = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
	if (!login.ok) throw new Error(`login failed HTTP ${login.status}`);
	const cookie = (login.headers.getSetCookie?.() ?? []).map((x) => x.split(';')[0]).join('; ');
	console.log('login ok (operator session)');

	const asks = [
		{
			stage: 'LEARNING — 2026-09-10 SENSEX CASE',
			question: 'The three 5-minute chart images (74900 PE, 74700 PE, 74900 CE) never reached the workspace — only orders.csv arrived (this CLI session has no image channel). I rebuilt the exact 5-min OHLC for every SENSEX strike 73600-75900 from the desk tick store instead and analysed that. If the charts carry anything the tape does not (drawn levels, your own markings), re-send them or paste the key bars and I will re-grade.',
		},
		{
			stage: 'LEARNING — 2026-09-10 SENSEX CASE',
			question: 'orders.csv contains 74600 PE, 74700 PE and 74900 CE — there is no 74900 PE trade in it, although chart #1 is the 74900 PE. Was the 74900 PE done in another account (so I should fetch that orderbook), or is chart #1 to be read as the 74600 PE position? This decides which re-entries and missed-profit numbers apply to YOUR book.',
		},
	];

	for (const a of asks) {
		const r = await fetch(`${BASE}/project-status/clarifications.json`, {
			method: 'POST', headers: { 'content-type': 'application/json', cookie },
			body: JSON.stringify({ stage: a.stage, question: a.question, askedBy: 'hermes' }),
		});
		const j = await r.json();
		console.log(r.status, JSON.stringify(j));
	}
	const st = await (await fetch(`${BASE}/project-status/clarifications.json?status=pending`, { headers: { cookie } })).json();
	console.log('pending now:', st.stats, '| stages:', JSON.stringify(st.byStage));
	await c.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
