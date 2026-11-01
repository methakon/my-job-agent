# Audit remediation hand-off — 2026-11-02

**Branch:** `feat/cpp-trading-agent`
**Code commit:** `2612834` (`fix: remediate 2026-11-02 system audit`)
**Audit:** [SYSTEM_AND_TECHNICAL_AUDIT_2026-11-02.md](SYSTEM_AND_TECHNICAL_AUDIT_2026-11-02.md), [WARNINGS_2026-11-02.md](WARNINGS_2026-11-02.md)

This file is for whoever (human or agent) continues the work on a local checkout. It states what
was changed, what was verified and how, what was deliberately left alone, and what to do next.

## Resume locally

```bash
cd /home/swarna-sekhar-dhar/projects/algotrading/cpp-trading-agent
git status                       # check for uncommitted local work before pulling
git fetch origin && git checkout feat/cpp-trading-agent && git pull
kiro-cli chat
```

Suggested first prompt: "Read docs/audits/REMEDIATION_HANDOFF_2026-11-02.md and continue from
commit 2612834. Build, run the tests against my local test database, then work through the
'Not done' list."

### Build

Needs `cmake`, `g++` (CI uses 13), `libssl-dev`, `libcurl4-openssl-dev`, `libmysqlclient-dev`.

```bash
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j"$(nproc)"
```

### Tests

`.env` is gitignored and was never available to the cloud session. Create it from `.env.example`.
The database tests refuse production values (port 3307, schema `myjob_agent`, users `mylife` / `root`,
non-loopback hosts) and need an explicit opt-in. Use a throwaway MySQL 8 with a schema named
`hermes_cpp_test`:

```bash
mysql -uroot -p hermes_cpp_test < tests/schema/hermes_cpp_test.sql
# if trigger creation fails with binary logging on:  SET GLOBAL log_bin_trust_function_creators = 1;
CPP_TEST_DB=1 MYSQL_HOST=127.0.0.1 MYSQL_PORT=<port> MYSQL_USER=<test user> \
MYSQL_PASSWORD=<pw> DATABASE_NAME=hermes_cpp_test \
  ctest --test-dir build --output-on-failure
```

`tests/differential_harness.cpp` (driven by `tests/run_dispatcher_differential.sh`) replays the
auth-bypass requests against a real socket and is the end-to-end check for A-01.

## What changed

| Finding | Change |
|---|---|
| A-01 | `check_auth` now uses `http_auth::Authenticator`. Browser sessions are random, expiring, server-side tokens in an `HttpOnly; SameSite=Strict` cookie. Logout revokes server-side. Login is constant-time and throttled (5 failures / 15 min per client address). The substring check and the constant `operator_valid_session` cookie are gone. |
| A-02 | Every `popen("curl ...")` replaced by `src/common/http_client` (libcurl, https only, no redirects). This includes `upstox_historical_backfill.cpp`, which the audit did not list. OAuth token expiry now comes from the token's own `exp` claim; a token without one is not stored. |
| A-04 | `record_analytics_event` locks the visitor row `FOR UPDATE` first, checks every statement for 1213 / 1205 / 1062, and retries the whole transaction (5 attempts). |
| A-05 | `EXP-03` was date-dependent (it used the real clock). The classifier was correct. The clock is pinned in EXP-01..09. |
| A-06 | Gate 21 reads project-checklist stages and the analysed-session count, and fails closed. It can currently never unlock because there is no source for breach counts or out-of-sample promotion. |
| A-08 / A-09 | Loopback bind by default (`ROADMAP_BIND_ADDR` overrides; invalid value refuses to start). SIGTERM / SIGINT run an ordered shutdown: feed, decision loop (joined), HTTP listener. |
| A-10 | WebSocket ping every 15 s idle; connection declared dead after 45 s without data or pong, which feeds the existing reconnect logic. |
| A-13 | Pool: hard ceiling (default 4 x warm size), blocking acquire with timeout (`MYSQL_POOL_ACQUIRE_TIMEOUT_MS`, 10 s), read / write timeouts, TLS `REQUIRED` for non-loopback hosts (`MYSQL_SSL_MODE` overrides). `release_local` returns a connection to the pool that owns it. |
| A-16 / A-17 | All warning sites cleared. Engine sources are compiled once as an `OBJECT` library. `is_new_visitor` was dead code. |
| A-22 | Random `Sec-WebSocket-Key`, CSPRNG frame masks. |

Also fixed (found during analysis, not in the audit): WebSocket TLS peer and hostname verification;
frames already buffered by TLS were held back until more network data arrived; hardcoded analytics
HMAC salt; `rand()` fallback for the AES IV; `post_session_analyzer` `execution_success` could never be
false; backfill returned nothing for date ranges crossing a month boundary; `ensure_test_schema`
ignored two `CREATE TABLE` results; the operator's reason on strategy-config changes was discarded;
query values were read from the whole request instead of the parsed query; a `vector<bool>` data race
in the visitor stress test hid real results.

## Verification (cloud sandbox: g++ 11.5, MariaDB 10.11, libcurl 8.10)

- `ctest`: 3/3. Unit suite 303 passed / 0 failed (baseline 257 / 1). Auth suite 303 checks (baseline 249).
- Visitor suite: 5/5 clean runs. The old code, with the test race fixed, failed every run with a real deadlock.
- Warnings: 0 under the audit's own command; baseline had 231 emitted lines.
- CI's blocking cppcheck gate (`--enable=warning`): clean (cppcheck 2.13).
- End to end: login / cookie / logout / throttle over a socket; real binary bound to 127.0.0.1 and exited 0 on SIGTERM; WebSocket TLS rejection (untrusted cert, wrong host), random handshake key per connection, ping and half-open detection against a local TLS server.

**Not verified:** g++ 13, clang++ 17, MySQL 8. The `MYSQL_OPT_SSL_MODE` code path was a no-op in the MariaDB build, so TLS-required behaviour against a real MySQL 8 is untested. The audit's own AF-xx trace lines and line numbers are not in the committed source (it ran on an uncommitted tree) and its counts of 16 tests / 17 targets do not match the tree (3 / 5).

## Behaviour changes to be aware of

- Anything not on the host that reaches the portal needs `ROADMAP_BIND_ADDR`.
- The `x-operator-password` header only works if `OPERATOR_PASSWORD` or `SESSION_PASSWORD` is set.
- Without `ANALYTICS_SECRET`, a random per-process secret is used, so visitor identities reset on restart.
- Storing a FYERS token requires `ENCRYPTION_KEY` or `APP_SECRET`; it is refused rather than stored in the clear.
- The WebSocket client now verifies the server certificate, so the host needs a working CA bundle.

## Not done

- A-03, A-07: wiring the gates. The audit's ordering constraint is to do this only after Gate 21 is trustworthy, which needs a real source for breach counts and out-of-sample promotion first.
- A-11, A-12: tick OHLC mapping and the two read queries selecting non-existent columns (`db_client.cpp`).
- A-14: option-quote capture has no idempotency key.
- A-15: the import is on the operator's machine.
- A-18 to A-21: display timezone labels, hardcoded `changePct`, 2026-only holidays, `sharpe_ratio` naming.

## Left alone on purpose (need an operator decision)

- `fetch_archived_tick_samples(limit_days)` ignores its argument (fixed 1 day, 5000 rows). Honouring it changes seasonality inputs that adjust live confidence.
- `fetch_user_portfolio` and `fetch_user_trade_count` ignore `user_id` (single paper portfolio). `/api/user/portfolio` passes a hardcoded id.
- `UpstoxSandboxTokenVerify` stores a placeholder token and a hardcoded client id.
- The accept loop is single-threaded; a slow client can stall other requests.

## Release gate

`AGENTS.md` requires the `/project-status` row to be synced before work is reported complete, and the
pre-push drift guard blocks code commits without one. The cloud session could not reach the control
plane and did **not** add an entry to `docs/gate-close-allow.json`, because that file records an
operator directive as its authority. Either sync the row with `npm run gate:status`, or add an
exact-SHA allow-list entry yourself. Commit `2612834` is the one affected.
