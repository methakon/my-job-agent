# Technical Specification — C++ options trading engine

**Baseline:** `feat/cpp-trading-agent` @ `05130a9`
**Language / standard:** C++20 (`CMakeLists.txt:4-5`)
**Build:** CMake ≥ 3.16, Ninja in CI
**Binary:** `cpp-trading-agent` (single process, fork-mode under PM2)

---

## 1. Architecture overview

The deployed system is **narrower than the source tree suggests**. Two subsystems
coexist in the binary:

| Subsystem | Entry point | Reachable at runtime |
|---|---|---|
| **Paper trading runtime** | `start_native_paper_runtime` (`native_paper_runtime.cpp:117`) | **Yes** — the live path |
| **Gate research pipeline (G0–G22)** | none | **No** — compiled, tested, never called |

`src/main.cpp` starts the HTTP server, then calls `start_native_paper_runtime(db)`
at line 165, then sleeps forever (lines 168–170). No gate module appears anywhere
in that sequence.

```
                          ┌─────────────────┐
   Upstox WSS ───────────►│ NativeWsTransport│  (OpenSSL, RFC6455)
                          └────────┬────────┘
                                   │ frames
                          ┌────────▼────────┐
                          │ UpstoxDecoder   │  protobuf / JSON fallback
                          └────────┬────────┘
                          ┌────────▼────────────────┐
                          │ BrokerFeedSupervisor    │  2 s state machine
                          │  ├─ ring buffer ────────┼──►  paper runtime thread
                          │  └─ persist queue ──────┼──►  fnf_market_snapshots
                          └────────┬────────────────┘
                                   │ EOD / pre-market triggers
                          ┌────────▼────────────────┐
                          │ PostSessionAnalyzer     │
                          │ PreMarketReadiness      │
                          │ DailyPnLEmailer         │
                          └─────────────────────────┘

   Operator ──► RoadmapServer :8080 ──► dashboard / JSON ──► RoadmapDbClient
                                                              │
                                                        MySQL (remote pool)
```

---

## 2. Process and thread model

Started from `main.cpp`:

| # | Thread | Created at | Lifetime |
|---|---|---|---|
| 1 | main | `main.cpp:20` | process; infinite 1 s sleep loop (`:168-170`) |
| 2 | HTTP acceptor | detached (`main.cpp:149-153`) | process |
| 3 | paper runtime | detached (`native_paper_runtime.cpp:117-285`) | process |
| 4 | feed supervisor | `broker_feed_supervisor.cpp:36-42` | process |
| 5 | tick persistence | `broker_feed_supervisor.cpp:36-42` | process |
| 6–7 | analytics workers ×2 | `visitor_tracker.cpp:319-327, 345-360` | process |
| 8 | option capture | only when `NATIVE_OPTION_QUOTE_CAPTURE=1` (`native_paper_runtime.cpp:127-129`) | process |
| — | EOD / pre-market | detached per trigger (`broker_feed_supervisor.cpp:591-595`) | transient |

**Single-instance guard:** `open("/tmp/cpp_trading_agent.lock")` + `lockf(F_TLOCK)`
(`main.cpp:113-121`).

**Shutdown: there is none.** No `SIGINT`/`SIGTERM`/`SIGQUIT` handler is installed;
only `SIGPIPE` is ignored (`main.cpp:137`). `RoadmapServer::stop()` is never
called and no thread is joined. Termination relies on the default signal
disposition, and PM2 enforces `kill_timeout: 30000`.

**HTTP model:** single-threaded, blocking, one request per accepted socket,
`Connection: close`. `SO_RCVTIMEO` 2 s with 10×10 ms `EAGAIN` retries; body read
driven by `Content-Length`; 64 KiB buffer; no total request-size cap
(`roadmap_server.cpp:1475-1533, 2325-2329`).

---

## 3. Module catalogue

### 3.1 Market data — `src/market_data/`

| Module | Role | Reachable |
|---|---|---|
| `native_ws_transport.hpp` | TLS + websocket framing, 10 MB frame cap, ping→pong reply | yes |
| `upstox/upstox_websocket_client.cpp` | Upstox v3 adapter: authorize REST, subscribe, decode fan-out | yes |
| `upstox/upstox_decoder.hpp` | Hand-written protobuf decoder + JSON fallback | yes |
| `fyers/fyers_websocket_client.cpp` | FYERS adapter (HSM handshake, dual subscribe frames) | **no** — refused at `broker_feed_supervisor.cpp:243-247` |
| `fyers/fyers_decoder.hpp` | FYERS decoder; binary path is a heuristic byte scan | no |
| `broker_feed_supervisor.cpp` | Ownership, provider selection, state machine, persistence, EOD/pre-market triggers | yes |
| `contract_catalog.cpp` | Fail-closed TSV loader, subscription selector, 24 h freshness | yes (catalog file absent) |
| `settlement_observations.cpp` | Fail-closed settlement TSV loader, 7-day freshness, URL host allow-list | yes |
| `src/engine/tick_receiver.cpp` | `CanonicalOptionTick`, SPSC ring buffer (65,536) | yes |
| `src/engine/feed_arbiter.hpp` | Dual-broker arbiter, pre-open OAI, imbalance survival | **no** — tests only |
| `src/engine/market_calendar.cpp` | Session phases, 2026 holiday set | yes |
| `src/engine/upstox_historical_backfill.cpp` | v2 candle backfill | **no** — no production caller |
| `src/engine/nse_archive_fetcher.cpp` | Participant OI + F&O bhavcopy | **no** — tests only |

**State machine** (`broker_feed_supervisor.cpp:20-27`):
`IDLE_OFF_HOURS → IDLE_WAITING_TOKEN → CONNECTING_FEED → FEED_HEALTH_VERIFYING →
ACTIVE_PAPER_TRADING → SESSION_CLOSED`. Paper trading is ACTIVE only in
`MARKET_OPEN` with a token, a connected socket and a feed fresher than 15 s
(`:377-402`).

**Reconnect:** fixed 2 s polling, no exponential backoff, no client ping, no read
deadline. Failure counters demote a provider at 2 consecutive failures
(`:185-230, 453-476`).

### 3.2 Execution — `src/engine/`

| Module | Role |
|---|---|
| `native_paper_runtime.cpp` | Orchestration loop; `DbPaperStore` adapter over `RoadmapDbClient` |
| `native_paper_engine.cpp` | Sole decision/execution engine: regime update → duplicate reject → supervision → path observation → exit → entry → allocation → fill |
| `adaptive_policy.cpp` | Entry sizing (bounded log-wealth) and exit authorisation |
| `paper_order.cpp` | Entry value objects + pure `paper_entry_status` predicate, re-run at the write boundary |
| `paper_account.hpp` | Ledger view + fee model (`paper-fees-v1-legacy-assumptions`) |
| `paper_settlement.cpp` | Expiry cash settlement with a 14-step rejection ladder |
| `position_path.cpp` | Executable-mark path accumulation; Gaussian similarity kernel |
| `position_exit_evaluator.cpp` | **Reporting only** — +50 %/−25 % display thresholds |
| `spread_position.hpp` | Multi-leg credit spreads — **declared, never executed** |
| `strategy_config_manager.cpp` | Atomic hot-reload store — **never loaded from DB in `src/`** |
| `decision_context.cpp` | Data-status verdict + immutable JSON decision snapshot |
| `decision_journal.cpp` | Transactional journal wrapper — unused; runtime calls the DB client directly |
| `option_observation.cpp` | Provenance gate for optional quote capture |

**Loop cadence** (`native_paper_runtime.cpp:142-283`): catalog reload 60 s;
batch drain 2,048 ticks; per-quote `process`; supervision 1 s; settlement 60 s;
20 ms sleep. The drain keeps only the newest tick per instrument per iteration
(`:184-186`), so OFI and incremental history are computed on **sampled** quotes.

**Position representation:** long-only single leg. `PaperPosition` has no `side`
field. Status is the DB string `OPEN` → `CLOSED`; there is no first-class order
state enum.

**Fee model** (`paper_account.hpp`): brokerage 20.00 per order × 1.18 GST;
exchange 0.000355 (NSE); STT 0.0015 on sell; stamp 0.00003 on buy; SEBI 0.000001;
GST 0.18. `fixed()` = 23.60 per order.

### 3.3 Gate research pipeline — `src/engine/gate*.cpp`

Twelve modules, **none wired**. Each is header + implementation with an entry
point exercised only by `tests/unit_and_integration_tests.cpp`.

| Gate | Subject | Key literal thresholds |
|---|---|---|
| G0 | Paper-only guards, index allowlist, capital cap, feed quality | staleness 500,000 µs; session 09:15–15:30 |
| G3 | Expanded feature set (gap, VWAP, ORB, OI, PCR) | ORB 5/15/30 min |
| G4 | Gap taxonomy → fade/follow proposal | OFI ≥ 20.0; score ≥ 65.0; cost 15.0 |
| G5 | Order-book microprice and OFI | 5 levels; EMA α 0.1; stacked ratio 3.0 |
| G6 | Volume profile, value area, failed auction | tick 5.0; VA 70 %; HVN 1.5×; LVN 0.3× |
| G7 | Black-Scholes Greeks, GEX, gamma flip, IV skew | ±15 % spot grid; 25-delta skew |
| G8 | Statistical arbitrage, leakage-controlled labels | max holding 45 min |
| G9 | Fill simulation and cost/latency stress | best level only |
| G10 | Regime machine and veto | — |
| G11 | Strategy taxonomy registry | — |
| G13 | Purged/embargoed CV, promotion gate | — |
| G22 | 15-minute seasonality, 80/20 split | clean-session count ≥ 10 |
| const | Entry-gate invariants R-001…R-015 | 7 of 15 actually implemented |

### 3.4 Persistence — `src/roadmap/`

`RoadmapDbClient` is 3,756 lines of hand-built SQL over a hand-rolled `MYSQL*`
pool. No ORM, no prepared statements, no migration framework.

| Concern | Implementation | Note |
|---|---|---|
| Pool | 5 initial connections, `acquire()` never blocks | Grows unbounded; `cv_` notified but never waited |
| Timeouts | connect only (5 s) | No read/write timeout |
| TLS | `SSL_MODE_PREFERRED` | May downgrade silently |
| Transactions | `TransactionGuard`, autocommit off → commit/rollback | Native path uses `NativeTransaction` |
| Isolation | default REPEATABLE READ; READ COMMITTED only in `record_analytics_event` | |
| Retries | none for deadlock/lock-timeout; 15×20 ms only for duplicate-key 1062 | |
| Escaping | `mysql_real_escape_string` on every value | |
| Leaks | several early returns skip `release()` | e.g. `db_client.cpp:1663-1664, 1706-1709` |

### 3.5 HTTP and operations — `src/roadmap/`, `src/analytics/`

`RoadmapServer` (raw BSD sockets) + `route_table.hpp` (40 exact routes) +
`http_auth.hpp` (hardened, **unused**) + `visitor_tracker.cpp` (2 workers,
10,000-entry bounded queue).

---

## 4. Data model

Timestamps: **UTC wall clock in `DATETIME`**, IST-day predicates via
`- INTERVAL 330 MINUTE` (`db_client.cpp:89-93, 1804-1817`). Session zone pinned
per connection; an unknown zone is refused (`:48-97`).

| Table | Purpose | Key columns | Integrity |
|---|---|---|---|
| `fnf_market_snapshots` | Hot tick store | `id`, `instrument`, `price`, `ts`, `source` | `KEY(instrument,ts)` |
| `fnf_market_snapshots_history` | Cold tick archive | as above + `archivedAt` | |
| `cpp_option_quote_observations` | Native option capture | `instrumentKey`, `underlying`, `expiry`, `strike`, `optionType`, `ltp`, `bid/ask`, `ts` | 8 CHECK constraints; **no unique key** |
| `upstox_live_paper_option_quotes` | Legacy quote source | `contractSymbol`, `instrumentToken`, `ltp`, `ts` | |
| `cpp_historical_daily_candles` | Derived daily OHLC | `instrument_key`, `timestamp`, OHLC, `volume`, `open_interest` | no in-repo DDL |
| `cpp_historical_intraday_candles` | 1-minute candles | as above | no in-repo DDL |
| `cpp_trade_reports` | Paper fill audit trail | `tradeUuid`, `instrument`, `quantity`, `entryPrice`, `netPnl`, `status`, `signal_timestamp` | `UNIQUE idx_signal_idempotency` |
| `cpp_portfolios` | Single wallet `cpp-portfolio-v1` | `capital`, `ceiling`, `deployed`, `netPnl`, `executionMode` | `ceiling` never rewritten by P&L |
| `hermes_cpp_decision_journal` | Immutable decision record | `decision_uuid`, `action`, `reason`, `feature_snapshot_json` | `UNIQUE decision_uuid` |
| `cpp_strategy_config` | Live tunables | `config_key`, `config_value` | AFTER UPDATE trigger → audit |
| `cpp_strategy_config_audit` | Parameter change log | `config_key`, `old_value`, `new_value`, `approved_by` | append-only |
| `provider_tokens` | Broker credentials | `provider`, `accessTokenEncrypted`, `status`, `expiresAt` | no in-repo DDL |
| `portal_users` | Operator identity | `email`, `passwordEnc`, `role` | |
| `tick_consolidation_lineage` | Dedup ledger | `(source_table, source_id)` PK, `canonical_hash` | PK |

**Schema drift.** The only in-repo structural definition for most of these is
`tests/schema/hermes_cpp_test.sql` — a *test fixture*, not a migration. There is
no DDL under `ddl/` for the money-carrying tables (`cpp_trade_reports`,
`cpp_portfolios`, `hermes_cpp_decision_journal`, `provider_tokens`).

---

## 5. Interfaces

### 5.1 Broker feed

`IBrokerWebSocketClient` (`broker_websocket_client.hpp:17-31`):
`provider_name`, `connect`, `subscribe`, `disconnect`, `is_connected`,
`set_on_tick`, `set_on_disconnect`. No auth-refresh hook and no error callback
beyond disconnect.

`CanonicalOptionTick` (`tick_receiver.hpp:12-31`): `instrument_key`, `symbol`,
`option_type`, `strike`, `ltp`, `bid_price`, `ask_price`, `iv`, `bid_qty`,
`ask_qty`, `volume`, `open_interest`, `change_oi`, `timestamp_ms`,
`received_timestamp_ms`, `provenance`, `raw_timestamp`, `is_real_data`.

**Note:** no decoder populates `iv`, `change_oi` or `raw_timestamp` — they are
declared and never written by any feed path.

### 5.2 Persistence seam

`PaperStore` (`native_paper_engine.hpp:11-26`) is the injection point:
`account`, `positions`, `history`, `journal`, `open`, `close`,
`empirical_model_active`. `DbPaperStore` is the only MySQL implementation
(`native_paper_runtime.cpp:80-115`); an offline ledger implementation allows
identical decision code in replay.

### 5.3 HTTP routes

40 routes, exact `(method, path)` resolution, one prefix route
(`/admin/visitors/`). Public allow-list: `/`, `/home`, `/visitor-info`,
`/api/visitor-info/stats`, `/login`, `/auth/login`, `/health`, `/api/health`,
`/api/upstox/callback`, `/auth/upstox/callback`, `/api/fyers/callback`,
`/auth/fyers/callback` (`route_table.hpp:215-246`).

Mutating routes: `/admin/analytics/retention-purge`, `/api/roadmap/item/update`,
`/api/roadmap/clarification/ask`, `/api/roadmap/clarification/answer`,
`/auth/login`, `/auth/logout`, `/api/upstox/token/init`,
`/api/fyers/token/init`, `/api/upstox-sandbox/token/verify`, and the four OAuth
callbacks.

---

## 6. Configuration

| Key | Default | Consumed by |
|---|---|---|
| `ROADMAP_PORT` | `8080` | HTTP listener |
| `MYSQL_REMOTE_*` / `MYSQL_*` | — | primary DB triple |
| `MYSQL_LOCAL_*` | — | local tick DB (degrades to remote) |
| `MYSQL_SESSION_TIME_ZONE` | — | per-connection zone; unset/defaulted values are refused |
| `NATIVE_CONTRACT_CATALOG` | `data/native_contracts.tsv` | contract catalog |
| `NATIVE_SETTLEMENT_CATALOG` | `data/native_settlements.tsv` | settlement loader |
| `NATIVE_OPTION_QUOTE_CAPTURE` | `0` | enables capture sink |
| `NATIVE_FEED_CAPACITY` | `128` (clamped 4–1500) | ring buffer |
| `FORCE_MARKET_OPEN` | unset | supervisor session override |
| `ENCRYPTION_KEY` | — | AES key derivation for broker tokens |
| `DAILY_PNL_EMAIL_ENABLED` | — | emailer |

**Neither `data/native_contracts.tsv` nor `data/native_settlements.tsv` exists in
this checkout** (there is no `data/` directory). With defaults, every catalog load
fails closed, no contract resolves, and entries can only return
`CONTRACT_METADATA_UNKNOWN`. Whether a deployment mounts them is **UNVERIFIED**
from the repository.

Database and broker identity defaults are baked into source
(`10.0.0.99`, `mylife`, `myjob_agent`, `3306`, empty password) at
`main.cpp` and `post_session_cli.cpp` — a missing `.env` connects with a guessed
identity rather than failing fast.

---

## 7. Build, test, CI

**Targets:** 17 (`cpp-trading-agent` + 16 tests). `src/post_session_cli.cpp` is
**not part of any target** — the GLOB covers only
`src/{engine,roadmap,common,market_data,analytics}` and `main.cpp` is named
explicitly, so the standalone CLI never compiles.

**Flags:** `-O3 -Wall -Wextra -pthread -fstack-protector-strong -D_FORTIFY_SOURCE=2`.
The `CMAKE_CXX_FLAGS_RELEASE` assignment **replaces** CMake's default, dropping
`-DNDEBUG`. No `-fPIE`, no `-Werror`.

**CTest:** 16 registrations. `differential_harness` is deliberately excluded.

**CI:** one workflow, `build-and-test`, `ubuntu-latest`, `mysql:8.0` service,
matrix `g++-13` / `clang++-17` Release. Steps: checkout → apt deps → configure
(Ninja) → **blocking** `cppcheck --enable=warning --error-exitcode=1` → advisory
`cppcheck --enable=style,performance,portability` → load schema → build → ctest
with `CPP_TEST_DB=1` → upload binary artifact (g++ leg only).

**No latency benchmark step exists**; the former invocation was removed because no
such target exists.

**Deploy job:** present but `if: false`.

---

## 8. Failure modes

| Condition | Behaviour | Assessment |
|---|---|---|
| Websocket closes | `on_disconnect` sets `should_reconnect_`; supervisor reconnects within 2 s | correct |
| Websocket half-open (no FIN) | Never detected; state parks in `FEED_HEALTH_VERIFYING` | **gap** |
| Broker token expired | Provider demoted; state → `IDLE_WAITING_TOKEN` | correct |
| Unknown session time zone | Connection closed, engine refuses to trade | correct (fail-closed) |
| Settlement observation absent | `settlement_price = -1.0`; settlement rejected | correct (fail-closed) |
| Contract catalog stale/missing | Load fails closed; no subscriptions | correct, but default path is absent |
| DB stalled | Caller hangs (no read timeout) | **gap** |
| DB pool exhausted | Unbounded new connections | **gap** |
| Process signalled | No handler; SIGKILL after 30 s; ledger mid-write may roll back | **gap** |
| Duplicate quote capture retry | Second row written (no unique key) | **gap** |
| Unauthenticated request with `x-operator-password` in any field | Authenticated | **security defect** |

---

## 9. Defect register

Ordered by severity. Each entry is code-verified at `05130a9`.

| ID | Defect | Location | Severity |
|---|---|---|---|
| D-01 | Live auth gate still uses substring `check_auth`; hardened `Authenticator` unwired | `roadmap_server.cpp:1440-1445, 2345` | Critical |
| D-02 | `popen("curl …")` with request-derived OAuth code | `roadmap_server.cpp:1574-1601, 1619-1645` | Critical |
| D-03 | HTTP binds `INADDR_ANY:8080` | `roadmap_server.cpp:2275-2283` | High |
| D-04 | No `SIGTERM`/`SIGINT` handling; no clean shutdown | `main.cpp:137` | High |
| D-05 | Half-open feed never detected; no client ping or read deadline | `native_ws_transport.hpp:179-183` | High |
| D-06 | `fnf_market_snapshots.open/high/low` store bid/ask/bid; `close` stores LTP | `db_client.cpp:748-751` | High |
| D-07 | `fetch_latest_post_session_record` selects non-existent columns; returns empty silently | `db_client.cpp:3704-3707` | High |
| D-08 | `count_historical_candles_for_date` filters on non-existent `candle_date` | `db_client.cpp:3741` | High |
| D-09 | Pool `acquire()` never blocks; unbounded growth; no read/write timeout; TLS PREFERRED | `db_client.cpp:78-122` | High |
| D-10 | Connection leaks on several error paths | `db_client.cpp:1663-1664, 1706-1709` | Medium |
| D-11 | `gate21` returns true unconditionally; hardcodes 14 sessions, 0 breaches | `gate21_final_acceptance.cpp:7-26` | High (false assurance) |
| D-12 | `gate13` leakage flag structurally always false | `gate13_validation_harness.cpp:24, 29` | Medium |
| D-13 | `gate_const_invariants` claims R-001..R-015; 5 rules unimplemented | `gate_const_invariants.cpp:111` | Medium |
| D-14 | Duplicate login attempts unthrottled | `roadmap_server.cpp:2544-2564` | Medium |
| D-15 | Operator password compared with `operator==` (not constant time) | `db_client.cpp:511-512` | Medium |
| D-16 | `fetch_user_portfolio` ignores `user_id`; always reads one row | `db_client.cpp:528-529` | Medium |
| D-17 | `changePct` hardcoded to 0.5 in snapshot reads | `db_client.cpp:1174` | Low (fabricated metric) |
| D-18 | Display readers append `IST` to unshifted UTC values | `db_client.cpp:884, 1161, 1190` | Medium |
| D-19 | `Sec-WebSocket-Key` hardcoded; mask from unseeded `rand()`; upgrade accepted on substring `101` | `native_ws_transport.hpp:139-144, 257, 280` | Medium |
| D-20 | Both broker clients self-deadlock on reconnect-with-symbols (unreachable today) | `upstox_websocket_client.cpp:120-123, 132` | Low (latent) |
| D-21 | FYERS `decode_json` falls back to `iv` for LTP (unit confusion) | `fyers_decoder.hpp:63` | Low (unreachable) |
| D-22 | `cpp_option_quote_observations` has no unique key | DDL | Medium |
| D-23 | Market holidays hardcoded for 2026 only | `market_calendar.cpp:40-56` | Medium |
| D-24 | `backtest_engine` "sharpe_ratio" is PnL/capital, not a Sharpe ratio | `backtest_engine.cpp:64` | Medium (mislabel) |

---

## 10. Deployment

PM2 fork mode, `instances: 1`, binary at
`/home/ubuntu/cpp-trading-agent/bin/cpp-trading-agent`,
`max_restarts: 10`, `min_uptime: 5s`, `kill_timeout: 30000`
(`ecosystem.cpp-trading-agent.config.js:21-35`). No `env` block — configuration
comes from `.env` in the working directory.

Deployment is **manual** (`pm2 restart` after replacing the binary). CI does not
deploy. The runtime revision is readable at `GET /api/health` via
`HERMES_BUILD_GIT_SHA`.
