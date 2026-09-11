/**
 * Shared clock, session and DB helpers for the market-session verification
 * scripts (rows 877 / 878). Read-only by itself.
 *
 * WHY EVERY WINDOW IS COMPUTED HERE (in this process) AND BOUND AS A PARAMETER:
 * the Oracle Cloud MySQL server's clock was measured on 2026-09-11 to run
 * ~5 h 30 m behind real UTC, while the columns the app writes (`createdAt`) carry
 * the CLIENT's UTC time. A server-side window (`createdAt > NOW() - INTERVAL n`)
 * therefore spans hours and overstates rates ~20x (measured: 198,720 "rows in 15
 * minutes" vs the true 4,133). Never window client-written timestamps with the DB
 * server clock.
 *
 * Column conventions in this database (verified):
 *   createdAt / updatedAt  -> written by the client in UTC        (use utcWall)
 *   ts, heartbeatAt, lease -> naive local wall clock = IST        (use istWall)
 */
const path = require('path');
const ROOT = '/home/swarna-sekhar-dhar/projects/my-job-agent';
require(path.join(ROOT, 'node_modules/dotenv')).config({ path: path.join(ROOT, '.env') });
const mysql = require(path.join(ROOT, 'node_modules/mysql2/promise'));

const IST_OFFSET_MS = 5.5 * 3_600_000;

/** 'YYYY-MM-DD HH:MM:SS' in UTC — for columns the app writes in UTC (createdAt). */
const utcWall = (d = new Date()) => d.toISOString().slice(0, 19).replace('T', ' ');

/** 'YYYY-MM-DD HH:MM:SS' in IST — for the naive wall-clock columns (ts, heartbeatAt). */
const istWall = (d = new Date()) => new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ');

/** Parse a naive DATETIME read back from MySQL as IST wall clock. */
const parseIst = (value) => {
	if (value instanceof Date) return value;
	const text = String(value ?? '').trim().replace('T', ' ').replace(/(\.\d+)?Z?$/, '');
	if (!text) return null;
	const date = new Date(`${text.replace(' ', 'T')}+05:30`);
	return Number.isNaN(date.getTime()) ? null : date;
};

const istParts = (d = new Date()) => {
	const x = new Date(d.getTime() + IST_OFFSET_MS);
	return { y: x.getUTCFullYear(), mo: x.getUTCMonth() + 1, d: x.getUTCDate(), h: x.getUTCHours(), mi: x.getUTCMinutes(), dow: x.getUTCDay() };
};

const pad = (n) => String(n).padStart(2, '0');
const istStamp = (d = new Date()) => {
	const p = istParts(d);
	return `${pad(p.d)}-${pad(p.mo)}-${p.y} ${pad(p.h)}:${pad(p.mi)} IST`;
};

const SESSION_OPEN_MIN = 9 * 60 + 15;
const SESSION_CLOSE_MIN = 15 * 60 + 30;

/** NSE/BSE session: Mon-Fri 09:15-15:30 IST. */
const isMarketOpen = (d = new Date()) => {
	const p = istParts(d);
	if (p.dow === 0 || p.dow === 6) return false;
	const mins = p.h * 60 + p.mi;
	return mins >= SESSION_OPEN_MIN && mins <= SESSION_CLOSE_MIN;
};

/** Human-readable session state, used by every guard message. */
const marketState = (d = new Date()) => {
	const p = istParts(d);
	const mins = p.h * 60 + p.mi;
	if (p.dow === 0 || p.dow === 6) return `weekend (${istStamp(d)})`;
	if (mins < SESSION_OPEN_MIN) return `pre-open (${istStamp(d)})`;
	if (mins > SESSION_CLOSE_MIN) return `after close (${istStamp(d)})`;
	return `OPEN (${istStamp(d)})`;
};

/** Fresh mysql2 pool (Oracle Cloud MySQL through the SSH tunnel; no local DB). */
const pool = async () => mysql.createPool({
	host: process.env.MYSQL_HOST,
	port: Number(process.env.MYSQL_PORT || 3307),
	user: process.env.MYSQL_USER,
	password: process.env.MYSQL_PASSWORD,
	database: process.env.DATABASE_NAME || 'myjob_agent',
	connectTimeout: 45_000,
	connectionLimit: 3,
});

/** Base URL of the running app (status/API reads). */
const BASE = process.env.PROJECT_STATUS_BASE || process.env.DESK_API_BASE || 'http://127.0.0.1:3010';

/** Authenticated GET (operator-password header — never /auth/login, which is rate limited). */
const authGet = async (route) => {
	const { authHeaders } = require('./gate-auth');
	const res = await fetch(`${BASE}${route}`, { headers: await authHeaders(), redirect: 'manual' });
	if (res.status === 401) throw new Error(`operator auth refused for ${route} (portal_users.passwordEnc vs ENCRYPTION_KEY)`);
	const text = await res.text();
	if (!res.ok) throw new Error(`GET ${route} -> HTTP ${res.status} ${text.slice(0, 200)}`);
	try {
		return JSON.parse(text);
	} catch {
		throw new Error(`GET ${route} did not answer JSON (SPA fallback?): ${text.replace(/\s+/g, ' ').slice(0, 120)}`);
	}
};

/** Last `[CANONICAL] …` summary line logged by the socket-owner process. */
const lastCanonicalLogLine = () => {
	const fs = require('fs');
	const candidates = [
		path.join(process.env.HOME || '/home/swarna-sekhar-dhar', '.pm2/logs/trading-agent-out.log'),
		path.join(process.env.HOME || '/home/swarna-sekhar-dhar', '.pm2/logs/trading-agent-error.log'),
	];
	for (const file of candidates) {
		try {
			const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.includes('[CANONICAL]'));
			if (lines.length) return lines[lines.length - 1].trim();
		} catch { /* file may not exist */ }
	}
	return null;
};

module.exports = {
	ROOT, BASE, IST_OFFSET_MS,
	utcWall, istWall, parseIst, istStamp, isMarketOpen, marketState,
	pool, authGet, lastCanonicalLogLine,
};
