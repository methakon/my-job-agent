#!/usr/bin/env node
/**
 * FYERS token lifecycle — unit tests (ProviderTokenService).
 *
 * Proves the single-row token model end to end, in-process (no DB, no network):
 *
 *  1. First login creates one active row (provider='fyers', environment='live').
 *  2. Second login updates the same row in place — row count stays at 1.
 *  3. getCurrentToken returns the active row; null when none exists.
 *  4. getActiveAccessToken returns the DECRYPTED access token.
 *  5. hasActiveToken is true/false correctly.
 *  6. markRevoked sets status + statusReason + revokedAt.
 *  7. rotateTokens delegates to storeTokens (same single-row model).
 *  8. authCodeHash is a deterministic SHA-256 of the original auth_code.
 *  9. getRefreshStatus reports refresh token + PIN availability.
 * 10. getActiveRefreshToken returns the decrypted refresh token.
 * 11. Stray duplicate active rows get collapsed on storeTokens.
 * 12. Refresh flow (mocked provider, no network):
 *      - success against the DOCUMENTED v3 endpoint (validate-refresh-token)
 *      - the stored refresh token is PRESERVED when the response carries none
 *      - a replacement refresh_token is adopted when the provider returns one
 *      - failure leaves the stored row unchanged
 *      - missing PIN => no network call at all
 *      - no stored refresh token => no network call at all
 * 13. getAppSecretHash computes SHA-256(appId:appSecret).
 *
 * NOTE: this file previously loaded the retired `fyers-token.service` dist
 * path (a stale module name) — the store under test is the CURRENT
 * provider-token.service (ProviderTokenService).
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

let pass = 0;
let fail = 0;
const ok = (name) => { pass++; console.log(`  ✅ ${name}`); };
const bad = (name, err) => { fail++; console.log(`  ❌ ${name}\n     ${err && err.message ? err.message : err}`); };
const t = (name, fn) => { try { fn(); ok(name); } catch (err) { bad(name, err); } };
const ta = async (name, fn) => { try { await fn(); ok(name); } catch (err) { bad(name, err); } };

// ── build ────────────────────────────────────────────────────────────────────
console.log('▶ building module (tsc) …');
try { execSync('npm run build', { cwd: ROOT, stdio: 'pipe', timeout: 240_000 }); } catch { /* dist presence asserted below */ }
const DIST_TRADING = path.join(ROOT, 'dist', 'trading');
if (!fs.existsSync(path.join(DIST_TRADING, 'provider-token.service.js'))) {
  console.error('✘ dist/trading/provider-token.service.js missing — cannot run tests');
  process.exit(1);
}
const { ProviderTokenService } = require(path.join(DIST_TRADING, 'provider-token.service.js'));

// ── fixtures ────────────────────────────────────────────────────────────────
const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const jwtWith = (claims) => `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(claims)}.unit-test-sig`;

const ACCESS_TOKEN = jwtWith({ sub: 'FY12345', exp: Math.floor(Date.now() / 1000) + 6 * 3600 });
const REFRESH_TOKEN = 'refresh-abc-123';
const AUTH_CODE = 'auth-code-xyz-789';
const USER_ID = 'FY12345';
const APP_ID = 'TQHWHBA2SZ-200';
const APP_SECRET = 'unit-test-secret-never-real';
const FYERS_PIN = '1234';

const sha256hex = (input) => crypto.createHash('sha256').update(input).digest('hex');
const appIdHash = () => crypto.createHash('sha256').update(`${APP_ID}:${APP_SECRET}`).digest('hex');

// ── mocks ───────────────────────────────────────────────────────────────────

/**
 * TypeORM FindOperator matcher (Not(...), IsNull(), Not(IsNull())).
 * Detection via typeorm's own marker symbol; nested operators are traversed
 * through `.child` (because `.value` flattens to the innermost SCALAR value
 * and therefore cannot be used for nesting).
 */
const FIND_OPERATOR_SYMBOL = Symbol.for('FindOperator');
const isFindOp = (v) => !!v && typeof v === 'object' && v['@instanceof'] === FIND_OPERATOR_SYMBOL;
const matchVal = (rowVal, v) => {
  if (isFindOp(v)) {
    if (v.type === 'not') {
      const child = v.child;
      return child ? !matchVal(rowVal, child) : rowVal !== v.value;
    }
    if (v.type === 'isNull') return rowVal === null || rowVal === undefined;
    if (v.type === 'in') return Array.isArray(v.value) ? v.value.includes(rowVal) : true;
    return true; // unhandled operator — permissive
  }
  return rowVal === v;
};
const matches = (row, where) => Object.entries(where ?? {}).every(([k, v]) => matchVal(row[k], v));

/** Mock repo: array-backed, single-row semantics, real where-clause matching. */
const makeRepo = () => {
  const rows = [];
  return {
    rows,
    async findOne({ where } = {}) { return rows.find((r) => matches(r, where)) ?? null; },
    async find({ where, order } = {}) {
      let result = where ? rows.filter((r) => matches(r, where)) : rows.slice();
      if (order && order.issuedAt === 'DESC') result = result.slice().reverse();
      return result;
    },
    async count({ where } = {}) { return where ? rows.filter((r) => matches(r, where)).length : rows.length; },
    async update(criteria, patch) { for (const r of rows) if (matches(r, criteria)) Object.assign(r, patch); },
    create(obj) { return { ...obj, id: crypto.randomUUID(), issuedAt: obj.issuedAt ?? new Date() }; },
    async save(entity) {
      const idx = rows.findIndex((r) => r.id === entity.id);
      if (idx >= 0) rows[idx] = entity;
      else rows.push(entity);
      return entity;
    },
    async clear() { rows.length = 0; },
  };
};

const makeEncryption = () => ({
  encrypt: (plain) => `enc:${plain}`,
  decrypt: (enc) => {
    if (!enc || !enc.startsWith('enc:')) return '';
    return enc.slice(4);
  },
});

const makeConfig = (over = {}) => {
  const values = { FYERS_APP_ID: APP_ID, FYERS_APP_SECRET: APP_SECRET, ...over };
  return { get: (key) => values[key] };
};

const build = (over = {}, repoRows = [], pin = FYERS_PIN) => {
  const repo = makeRepo();
  repo.rows.push(...repoRows.map((r) => ({ ...r })));
  const encryption = makeEncryption();
  const config = makeConfig(over);
  const service = new ProviderTokenService(repo, encryption, config);
  service.fyersPin = pin;
  return { service, repo };
};

// ── fetch stub (mocked provider — no network) ───────────────────────────────
const realFetch = global.fetch;
let fetchCalls = [];
const stubFetch = (handler) => {
  fetchCalls = [];
  global.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    return handler(url, opts);
  };
};
const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  async json() { return body; },
});

// ── tests ────────────────────────────────────────────────────────────────────
(async () => {
  console.log('\n▶ FYERS token lifecycle — single-row model + refresh flow\n');

  // 1. First login creates one active row
  await ta('first login creates one active row (provider fyers / live)', async () => {
    const { service, repo } = build();
    const token = await service.storeTokens(ACCESS_TOKEN, REFRESH_TOKEN, USER_ID, 'fyers', 'live', AUTH_CODE);
    assert.equal(token.status, 'active');
    assert.equal(token.provider, 'fyers');
    assert.equal(token.environment, 'live');
    assert.equal(token.clientId, USER_ID);
    assert.equal(token.accessTokenEncrypted, `enc:${ACCESS_TOKEN}`);
    assert.equal(token.refreshTokenEncrypted, `enc:${REFRESH_TOKEN}`);
    assert.equal(repo.rows.length, 1, 'only one row in the store');
  });

  // 2. Second login updates in place — no new row
  await ta('second login updates in place (row count stays 1)', async () => {
    const { service, repo } = build();
    await service.storeTokens(ACCESS_TOKEN, REFRESH_TOKEN, USER_ID, 'fyers', 'live', AUTH_CODE);
    const NEW_TOKEN = jwtWith({ sub: 'FY12345', exp: Math.floor(Date.now() / 1000) + 12 * 3600 });
    const updated = await service.storeTokens(NEW_TOKEN, 'refresh-v2', USER_ID, 'fyers', 'live');
    assert.equal(repo.rows.length, 1, 'row count must not grow');
    assert.equal(updated.accessTokenEncrypted, `enc:${NEW_TOKEN}`);
    assert.equal(updated.refreshTokenEncrypted, 'enc:refresh-v2');
  });

  // 3. getCurrentToken
  await ta('getCurrentToken returns the active row', async () => {
    const { service } = build();
    await service.storeTokens(ACCESS_TOKEN, REFRESH_TOKEN, USER_ID, 'fyers', 'live', AUTH_CODE);
    const active = await service.getCurrentToken('fyers', 'live');
    assert.ok(active, 'active token must exist');
    assert.equal(active.status, 'active');
  });

  await ta('getCurrentToken returns null when no token exists', async () => {
    const { service } = build();
    assert.equal(await service.getCurrentToken('fyers', 'live'), null);
  });

  // 4. getActiveAccessToken
  await ta('getActiveAccessToken returns the DECRYPTED access token', async () => {
    const { service } = build();
    await service.storeTokens(ACCESS_TOKEN, REFRESH_TOKEN, USER_ID, 'fyers', 'live', AUTH_CODE);
    assert.equal(await service.getActiveAccessToken('fyers', 'live'), ACCESS_TOKEN);
  });

  await ta('getActiveAccessToken returns null when no token exists', async () => {
    const { service } = build();
    assert.equal(await service.getActiveAccessToken('fyers', 'live'), null);
  });

  // 5. hasActiveToken
  await ta('hasActiveToken is true when an active token exists', async () => {
    const { service } = build();
    await service.storeTokens(ACCESS_TOKEN, REFRESH_TOKEN, USER_ID, 'fyers', 'live', AUTH_CODE);
    assert.equal(await service.hasActiveToken('fyers', 'live'), true);
  });

  await ta('hasActiveToken is false when no token exists', async () => {
    const { service } = build();
    assert.equal(await service.hasActiveToken('fyers', 'live'), false);
  });

  // 6. markRevoked
  await ta('markRevoked sets status, statusReason, and revokedAt', async () => {
    const { service, repo } = build();
    const token = await service.storeTokens(ACCESS_TOKEN, REFRESH_TOKEN, USER_ID, 'fyers', 'live', AUTH_CODE);
    await service.markRevoked(token.id, 'user_revoked');
    const updated = repo.rows.find((r) => r.id === token.id);
    assert.equal(updated.status, 'revoked');
    assert.equal(updated.statusReason, 'user_revoked');
    assert.ok(updated.revokedAt instanceof Date, 'revokedAt must be a Date');
  });

  // 7. rotateTokens in place
  await ta('rotateTokens stores new tokens in place', async () => {
    const { service, repo } = build();
    await service.storeTokens(ACCESS_TOKEN, REFRESH_TOKEN, USER_ID, 'fyers', 'live', AUTH_CODE);
    const NEW_TOKEN = jwtWith({ sub: 'FY12345', exp: Math.floor(Date.now() / 1000) + 6 * 3600 });
    const rotated = await service.rotateTokens(NEW_TOKEN, 'refresh-rotated', USER_ID, 'fyers', 'live');
    assert.equal(repo.rows.length, 1, 'rotation must not create new rows');
    assert.equal(rotated.accessTokenEncrypted, `enc:${NEW_TOKEN}`);
  });

  // 8. authCodeHash
  await ta('authCodeHash is a deterministic SHA-256 of the auth_code', async () => {
    const { service } = build();
    const token = await service.storeTokens(ACCESS_TOKEN, REFRESH_TOKEN, USER_ID, 'fyers', 'live', AUTH_CODE);
    assert.equal(token.authCodeHash, sha256hex(AUTH_CODE));
    const token2 = await service.storeTokens(ACCESS_TOKEN, REFRESH_TOKEN, USER_ID, 'fyers', 'live', AUTH_CODE);
    assert.equal(token2.authCodeHash, token.authCodeHash, 'hash must be deterministic');
  });

  // 9. getRefreshStatus
  await ta('getRefreshStatus reports refresh token and PIN availability', async () => {
    const { service } = build();
    await service.storeTokens(ACCESS_TOKEN, REFRESH_TOKEN, USER_ID, 'fyers', 'live', AUTH_CODE);
    const status = await service.getRefreshStatus();
    assert.equal(status.hasRefreshToken, true, 'must have refresh token');
    assert.equal(status.hasPin, true, 'PIN is configured');
  });

  await ta('getRefreshStatus reports false when no refresh token stored', async () => {
    const { service } = build();
    await service.storeTokens(ACCESS_TOKEN, null, USER_ID, 'fyers', 'live', AUTH_CODE);
    assert.equal((await service.getRefreshStatus()).hasRefreshToken, false);
  });

  await ta('getRefreshStatus reports hasPin=false when PIN not configured', async () => {
    const { service } = build({}, [], '');
    await service.storeTokens(ACCESS_TOKEN, REFRESH_TOKEN, USER_ID, 'fyers', 'live', AUTH_CODE);
    assert.equal((await service.getRefreshStatus()).hasPin, false);
  });

  // 10. getActiveRefreshToken
  await ta('getActiveRefreshToken returns the decrypted refresh token', async () => {
    const { service } = build();
    await service.storeTokens(ACCESS_TOKEN, REFRESH_TOKEN, USER_ID, 'fyers', 'live', AUTH_CODE);
    assert.equal(await service.getActiveRefreshToken('fyers', 'live'), REFRESH_TOKEN);
  });

  await ta('getActiveRefreshToken returns null when no refresh token stored', async () => {
    const { service } = build();
    await service.storeTokens(ACCESS_TOKEN, null, USER_ID, 'fyers', 'live', AUTH_CODE);
    assert.equal(await service.getActiveRefreshToken('fyers', 'live'), null);
  });

  // 11. stray duplicate collapse
  await ta('stray duplicate active rows are collapsed to one', async () => {
    const stray1 = { id: 'stray-1', provider: 'fyers', environment: 'live', status: 'active', accessTokenEncrypted: 'enc:old1', refreshTokenEncrypted: null, clientId: USER_ID };
    const stray2 = { id: 'stray-2', provider: 'fyers', environment: 'live', status: 'active', accessTokenEncrypted: 'enc:old2', refreshTokenEncrypted: null, clientId: USER_ID };
    const { service, repo } = build({}, [stray1, stray2]);
    await service.storeTokens(ACCESS_TOKEN, REFRESH_TOKEN, USER_ID, 'fyers', 'live', AUTH_CODE);
    assert.equal(repo.rows.filter((r) => r.status === 'active').length, 1, 'only one active row after collapse');
    assert.ok(repo.rows.filter((r) => r.status === 'revoked').length >= 1, 'stray rows should be revoked');
  });

  // 12. refresh flow (mocked provider)
  await ta('refresh success: documented v3 endpoint, in-place rotation, refresh token PRESERVED', async () => {
    const { service, repo } = build();
    await service.storeTokens(ACCESS_TOKEN, REFRESH_TOKEN, USER_ID, 'fyers', 'live', AUTH_CODE);
    const NEW_ACCESS = jwtWith({ sub: 'FY12345', exp: Math.floor(Date.now() / 1000) + 10 * 3600 });
    stubFetch(() => jsonResponse({ s: 'ok', code: 200, message: '', access_token: NEW_ACCESS, fy_id: USER_ID }));
    try {
      const result = await service.refreshAccessToken();
      assert.equal(result, true, 'refresh must succeed');
      assert.equal(fetchCalls.length, 1);
      const call = fetchCalls[0];
      assert.equal(call.url, 'https://api-t1.fyers.in/api/v3/validate-refresh-token', 'documented v3 endpoint');
      assert.equal(call.opts.method, 'POST');
      assert.equal(call.opts.headers['Content-Type'], 'application/json');
      const body = JSON.parse(call.opts.body);
      assert.equal(body.grant_type, 'refresh_token');
      assert.equal(body.appIdHash, appIdHash());
      assert.equal(body.refresh_token, REFRESH_TOKEN);
      assert.equal(body.pin, FYERS_PIN);
      assert.equal(await service.getActiveAccessToken('fyers', 'live'), NEW_ACCESS, 'access token rotated in place');
      assert.equal(await service.getActiveRefreshToken('fyers', 'live'), REFRESH_TOKEN, 'refresh token preserved (response carried none)');
      assert.equal(repo.rows.length, 1, 'single row preserved');
    } finally { global.fetch = realFetch; }
  });

  await ta('refresh adopts a replacement refresh_token when the provider returns one', async () => {
    const { service } = build();
    await service.storeTokens(ACCESS_TOKEN, REFRESH_TOKEN, USER_ID, 'fyers', 'live', AUTH_CODE);
    const NEW_ACCESS = jwtWith({ sub: 'FY12345', exp: Math.floor(Date.now() / 1000) + 10 * 3600 });
    stubFetch(() => jsonResponse({ s: 'ok', access_token: NEW_ACCESS, refresh_token: 'refresh-replacement', fy_id: USER_ID }));
    try {
      const result = await service.refreshAccessToken();
      assert.equal(result, true);
      assert.equal(await service.getActiveRefreshToken('fyers', 'live'), 'refresh-replacement');
      assert.equal(await service.getActiveAccessToken('fyers', 'live'), NEW_ACCESS);
    } finally { global.fetch = realFetch; }
  });

  await ta('refresh failure: stored row unchanged, result false', async () => {
    const { service } = build();
    await service.storeTokens(ACCESS_TOKEN, REFRESH_TOKEN, USER_ID, 'fyers', 'live', AUTH_CODE);
    stubFetch(() => jsonResponse({ s: 'error', code: 400, message: 'Invalid input' }, 400));
    try {
      const result = await service.refreshAccessToken();
      assert.equal(result, false);
      assert.equal(await service.getActiveAccessToken('fyers', 'live'), ACCESS_TOKEN, 'stored access unchanged');
      assert.equal(await service.getActiveRefreshToken('fyers', 'live'), REFRESH_TOKEN, 'stored refresh unchanged');
    } finally { global.fetch = realFetch; }
  });

  await ta('missing PIN => refresh returns false with NO network call', async () => {
    const { service } = build({}, [], '');
    await service.storeTokens(ACCESS_TOKEN, REFRESH_TOKEN, USER_ID, 'fyers', 'live', AUTH_CODE);
    stubFetch(() => { throw new Error('fetch must not be called when FYERS_PIN is missing'); });
    try {
      const result = await service.refreshAccessToken();
      assert.equal(result, false);
      assert.equal(fetchCalls.length, 0, 'no network call without the PIN');
    } finally { global.fetch = realFetch; }
  });

  await ta('no stored refresh token => refresh returns false with NO network call', async () => {
    const { service } = build();
    await service.storeTokens(ACCESS_TOKEN, null, USER_ID, 'fyers', 'live', AUTH_CODE);
    stubFetch(() => { throw new Error('fetch must not be called without a refresh token'); });
    try {
      const result = await service.refreshAccessToken();
      assert.equal(result, false);
      assert.equal(fetchCalls.length, 0, 'no network call without a refresh token');
    } finally { global.fetch = realFetch; }
  });

  // 13. appId:secret hash
  await ta('getAppSecretHash computes expected SHA-256 of appId:appSecret', async () => {
    const { service } = build();
    assert.equal(service.getAppSecretHash(), appIdHash());
  });

  // ── summary ──────────────────────────────────────────────────────────────
  console.log(`\n${pass + fail} tests: ${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
})();
