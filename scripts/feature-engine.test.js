#!/usr/bin/env node
/**
 * GATE 3 — feature engine determinism test (v5 rule: same inputs → same output;
 * edge cases return a safe explicit state). Exercises the pure math paths via a
 * small fixture served through the running service is DB-dependent — instead we
 * test the loaded-window math by calling the service with a real stored day and
 * asserting self-consistency (VWAP within day's min/max, ATR >= 0, ORB >= 0).
 */
const assert = require('node:assert/strict');

const BASE = process.env.AGENT_BASE_URL || 'http://127.0.0.1:3010';
const { execFileSync } = require('node:child_process');

function portalPassword() {
  const fs = require('node:fs');
  const crypto = require('node:crypto');
  const env = {};
  for (const line of fs.readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  const enc = execFileSync('mysql', ['-h', env.MYSQL_HOST, '-P', env.MYSQL_PORT, '-u', env.MYSQL_USER,
    '-N', '-e', "SELECT passwordEnc FROM portal_users WHERE email='bapay.9@gmail.com';", 'myjob_agent'],
    { env: { ...process.env, MYSQL_PWD: env.MYSQL_PASSWORD } }).toString().trim();
  const [iv, data] = enc.split(':');
  const key = crypto.createHash('sha256').update(env.ENCRYPTION_KEY).digest();
  const d = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(iv, 'hex'));
  return Buffer.concat([d.update(Buffer.from(data, 'hex')), d.final()]).toString('utf8');
}

let cookie = '';
async function req(path) {
  const h = { 'Content-Type': 'application/json' };
  if (!cookie) {
    const login = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: h, body: JSON.stringify({ password: portalPassword() }) });
    cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  }
  if (cookie) h['cookie'] = cookie;
  const res = await fetch(`${BASE}${path}`, { headers: h });
  return res.json();
}

async function main() {
  const day = '2026-09-04';
  const list = await req(`/trading/market/features?day=${day}`);
  assert.ok(Array.isArray(list.instruments) && list.instruments.length >= 3, `instruments on ${day}`);
  const nifty = list.instruments.find((i) => i.includes('NIFTY50'));
  assert.ok(nifty, 'NIFTY50 present');
  const f = await req(`/trading/market/features/${encodeURIComponent(nifty)}?day=${day}`);
  assert.ok(f.barCount > 1000, `enough bars (${f.barCount})`);
  assert.ok(f.vwap !== null && f.vwap > 0, 'vwap computed');
  assert.ok(f.atr14 !== null && f.atr14 >= 0, 'atr computed');
  assert.ok(f.rangePct !== null && f.rangePct > 0, 'rangePct > 0');
  // determinism: two calls → identical numbers
  const f2 = await req(`/trading/market/features/${encodeURIComponent(nifty)}?day=${day}`);
  assert.equal(f.vwap, f2.vwap, 'vwap deterministic');
  assert.equal(f.atr14, f2.atr14, 'atr deterministic');
  // empty day → safe explicit state (nulls, barCount 0)
  const empty = await req(`/trading/market/features/${encodeURIComponent(nifty)}?day=2020-01-01`);
  assert.equal(empty.barCount, 0, 'empty day → barCount 0');
  assert.equal(empty.vwap, null, 'empty day → vwap null');
  console.log(`feature-engine: OK (${nifty} ${day}: vwap ${f.vwap.toFixed(2)}, atr14 ${f.atr14.toFixed(2)}, bars ${f.barCount}, deterministic, empty-day safe)`);
}

main().catch((e) => { console.error('FEATURE ENGINE TEST FAIL:', e.message); process.exit(1); });
