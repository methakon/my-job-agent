/**
 * Shared operator session for the /project-status gate tooling.
 *
 * Why this exists: `/auth/login` is strictly rate limited (10 attempts / 15 min —
 * see src/main.ts). The writer and the drift guard both need a session cookie, so
 * hammering `/auth/login` on every run locks the tooling out of its own control
 * plane. Both scripts therefore share ONE cached cookie.
 *
 * Never hard-codes a credential: the operator password is decrypted from
 * `portal_users.passwordEnc` (AES-256-CBC under ENCRYPTION_KEY) — the same
 * database-first contract the app's login page uses.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const CACHE_PATH = process.env.GATE_COOKIE_CACHE || path.join(os.homedir(), '.hermes', '.gate-cookie.json');
const TTL_MS = Number(process.env.GATE_COOKIE_TTL_MS || 10 * 60 * 1000);

function loadCookie(base) {
	try {
		const j = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
		if (j && j.cookie && j.base === base && Date.now() - j.at < TTL_MS) return j.cookie;
	} catch {
		/* no cache yet */
	}
	return null;
}

function storeCookie(base, cookie) {
	try {
		fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
		fs.writeFileSync(CACHE_PATH, JSON.stringify({ base, at: Date.now(), cookie }), { mode: 0o600 });
	} catch {
		/* cache is an optimisation only */
	}
}

function clearCookie() {
	try {
		fs.unlinkSync(CACHE_PATH);
	} catch {
		/* nothing cached */
	}
}

async function operatorPassword() {
	const mysql = require('mysql2/promise');
	const conn = await mysql.createConnection({
		host: process.env.MYSQL_HOST,
		port: Number(process.env.MYSQL_PORT || 3307),
		user: process.env.MYSQL_USER,
		password: process.env.MYSQL_PASSWORD,
		database: process.env.DATABASE_NAME || 'myjob_agent', // Oracle Cloud MySQL (tunnel) — no local DB exists
	});
	try {
		const [users] = await conn.query(
			'SELECT passwordEnc FROM portal_users WHERE passwordEnc IS NOT NULL LIMIT 1',
		);
		if (!users.length) throw new Error('no portal_users row carries a password');
		const [ivHex, dataHex] = String(users[0].passwordEnc).split(':');
		const key = crypto.createHash('sha256').update(process.env.ENCRYPTION_KEY ?? '').digest();
		const d = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex, 'hex'));
		return Buffer.concat([d.update(Buffer.from(dataHex, 'hex')), d.final()]).toString('utf8');
	} finally {
		await conn.end();
	}
}

/**
 * @returns {Promise<{cookie: string|null, source: 'cache'|'login', detail: string, loginStatus?: number}>}
 */
async function session(base, { force = false } = {}) {
	if (!force) {
		const cached = loadCookie(base);
		if (cached) return { cookie: cached, source: 'cache', detail: 'cached session cookie (login rate limit spared)' };
	}
	const password = await operatorPassword();
	const res = await fetch(`${base}/auth/login`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ password }),
	});
	const cookie = ((res.headers.getSetCookie && res.headers.getSetCookie()) || [])
		.map((cp) => cp.split(';')[0])
		.join('; ');
	const rate = res.status === 429 ? ' — /auth/login allows 10 attempts / 15 min (src/main.ts)' : '';
	if (!cookie) {
		return {
			cookie: null,
			source: 'login',
			loginStatus: res.status,
			detail: `login HTTP ${res.status} returned no session cookie${rate}`,
		};
	}
	if (res.status >= 400) {
		return { cookie, source: 'login', loginStatus: res.status, detail: `login HTTP ${res.status}${rate}` };
	}
	storeCookie(base, cookie);
	return { cookie, source: 'login', loginStatus: res.status, detail: `fresh operator login (HTTP ${res.status})` };
}

module.exports = { session, clearCookie, CACHE_PATH };
