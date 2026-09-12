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

module.exports = { loadArchivedBars, loadArchivedSeries, SERIES };
