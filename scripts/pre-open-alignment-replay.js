#!/usr/bin/env node
/**
 * GATE 2 #6 (roadmap row 27) — REPLAY the pre-open/cross-market alignment over
 * ARCHIVED rows, so the behaviour is demonstrated on data the project actually
 * stored rather than only on fixtures.
 *
 * Usage:
 *   node scripts/pre-open-alignment-replay.js [--session YYYY-MM-DD] [--asOf HH:MM]
 *
 * Reads wall clocks as SQL strings (DATE_FORMAT) — never as JS Dates — and declares
 * each column's basis from the shared TIME_BASIS table, then reports:
 *   * the aligned frame (rows, per-symbol resolution, coverage);
 *   * every exclusion with its documented reason;
 *   * the independent probeTimeBases() verdict for the columns used, so a reviewer can
 *     see whether the DECLARED basis still matches what the stored values imply.
 *
 * Honest by construction: if the archive holds no usable in-window row (as on
 * 2026-09-12, where 3 pre-open rows exist with no symbol and no auction window was
 * captured), the frame is EMPTY and says so — this tool never manufactures a frame.
 */
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { TIME_BASIS, probeTimeBases } = require('./lib/market-session.js');

const ROOT = path.join(__dirname, '..');
const ALIGN = require(path.join(ROOT, 'dist', 'trading', 'pre-open', 'pre-open-alignment'));

const env = {};
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const argOf = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const basisOf = (column) => (TIME_BASIS[column] === 'ist' ? 'IST' : TIME_BASIS[column] === 'utc' ? 'UTC' : null);

(async () => {
  const db = await mysql.createConnection({
    host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3307),
    user: env.MYSQL_USER, password: env.MYSQL_PASSWORD, database: 'myjob_agent', connectTimeout: 12000,
  });

  // --- pick the session: the newest TRADING day present in the cross-market tape -----
  // `ts` is DECLARED IST (see TIME_BASIS), so its IST day is the date part of the stored
  // wall clock itself — adding a +330 offset here would be the exact double-shift this row
  // exists to prevent. DATE_FORMAT (not DATE) keeps it a STRING: reading a DATE/DATETIME
  // column as a JS Date is the coercion that faked a "server clock is behind" story.
  const [dayRows] = await db.query(
    "SELECT DATE_FORMAT(`ts`,'%Y-%m-%d') AS istDay, COUNT(*) n FROM unified_market_snapshots GROUP BY istDay ORDER BY istDay DESC LIMIT 8");
  const days = dayRows.map((r) => ({ day: String(r.istDay), n: Number(r.n) }));
  const isWeekday = (day) => {
    const wd = new Date(`${day}T12:00:00+05:30`).getUTCDay();
    return wd >= 1 && wd <= 5;
  };
  const newestTrading = (days.find((d) => isWeekday(d.day)) || days[0] || {}).day || null;
  const sessionDate = argOf('session', newestTrading);
  const asOfWall = argOf('asOf', null);
  // Which window the frame is aligned to. The ITEM's window is the pre-open auction
  // (09:00–09:15 IST); 'market' widens it to the continuous session so the aligner can be
  // demonstrated on the rows the archive actually holds. Reported either way.
  const windowMode = argOf('window', 'pre-open');
  const windowStartMin = windowMode === 'market' ? 9 * 60 + 15 : 9 * 60;
  const windowEndMin = windowMode === 'market' ? 15 * 60 + 30 : 9 * 60 + 15;
  const windowStartWall = `${String(Math.floor(windowStartMin / 60)).padStart(2, '0')}:${String(windowStartMin % 60).padStart(2, '0')}:00`;
  const windowEndWall = `${String(Math.floor(windowEndMin / 60)).padStart(2, '0')}:${String(windowEndMin % 60).padStart(2, '0')}:00`;
  console.log(`window=${windowMode} [${windowStartWall} , ${windowEndWall}) IST`);
  console.log(`session=${sessionDate}  (tape days: ${days.map((d) => `${d.day}${isWeekday(d.day) ? '' : ' [non-trading]'}:${d.n}`).join(', ') || 'none'})`);

  const asOfMs = asOfWall ? Date.parse(`${sessionDate}T${asOfWall}:00+05:30`) : undefined;

  // --- archived cross-market rows inside the pre-open window -------------------
  const [cross] = await db.query(
    "SELECT symbol, DATE_FORMAT(`ts`,'%Y-%m-%d %H:%i:%s') AS wall_ist, DATE_FORMAT(`createdAt`,'%Y-%m-%d %H:%i:%s') AS wall_utc, sequenceNumber " +
    "FROM unified_market_snapshots " +
    "WHERE DATE(`ts`) = ? AND TIME(`ts`) >= ? AND TIME(`ts`) < ? " +
    "ORDER BY `ts` ASC LIMIT 400",
    [sessionDate, windowStartWall, windowEndWall]);

  // --- previous session close as the REFERENCE rows -----------------------------
  // The reference must be the previous session's FINAL quotes, not simply the newest
  // archived rows (after-hours rows are CALENDAR_CLOSED and are refused — correctly).
  const [prevDayRows] = await db.query(
    "SELECT DATE_FORMAT(MAX(DATE(`ts`)),'%Y-%m-%d') AS prevDay FROM unified_market_snapshots " +
    "WHERE DATE(`ts`) < ? AND TIME(`ts`) >= '09:15:00' AND TIME(`ts`) <= '15:30:00'", [sessionDate]);
  const prevDay = prevDayRows[0] && prevDayRows[0].prevDay ? String(prevDayRows[0].prevDay) : null;
  const [refs] = prevDay
    ? await db.query(
      "SELECT symbol, DATE_FORMAT(`ts`,'%Y-%m-%d %H:%i:%s') AS wall_ist, `ltp` " +
      "FROM unified_market_snapshots WHERE DATE(`ts`) = ? AND TIME(`ts`) BETWEEN '15:20:00' AND '15:30:00' " +
      "ORDER BY `ts` DESC LIMIT 12", [prevDay])
    : [[]];
  console.log(`reference session: ${prevDay || 'none found'} (${refs.length} closing rows)`);

  // --- archived pre-open observations (eventTime declared IST, cross-checked vs UTC createdAt)
  const [pre] = await db.query(
    "SELECT symbol, DATE_FORMAT(eventTime,'%Y-%m-%d %H:%i:%s') AS wall_ist, DATE_FORMAT(createdAt,'%Y-%m-%d %H:%i:%s') AS wall_utc, sessionPhase, source, quality " +
    "FROM pre_open_observations WHERE DATE(eventTime) = ? LIMIT 200", [sessionDate]);

  const inputs = [];
  for (const r of cross) {
    inputs.push({
      kind: 'CROSS_MARKET', source: 'unified_market_snapshots', symbol: r.symbol,
      wall: String(r.wall_ist).slice(0, 19), basis: basisOf('ts'),
      crossCheck: { wall: r.wall_utc, basis: basisOf('createdAt') },
      sequence: r.sequenceNumber ?? null, values: {},
    });
  }
  for (const r of refs) {
    inputs.push({ kind: 'REFERENCE', source: 'unified_market_snapshots', symbol: r.symbol, wall: String(r.wall_ist).slice(0, 19), basis: basisOf('ts'), values: {} });
  }
  for (const r of pre) {
    inputs.push({
      kind: 'PRE_OPEN', source: `pre_open_observations[${r.source}]`, symbol: r.symbol,
      wall: r.wall_ist, basis: basisOf('eventTime'),
      crossCheck: { wall: r.wall_utc, basis: basisOf('createdAt') },
      values: {},
    });
  }

  const frame = ALIGN.alignPreOpenFrame(inputs, { sessionDate, windowStartMin, windowEndMin, ...(asOfMs ? { asOfMs } : {}) });

  console.log('\n=== FRAME ===');
  console.log(`  version         : ${frame.version}`);
  console.log(`  window (IST)    : ${new Date(frame.windowStartMs).toISOString()} .. ${new Date(frame.windowEndMs).toISOString()} (as instants)`);
  console.log(`  asOfMs          : ${frame.asOfMs}`);
  console.log(`  rows aligned    : ${frame.coverage.rowCount}   symbols: ${frame.coverage.symbolCount}`);
  console.log(`  kind counts     : ${JSON.stringify(frame.coverage.kindCounts)}`);
  console.log(`  source counts   : ${JSON.stringify(frame.coverage.sourceCounts)}`);
  console.log(`  coverage span   : ${frame.coverage.spanMs === null ? 'n/a' : frame.coverage.spanMs + ' ms'}`);
  console.log(`  inputs supplied : ${inputs.length} (cross=${cross.length}, pre_open=${pre.length}, refs=${refs.length})`);

  console.log('\n=== EXCLUSIONS (documented reasons) ===');
  if (!frame.exclusions.length) console.log('  (none)');
  for (const e of frame.exclusions.slice(0, 12)) console.log(`  ${e.reason}: ${e.detail}`);
  if (frame.exclusions.length > 12) console.log(`  ... ${frame.exclusions.length - 12} more`);
  console.log(`  counts: ${JSON.stringify(frame.exclusionCounts)}`);

  console.log('\n=== PER-SYMBOL AT asOf ===');
  if (!frame.symbols.length) console.log('  (no symbol produced a usable row)');
  for (const s of frame.symbols) {
    console.log(`  ${s.symbol}: ${s.status}${s.reason ? ' — ' + s.reason : ''} (rows=${s.informativeRows})`);
  }

  console.log('\n=== INDEPENDENT BASIS PROBE (declared vs stored) ===');
  const probe = await probeTimeBases(db);
  for (const key of ['unified_market_snapshots.ts', 'unified_market_snapshots.createdAt', 'pre_open_observations.eventTime', 'pre_open_observations.createdAt']) {
    const p = probe[key];
    console.log(`  ${key}: declared=${p?.declared ?? '?'} stored=${p?.basis ?? '?'} newest=${p?.newest ?? '-'} deltaMin=${p?.deltaMin ?? '-'}`);
  }

  const crypto = require('crypto');
  const digestHash = crypto.createHash('sha256').update(frame.digest).digest('hex').slice(0, 16);
  console.log(`\nREPLAY_DIGEST_SHA256 ${digestHash}  (full digest length ${frame.digest.length} chars)`);
  console.log(`FRAME_ROWS ${frame.coverage.rowCount}  SYMBOLS ${frame.coverage.symbolCount}  EXCLUSIONS ${frame.exclusions.length}`);
  await db.end();
})().catch((e) => { console.error('REPLAY FAILED', e.code || '', e.message || '', e.sqlMessage ? `\n  sql: ${e.sqlMessage}` : ''); process.exit(1); });
