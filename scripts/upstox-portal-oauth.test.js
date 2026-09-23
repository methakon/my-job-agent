#!/usr/bin/env node
/**
 * Upstox portal OAuth — FNF Trading portal button → /api/upstox/login →
 * registered /api/upstox/callback → server-side exchange → encrypted
 * provider_tokens persistence → trading-consumer retrieval.
 *
 * In-process (no DB, no network, no real credentials). The REAL service,
 * controller and page classes run against an in-memory TypeORM-shaped repo and
 * the REAL AES EncryptionService with a test key.
 *
 *  A. Authorization URL construction (documented dialog host + exact params).
 *  B. State generation + validation (server-side, single-use, TTL-bounded).
 *  C. Missing state rejection.
 *  D. Mismatched/forged state rejection.
 *  E. Callback with a valid code (full flow, mocked Upstox).
 *  F. Token exchange success (form body, grant_type=authorization_code).
 *  G. Token exchange failure (Upstox error surfaces; nothing persisted).
 *  H. Database encryption/storage (AES-256-CBC under ENCRYPTION_KEY;
 *     provider=upstox, environment=live, status=active; expiresAt from exp).
 *  I. Replacement of the previous active token (single selectable row only).
 *  J. Token retrieval after login (getCurrentToken / getActiveAccessToken /
 *     getValidUpstoxAccessToken / tokenStatus).
 *  K. Callback + portal never expose credentials.
 *  L. Portal success redirect + banner + button.
 *  M. Portal failure handling.
 *
 * Plus the integration-style chain proving the whole path end to end.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'trading', 'upstox-live-paper');

let pass = 0;
let fail = 0;
const ok = (name) => {
  pass++;
  console.log(`  ✅ ${name}`);
};
const bad = (name, err) => {
  fail++;
  console.log(`  ❌ ${name}\n     ${err && err.message ? err.message : err}`);
};
const t = (name, fn) => {
  try {
    fn();
    ok(name);
  } catch (err) {
    bad(name, err);
  }
};
const ta = async (name, fn) => {
  try {
    await fn();
    ok(name);
  } catch (err) {
    bad(name, err);
  }
};

// ── build + load compiled modules ────────────────────────────────────────────
console.log('▶ building module (tsc) …');
try {
  execSync('npm run build', { cwd: ROOT, stdio: 'pipe', timeout: 240_000 });
} catch {
  // dist presence is asserted below
}
const DIST = path.join(ROOT, 'dist', 'trading');
if (!fs.existsSync(path.join(DIST, 'upstox-live-paper', 'upstox-live-paper-auth.service.js'))) {
  console.error('✘ dist/trading/upstox-live-paper missing — cannot run tests');
  process.exit(1);
}
const { UpstoxLivePaperTokenService } = require(path.join(DIST, 'upstox-live-paper', 'upstox-live-paper-auth.service.js'));
const { UpstoxLivePaperTokenController } = require(path.join(DIST, 'upstox-live-paper', 'upstox-live-paper-token.controller.js'));
const { ProviderTokenService } = require(path.join(DIST, 'provider-token.service.js'));
const { EncryptionService } = require(path.join(ROOT, 'dist', 'auth', 'encryption.service.js'));
const { FnfTradingPageController } = require(path.join(DIST, 'fnf-trading-page.controller.js'));

// ── fixtures (no real credentials anywhere) ──────────────────────────────────
const CLIENT_ID = 'f2e2aaaa-9999-8888-7777-666655554444';
const SECRET = 'unit-test-secret-never-real';
const REDIRECT = 'https://berhampore.in/api/upstox/callback';
const DIALOG = 'https://api.upstox.com/v2/login/authorization/dialog';
const EXCHANGE = 'https://api.upstox.com/v2/login/authorization/token';
const ENCRYPTION_KEY = 'unit-test-key-not-a-real-secret';
const EXP = Math.floor(Date.now() / 1000) + 6 * 3600;

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const jwtWith = (claims) => `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(claims)}.unit-test-signature`;

const makeConfig = (over = {}) => {
  const values = {
    UPSTOX_LIVE_API_KEY: CLIENT_ID,
    UPSTOX_LIVE_API_SECRET: SECRET,
    UPSTOX_LIVE_REDIRECT_URI: REDIRECT,
    ...over,
  };
  return { get: (key) => values[key] };
};

/** In-memory repo implementing the exact TypeORM surface ProviderTokenService uses. */
const makeRepo = () => {
  const rows = [];
  const matches = (row, where) =>
    Object.entries(where ?? {}).every(([k, v]) => {
      if (v && typeof v === 'object' && typeof v.type === 'string' && 'value' in v) {
        return v.type === 'not' ? row[k] !== v.value : true;
      }
      return row[k] === v;
    });
  return {
    rows,
    async findOne({ where } = {}) {
      return rows.find((r) => matches(r, where)) ?? null;
    },
    async find({ where } = {}) {
      return where ? rows.filter((r) => matches(r, where)) : rows.slice();
    },
    async count({ where } = {}) {
      return where ? rows.filter((r) => matches(r, where)).length : rows.length;
    },
    async update(criteria, patch) {
      for (const r of rows) if (matches(r, criteria)) Object.assign(r, patch);
    },
    create(obj) {
      return { ...obj, updatedAt: new Date() };
    },
    async save(entity) {
      if (!entity.id) entity.id = `pt-${rows.length + 1}-${Math.random().toString(36).slice(2, 8)}`;
      const idx = rows.findIndex((r) => r.id === entity.id);
      if (idx >= 0) rows[idx] = entity;
      else rows.unshift(entity);
      return entity;
    },
  };
};

const makeEncryption = () =>
  new EncryptionService({ get: (k) => (k === 'ENCRYPTION_KEY' ? ENCRYPTION_KEY : undefined) });
const decryptWith = (enc) => makeEncryption().decrypt(enc);

const makeStack = (over = {}) => {
  const repo = makeRepo();
  const encryption = makeEncryption();
  const providerStore = new ProviderTokenService(repo, encryption, makeConfig());
  const service = new UpstoxLivePaperTokenService(makeConfig(over), encryption, providerStore);
  return { repo, providerStore, service };
};

const mkRes = () => ({
  code: null,
  body: null,
  type() {
    return this;
  },
  status(code) {
    this.code = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  },
  redirect(url) {
    this.code = 302;
    this.body = url;
    return this;
  },
  send(body) {
    this.body = body;
    return this;
  },
});

const redirectParams = (res) => new URLSearchParams(new URL(String(res.body), 'http://desk.local').search);

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
  async text() {
    return JSON.stringify(body);
  },
});

/** FNF page rendered with stub desk services, real token store. */
const makePageController = (providerStore) => {
  const trading = {
    listPortfolios: async () => [],
    listTrades: async () => [],
    marketTable: async () => [],
    generateSignals: async () => [],
    learningSummary: async () => ({ total: 0, winRate: 0, winners: 0, netPnl: 0, byAlgo: {} }),
    astroMatch: async () => ({ shubh: true, score: 80, label: 'test window' }),
    listCalibrations: async () => [],
    calculateCost: () => ({
      notional: 100000,
      brokerage: 30,
      stt: 0,
      exchangeTxn: 2.75,
      gst: 5.9,
      sebi: 0.1,
      stamp: 15,
      total: 53.75,
    }),
  };
  const feed = {
    status: () => ({ enabled: true, connected: false, fallbackActive: false, subscribedSymbols: [], lastMessage: 'test', provider: 'fyers' }),
  };
  const unified = {
    storeFreshness: async () => ({ ageMs: null, lastTs: null, quotesLast5m: 0, snapshotsLast5m: 0, symbolsLast5m: 0, source: null }),
  };
  return new FnfTradingPageController(trading, providerStore, feed, unified);
};

const renderPage = async (controller, query = {}) => {
  const res = mkRes();
  await controller.page(res, query.fyers, query.reason, query.upstox);
  return String(res.body);
};

(async () => {
  console.log('\n▶ Upstox portal OAuth — FNF Trading button chain\n');

  // ── A. authorization URL ──────────────────────────────────────────────────
  await ta('A. authorization URL: documented dialog + exact server-side params', async () => {
    const { service } = makeStack();
    const { url, state } = await service.initiateTokenRequest('/fnf-trading');
    const u = new URL(url);
    assert.equal(`${u.origin}${u.pathname}`, DIALOG);
    assert.equal(u.searchParams.get('response_type'), 'code');
    assert.equal(u.searchParams.get('client_id'), CLIENT_ID);
    assert.equal(u.searchParams.get('redirect_uri'), REDIRECT);
    assert.equal(u.searchParams.get('state'), state);
    assert.ok((state ?? '').length >= 16, 'state must be long enough to be unguessable');
    assert.ok(!url.includes('client_secret'), 'the secret never appears in the authorization URL');
    assert.ok(!url.includes(SECRET), 'the secret never appears in the authorization URL');
  });

  // ── B. state generation + validation ──────────────────────────────────────
  await ta('B. state: strong random, accepted exactly once', async () => {
    const { service } = makeStack();
    const a = await service.initiateTokenRequest();
    const b = await service.initiateTokenRequest();
    assert.notEqual(a.state, b.state, 'two flows never share a state');
    assert.equal(service.consumeState(a.state).ok, true);
    const replay = service.consumeState(a.state);
    assert.equal(replay.ok, false);
    assert.match(replay.reason, /already-used|Unknown/);
  });

  // ── C. missing state ──────────────────────────────────────────────────────
  await ta('C. callback with a missing state is refused before any exchange', async () => {
    const { service } = makeStack();
    const controller = new UpstoxLivePaperTokenController(service);
    stubFetch(() => {
      throw new Error('fetch must not be called without a state');
    });
    const res = mkRes();
    await controller.callback({ code: 'x', state: undefined }, res);
    global.fetch = realFetch;
    assert.equal(res.code, 302);
    assert.equal(redirectParams(res).get('upstox'), 'error');
    assert.match(redirectParams(res).get('reason'), /Missing OAuth state/);
    assert.equal(fetchCalls.length, 0);
  });

  // ── D. mismatched state ───────────────────────────────────────────────────
  await ta('D. callback with a forged state is refused before any exchange', async () => {
    const { service } = makeStack();
    const controller = new UpstoxLivePaperTokenController(service);
    stubFetch(() => {
      throw new Error('fetch must not be called for a forged state');
    });
    const res = mkRes();
    await controller.callback({ code: 'injected-code', state: 'forged-state' }, res);
    global.fetch = realFetch;
    assert.equal(res.code, 302);
    assert.equal(redirectParams(res).get('upstox'), 'error');
    assert.match(redirectParams(res).get('reason'), /Unknown or already-used/);
    assert.equal(fetchCalls.length, 0);
  });

  // ── E./F. valid callback → documented exchange ────────────────────────────
  await ta('E/F. callback with a valid code: exchange + return to /fnf-trading', async () => {
    const { service, repo } = makeStack();
    const controller = new UpstoxLivePaperTokenController(service);
    const { state } = await service.initiateTokenRequest('/fnf-trading');
    const token = jwtWith({ sub: '87BKM6', iat: Math.floor(Date.now() / 1000), exp: EXP });
    stubFetch(() => jsonResponse({ access_token: token, token_type: 'Bearer' }));

    const res = mkRes();
    await controller.callback({ code: 'SINGLE-USE-CODE', state }, res);
    global.fetch = realFetch;

    assert.equal(res.code, 302);
    assert.match(String(res.body), /^\/fnf-trading\?/, 'portal-initiated logins return to the FNF page');
    const params = redirectParams(res);
    assert.equal(params.get('upstox'), 'ok');
    assert.equal(params.get('client_id'), CLIENT_ID.toUpperCase());
    assert.equal(params.get('expires'), new Date(EXP * 1000).toISOString());
    assert.ok(!String(res.body).includes(token.slice(0, 24)), 'the redirect never carries the token');

    const call = fetchCalls[0];
    assert.ok(call, 'fetch must be called');
    assert.equal(fetchCalls.length, 1);
    assert.equal(call.url, EXCHANGE);
    assert.equal(call.opts.method, 'POST');
    assert.equal(call.opts.headers['content-type'], 'application/x-www-form-urlencoded');
    const body = new URLSearchParams(call.opts.body);
    assert.equal(body.get('grant_type'), 'authorization_code');
    assert.equal(body.get('code'), 'SINGLE-USE-CODE');
    assert.equal(body.get('client_id'), CLIENT_ID);
    assert.equal(body.get('client_secret'), SECRET);
    assert.equal(body.get('redirect_uri'), REDIRECT);
    assert.equal(repo.rows.length, 1, 'one provider_tokens row persisted');
  });

  // ── G. exchange failure ───────────────────────────────────────────────────
  await ta('G. exchange failure: Upstox error surfaces; nothing persisted', async () => {
    const { service, repo } = makeStack();
    const controller = new UpstoxLivePaperTokenController(service);
    const { state } = await service.initiateTokenRequest('/fnf-trading');
    stubFetch(() => jsonResponse({ status: 'error', errors: [{ message: 'Invalid code' }] }, 400));
    const res = mkRes();
    await controller.callback({ code: 'bad-code', state }, res);
    global.fetch = realFetch;
    assert.equal(res.code, 302);
    assert.match(String(res.body), /^\/fnf-trading\?/);
    assert.equal(redirectParams(res).get('upstox'), 'error');
    assert.match(redirectParams(res).get('reason'), /Invalid code/);
    assert.ok(!String(res.body).includes(SECRET), 'the secret never appears in a redirect');
    assert.equal(repo.rows.length, 0, 'nothing persisted on failure');
  });

  // ── H. encryption / storage ───────────────────────────────────────────────
  await ta('H. provider_tokens row: real AES encryption + production identity', async () => {
    const { service, providerStore } = makeStack();
    const token = jwtWith({ exp: EXP });
    await service.persistToken({ clientId: CLIENT_ID, accessToken: token, expiresAt: new Date(EXP * 1000).toISOString() });
    const row = await providerStore.getCurrentToken('upstox', 'live');
    assert.ok(row, 'active row exists');
    assert.equal(row.provider, 'upstox');
    assert.equal(row.environment, 'live');
    assert.equal(row.status, 'active');
    assert.equal(new Date(row.expiresAt).getTime(), EXP * 1000, 'expiresAt from the token exp claim');
    assert.notEqual(row.accessTokenEncrypted, token, 'the stored value is not the raw token');
    assert.ok(!row.accessTokenEncrypted.includes(token.slice(0, 24)), 'ciphertext contains no plaintext fragment');
    assert.match(row.accessTokenEncrypted, /^[0-9a-f]+:[0-9a-f]+$/, 'iv:cipher hex format (AES-256-CBC)');
    assert.equal(decryptWith(row.accessTokenEncrypted), token, 'decrypts back to the exact token');
  });

  // ── I. replacement / single active row ────────────────────────────────────
  await ta('I. re-login replaces the active token; never two selectable active rows', async () => {
    const { service, providerStore, repo } = makeStack();
    const tokenA = jwtWith({ exp: EXP });
    const tokenB = jwtWith({ exp: EXP + 120 });
    await service.persistToken({ clientId: CLIENT_ID, accessToken: tokenA, expiresAt: new Date(EXP * 1000).toISOString() });
    await service.persistToken({ clientId: CLIENT_ID, accessToken: tokenB, expiresAt: new Date((EXP + 120) * 1000).toISOString() });
    const active = repo.rows.filter((r) => r.provider === 'upstox' && r.environment === 'live' && r.status === 'active');
    assert.equal(active.length, 1, 'exactly one active row');
    const current = await providerStore.getCurrentToken('upstox', 'live');
    assert.equal(decryptWith(current.accessTokenEncrypted), tokenB, 'the fresh token is the one selected');
  });

  await ta('I2. stray duplicate active rows are collapsed, not left ambiguous', async () => {
    const { service, repo } = makeStack();
    await service.persistToken({ clientId: CLIENT_ID, accessToken: jwtWith({ exp: EXP }), expiresAt: new Date(EXP * 1000).toISOString() });
    repo.rows.unshift({ id: 'stray-row', provider: 'upstox', environment: 'live', status: 'active', accessTokenEncrypted: 'enc:stray' });
    const tokenC = jwtWith({ exp: EXP + 60 });
    await service.persistToken({ clientId: CLIENT_ID, accessToken: tokenC, expiresAt: new Date((EXP + 60) * 1000).toISOString() });
    const active = repo.rows.filter((r) => r.provider === 'upstox' && r.environment === 'live' && r.status === 'active');
    assert.equal(active.length, 1, 'single active row after the write');
    assert.equal(decryptWith(active[0].accessTokenEncrypted), tokenC, 'fresh token selected');
    assert.ok(repo.rows.some((r) => r.status === 'revoked'), 'the superseded duplicate is revoked');
  });

  // ── J. retrieval after login ──────────────────────────────────────────────
  await ta('J. retrieval: getCurrentToken → decrypt → consumer path → status', async () => {
    const { service, providerStore } = makeStack();
    const token = jwtWith({ exp: EXP });
    await service.persistToken({ clientId: CLIENT_ID, accessToken: token, expiresAt: new Date(EXP * 1000).toISOString() });
    assert.ok(await providerStore.getCurrentToken('upstox', 'live'), 'getCurrentToken selects the fresh row');
    assert.equal(await providerStore.getActiveAccessToken('upstox', 'live'), token, 'decrypted access token');
    const active = await service.getValidUpstoxAccessToken();
    assert.equal(active.token, token, 'consumer choke point returns the stored token');
    assert.equal(active.clientId, CLIENT_ID.toUpperCase());
    assert.equal(new Date(active.expiresAt).getTime(), EXP * 1000);
    const status = await service.tokenStatus();
    assert.equal(status.status, 'TOKEN_VALID');
  });

  await ta('J2. consumer refuses missing/expired tokens — no env or hard-coded fallback', async () => {
    const { service } = makeStack();
    await assert.rejects(() => service.getValidUpstoxAccessToken(), /AUTH_REQUIRED/);

    const { service: s2 } = makeStack();
    await s2.persistToken({
      clientId: CLIENT_ID,
      accessToken: jwtWith({ exp: Math.floor(Date.now() / 1000) - 60 }),
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await assert.rejects(() => s2.getValidUpstoxAccessToken(), /TOKEN_EXPIRED — AUTH_REQUIRED/);
  });

  // ── K. no credential exposure ─────────────────────────────────────────────
  await ta('K. callback + portal never expose credentials', async () => {
    const svcSrc = fs.readFileSync(path.join(SRC, 'upstox-live-paper-auth.service.ts'), 'utf8');
    const ctrlSrc = fs.readFileSync(path.join(SRC, 'upstox-live-paper-token.controller.ts'), 'utf8');
    assert.ok(!/logger\.\w+\([^)]*accessToken[^)]*\)/.test(svcSrc), 'the token is never passed to the logger');
    assert.ok(!/console\.log\(/.test(svcSrc), 'no console logging in the token service');
    assert.ok(!/logger\.\w+\([^)]*(client_secret|accessToken)/.test(ctrlSrc), 'the controller logs no secret material');
    const pageSrc = fs.readFileSync(path.join(ROOT, 'src', 'trading', 'fnf-trading-page.controller.ts'), 'utf8');
    assert.ok(!pageSrc.includes('UPSTOX_LIVE_API_SECRET'), 'the portal page never references the API secret');
    assert.ok(!pageSrc.includes('client_secret'), 'the portal page never handles a client_secret');
  });

  // ── L. portal success ─────────────────────────────────────────────────────
  await ta('L. portal: button beside FYERS; success banner + ACTIVE status after login', async () => {
    const { service, providerStore } = makeStack();
    const page = makePageController(providerStore);
    const before = await renderPage(page);
    assert.ok(before.includes('href="/api/upstox/login"'), 'Upstox button present');
    assert.ok(before.includes('GET UPSTOX TOKEN — log in at Upstox'), 'button label');
    assert.ok(before.includes('href="/auth/fyers/login"'), 'FYERS button still present');
    assert.ok(before.includes('NO TOKEN — click GET UPSTOX TOKEN below'), 'independent Upstox status');

    await service.persistToken({ clientId: CLIENT_ID, accessToken: jwtWith({ exp: EXP }), expiresAt: new Date(EXP * 1000).toISOString() });
    const after = await renderPage(page, { upstox: 'ok' });
    assert.ok(after.includes('✅ Upstox login successful — token stored securely in the database'), 'success banner');
    assert.ok(after.includes('ACTIVE (stored in DB, encrypted)'), 'independent ACTIVE status for Upstox');
    assert.ok(!after.includes(SECRET), 'no secret in the rendered page');
  });

  // ── M. portal failure ─────────────────────────────────────────────────────
  await ta('M. portal failure banner is safe and specific', async () => {
    const { providerStore } = makeStack();
    const page = makePageController(providerStore);
    const html = await renderPage(page, { upstox: 'error', reason: 'OAuth state expired (5 minute limit) — start again from the desk' });
    assert.ok(html.includes('⚠️ Upstox login failed'), 'failure banner shown');
    assert.ok(html.includes('OAuth state expired'), 'reason echoed');
    assert.ok(!html.includes(SECRET), 'no secret anywhere');
  });

  // ── N. notifier intake validation (Upstox → POST /api/upstox/notifier) ────
  await ta('N1. notifier: valid payload persists encrypted; response never echoes the token', async () => {
    const { service, providerStore, repo } = makeStack();
    const controller = new UpstoxLivePaperTokenController(service);
    const token = jwtWith({ sub: '87BKM6', exp: EXP });
    const res = await controller.notifier({
      client_id: CLIENT_ID,
      user_id: '87BKM6',
      access_token: token,
      token_type: 'Bearer',
      issued_at: new Date(EXP * 1000 - 3600_000).toISOString(),
      expires_at: new Date(EXP * 1000).toISOString(),
      message_type: 'access_token',
    });
    assert.equal(res.received, true);
    assert.equal(res.stored, true);
    assert.ok(!JSON.stringify(res).includes(token.slice(0, 24)), 'the response never carries the token');
    const row = await providerStore.getCurrentToken('upstox', 'live');
    assert.ok(row, 'a provider_tokens row was written');
    assert.equal(row.provider, 'upstox');
    assert.equal(row.environment, 'live');
    assert.equal(row.status, 'active');
    assert.equal(decryptWith(row.accessTokenEncrypted), token, 'stored value decrypts to the notifier token');
    assert.notEqual(row.accessTokenEncrypted, token, 'never stored in plaintext');
    assert.equal(repo.rows.filter((r) => r.status === 'active').length, 1, 'exactly one active row');
  });

  await ta('N2. notifier: unsupported message_type is ignored (nothing stored)', async () => {
    const { service, repo } = makeStack();
    const controller = new UpstoxLivePaperTokenController(service);
    const res = await controller.notifier({
      client_id: CLIENT_ID,
      access_token: jwtWith({ exp: EXP }),
      expires_at: new Date(EXP * 1000).toISOString(),
      message_type: 'order_update',
    });
    assert.equal(res.received, true);
    assert.equal(res.ignored, true);
    assert.equal(repo.rows.length, 0);
  });

  await ta('N3. notifier: missing required fields are ignored (nothing stored)', async () => {
    const { service, repo } = makeStack();
    const controller = new UpstoxLivePaperTokenController(service);
    const res = await controller.notifier({ client_id: CLIENT_ID, message_type: 'access_token' });
    assert.equal(res.ignored, true);
    assert.equal(repo.rows.length, 0);
  });

  await ta('N4. notifier: unknown client_id is rejected; nothing stored; no token echoed', async () => {
    const { service, repo } = makeStack();
    const controller = new UpstoxLivePaperTokenController(service);
    const token = jwtWith({ exp: EXP });
    const res = await controller.notifier({
      client_id: 'EVIL-APP',
      access_token: token,
      expires_at: new Date(EXP * 1000).toISOString(),
      message_type: 'access_token',
    });
    assert.equal(res.received, true);
    assert.equal(res.stored, false);
    assert.match(String(res.error), /unknown Upstox client_id/);
    assert.ok(!JSON.stringify(res).includes(token.slice(0, 24)), 'no token material in the response');
    assert.equal(repo.rows.length, 0);
  });

  await ta('N5. notifier: a second payload replaces the single active row (never two selectable rows)', async () => {
    const { service, providerStore, repo } = makeStack();
    const controller = new UpstoxLivePaperTokenController(service);
    const t1 = jwtWith({ exp: EXP });
    const t2 = jwtWith({ exp: EXP + 60 });
    await controller.notifier({ client_id: CLIENT_ID, access_token: t1, token_type: 'Bearer', expires_at: new Date(EXP * 1000).toISOString(), message_type: 'access_token' });
    await controller.notifier({ client_id: CLIENT_ID, access_token: t2, token_type: 'Bearer', expires_at: new Date((EXP + 60) * 1000).toISOString(), message_type: 'access_token' });
    assert.equal(repo.rows.filter((r) => r.status === 'active').length, 1);
    const current = await providerStore.getCurrentToken('upstox', 'live');
    assert.equal(decryptWith(current.accessTokenEncrypted), t2, 'the fresh token is selected');
  });

  // ── INTEGRATION: the full chain ───────────────────────────────────────────
  await ta('INTEGRATION: button → login route → callback → exchange → provider_tokens → retrieval → portal', async () => {
    const { service, providerStore, repo } = makeStack();
    const controller = new UpstoxLivePaperTokenController(service);
    const page = makePageController(providerStore);

    // 1. the rendered portal exposes the button
    const html1 = await renderPage(page);
    const buttonHref = (html1.match(/href="([^"]*upstox[^"]*)"/) ?? [])[1];
    assert.ok(buttonHref && buttonHref.startsWith('/api/upstox'), 'button target is the login route');

    // 2. the login route redirects to the broker dialog with a server-minted state
    const loginRes = mkRes();
    await controller.login(loginRes);
    assert.equal(loginRes.code, 302);
    const dialog = new URL(String(loginRes.body));
    assert.equal(`${dialog.origin}${dialog.pathname}`, DIALOG);
    const state = dialog.searchParams.get('state');
    assert.ok(state, 'state minted server-side');
    assert.ok(!String(loginRes.body).includes(SECRET), 'no secret in the redirect');

    // 3. the callback (Upstox → registered URI) with a mocked exchange
    const token = jwtWith({ sub: '87BKM6', exp: EXP });
    stubFetch((_url, opts) => {
      const body = new URLSearchParams(opts.body);
      assert.equal(body.get('redirect_uri'), REDIRECT, 'exchange must use the registered redirect URI');
      return jsonResponse({ access_token: token, token_type: 'Bearer' });
    });
    const cbRes = mkRes();
    await controller.callback({ code: 'chain-code', state }, cbRes);
    global.fetch = realFetch;
    assert.equal(redirectParams(cbRes).get('upstox'), 'ok', 'callback redirects to the portal with success');

    // 4. encrypted provider_tokens persistence
    const row = await providerStore.getCurrentToken('upstox', 'live');
    assert.ok(row && row.provider === 'upstox' && row.environment === 'live' && row.status === 'active');
    assert.equal(decryptWith(row.accessTokenEncrypted), token, 'stored value decrypts to the exchanged token');
    assert.equal(repo.rows.filter((r) => r.status === 'active').length, 1);

    // 5. the trading-agent consumption path reads the fresh token
    const consumed = await service.getValidUpstoxAccessToken();
    assert.equal(consumed.token, token);

    // 6. the portal shows the result
    const html2 = await renderPage(page, { upstox: 'ok' });
    assert.ok(html2.includes('✅ Upstox login successful'), 'portal success state');
    assert.ok(html2.includes('ACTIVE (stored in DB, encrypted)'), 'portal token status ACTIVE');
  });

  await ta('INTEGRATION: a replayed callback cannot double-store', async () => {
    const { service, repo } = makeStack();
    const controller = new UpstoxLivePaperTokenController(service);
    const { state } = await service.initiateTokenRequest('/fnf-trading');
    stubFetch(() => jsonResponse({ access_token: jwtWith({ exp: EXP }), token_type: 'Bearer' }));
    await controller.callback({ code: 'c1', state }, mkRes());
    const res2 = mkRes();
    await controller.callback({ code: 'c1', state }, res2);
    global.fetch = realFetch;
    assert.equal(redirectParams(res2).get('upstox'), 'error');
    assert.match(redirectParams(res2).get('reason'), /already-used|Unknown/);
    assert.equal(repo.rows.length, 1, 'replay stored nothing');
  });

  console.log(`\n${fail === 0 ? '✔' : '✘'} upstox-portal-oauth: ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error('test harness crashed:', err);
  process.exit(1);
});
