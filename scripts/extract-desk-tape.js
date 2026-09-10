// Extract the SENSEX option tape + index.json (authoritative metadata) for analysis.
const fs = require('fs');
const p = require('path');
const R = '/home/swarna-sekhar-dhar/projects/my-job-agent';
require(p.join(R, 'node_modules/dotenv')).config({ path: p.join(R, '.env') });
const mysql = require(p.join(R, 'node_modules/mysql2/promise'));

const OUT = process.argv[2] || '/tmp/sx-tape';
const DATE = process.argv[3] || '2026-09-10';
const FROM = process.argv[4] || '12:00:00';
const TO = process.argv[5] || '15:35:00';
fs.mkdirSync(OUT, { recursive: true });
const head = 'ts,ltp,bid,ask,bidQty,askQty,volume,openInterest,oiChange,iv,delta,gamma,theta,vega,underlyingPrice';

(async () => {
  const db = await mysql.createConnection({
    host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT),
    user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD,
    database: process.env.LOCAL_DB_NAME || 'myjob_agent', dateStrings: true,
  });
  const [meta] = await db.query(
    `SELECT contractSymbol s, underlying u, CAST(strike AS UNSIGNED) k, optionType t, expiry e
       FROM upstox_live_paper_option_quotes WHERE underlying IS NOT NULL GROUP BY contractSymbol, underlying, strike, optionType, expiry`);
  const index = {};
  for (const m of meta) index[m.s] = { underlying: m.u, expiry: m.e, strike: m.k, optionType: m.t };
  fs.writeFileSync(`${p.join(OUT, 'index.json')}`, JSON.stringify(index, null, 2));

  let wrote = 0;
  for (const sym of Object.keys(index)) {
    const [rows] = await db.query(
      `SELECT ts, ltp, bid, ask, bidQty, askQty, volume, openInterest, oiChange,
              impliedVolatility, delta, gamma, theta, vega, underlyingPrice
         FROM upstox_live_paper_option_quotes
        WHERE contractSymbol=? AND ts >= ? AND ts <= ? ORDER BY ts`, [sym, `${DATE} ${FROM}`, `${DATE} ${TO}`]);
    fs.writeFileSync(`${p.join(OUT, sym + '.csv')}`,
      head + '\n' + rows.map((r) => [r.ts, r.ltp, r.bid, r.ask, r.bidQty, r.askQty, r.volume, r.openInterest,
        r.oiChange, r.impliedVolatility, r.delta, r.gamma, r.theta, r.vega, r.underlyingPrice].join(',')).join('\n') + '\n');
    wrote++;
  }
  const [snaps] = await db.query(
    `SELECT ts, instrument, price, bid, ask, volume, open, high, low, close, dataSource
       FROM upstox_live_paper_market_snapshots WHERE ts >= ? AND ts <= ? ORDER BY ts`, [`${DATE} ${FROM}`, `${DATE} ${TO}`]);
  fs.writeFileSync(`${p.join(OUT, 'snapshots.csv')}`,
    'ts,instrument,price,bid,ask,volume,open,high,low,close,dataSource\n' +
    snaps.map((r) => [r.ts, r.instrument, r.price, r.bid, r.ask, r.volume, r.open, r.high, r.low, r.close, r.dataSource].join(',')).join('\n') + '\n');
  console.log(`wrote ${wrote} contract files + index.json + snapshots.csv (${snaps.length} snapshots) to ${OUT}`);
  await db.end();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
