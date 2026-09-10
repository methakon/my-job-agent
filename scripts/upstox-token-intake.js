#!/usr/bin/env node
/**
 * Upstox LIVE access-token intake — sanctioned path, reusable.
 * ============================================================
 * Delivers an operator-supplied Upstox v3 access token to the RUNNING app
 * through its own notifier route (POST /api/upstox/notifier), which validates
 * the client_id against the allowed set, encrypts the token (AES-256-CBC under
 * ENCRYPTION_KEY) and upserts the `upstox_live_paper_tokens` row. Never raw SQL,
 * never /auth/login (rate limited to 10 attempts / 15 min).
 *
 * Auth: x-operator-password, resolved from portal_users.passwordEnc exactly like
 * the gate tooling (scripts/lib/gate-auth.js). No credential is hard-coded and
 * the token value is never printed or written to disk by this script.
 *
 * Usage:
 *   node scripts/upstox-token-intake.js --file /path/to/token.txt
 *   echo "$TOKEN" | node scripts/upstox-token-intake.js
 *   node scripts/upstox-token-intake.js            # reads stdin (also fine from a pipe)
 *
 * Exit codes: 0 stored + verified, 1 failure (bad token shape, HTTP error,
 * row not stored, or stored expiry already in the past).
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
require(path.join(ROOT, 'node_modules/dotenv')).config({ path: path.join(ROOT, '.env') });
const { authHeaders } = require(path.join(__dirname, 'lib/gate-auth.js'));

const BASE = process.env.PRE_OPEN_APP_BASE || 'http://127.0.0.1:3010';

function readToken() {
  const i = process.argv.indexOf('--file');
  if (i !== -1 && process.argv[i + 1]) return fs.readFileSync(process.argv[i + 1], 'utf8').trim();
  if (process.argv[2] && !process.argv[2].startsWith('--')) return process.argv[2].trim();
  return fs.readFileSync(0, 'utf8').trim();
}

function decodeClaims(tok) {
  const parts = tok.split('.');
  if (parts.length !== 3) throw new Error(`not a JWT (expected 3 segments, got ${parts.length})`);
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  for (const k of ['sub', 'iat', 'exp']) {
    if (payload[k] === undefined) throw new Error(`JWT is missing the "${k}" claim — refusing to guess expiry`);
  }
  return payload;
}

const ist = (ms) => new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata', dateStyle: 'short', timeStyle: 'medium', hourCycle: 'h23',
}).format(new Date(ms));

async function storedRow(mysql) {
  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT || 3307),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.DATABASE_NAME || 'myjob_agent',
  });
  try {
    const [rows] = await conn.query(
      'SELECT clientId, status, issuedAt, expiresAt, (accessTokenEncrypted IS NOT NULL) AS hasToken FROM upstox_live_paper_tokens ORDER BY clientId',
    );
    return rows;
  } finally {
    await conn.end();
  }
}

(async () => {
  const tok = readToken();
  const claims = decodeClaims(tok);
  const clientId = (process.env.UPSTOX_LIVE_API_KEY || '').trim();
  if (!clientId) throw new Error('UPSTOX_LIVE_API_KEY not configured in .env');

  const iatMs = claims.iat * 1000;
  const expMs = claims.exp * 1000;
  console.log(`token claims: sub=${claims.sub} iat=${ist(iatMs)} exp=${ist(expMs)} (valid ${((expMs - Date.now()) / 60000).toFixed(0)} more minutes)`);

  const res = await fetch(`${BASE}/api/upstox/notifier`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify({
      message_type: 'access_token',
      client_id: clientId,
      access_token: tok,
      token_type: 'Bearer',
      issued_at: claims.iat,   // epoch seconds — persistToken parses numbers as seconds
      expires_at: claims.exp,
    }),
  });
  const text = await res.text();
  console.log(`notifier: HTTP ${res.status} ${text.slice(0, 300)}`);
  if (!res.ok) throw new Error(`notifier rejected the token (HTTP ${res.status})`);
  const parsed = JSON.parse(text);
  if (!parsed.stored) throw new Error(`app did not store the token: ${text.slice(0, 200)}`);

  const rows = await storedRow(require(path.join(ROOT, 'node_modules/mysql2/promise')));
  for (const r of rows) {
    const exp = r.expiresAt ? new Date(r.expiresAt).toISOString() : null;
    console.log(`row: clientId=${r.clientId} status=${r.status} expiresAt=${exp} (${r.expiresAt ? ist(new Date(r.expiresAt).getTime()) : 'n/a'}) tokenStored=${!!r.hasToken}`);
  }
  const mine = rows.find((r) => String(r.clientId).toUpperCase() === clientId.toUpperCase());
  if (!mine || !mine.hasToken) throw new Error('no stored token row for this client_id');
  if (mine.status !== 'TOKEN_VALID') throw new Error(`stored row status=${mine.status} — token is not currently valid`);
  console.log('OK — token stored and TOKEN_VALID');
})().catch((e) => { console.error('TOKEN_INTAKE_FAILED', e.message); process.exit(1); });
