#!/usr/bin/env node
/**
 * Upstox LIVE token acquisition — OAuth authorization-code flow tests.
 *
 * Proves the self-service path end to end, in-process (no DB, no network, no
 * running server):
 *
 *  1. initiateTokenRequest builds Upstox's DOCUMENTED dialog URL
 *     (api.upstox.com/v2/login/authorization/dialog) and the dead host
 *     (apps.upstox.com/authorization) is gone.
 *  2. The minted state is single-use, TTL-bounded, and missing/unknown/expired
 *     states are refused before anything reaches Upstox.
 *  3. completeAuthorization POSTs the documented form body (code, client_id,
 *     client_secret, redirect_uri, grant_type=authorization_code), derives the
 *     expiry from the token's own exp claim, encrypts and persists it, and never
 *     returns or logs the raw token.
 *  4. Upstox errors surface their own message and nothing is persisted.
 *  5. A token with no exp claim and no expires_in is REFUSED (no guessed
 *     lifetime); expires_in is honoured when Upstox supplies it.
 *  6. The controller callback redirects to the desk with upstox=ok / upstox=error
 *     (or JSON when asked), burns the state, refuses replay, and is @BypassAuth
 *     so Upstox's redirect cannot be blocked by the operator wall.
 *  7. The desk page actually exposes the button and the result banner.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'trading', 'upstox-live-paper');
const PAGE = path.join(ROOT, 'public', 'upstox-live-paper.html');

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

// ── build + load compiled module ─────────────────────────────────────────────
console.log('▶ building module (tsc) …');
try {
  execSync('npm run build', { cwd: ROOT, stdio: 'pipe', timeout: 240_000 });
} catch {
  // fall through — dist presence is asserted below
}
const DIST = path.join(ROOT, 'dist', 'trading', 'upstox-live-paper');
if (!fs.existsSync(DIST)) {
  console.error('✘ dist/trading/upstox-live-paper missing — cannot run behavioural tests');
  process.exit(1);
}
const { UpstoxLivePaperTokenService } = require(path.join(DIST, 'upstox-live-paper-auth.service.js'));
const { UpstoxLivePaperTokenController } = require(path.join(DIST, 'upstox-live-paper-token.controller.js'));
const { ProviderTokenService } = require(path.join(ROOT, 'dist', 'trading', 'provider-token.service.js'));

// ── fixtures ─────────────────────────────────────────────────────────────────
const CLIENT_ID = '8ca3aaaa-1111-2222-3333-444455556666';
const SECRET = 'unit-test-secret-never-real';
const REDIRECT = 'https://berhampore.in/api/upstox/callback';
const DIALOG = 'https://api.upstox.com/v2/login/authorization/dialog';
const EXCHANGE = 'https://api.upstox.com/v2/login/authorization/token';
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

/**
 * In-memory repo for the REAL ProviderTokenService — the unified store the
 * token service now writes/reads (provider_tokens). Implements the exact
 * TypeORM surface used by storeTokens/getCurrentToken/getActiveAccessToken:
 * findOne / find / count / update / create / save, including FindOperator
 * handling for the stray-row collapse (update({..., id: Not(existing.id)})).
 */
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

const build = (over = {}) => {
  const repo = makeRepo();
  const encryption = { encrypt: (value) => `enc:${value}`, decrypt: (value) => String(value ?? '').replace(/^enc:/, '') };
  // The service persists through the unified provider store — construct the
  // REAL ProviderTokenService on the in-memory repo (no DB, no network).
  const providerStore = new ProviderTokenService(repo, encryption, makeConfig());
  const service = new UpstoxLivePaperTokenService(makeConfig(over), encryption, providerStore);
  return { service, repo, providerStore };
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

/** Read the query params of a redirect target (URLSearchParams handles + as space). */
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

(async () => {
  console.log('\n▶ Upstox LIVE token — OAuth code flow\n');

  // ── 1. dialog URL ──────────────────────────────────────────────────────────
  await ta('initiateTokenRequest builds the documented dialog URL', async () => {
    const { service } = build();
    const { url, state } = await service.initiateTokenRequest();
    const u = new URL(url);
    assert.equal(`${u.origin}${u.pathname}`, DIALOG);
    assert.equal(u.searchParams.get('response_type'), 'code');
    assert.equal(u.searchParams.get('client_id'), CLIENT_ID);
    assert.equal(u.searchParams.get('redirect_uri'), REDIRECT);
    assert.equal(u.searchParams.get('state'), state);
    assert.ok(state.length >= 16, 'state must be long enough to be unguessable');
    assert.ok(!url.includes('apps.upstox.com'), 'the dead authorization host must not be used');
  });

  await ta('initiating without a redirect URI fails loudly', async () => {
    const { service } = build({ UPSTOX_LIVE_REDIRECT_URI: '' });
    await assert.rejects(() => service.initiateTokenRequest(), /UPSTOX_LIVE_REDIRECT_URI not configured/);
  });

  // ── 2. state lifecycle ────────────────────────────────────────────────────
  await ta('a minted state is accepted exactly once', async () => {
    const { service } = build();
    const { state } = await service.initiateTokenRequest();
    assert.equal(service.consumeState(state).ok, true);
    const replay = service.consumeState(state);
    assert.equal(replay.ok, false);
    assert.match(replay.reason, /already-used|Unknown/);
  });

  await ta('missing, unknown and expired states are refused', async () => {
    const { service } = build();
    assert.equal(service.consumeState(undefined).ok, false);
    assert.match(service.consumeState(undefined).reason, /Missing OAuth state/);
    assert.equal(service.consumeState('forged-state').ok, false);
    assert.match(service.consumeState('forged-state').reason, /Unknown or already-used/);

    service.pendingStates.set('stale-state', { createdAt: Date.now() - 6 * 60 * 1000, used: false });
    const expired = service.consumeState('stale-state');
    assert.equal(expired.ok, false);
    assert.match(expired.reason, /expired/);
    assert.equal(service.pendingStates.has('stale-state'), false, 'expired state is dropped');
  });

  // ── 3. exchange + persist ─────────────────────────────────────────────────
  await ta('completeAuthorization exchanges the code and persists the token without returning it', async () => {
    const { service, repo } = build();
    const token = jwtWith({ sub: '87BKM6', iat: Math.floor(Date.now() / 1000), exp: EXP });
    stubFetch(() => jsonResponse({ access_token: token, token_type: 'Bearer', email: 'operator@example.com' }));

    const out = await service.completeAuthorization('SINGLE-USE-CODE');
    global.fetch = realFetch;

    const call = fetchCalls[0];
    assert.ok(call, 'fetch must be called exactly once');
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

    assert.equal(out.clientId, CLIENT_ID.toUpperCase());
    assert.equal(new Date(out.expiresAt).getTime(), EXP * 1000, 'expiry must come from the exp claim');

    assert.equal(repo.rows.length, 1, 'exactly one row persisted');
    assert.equal(repo.rows[0].provider, 'upstox');
    assert.equal(repo.rows[0].environment, 'live');
    assert.equal(repo.rows[0].status, 'active');
    assert.equal(new Date(repo.rows[0].expiresAt).getTime(), EXP * 1000, 'expiry (exp claim) stored on the provider row');
    assert.equal(repo.rows[0].accessTokenEncrypted, `enc:${token}`, 'token stored encrypted, never plain');
    assert.ok(!JSON.stringify(out).includes('eyJ'), 'the raw token must not be handed back to the caller');
  });

  await ta('an Upstox error surfaces its own message and persists nothing', async () => {
    const { service, repo } = build();
    stubFetch(() => jsonResponse({ status: 'error', errors: [{ message: 'Invalid code' }] }, 400));
    await assert.rejects(() => service.completeAuthorization('bad-code'), /Invalid code/);
    global.fetch = realFetch;
    assert.equal(repo.rows.length, 0);
  });

  await ta('a token with no expiry is refused rather than guessed', async () => {
    const { service, repo } = build();
    stubFetch(() => jsonResponse({ access_token: 'opaque-token-no-claims', token_type: 'Bearer' }));
    await assert.rejects(() => service.completeAuthorization('code'), /no token expiry/);
    global.fetch = realFetch;
    assert.equal(repo.rows.length, 0);
  });

  await ta('expires_in from Upstox is honoured when there is no exp claim', async () => {
    const { service, repo } = build();
    stubFetch(() => jsonResponse({ access_token: 'opaque-token', expires_in: 3600 }));
    const out = await service.completeAuthorization('code');
    global.fetch = realFetch;
    const delta = new Date(out.expiresAt).getTime() - Date.now();
    assert.ok(Math.abs(delta - 3600_000) < 10_000, `expiry should be ~1h out, got ${delta}ms`);
    assert.equal(repo.rows.length, 1);
  });

  await ta('a missing client_secret blocks the exchange before any network call', async () => {
    const { service } = build({ UPSTOX_LIVE_API_SECRET: '' });
    stubFetch(() => {
      throw new Error('fetch must not be called without a client_secret');
    });
    await assert.rejects(() => service.completeAuthorization('code'), /UPSTOX_LIVE_API_SECRET not configured/);
    global.fetch = realFetch;
    assert.equal(fetchCalls.length, 0);
  });

  // ── 4. controller callback ────────────────────────────────────────────────
  await ta('callback refuses a forged state and redirects with the reason', async () => {
    const { service } = build();
    const controller = new UpstoxLivePaperTokenController(service);
    stubFetch(() => {
      throw new Error('fetch must not be called for a forged state');
    });
    const res = mkRes();
    await controller.callback({ code: 'injected-code', state: 'forged' }, res);
    global.fetch = realFetch;

    assert.equal(res.code, 302);
    assert.match(res.body, /^\/upstox-live-paper\.html\?/);
    const params = redirectParams(res);
    assert.equal(params.get('upstox'), 'error');
    assert.match(params.get('reason'), /Unknown or already-used OAuth state/);
    assert.equal(fetchCalls.length, 0, 'no exchange attempted for a forged state');
  });

  await ta('callback completes the flow, redirects upstox=ok, and burns the state', async () => {
    const { service, repo } = build();
    const controller = new UpstoxLivePaperTokenController(service);
    const { state } = await service.initiateTokenRequest();
    stubFetch(() => jsonResponse({ access_token: jwtWith({ exp: EXP }), token_type: 'Bearer' }));

    const res = mkRes();
    await controller.callback({ code: 'real-code', state }, res);

    assert.equal(res.code, 302);
    const params = redirectParams(res);
    assert.equal(params.get('upstox'), 'ok');
    assert.equal(params.get('client_id'), CLIENT_ID.toUpperCase());
    assert.equal(params.get('expires'), new Date(EXP * 1000).toISOString());
    assert.equal(repo.rows.length, 1, 'token persisted through the callback');

    const replay = mkRes();
    await controller.callback({ code: 'real-code', state }, replay);
    global.fetch = realFetch;
    assert.equal(redirectParams(replay).get('upstox'), 'error');
    assert.equal(repo.rows.length, 1, 'replay must not store a second token');
  });

  await ta('callback reports Upstox-side denials and supports format=json', async () => {
    const { service } = build();
    const controller = new UpstoxLivePaperTokenController(service);
    const res = mkRes();
    await controller.callback({ error: 'access_denied', error_description: 'User denied', format: 'json' }, res);
    assert.equal(res.code, 400);
    assert.equal(res.body.upstox, 'error');
    assert.equal(res.body.reason, 'User denied');

    const res2 = mkRes();
    await controller.callback({ code: 'c', state: 'forged', format: 'json' }, res2);
    assert.equal(res2.code, 400);
    assert.match(res2.body.reason, /Unknown or already-used/);
  });

  await ta('callback without a code is reported, not silently ignored', async () => {
    const { service } = build();
    const controller = new UpstoxLivePaperTokenController(service);
    const res = mkRes();
    await controller.callback({ state: 'whatever' }, res);
    assert.equal(res.code, 302);
    assert.equal(redirectParams(res).get('upstox'), 'error');
    assert.match(redirectParams(res).get('reason'), /missing authorization code/);
  });

  // ── 5. source + page assertions ───────────────────────────────────────────
  t('the dead Upstox host is gone and both documented endpoints are used', () => {
    const src = fs.readFileSync(path.join(SRC, 'upstox-live-paper-auth.service.ts'), 'utf8');
    assert.ok(!/['"`]https:\/\/apps\.upstox\.com/.test(src), 'the dead authorization host must not be used as a URL');
    assert.ok(src.includes(DIALOG), 'dialog endpoint present');
    assert.ok(src.includes(EXCHANGE), 'exchange endpoint present');
    assert.ok(!/logger\.\w+\([^)]*accessToken[^)]*\)/.test(src), 'the token must never be logged');
  });

  t('the callback is public but state-guarded, and the notifier fallback is untouched', () => {
    const src = fs.readFileSync(path.join(SRC, 'upstox-live-paper-token.controller.ts'), 'utf8');
    assert.ok(/@Get\('callback'\)\s*\n\s*@BypassAuth\(\)/.test(src), 'callback must be @BypassAuth for the Upstox redirect');
    assert.ok(src.includes('consumeState'), 'callback must validate the state');
    assert.ok(src.includes('@Post(\'notifier\')'), 'the notifier intake stays');
    assert.ok(!/slice\(0, 8\)/.test(src), 'the old code-prefix log must be gone');
  });

  t('the desk page exposes the button, the status fields and the result banner', () => {
    const html = fs.readFileSync(PAGE, 'utf8');
    assert.ok(html.includes('href="/api/upstox/token/init"'), 'GET THE TOKEN must link to the init route');
    assert.ok(html.includes('id="tok-status"') && html.includes('id="tok-expiry"'), 'token status fields present');
    assert.ok(html.includes('id="tok-banner"'), 'result banner present');
    assert.ok(html.includes("oauth === 'ok'") && html.includes("oauth === 'error'"), 'banner handles both outcomes');
  });

  console.log(`\n${fail === 0 ? '✔' : '✘'} upstox-token-oauth: ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error('test harness crashed:', err);
  process.exit(1);
});
