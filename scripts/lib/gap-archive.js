/**
 * Shared archive loader for the GATE 4 gap engine (research tooling, not production).
 *
 * Extracted so the taxonomy replay and the hypotheses replay load sessions ONE way. It owns
 * exactly one concern: turn the archived daily rows into a session series via the engine's
 * adapter. It contains no gap logic.
 *
 * Session labelling and bar selection are the adapter's rules (see gap-session-series.ts):
 *   * session date = DATE(`ts`) — the broker timestamp in IST inside the market window, NEVER
 *     DATE(createdAt), which carries over past midnight;
 *   * one bar per session = widest high-low span, ties broken by earliest ts.
 */
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SERIES = require(path.join(ROOT, 'dist', 'trading', 'gap-engine', 'gap-session-series'));

/**
 * One bar per session from `fnf_market_snapshots_history`.
 * Returns raw bar rows ready for buildSessionSeries (the adapter does the picking/deriving).
 */
async function loadArchivedBars(db, instrument) {
  const [rows] = await db.query(
    `WITH bars AS (
       SELECT DATE_FORMAT(\`ts\`,'%Y-%m-%d') AS d,
              \`open\` AS o, high AS h, low AS l, \`close\` AS c,
              DATE_FORMAT(\`ts\`,'%Y-%m-%d %H:%i:%s') AS src,
              ROW_NUMBER() OVER (PARTITION BY DATE(\`ts\`) ORDER BY (high - low) DESC, \`ts\` ASC) AS rn
       FROM fnf_market_snapshots_history
       WHERE instrument = ? AND TIME(\`ts\`) BETWEEN '09:15:00' AND '15:30:00'
     ) SELECT d, o, h, l, c, src FROM bars WHERE rn = 1 ORDER BY d ASC`, [instrument]);
  return rows.map((r) => ({
    instrument,
    sessionDate: String(r.d),
    open: Number(r.o),
    high: Number(r.h),
    low: Number(r.l),
    quotedClose: Number(r.c),
    sourceId: String(r.src),
  }));
}

/** Raw bars + the adapter-built series for one instrument. */
async function loadArchivedSeries(db, instrument) {
  const rawBars = await loadArchivedBars(db, instrument);
  return { rawBars, series: SERIES.buildSessionSeries(instrument, rawBars) };
}

/**
 * Intraday paths for the FAILED-ORB candidate: every market-hours row per session, in order.
 *
 * The traded price is the `price` column — that is the one that moves tick to tick (~15 s cadence);
 * the row's open/high/low/close are degenerate copies of it, and `close` is the broker's PREVIOUS
 * close (proven in the row-38 work), never the session's own.
 *
 * `ts` is DECLARED IST (see TIME_BASIS in scripts/lib/market-session.js), so each instant is built
 * with an explicit +05:30 offset — never by handing a bare wall clock to `new Date()`.
 */
async function loadArchivedIntradayPaths(db, instrument, opts = {}) {
	const since = opts.since || '2026-09-01';
	const [rows] = await db.query(
		"SELECT DATE_FORMAT(`ts`,'%Y-%m-%d') AS d, DATE_FORMAT(`ts`,'%Y-%m-%d %H:%i:%s') AS wall_ist, `price` AS price " +
		'FROM fnf_market_snapshots_history ' +
		"WHERE instrument = ? AND DATE(`ts`) >= ? AND TIME(`ts`) BETWEEN '09:15:00' AND '15:30:00' " +
		'ORDER BY `ts` ASC',
		[instrument, since],
	);
	const byDay = new Map();
	for (const r of rows) {
		if (!byDay.has(r.d)) byDay.set(r.d, []);
		byDay.get(r.d).push({ instantMs: Date.parse(String(r.wall_ist).replace(' ', 'T') + '+05:30'), price: Number(r.price) });
	}
	return [...byDay.entries()].map(([sessionDate, points]) => ({ sessionDate, instrument, points }));
}

module.exports = { loadArchivedBars, loadArchivedSeries, loadArchivedIntradayPaths };
