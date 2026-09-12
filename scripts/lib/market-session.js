/**
 * Shared clock, session and DB helpers for the market-session verification
 * scripts (rows 877 / 878). Read-only by itself.
 *
 * WHY EVERY WINDOW IS COMPUTED HERE (in this process) AND BOUND AS A PARAMETER:
 * VERIFIED EMPIRICALLY 2026-09-12 (raw DATE_FORMAT reads + UNIX_TIMESTAMP, not JS Dates):
 *   - The MySQL SERVER CLOCK IS CORRECT: NOW(3) = '2026-09-11 19:20:59' when the client's
 *     real UTC was 19:20:58 (epoch delta < 1 s), @@session/@@global time_zone = 'UTC'.
 *   - Columns have TWO different wall-clock bases, because a DATETIME carries no zone:
 *       createdAt / updatedAt ........ server DEFAULT CURRENT_TIMESTAMP -> UTC wall clock
 *       receivedTimestamp, ts, heartbeatAt, orderedAt, signalTs, evaluatedAt
 *         ............................ written through the driver with the client's LOCAL
 *                                      zone (IST, +05:30) -> IST wall clock
 *   - Consequence 1: windowing an IST-based column with a UTC cutoff (or with the server's
 *     NOW()) inflates the window by 5 h 30 m — measured 198,720 "rows in 15 minutes"
 *     against a true 4,133 (~20x), which is how this trap was found.
 *   - Consequence 2: mysql2 parses a naive DATETIME with the CLIENT's zone, so reading a
 *     UTC-stored column (createdAt) into a JS Date yields an instant 5 h 30 m EARLY, while
 *     reading an IST-stored column yields the correct instant. Never do age arithmetic on a
 *     JS Date read of createdAt/updatedAt; compare raw strings in SQL (TIMESTAMPDIFF against
 *     a bound wall string) or DATE_FORMAT it first.
 *   - An earlier note in this file blamed a "5 h 30 m behind" server clock. That was the
 *     driver artifact above, not a server fault.
 *
 * RULES (enforced by windowFor(), and assertable at runtime with probeTimeBases()):
 *   1. `createdAt` (UTC basis) is windowed with utcWall() — correct for every table here;
 *   2. a client-written column is windowed with istWall();
 *   3. probeTimeBases(db) re-derives each column's basis from live data, so a convention
 *      change shows up as a warning instead of as a silently wrong window.
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

/**
 * Wall-clock basis per column, verified empirically (see the header). 'utc' columns come
 * from the server default CURRENT_TIMESTAMP; 'ist' columns are written through the driver
 * with the client's local zone. Windowing the wrong basis is off by 5 h 30 m.
 */
const TIME_BASIS = {
	createdAt: 'utc', updatedAt: 'utc',
	receivedTimestamp: 'ist', ts: 'ist', heartbeatAt: 'ist', orderedAt: 'ist',
	signalTs: 'ist', evaluatedAt: 'ist', fillQuoteTs: 'ist', closedAt: 'ist',
	// pre_open_observations (verified 2026-09-12 from stored rows, not assumed): all three
	// rows written by the 00:45 IST capture carry eventTime '2026-09-11 00:45:41' with
	// createdAt '2026-09-10 19:15:41' — the SAME instant exactly 330 min apart — and
	// pre-open-capture.service.ts derives sessionDate via istDateString(eventTime), so the
	// event/receive columns are market-wall (IST) and only createdAt/updatedAt are UTC.
	eventTime: 'ist', receivedAt: 'ist',
};

/**
 * Window descriptor for a table: which column to window, on which basis, the
 * client-computed cutoff to bind, and the SQL predicate fragment. `alias` qualifies the
 * column for queries with a table alias.
 */
const windowFor = (table, minutes, { column = 'createdAt', now = new Date(), alias = '' } = {}) => {
	const basis = TIME_BASIS[column] ?? 'utc';
	const cutoffDate = new Date(now.getTime() - minutes * 60_000);
	const prefix = alias ? `${alias}.` : '';
	return {
		table,
		column,
		basis,
		cutoff: basis === 'ist' ? istWall(cutoffDate) : utcWall(cutoffDate),
		predicate: `${prefix}\`${column}\` > ?`,
	};
};

/** (table, column) pairs whose basis the probe re-derives from live data. */
const PROBE_COLUMNS = [
	['unified_option_quotes', 'createdAt'], ['unified_option_quotes', 'receivedTimestamp'], ['unified_option_quotes', 'ts'],
	['unified_market_snapshots', 'createdAt'], ['unified_market_snapshots', 'receivedTimestamp'],
	['unified_market_snapshots', 'ts'],
	['pre_open_observations', 'eventTime'], ['pre_open_observations', 'createdAt'],
	['fnf_option_quotes', 'createdAt'], ['fnf_option_quotes', 'ts'],
	['fnf_market_snapshots', 'createdAt'], ['pattern_signals', 'createdAt'],
	['fnf_trades', 'orderedAt'], ['upstox_live_paper_candidates', 'evaluatedAt'],
	['upstox_live_paper_orders', 'createdAt'], ['market_data_feed_leases', 'heartbeatAt'],
];

/**
 * Re-derive each column's wall-clock basis from the newest stored value instead of trusting
 * the table above: a UTC-stored column lands within minutes of the server's UTC now, an
 * IST-stored one lands ~+330 min ahead of it. Anything else is reported as 'unknown' (e.g. a
 * source timestamp like ts, which is stale after the close by design) — never silently assumed.
 * String comparison only: reading these columns as JS Dates is exactly what confused earlier
 * measurements.
 */
const probeTimeBases = async (db) => {
	const [nowRows] = await db.query("SELECT DATE_FORMAT(UTC_TIMESTAMP(3),'%Y-%m-%d %H:%i:%s') AS utcNow");
	const utcNowMs = Date.parse(`${nowRows[0].utcNow}Z`);
	const out = {};
	for (const [table, column] of PROBE_COLUMNS) {
		const key = `${table}.${column}`;
		try {
			const [rows] = await db.query(`SELECT DATE_FORMAT(MAX(\`${column}\`),'%Y-%m-%d %H:%i:%s') AS newest FROM \`${table}\``);
			const newest = rows[0]?.newest ?? null;
			if (!newest) { out[key] = { basis: 'empty' }; continue; }
			const deltaMin = (Date.parse(`${newest}Z`) - utcNowMs) / 60_000;
			const basis = Math.abs(deltaMin) <= 90 ? 'utc' : Math.abs(deltaMin - 330) <= 90 ? 'ist' : 'unknown';
			out[key] = { basis, newest, deltaMin: Number(deltaMin.toFixed(1)), declared: TIME_BASIS[column] ?? 'utc' };
		} catch (error) {
			out[key] = { basis: 'error', error: String(error.message).slice(0, 80) };
		}
	}
	return out;
};

module.exports = {
	ROOT, BASE, IST_OFFSET_MS,
	utcWall, istWall, parseIst, istStamp, isMarketOpen, marketState,
	pool, authGet, lastCanonicalLogLine,
	TIME_BASIS, PROBE_COLUMNS, windowFor, probeTimeBases,
};
