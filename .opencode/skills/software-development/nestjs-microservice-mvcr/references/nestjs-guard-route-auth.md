# Route-scoped alternate auth inside a global NestJS guard (probe tokens)

Session origin: my-job-agent POST /ai/test (2026-09-06) — one machine-probe
endpoint behind the global operator-password wall (ConditionalAuthGuard as
APP_GUARD) needed its own env credential (`HERMES_AI_TEST_TOKEN`) without
weakening any other route. Verified working: build green, 9/9 guard tests,
full regression sweep clean.

## The problem class
A single endpoint protected by a global auth wall (APP_GUARD) must accept its
own credential from environment/config. Requirements that recur: no global
bypass, no weakening of other routes, the new credential must NOT open other
routes, fail closed, constant-time compare, never log the token.

## Design rules (validated — do not re-litigate)
1. **Never just add `@UseGuards` on the route.** Global guards run FIRST and
   throw 401, so the route-level guard is never consulted. The route must be
   recognized *inside* the existing wall.
2. **Avoid `@BypassAuth` + a dedicated guard.** It reads as lifting the auth
   wall for the route and makes review optics worse. The global guard should
   still run and only let the request through on a token match.
3. **Smallest clean change: opt-in metadata checked inside the global guard.**

   Guard file (`conditional-auth.guard.ts`-style):
   ```ts
   export const AI_TEST_TOKEN_KEY = 'aiTestToken';
   export const AI_TEST_HEADER = 'x-hermes-ai-test-token';

   export function aiTestTokenOk(input: unknown): boolean {
     if (typeof input !== 'string' || input.length === 0) return false; // fail closed
     const expected = process.env.HERMES_AI_TEST_TOKEN;
     if (!expected || expected.length === 0) return false;              // no config -> fail closed
     const a = createHash('sha256').update(input).digest();
     const b = createHash('sha256').update(expected).digest();
     return timingSafeEqual(a, b); // equal digest lengths: no length leak, no throw
   }
   ```
   Decorator file (the same one that defines `BypassAuth`):
   ```ts
   export const AllowAiTestToken = () => SetMetadata(AI_TEST_TOKEN_KEY, true);
   ```
   Guard `canActivate`, positioned AFTER the IP-whitelist check and BEFORE the
   operator-password path:
   ```ts
   const wantsAiTestToken = this.reflector.getAllAndOverride<boolean>(
     AI_TEST_TOKEN_KEY, [context.getHandler(), context.getClass()]);
   if (wantsAiTestToken && aiTestTokenOk(req.headers[AI_TEST_HEADER])) return true;
   ```
   Controller: decorate exactly the one handler. Anything without the metadata
   ignores the header entirely — the token authenticates nothing else.
4. **Probe token mints NO session** — it is not an identity. Return `true`
   without touching `req.session`. (Assert `req.session.user` stays undefined.)
5. Read config from `process.env` at request time — matches the existing
   `operatorPasswordOk()` style; `ConfigModule.forRoot` loads `.env` at boot.
6. Never log the supplied or configured token.

## Plain-node unit tests for guards (repo has NO @nestjs/testing/Jest/supertest)

Repo convention: `scripts/*.test.js`, plain node, requires from `dist/` AFTER
`npm run build`, chained in package.json (e.g.
`"test:ai": "npm run build && node scripts/a.test.js && node scripts/b.test.js"`).

Recipe that works (from `scripts/ai-auth.test.js`):
- **`require('reflect-metadata')` FIRST** — without the polyfill, Nest's
  `SetMetadata` decorators silently store nothing, the metadata-gated branch
  never fires, and the test 401s exactly like a wiring bug. This was the first
  real failure of the session; the fix is one require line.
- Instantiate the guard directly: `new ConditionalAuthGuard(fakeReflector)`.
  Provider args (e.g. users service) are optional in the constructor — omit.
- **Fake reflector must behave like the real Nest `Reflector.getAllAndOverride`**:
  ```ts
  const reflectorOf = (handlerMeta = {}, classMeta = {}) => ({
    getAllAndOverride: (key, [handler, cls]) =>
      Reflect.getMetadata(key, handler) ?? Reflect.getMetadata(key, cls)
      ?? handlerMeta[key] ?? classMeta[key],
  });
  ```
  The `Reflect.getMetadata` fallback is what makes the test verify REAL
  decorator wiring: import the compiled real controller and pass
  `AiTestController.prototype.test` as the context handler — if the decorator
  were missing on the handler, the "valid token" test fails. Second real
  failure of the session was a fake that only consulted its own maps.
- Fake ExecutionContext: `{ getHandler: () => handler, getClass: () => cls,
  switchToHttp: () => ({ getRequest: () => req }) }`.
- **Fake req MUST have `session: {}`** — express-session always attaches a
  session object in production; the operator-password path writes
  `req.session!.user` and throws `TypeError: Cannot set properties of
  undefined` otherwise. Third real failure of the session.
- Expected failures are `UnauthorizedException`:
  `await assert.rejects(guard.canActivate(ctx), UnauthorizedException)`.
  Allowed: `assert.doesNotReject(...)` then assert on `ctx.req.session.user`.
- Env juggling: set/restore `process.env.HERMES_AI_TEST_TOKEN` and
  `SESSION_PASSWORD` around the run (restore in `finally`) — per-scenario
  set/unset covers the fail-closed-no-config case.

Scenarios to cover (map 1:1 to the task's security requirements):
1. valid token -> allowed, NO operator password presented, and no session
   identity minted (covers "operator password is NOT required");
2. missing header -> 401;
3. wrong token -> 401;
4. correct token on a handler WITHOUT the metadata -> 401 (proves the token
   opens no other route);
5. operator password still authenticates on a normal route;
6. operator password still accepted on the token route;
7. env var unset -> 401 even with correct header (fail closed);
8. metadata presence assertion on the compiled handler (wiring check);
9. helper-level fail-closed behavior (empty/non-string input, empty config).

## Verification sequence used
`npm run build` -> `node scripts/ai-auth.test.js` -> `npm run test:ai`
(provider suite + auth suite) -> regression sweep of adjacent suites
(gate0, upstox-isolation, feature-engine, parser suites). Report `git diff`
of only the files you touched — the working tree may carry unrelated
pre-existing changes; isolate your diff with explicit paths
(`git diff src/auth/... src/ai/... scripts/...`). Check env key presence with
`grep -c '^HERMES_AI_TEST_TOKEN=' .env` (name only — never print the value).
