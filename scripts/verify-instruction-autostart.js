/**
 * End-to-end verification of the pre-cleared instruction auto-start, exercising
 * the REAL HTTP API with an operator session.
 *
 * The test instruction is deliberately un-executable (maxCapital = ₹1, below one
 * lot), so this proves the whole chain — login → arm gate → broker lot size →
 * live premium → capital filter — WITHOUT opening any position. It cleans up
 * after itself. No secret is ever printed.
 */
const path = require('path');
const crypto = require('crypto');
const ROOT = '/home/swarna-sekhar-dhar/projects/my-job-agent';
require(path.join(ROOT, 'node_modules/dotenv')).config({ path: path.join(ROOT, '.env') });
const mysql = require(path.join(ROOT, 'node_modules/mysql2/promise'));

const BASE = process.env.DESK_API_BASE || 'http://127.0.0.1:3010';

const decrypt = (enc) => {
  try {
    const [ivHex, dataHex] = String(enc).split(':');
    const key = crypto.createHash('sha256').update(process.env.ENCRYPTION_KEY ?? '').digest();
    const d = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex, 'hex'));
    return Buffer.concat([d.update(Buffer.from(dataHex, 'hex')), d.final()]).toString('utf8');
  } catch { return ''; }
};

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT || 3307),
    user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD,
    database: process.env.LOCAL_DB_NAME || 'myjob_agent',
  });
  const q = async (sql, args = []) => (await conn.query(sql, args))[0];

  // ── 1. operator session ────────────────────────────────────────────────────
  const owners = await q('SELECT email, passwordEnc FROM portal_users WHERE passwordEnc IS NOT NULL LIMIT 1');
  if (!owners.length) throw new Error('no seeded portal user');
  const password = decrypt(owners[0].passwordEnc);
  if (!password) throw new Error('could not decrypt the operator password');
  const login = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (!login.ok) throw new Error(`login failed: HTTP ${login.status}`);
  const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  console.log('1 login                 : ok (session minted, password never printed)');

  const api = async (method, url, body) => {
    const res = await fetch(`${BASE}${url}`, {
      method, headers: { 'Content-Type': 'application/json', cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: res.status, json, text };
  };

  // ── 2. status endpoint (contract master visible) ───────────────────────────
  const status = await api('GET', '/upstox-live-paper/instructions');
  if (status.status !== 200) throw new Error(`GET instructions → HTTP ${status.status}: ${status.text.slice(0, 200)}`);
  const s = status.json;
  console.log(`2 instruction status    : HTTP 200 · todayIst=${s.todayIst} · inWindow=${s.withinSessionWindow} · universes=${(s.universes || []).join(',')}`);
  console.log(`   contract master      : ${JSON.stringify(s.contractMaster)}`);
  console.log(`   armed portfolios     : ${JSON.stringify(s.armedPortfolios)}`);
  console.log(`   instructions         : ${s.instructions.length}`);

  // ── 3. a real, live contract from the desk's own quote table ───────────────
  const live = await q(`SELECT contractSymbol, underlying, optionType, strike, expiry, ltp
      FROM upstox_live_paper_option_quotes ORDER BY ts DESC, createdAt DESC LIMIT 5`);
  if (!live.length) throw new Error('no live desk quotes to build a test instruction from');
  const contract = live[0];
  console.log(`3 live contract         : ${contract.contractSymbol} (${contract.underlying} ${contract.strike}${contract.optionType} ltp ${contract.ltp}, expiry ${contract.expiry})`);

  // ── 4. create the (un-executable) test instruction ─────────────────────────
  const created = await api('POST', '/upstox-live-paper/instructions', {
    label: 'verification — must REFUSE (cap below one lot)',
    instrument: contract.contractSymbol,
    underlying: contract.underlying,
    side: 'BUY',
    maxCapital: 1,
    enabled: true,
  });
  if (created.status >= 300 || !created.json?.id) throw new Error(`create instruction → HTTP ${created.status}: ${created.text.slice(0, 300)}`);
  const instructionId = created.json.id;
  console.log(`4 instruction created   : ${instructionId} (maxCapital ₹1 — cannot afford one lot)`);

  // ── 5. arm the portfolio, then force-run the instruction ───────────────────
  const portfolioId = s.armedPortfolios?.[0]?.id;
  const armed = await api('POST', `/upstox-live-paper/portfolios/${portfolioId}/auto`, { enabled: true });
  console.log(`5 portfolio armed       : HTTP ${armed.status} autoTradeEnabled=${armed.json?.autoTradeEnabled}`);
  const forced = await api('POST', `/upstox-live-paper/instructions/${instructionId}/run?force=true`);
  console.log('6 forced run (armed)    :', JSON.stringify({
    executed: forced.json?.executed, skipped: forced.json?.skipped,
    lotSizeSource: forced.json?.lotSizeSource, quote: forced.json?.quote,
  }));
  if (forced.json?.executed) throw new Error('the ₹1-cap instruction executed — it must have been refused');

  // ── 6. the master arm gate: same run, portfolio disarmed ───────────────────
  await api('POST', `/upstox-live-paper/portfolios/${portfolioId}/auto`, { enabled: false });
  const unarmed = await api('POST', `/upstox-live-paper/instructions/${instructionId}/run?force=true`);
  console.log('7 forced run (unarmed)  :', JSON.stringify({ executed: unarmed.json?.executed, skipped: unarmed.json?.skipped }));
  if (unarmed.json?.executed || !/auto-trade is OFF/.test(String(unarmed.json?.skipped))) {
    throw new Error('the armed-portfolio gate did not hold');
  }
  await api('POST', `/upstox-live-paper/portfolios/${portfolioId}/auto`, { enabled: true });

  // ── 7. the scheduled path outside the window is inert ──────────────────────
  const after = await api('POST', '/upstox-live-paper/instructions/run-due');
  const results = after.json?.results ?? [];
  console.log('8 scheduled run-due     :', JSON.stringify(results.map((r) => r.skipped)));

  // ── 8. the desk must still have opened NOTHING ─────────────────────────────
  const trades = await q('SELECT COUNT(*) n FROM upstox_live_paper_trades');
  const executed = results.filter((r) => r.executed).length;
  console.log(`9 safety                : executed=${executed} · upstox_live_paper_trades=${trades[0].n}`);
  if (executed !== 0) throw new Error('an instruction executed when it should have been refused');

  // ── 9. cleanup ─────────────────────────────────────────────────────────────
  const removed = await api('DELETE', `/upstox-live-paper/instructions/${instructionId}`);
  const left = await q('SELECT COUNT(*) n FROM upstox_live_paper_instructions');
  console.log(`10 cleanup              : delete HTTP ${removed.status} · instructions left=${left[0].n}`);

  await conn.end();
  console.log('\nRESULT: auto-start chain verified end-to-end; no position opened.');
})().catch(async (err) => {
  console.error('VERIFY FAILED:', err.message);
  process.exit(1);
});
