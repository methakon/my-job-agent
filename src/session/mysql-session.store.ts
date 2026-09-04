import session from 'express-session';
import { createPool, Pool } from 'mysql2/promise';

/**
 * J-04 — MySQL-backed session store so logins survive pm2 restarts (the
 * default MemoryStore dies with the process). Dedicated mysql2 pool from .env;
 * single `sessions` table (sid PK, sess JSON, expire). Set/read paths follow
 * express-session's Store contract; touch() refreshes the expiry for rolling
 * sessions without a full round-trip write.
 */
export class MysqlSessionStore extends session.Store {
	private pool: Pool;
	private readonly ttlMs: number;

	constructor(ttlMs = 24 * 60 * 60 * 1000) {
		super();
		this.ttlMs = ttlMs;
		this.pool = createPool({
			host: process.env.MYSQL_HOST || '127.0.0.1',
			port: Number(process.env.MYSQL_PORT || 3306),
			user: process.env.MYSQL_USER || 'root',
			password: process.env.MYSQL_PASSWORD || '',
			database: process.env.MYSQL_DATABASE || 'myjob_agent',
			connectionLimit: 4,
			namedPlaceholders: true,
		});
		this.pool
			.query('SELECT 1')
			.then(() => this.pool.query('DELETE FROM sessions WHERE expire < NOW()'))
			.catch((err) => console.error('[session-store] mysql init failed:', String(err).slice(0, 200)));
	}

	private expireDate(): Date {
		return new Date(Date.now() + this.ttlMs);
	}

	get(sid: string, cb: (err: unknown, session?: session.SessionData | null) => void): void {
		this.pool
			.query('SELECT sess, expire FROM sessions WHERE sid = ?', [sid])
			.then(([rows]) => {
				const row = (rows as Array<{ sess: string; expire: Date }>)[0];
				if (!row) return cb(null, null);
				if (new Date(row.expire).getTime() < Date.now()) {
					this.pool.query('DELETE FROM sessions WHERE sid = ?', [sid]).catch(() => undefined);
					return cb(null, null);
				}
				let data: session.SessionData;
				try {
					data = JSON.parse(row.sess);
				} catch {
					return cb(null, null);
				}
				cb(null, data);
			})
			.catch((err) => cb(err));
	}

	set(sid: string, sess: session.SessionData, cb?: (err?: unknown) => void): void {
		this.pool
			.query('INSERT INTO sessions (sid, sess, expire) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE sess = VALUES(sess), expire = VALUES(expire)', [
				sid,
				JSON.stringify(sess),
				this.expireDate(),
			])
			.then(() => cb?.())
			.catch((err) => cb?.(err));
	}

	destroy(sid: string, cb?: (err?: unknown) => void): void {
		this.pool
			.query('DELETE FROM sessions WHERE sid = ?', [sid])
			.then(() => cb?.())
			.catch((err) => cb?.(err));
	}

	touch(sid: string, sess: session.SessionData, cb?: (err?: unknown) => void): void {
		this.pool
			.query('UPDATE sessions SET expire = ? WHERE sid = ?', [this.expireDate(), sid])
			.then(() => cb?.())
			.catch((err) => cb?.(err));
	}
}
