/**
 * Auth tests for the /ai/test probe token (HERMES_AI_TEST_TOKEN).
 *
 * Convention follows the repo's existing scripts/*.test.js style: plain node,
 * no Jest, run AFTER `npm run build` (requires ../dist/...).
 *
 * Covers (task requirements):
 *   1. valid AI test token            -> allowed (no operator password needed)
 *   2. missing AI test token          -> 401
 *   3. wrong AI test token            -> 401
 *   4. operator password NOT required when a valid AI test token is supplied
 *   5. existing operator-password auth still works on other (non-token) routes
 *   6. token never authenticates routes that are not opted in (@AllowAiTestToken)
 *   7. missing HERMES_AI_TEST_TOKEN config fails closed (even with a header)
 *   8. the @AllowAiTestToken metadata really is on the compiled /ai/test handler
 *
 * Run: npm run build && node scripts/ai-auth.test.js
 */
'use strict';

require('reflect-metadata'); // Nest decorator metadata (same as src/main.ts)
const assert = require('node:assert/strict');
const {
  ConditionalAuthGuard,
  AI_TEST_TOKEN_KEY,
  AI_TEST_HEADER,
  AUTH_HEADER,
  aiTestTokenOk,
} = require('../dist/auth/conditional-auth.guard');
const { AiTestController } = require('../dist/ai/ai-test.controller');

const CFG_TOKEN = 'cfg-hermes-ai-test-token-9f2c';
const OP_PASSWORD = 'cfg-operator-password';

// A reflector fake that behaves like the real Nest Reflector for
// getAllAndOverride: read handler metadata first, then class metadata
// (Reflect-backed so real decorator metadata is honoured), with a map
// fallback for synthetic handlers used in the other-route scenarios.
const reflectorOf = (handlerMeta = {}, classMeta = {}) => ({
  getAllAndOverride: (key, [handler, cls]) =>
    Reflect.getMetadata(key, handler) ?? Reflect.getMetadata(key, cls) ?? handlerMeta[key] ?? classMeta[key],
});

const makeContext = (opts = {}) => {
  const req = {
    headers: { ...(opts.headers ?? {}) },
    session: {}, // express-session always attaches an object in production
    body: {},
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
  };
  return {
    getHandler: () => opts.handler ?? (() => {}),
    getClass: () => opts.cls ?? class {},
    switchToHttp: () => ({ getRequest: () => req }),
    req,
  };
};

let passed = 0;
const ok = (name) => {
  passed += 1;
  console.log(`  ok - ${name}`);
};

async function allows(name, guard, ctx) {
  const r = await guard.canActivate(ctx);
  assert.equal(r, true, `${name}: expected allow`);
  ok(name);
}

async function throws401(name, guard, ctx) {
  await assert.rejects(
    () => guard.canActivate(ctx),
    (e) => e && e.constructor && e.constructor.name === 'UnauthorizedException',
    `${name}: expected 401 UnauthorizedException`,
  );
  ok(name);
}

async function main() {
  console.log('ai-auth: /ai/test probe-token auth (HERMES_AI_TEST_TOKEN)');

  process.env.HERMES_AI_TEST_TOKEN = CFG_TOKEN;
  process.env.SESSION_PASSWORD = OP_PASSWORD;

  // Guard on the REAL /ai/test handler: exercises the compiled decorator
  // wiring (metadata present) plus the token path end-to-end.
  const aiTestCtx = (headers) =>
    makeContext({ handler: AiTestController.prototype.test, headers });

  // 1 + 4: valid token -> allowed, and no operator password is presented.
  {
    const guard = new ConditionalAuthGuard(reflectorOf());
    const ctx = aiTestCtx({ [AI_TEST_HEADER]: CFG_TOKEN });
    await allows('valid AI test token -> allowed (no operator password)', guard, ctx);
    assert.equal(ctx.req.session.user, undefined, 'token must not mint a session identity');
  }

  // 2: missing header -> 401.
  {
    const guard = new ConditionalAuthGuard(reflectorOf());
    await throws401('missing AI test token -> 401', guard, aiTestCtx({}));
  }

  // 3: wrong token -> 401.
  {
    const guard = new ConditionalAuthGuard(reflectorOf());
    await throws401('wrong AI test token -> 401', guard, aiTestCtx({ [AI_TEST_HEADER]: 'not-the-token' }));
  }

  // 6: token must NOT authenticate a route without @AllowAiTestToken metadata
  //    (any other controller handler), even when the token is correct.
  {
    const guard = new ConditionalAuthGuard(reflectorOf());
    const otherRoute = makeContext({ headers: { [AI_TEST_HEADER]: CFG_TOKEN } }); // bare fn -> no metadata
    await throws401('AI test token on a non-opted-in route -> 401', guard, otherRoute);
  }

  // 5: operator password still works on non-token routes.
  {
    const guard = new ConditionalAuthGuard(reflectorOf());
    const otherRoute = makeContext({ headers: { [AUTH_HEADER]: OP_PASSWORD } });
    await allows('operator password still authenticates other routes', guard, otherRoute);
  }

  // 5b: operator password also works on the /ai/test handler itself (token is
  //     an addition, not a replacement for the password wall).
  {
    const guard = new ConditionalAuthGuard(reflectorOf());
    await allows('operator password still accepted on /ai/test', guard, aiTestCtx({ [AUTH_HEADER]: OP_PASSWORD }));
  }

  // 7: missing HERMES_AI_TEST_TOKEN config -> fail closed even with a header.
  {
    delete process.env.HERMES_AI_TEST_TOKEN;
    const guard = new ConditionalAuthGuard(reflectorOf());
    await throws401('missing HERMES_AI_TEST_TOKEN config -> 401 (fail closed)', guard, aiTestCtx({ [AI_TEST_HEADER]: CFG_TOKEN }));
    process.env.HERMES_AI_TEST_TOKEN = CFG_TOKEN; // restore
  }

  // 8: compiled /ai/test handler really carries the route metadata.
  {
    const meta = Reflect.getMetadata(AI_TEST_TOKEN_KEY, AiTestController.prototype.test);
    assert.equal(meta, true, '@AllowAiTestToken metadata must be on POST /ai/test');
    ok('@AllowAiTestToken metadata present on compiled /ai/test handler');
  }

  // Constant-time helper sanity.
  {
    assert.equal(aiTestTokenOk(CFG_TOKEN), true, 'helper: match');
    assert.equal(aiTestTokenOk('wrong'), false, 'helper: mismatch');
    assert.equal(aiTestTokenOk(''), false, 'helper: empty');
    assert.equal(aiTestTokenOk(undefined), false, 'helper: undefined');
    ok('aiTestTokenOk helper behaves fail-closed');
  }

  console.log(`\nai-auth: ALL PASS (${passed} assertions)`);
}

main().catch((e) => {
  console.error('\nai-auth: FAIL');
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
