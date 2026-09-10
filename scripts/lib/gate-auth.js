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

/** Decrypt the operator password from the DB row the app itself verifies against. */
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

/** Headers that authenticate a server-to-server call — no login, no rate limit. */
async function authHeaders() {
	return { [AUTH_HEADER]: await operatorPassword() };
}

module.exports = { operatorPassword, authHeaders, AUTH_HEADER };
