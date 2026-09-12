/**
 * Shared operator auth for the /project-status gate tooling.
 *
 * Why this exists: the tooling must authenticate exactly the way the app allows
 * for server-to-server callers. `src/auth/conditional-auth.guard.ts` accepts a
 * correct operator password in the `x-operator-password` header on ANY protected
 * route (and mints a session for it), while `POST /auth/login` is strictly rate
 * limited to 10 attempts / 15 min (src/main.ts). Using the header therefore needs
 * no session juggling and cannot lock the tooling out of its own control plane.
 *
 * Never hard-codes a credential: the password is decrypted from the
 * `portal_users.passwordEnc` row (AES-256-CBC under ENCRYPTION_KEY) — the same
 * database-first contract the login page uses. The value is never logged.
 */
const crypto = require('crypto');

const AUTH_HEADER = 'x-operator-password';

/**
 * Resolve the database target, or refuse.
 *
 * mysql2 defaults host to `localhost` and port to 3306 when they are undefined — and a MySQL
 * listener DOES exist on this machine's 127.0.0.1:3306, so a caller that forgot to load `.env`
 * into `process.env` used to get a silent connection (or a confusing ETIMEDOUT) against a
 * database that is never a store for this project. Fail immediately and say why instead.
 */
function dbTarget() {
	const host = process.env.MYSQL_HOST ? String(process.env.MYSQL_HOST).trim() : '';
	const portRaw = process.env.MYSQL_PORT ? String(process.env.MYSQL_PORT).trim() : '';
	if (!host) {
		throw new Error(
			'gate-auth: MYSQL_HOST is not set. Refusing to let mysql2 default to localhost, and refusing any :3306 target — the only store for this project is Oracle Cloud MySQL through the tunnel (MYSQL_* in .env). Load .env into process.env before requiring the gate tooling.',
		);
	}
	if (!portRaw) {
		throw new Error(
			'gate-auth: MYSQL_PORT is not set. Refusing to let mysql2 default to 3306 (a local listener exists on this host and is NOT a store for this project). Set MYSQL_PORT to the tunnel port (3307) via .env.',
		);
	}
	const port = Number(portRaw);
	if (!Number.isInteger(port) || port <= 0) throw new Error(`gate-auth: MYSQL_PORT is not a valid port: "${portRaw}"`);
	return { host, port };
}

/** Decrypt the operator password from the DB row the app itself verifies against. */
async function operatorPassword() {
	const mysql = require('mysql2/promise');
	const { host, port } = dbTarget();
	const conn = await mysql.createConnection({
		host,
		port,
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

/** Headers that authenticate a server-to-server call — no login, no rate limit. */
async function authHeaders() {
	return { [AUTH_HEADER]: await operatorPassword() };
}

module.exports = { operatorPassword, authHeaders, dbTarget, AUTH_HEADER };
