#!/usr/bin/env node
/**
 * FYERS token lifecycle — unit tests.
 *
 * Proves the single-row token model end to end, in-process (no DB, no network):
 *
 *  1. First login creates one active row.
 *  2. Second login updates the same row in place — row count stays at 1.
 *  3. getCurrentToken returns the active row; null when none exists.
 *  4. getActiveAccessToken returns the DECRYPTED access token.
 *  5. hasActiveToken is true/false correctly.
 *  6. markRevoked sets status + statusReason + revokedAt.
 *  7. rotateTokens delegates to storeTokens (same single-row model).
 *  8. authCodeHash is a deterministic SHA-256 of the original auth_code.
 *  9. getRefreshStatus reports refresh token + PIN availability.
 * 10. Stray duplicate active rows get collapsed on storeTokens.
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
const DIST_FYERS = path.join(ROOT, 'dist', 'trading');
if (!fs.existsSync(path.join(DIST_FYERS, 'fyers-token.service.js'))) {
  console.error('✘ dist/trading/fyers-token.service.js missing — cannot run tests');
  process.exit(1);
}
const { FyersTokenService } = require(path.join(DIST_FYERS, 'fyers-token.service.js'));

// ── helpers ──────────────────────────────────────────────────────────────────

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const jwtWith = (claims) => `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(claims)}.unit-test-sig`;

const ACCESS_TOKEN = jwtWith({ sub: 'FY12345', exp: Math.floor(Date.now() / 1000) + 6 * 3600 });
const REFRESH_TOKEN = 'refresh-abc-123';
const AUTH_CODE = 'auth-code-xyz-789';
const USER_ID = 'FY12345';
const APP_ID = 'TQHWHBA2SZ-200';
const APP_SECRET = 'unit-test-secret-never-real';
const FYERS_PIN = '1234';

/** Deterministic SHA-256 hex (matches FyersTokenService.hashAuthCode). */
const sha256hex = (input) => crypto.createHash('sha256').update(input).digest('hex');

/** Deterministic appId:appSecret hash (matches FyersTokenService.computeAppIdHash). */
const appIdHash = () => crypto.createHash('sha256').update(`${APP_ID}:${APP_SECRET}`).digest('hex');

/** Mock repo: array-backed, single-row semantics. */
const makeRepo = (rows = []) => {
  const store = rows.map(r => ({ ...r }));
  return {
    store,
    async findOne({ where } = {}) {
      if (where && where.status) return store.find(r => r.status === where.status) ?? null;
      return store[0] ?? null;
    },
    async find({ where, order } = {}) {
      let result = store.slice();
      if (where && where.status) result = result.filter(r => r.status === where.status);
      if (order && order.issuedAt === 'DESC') result.reverse();
      return result;
    },
    async count({ where } = {}) {
      if (where && where.refreshTokenEncrypted) {
        return store.filter(r => r.refreshTokenEncrypted != null).length;
      }
      if (where && where.status) return store.filter(r => r.status === where.status).length;
      return store.length;
    },
    create(obj) { return { ...obj, id: crypto.randomUUID(), issuedAt: new Date() }; },
    async save(entity) {
      const idx = store.findIndex(r => r.id === entity.id);
      if (idx >= 0) store[idx] = entity;
      else store.push(entity);
      return entity;
    },
    async update(where, patch) {
      for (const r of store) {
        if (where.id && r.id === where.id) Object.assign(r, patch);
        if (where.status && where.id && r.status === where.status && r.id !== where.id) Object.assign(r, patch);
        if (where.status && r.status === where.status && !where.id && !where.Not) Object.assign(r, patch);
      }
    },
    async clear() { store.length = 0; },
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
  const values = {
    FYERS_APP_ID: APP_ID,
    FYERS_APP_SECRET: APP_SECRET,
    ...over,
  };
  return { get: (key) => values[key] };
};

const build = (over = {}, repoRows = []) => {
  const repo = makeRepo(repoRows);
  const encryption = makeEncryption();
  const config = makeConfig(over);
  const service = new FyersTokenService(repo, encryption, config);
  // Inject FYERS_PIN via property
  if ('FYERS_PIN' in over) service.fyersPin = over.FYERS_PIN;
  else service.fyersPin = FYERS_PIN;
  return { service, repo };
};

// ── tests ────────────────────────────────────────────────────────────────────
(async () => {
  console.log('\n▶ FYERS token lifecycle — single-row model\n');

  // 1. First login creates one active row
  await ta('first login creates one active row', async () => {
    const { service, repo } = build();
    const token = await service.storeTokens(ACCESS_TOKEN, REFRESH_TOKEN, USER_ID, AUTH_CODE);
    assert.equal(token.status, 'active');
    assert.equal(token.provider, 'fyers');
    assert.equal(token.appId, APP_ID);
    assert.equal(token.accessTokenEncrypted, `enc:${ACCESS_TOKEN}`);
    assert.equal(token.refreshTokenEncrypted, `enc:${REFRESH_TOKEN}`);
    assert.equal(token.userId, USER_ID);
    assert.equal(repo.store.length, 1, 'only one row in the store');
  });

  // 2. Second login updates in place — no new row
  await ta('second login updates in place (row count stays 1)', async () => {
    const { service, repo } = build();
    await service.storeTokens(ACCESS_TOKEN, REFRESH_TOKEN, USER_ID, AUTH_CODE);
    const NEW_TOKEN = jwtWith({ sub: 'FY12345', exp: Math.floor(Date.now() / 1000) + 12 * 3600 });
    const updated = await service.storeTokens(NEW_TOKEN, 'refresh-v2', USER_ID, null);
    assert.equal(repo.store.length, 1, 'row count must not grow');
    assert.equal(updated.accessTokenEncrypted, `enc:${NEW_TOKEN}`);
    assert.equal(updated.refreshTokenEncrypted, 'enc:refresh-v2');
  });

  // 3. getCurrentToken returns active row
  await ta('getCurrentToken returns the active row', async () => {
    const { service } = build();
    await service.storeTokens(ACCESS_TOKEN, REFRESH_TOKEN, USER_ID, AUTH_CODE);
    const active = await service.getCurrentToken();
    assert.ok(active, 'active token must exist');
    assert.equal(active.status, 'active');
  });

  await ta('getCurrentToken returns null when no token exists', async () => {
    const { service } = build();
    const active = await service.getCurrentToken();
    assert.equal(active, null);
  });

  // 4. getActiveAccessToken returns decrypted access token
  await ta('getActiveAccessToken returns the DECRYPTED access token', async () => {
    const { service } = build();
    await service.storeTokens(ACCESS_TOKEN, REFRESH_TOKEN, USER_ID, AUTH_CODE);
    const decrypted = await service.getActiveAccessToken();
    assert.equal(decrypted, ACCESS_TOKEN, 'must return original plaintext');
  });

  await ta('getActiveAccessToken returns null when no token exists', async () => {
    const { service } = build();
    const result = await service.getActiveAccessToken();
    assert.equal(result, null);
  });

  // 5. hasActiveToken boolean
  await ta('hasActiveToken is true when active token exists', async () => {
    const { service } = build();
    await service.storeTokens(ACCESS_TOKEN, REFRESH_TOKEN, USER_ID, AUTH_CODE);
    assert.equal(await service.hasActiveToken(), true);
  });

  await ta('hasActiveToken is false when no token exists', async () => {
    const { service } = build();
    assert.equal(await service.hasActiveToken(), false);
  });

  // 6. markRevoked
  await ta('markRevoked sets status, statusReason, and revokedAt', async () => {
    const { service, repo } = build();
    const token = await service.storeTokens(ACCESS_TOKEN, REFRESH_TOKEN, USER_ID, AUTH_CODE);
    await service.markRevoked(token.id, 'user_revoked');
    const updated = repo.store.find(r => r.id === token.id);
    assert.equal(updated.status, 'revoked');
    assert.equal(updated.statusReason, 'user_revoked');
    assert.ok(updated.revokedAt instanceof Date, 'revokedAt must be a Date');
  });

  // 7. rotateTokens delegates to storeTokens (single-row model)
  await ta('rotateTokens stores new tokens in place', async () => {
    const { service, repo } = build();
    await service.storeTokens(ACCESS_TOKEN, REFRESH_TOKEN, USER_ID, AUTH_CODE);
    const NEW_TOKEN = jwtWith({ sub: 'FY12345', exp: Math.floor(Date.now() / 1000) + 6 * 3600 });
    const rotated = await service.rotateTokens(NEW_TOKEN, 'refresh-rotated', USER_ID, null);
    assert.equal(repo.store.length, 1, 'rotation must not create new rows');
    assert.equal(rotated.accessTokenEncrypted, `enc:${NEW_TOKEN}`);
  });

  // 8. authCodeHash is deterministic SHA-256
  await ta('authCodeHash is a deterministic SHA-256 of the auth_code', async () => {
    const { service } = build();
    const token = await service.storeTokens(ACCESS_TOKEN, REFRESH_TOKEN, USER_ID, AUTH_CODE);
    assert.equal(token.authCodeHash, sha256hex(AUTH_CODE));
    // Run again with same code — same hash
    const token2 = await service.storeTokens(ACCESS_TOKEN, REFRESH_TOKEN, USER_ID, AUTH_CODE);
    assert.equal(token2.authCodeHash, token.authCodeHash, 'hash must be deterministic');
  });

  // 9. getRefreshStatus
  await ta('getRefreshStatus reports refresh token and PIN availability', async () => {
    const { service } = build();
    await service.storeTokens(ACCESS_TOKEN, REFRESH_TOKEN, USER_ID, AUTH_CODE);
    const status = await service.getRefreshStatus();
    assert.equal(status.hasRefreshToken, true, 'must have refresh token');
    assert.equal(status.hasPin, true, 'PIN is configured');
  });

  await ta('getRefreshStatus reports false when no refresh token stored', async () => {
    const { service } = build();
    await service.storeTokens(ACCESS_TOKEN, null, USER_ID, AUTH_CODE);
    const status = await service.getRefreshStatus();
    assert.equal(status.hasRefreshToken, false);
  });

  await ta('getRefreshStatus reports hasPin=false when PIN not configured', async () => {
    const { service } = build({ FYERS_PIN: '' });
    await service.storeTokens(ACCESS_TOKEN, REFRESH_TOKEN, USER_ID, AUTH_CODE);
    const status = await service.getRefreshStatus();
    assert.equal(status.hasPin, false);
  });

  // 10. getActiveRefreshToken
  await ta('getActiveRefreshToken returns decrypted refresh token', async () => {
    const { service } = build();
    await service.storeTokens(ACCESS_TOKEN, REFRESH_TOKEN, USER_ID, AUTH_CODE);
    const refresh = await service.getActiveRefreshToken();
    assert.equal(refresh, REFRESH_TOKEN, 'must return original plaintext');
  });

  await ta('getActiveRefreshToken returns null when no refresh token stored', async () => {
    const { service } = build();
    await service.storeTokens(ACCESS_TOKEN, null, USER_ID, AUTH_CODE);
    const refresh = await service.getActiveRefreshToken();
    assert.equal(refresh, null);
  });

  // 11. Stray duplicate active rows get collapsed
  await ta('stray duplicate active rows are collapsed to one', async () => {
    // Pre-seed with 2 active rows (shouldn't happen but tests the safety net)
    const stray1 = { id: 'stray-1', status: 'active', accessTokenEncrypted: 'enc:old1', refreshTokenEncrypted: null, appId: APP_ID, userId: null, authCodeHash: null };
    const stray2 = { id: 'stray-2', status: 'active', accessTokenEncrypted: 'enc:old2', refreshTokenEncrypted: null, appId: APP_ID, userId: null, authCodeHash: null };
    const { service, repo } = build({}, [stray1, stray2]);
    // storeTokens should collapse duplicates
    await service.storeTokens(ACCESS_TOKEN, REFRESH_TOKEN, USER_ID, AUTH_CODE);
    const activeCount = repo.store.filter(r => r.status === 'active').length;
    assert.equal(activeCount, 1, 'only one active row after collapse');
    // The stray ones should be revoked
    const revoked = repo.store.filter(r => r.status === 'revoked');
    assert.ok(revoked.length >= 1, 'stray rows should be revoked');
  });

  // 12. PIN not configured → refreshAccessToken fails
  await ta('refreshAccessToken returns false when PIN not configured', async () => {
    const { service } = build({ FYERS_PIN: '' });
    await service.storeTokens(ACCESS_TOKEN, REFRESH_TOKEN, USER_ID, AUTH_CODE);
    const result = await service.refreshAccessToken();
    assert.equal(result, false);
  });

  // 13. refreshAccessToken with no refresh token → fails gracefully
  await ta('refreshAccessToken returns false when no refresh token stored', async () => {
    const { service } = build({ FYERS_PIN: FYERS_PIN });
    await service.storeTokens(ACCESS_TOKEN, null, USER_ID, AUTH_CODE);
    const result = await service.refreshAccessToken();
    assert.equal(result, false);
  });

  // 14. getAppSecretHash matches expected hash
  await ta('getAppSecretHash computes expected SHA-256 of appId:appSecret', async () => {
    const { service } = build();
    const hash = service.getAppSecretHash();
    assert.equal(hash, appIdHash(), 'hash must match SHA-256(appId:appSecret)');
  });

  // ── summary ──────────────────────────────────────────────────────────────
  console.log(`\n${pass + fail} tests: ${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
})();
