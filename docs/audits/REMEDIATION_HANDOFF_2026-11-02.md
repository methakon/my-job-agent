# Audit remediation hand-off — 2026-11-02

**Branch:** `feat/cpp-trading-agent`
**Code commits:** `2612834` (round 1: security, concurrency, warnings), then round 2 (data integrity, low findings), see below
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

## Round 2 (remaining audit items)

| Finding | Change |
|---|---|
| A-11 | `save_canonical_market_snapshot` stores `open = high = low = close = ltp` (it stored `bid / ask / bid / ltp`). `ts` and `createdAt` are written with `UTC_TIMESTAMP()` as `docs/TIMESTAMP_CONVENTIONS.md` requires (`NOW()` follows the session zone). The TypeScript feature engine builds daily bars from `MAX(high)`, `MIN(low)` and the first `open` of these rows, so ATR was inflated by the spread. **Existing rows keep the old meaning; they were not rewritten.** The C++ rollup reads `price`, so it was never affected. |
| A-12 | Two broken reads. `fetch_latest_post_session_record` selected six columns that do not exist (always empty, no log), so the pre-market report always said "no prior session"; fixed, and it now honours test isolation and logs errors. `count_historical_candles_for_date` filtered on a non-existent `candle_date` (always 0); it now counts rows whose `timestamp` falls in the requested day. A runtime probe called all 53 distinct read queries against the schema: none now fails on a column. |
| A-18 | The `fnf_market_snapshots.ts` label printed UTC with an "IST" suffix; it is now shifted +330 min. The same suffix on `hermes_cpp_project_clarifications` and `fnf_decay_calibrations.lastRectifiedAt` was **not** changed: their DDL is not in the repo, so whether they hold UTC or IST is unknown. |
| A-19 | `changePct` was the constant `0.5`; it is now the move since the previous tick of the same instrument (0 when there is none). |
| A-20 | The holiday list is still 2026-only (no 2027 dates were invented; NSE publishes them in December). `NSE_HOLIDAYS` / `NSE_HOLIDAYS_FILE` add dates, bad entries are reported, and a query for a year with no data logs a warning once instead of silently calling every weekday a trading day. |
| A-21 | `sharpe_ratio` is now a real per-trade Sharpe (mean / sample sd of trade P&L, not annualised). The old figure is kept as `pnl_over_risk_capital`. |
| A-07 (partial) | Behaviour unchanged. The Kelly result was computed and discarded; each decision-journal row now carries `{"sizing": {applied_lots, kelly_suggested_lots, kelly_oos_gate_passed, ...}}` so the gap can be measured. |
| config | `.env.example` documents every setting added in rounds 1 and 2. A zero or negative timeout setting now means "use the default", not a 1-second timeout. |

## Gate wiring inventory (A-03), generated from the source

Only these gate files are referenced outside the gate files themselves: `gate0` (journal, arbiter),
`gate7` (decoder), `gate11` (db client, server), `gate16` (`main.cpp`), `gate22` (`main.cpp`).
**Everything else has no call site:**
`gate3`, `gate4`, `gate5`, `gate6`, `gate8`, `gate9`, `gate10`, `gate12`, `gate13`, `gate14`, `gate15`,
`gate17`, `gate18`, `gate19`, `gate20`, `gate21`, and `gate_const_invariants`.

## Verification (cloud sandbox: g++ 11.5, MariaDB 10.11, libcurl 8.10)

- `ctest`: 3/3. Unit suite 329 passed / 0 failed (baseline 257 / 1), stable over 4 repeat runs. Auth suite 303 checks (baseline 249).
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
- New snapshot rows have real OHLC (see A-11). Daily bars the TypeScript feature engine derives from days that mix old and new rows will mix the two meanings until the old rows age out or are archived.
- `changePct` and the "IST" label on the market-snapshot view now show different numbers from before (they were a constant and a UTC time).
- `BacktestResult::sharpe_ratio` changed meaning; the old figure is `pnl_over_risk_capital`.
- Decision-journal `feature_snapshot_json` is now `{"sizing": {...}}` instead of `{}` for entry decisions.

## Not done

- **A-03 / A-07, the gates themselves.** Wiring a gate into the live decision path changes which paper
  trades are taken and their size. Gate 21 now fails closed, so the audit's ordering constraint is met,
  but each wiring is a trading-behaviour decision. Suggested order: run a gate in **shadow** (compute
  and journal its verdict, take no action), compare against outcomes, then promote. The Kelly sizing
  numbers needed for that comparison are now in the journal (see A-07 above).
- **A-14, option-quote idempotency key.** Needs a schema migration (a unique key on a table that takes
  hundreds of thousands of rows a day) and a choice of key. `fnf_market_snapshots.ts` has one-second
  resolution, so (instrument, ts) would merge genuinely different ticks, and de-duplicating on price
  and volume discards data. This needs the table's real size and the broker payload's own ids; both
  are on the operator's side. `upstox_live_paper_option_quotes` already has `payloadHash`, which is
  the likely key for that table.
- **A-15, the import** runs on the operator's machine.
- **A-18 (two labels)**, see the table above: needs the DDL for those two tables.
- **A-20 data**: the 2027 holiday list, when NSE publishes it.

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
exact-SHA allow-list entry yourself. Commit `2612834`, the round-2 commit that follows it, and this file's own commit are all affected.
