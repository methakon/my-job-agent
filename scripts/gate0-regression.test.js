#!/usr/bin/env node
/**
 * Gate-0 regression tests (v5 "Done when": old behavior passes regression tests
 * AND a negative test proves new code cannot bypass the guard).
 *
 * Protected invariants of the paper desk:
 *   1. Option-only hard guard — openTrade rejects *-INDEX and unregistered symbols
 *   2. ₹5,000 = capital FILTER, not instrument-selection rule
 *   3. NO TRADE is a first-class outcome (empty signal list when nothing qualifies)
 *   4. Envelope ceiling = capital + netPnl (auto-grow/shrink by profit−charges)
 *   5. Local Greeks / |delta| band helpers (T-09) behave deterministically
 */
const assert = require('node:assert/strict');

// ---- pure logic checks (dist, no DB) ----
const { localGreeks, impliedVol } = require('../dist/trading/bsm-greeks');

function greeksTests() {
  // textbook ATM call: S=100 K=100 T=1 r=5% premium 10.45 → IV ≈ 0.20, delta ≈ 0.637
  const g = localGreeks(10.45, { spot: 100, strike: 100, years: 1, rate: 0.05, q: 0 }, 'CE');
  assert.ok(g, 'localGreeks returns result');
  assert.ok(Math.abs(g.iv - 0.20) < 0.005, `ATM IV ≈ 0.20 (got ${g.iv})`);
  assert.ok(Math.abs(g.delta - 0.637) < 0.01, `ATM delta ≈ 0.637 (got ${g.delta})`);
  assert.ok(g.gamma > 0 && g.theta < 0 && g.vega > 0, 'gamma>0, theta<0 (long), vega>0');

  // PE mirror: negative delta, same IV
  const gp = localGreeks(5.57, { spot: 100, strike: 100, years: 1, rate: 0.05, q: 0 }, 'PE');
  assert.ok(gp && gp.delta < 0, `PE delta negative (got ${gp && gp.delta})`);
  assert.ok(Math.abs(gp.iv - 0.20) < 0.005, `PE IV ≈ 0.20 (got ${gp && gp.iv})`);

  // deep-OTM call: low delta (< 0.1 territory for far strikes) → would be filtered
  // by the |delta| 0.10–0.40 band gate.
  const far = localGreeks(0.5, { spot: 100, strike: 130, years: 1 / 12, rate: 0.065, q: 0 }, 'CE');
  if (far) assert.ok(far.delta < 0.15, `far-OTM delta small (got ${far.delta})`);

  // invalid inputs → null (no crash, safe explicit state)
  assert.equal(localGreeks(-5, { spot: 100, strike: 100, years: 1 }, 'CE'), null);
  assert.equal(impliedVol(0, { spot: 100, strike: 100, years: 1 }, 'CE'), null);
  console.log('bsm-greeks: OK (ATM IV/delta textbook, PE mirror, far-OTM low delta, invalid→null)');
}

// ---- integration checks via the running service ----
const BASE = process.env.AGENT_BASE_URL || 'http://127.0.0.1:3010';
const { execFileSync } = require('node:child_process');

/** Portal password no longer lives in .env (2026-09-05): decrypt it from the
 *  portal_users DB row under ENCRYPTION_KEY, exactly like the app does. */
function portalPassword() {
  const fs = require('node:fs');
  const crypto = require('node:crypto');
  const env = {};
  for (const line of fs.readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  const enc = execFileSync('mysql', [
    '-h', env.MYSQL_HOST, '-P', env.MYSQL_PORT, '-u', env.MYSQL_USER,
    '-N', '-e', "SELECT passwordEnc FROM portal_users WHERE email='bapay.9@gmail.com';",
    'myjob_agent',
  ], { env: { ...process.env, MYSQL_PWD: env.MYSQL_PASSWORD } }).toString().trim();
  const [iv, data] = enc.split(':');
  const key = crypto.createHash('sha256').update(env.ENCRYPTION_KEY).digest();
  const d = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(iv, 'hex'));
  return Buffer.concat([d.update(Buffer.from(data, 'hex')), d.final()]).toString('utf8');
}

let _authCookie = '';
async function req(method, path, body) {
  const h = { 'Content-Type': 'application/json' };
  if (!_authCookie) {
    const pw = portalPassword();
    const login = await fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ password: pw }),
    });
    const setCookie = login.headers.get('set-cookie') || '';
    _authCookie = setCookie.split(';')[0];
  }
  if (_authCookie) h['cookie'] = _authCookie;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: h,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function guardTests() {
  const portfolios = await req('GET', '/trading/portfolios');
  assert.ok(Array.isArray(portfolios.body), 'portfolios list');
  const port = portfolios.body.find((p) => p.label === 'sandbox-live') || portfolios.body[0];
  assert.ok(port, 'has a portfolio');

  // 1. Negative test: index instrument must be rejected (hard guard)
  const idxTry = await req('POST', '/trading/trades', {
    portfolioId: port.id,
    instrument: 'NSE:NIFTY50-INDEX',
    side: 'BUY',
    quantity: 1,
    entryPrice: 23900,
  });
  assert.ok(idxTry.status >= 400, `index instrument MUST be rejected (HTTP ${idxTry.status})`);
  console.log(`openTrade NSE:NIFTY50-INDEX → HTTP ${idxTry.status} — REJECTED ✓`);

  // 2. Unregistered contract must be rejected
  const unregTry = await req('POST', '/trading/trades', {
    portfolioId: port.id,
    instrument: 'NSE:NIFTY26SEP99999CE',
    side: 'BUY',
    quantity: 1,
    entryPrice: 10,
  });
  assert.ok(unregTry.status >= 400, `unregistered contract MUST be rejected (HTTP ${unregTry.status})`);
  console.log(`openTrade unregistered NSE:NIFTY26SEP99999CE → HTTP ${unregTry.status} — REJECTED ✓`);

  // 3. NO TRADE: signals endpoint returns a (possibly empty) array — never a forced pick
  const sigs = await req('GET', '/trading/signals?portfolioId=' + port.id);
  assert.equal(sigs.status, 200, 'signals endpoint 200');
  assert.ok(Array.isArray(sigs.body), 'signals returns an array');
  console.log(`signals (${new Date().toISOString()}, market closed) → ${sigs.body.length} signal(s) — NO TRADE is a valid outcome ✓`);

  // 4. Envelope sanity: ceiling = capital + netPnl
  const p2 = await req('GET', '/trading/portfolios');
  const live = (p2.body || []).find((x) => x.id === port.id);
  if (live) {
    const expected = Math.max(0, Number(live.capital) + Number(live.netPnl));
    assert.ok(Math.abs(Number(live.ceiling) - expected) < 0.02, `ceiling = capital+netPnl (${live.ceiling} vs ${expected})`);
    console.log(`envelope: ceiling ${live.ceiling} = capital ${live.capital} + netPnl ${live.netPnl} ✓`);
  }
}

async function main() {
  greeksTests();
  await guardTests();
  console.log('\nGATE-0 regression suite: ALL PASS');
}

main().catch((e) => {
  console.error('REGRESSION FAIL:', e.message);
  process.exit(1);
});
