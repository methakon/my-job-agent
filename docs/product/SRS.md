# Software Requirements Specification — C++ options trading engine

**Baseline:** `feat/cpp-trading-agent` @ `05130a9`
**Status legend:** SPECIFIED · IMPLEMENTED · TESTED · WIRED (see `README.md`)

Requirement IDs are stable. A requirement may be IMPLEMENTED without being WIRED;
the Status column states which, because that distinction is the single largest
source of misunderstanding about this system.

---

## 1. Scope

### 1.1 In scope

A single-process C++20 engine that:

- ingests broker market data over a websocket,
- evaluates option quotes against a configurable set of decision rules,
- simulates (paper-trades) long option positions with a persistent ledger,
- cash-settles positions at expiry from an exchange settlement file,
- serves an operator web dashboard and JSON API over an embedded HTTP server,
- runs pre-market readiness and end-of-day analysis/archival in-process.

### 1.2 Out of scope

- Live broker order placement. Blocked at compile time (`gate0_bootstrap.hpp:37-45`).
- Short options, futures, and multi-leg execution. Spread structures exist but are not reachable (§4.4).
- Any trained machine-learning model or external inference call (§5).
- Multi-tenant operation. The ledger is a single wallet row `cpp-portfolio-v1`.

### 1.3 Definitions

| Term | Meaning |
|---|---|
| TD | Transaction Date — the IST session day, shifted from UTC in SQL |
| CES | Canonical Executable Snapshot — a decoded broker tick |
| PSA | Post-Session Analysis record |
| EOD | End-of-day trigger fired by the feed supervisor state machine |

---

## 2. System context

```
Broker WS ──► decode ──► ring buffer ──► decision engine ──► ledger (MySQL)
                │                                    │
                └──► persistence queue ──► fnf_market_snapshots
                                                     ▲
Operator ──► HTTP :8080 ──► dashboard / API ─────────┘
```

The engine is supervised by PM2 as a single fork-mode instance
(`ecosystem.cpp-trading-agent.config.js:21-35`), `instances: 1`,
`kill_timeout: 30000`.

---

## 3. Functional requirements — market data

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-MD-01 | Connect to the Upstox v3 market-data feed over TLS websocket and subscribe to option contracts plus index reference keys. | IMPLEMENTED, WIRED | `upstox_websocket_client.cpp:71-157` |
| FR-MD-02 | Decode Upstox v3 protobuf frames, and fall back to a JSON string scan, into a canonical tick carrying symbol, strike, option type, LTP, bid, ask, volume, OI and timestamps. | IMPLEMENTED, WIRED | `upstox_decoder.hpp:14-26`, `tick_receiver.hpp:12-31` |
| FR-MD-03 | Reject ticks whose LTP is non-positive or ≥ 1,000,000, and drop `NSE_COM` / `NCD_FO` instruments. | IMPLEMENTED, WIRED | `upstox_decoder.hpp:79-81, 419-421` |
| FR-MD-04 | Build the subscription set from a 24-hour-fresh TSV contract catalog, selecting the nearest expiry and strikes nearest spot per underlying (NIFTY, BANKNIFTY, SENSEX). | IMPLEMENTED, WIRED (catalog absent in repo) | `contract_catalog.cpp:50-126` |
| FR-MD-05 | Persist every tick to `fnf_market_snapshots` via a bounded queue, flushing in batches of 100 every 500 ms. | IMPLEMENTED, WIRED | `broker_feed_supervisor.cpp:478-499` |
| FR-MD-06 | Reconnect when the socket closes, polling every 2 s; demote a provider to fallback after 2 consecutive failures. | IMPLEMENTED, WIRED | `broker_feed_supervisor.cpp:453-476, 185-230` |
| FR-MD-07 | Detect a half-open or stalled feed and force a reconnect without waiting for a TCP close. | **NOT IMPLEMENTED** | No staleness-driven reconnect exists; `should_reconnect_` is set only by the disconnect callback (`broker_feed_supervisor.cpp:345-349`) |
| FR-MD-08 | Support a second broker (FYERS) as a failover data source. | IMPLEMENTED, **NOT WIRED** | Hard-refused at `broker_feed_supervisor.cpp:243-247` |
| FR-MD-09 | Restrict trading to a four-index allowlist. | IMPLEMENTED, TESTED, NOT WIRED | `gate0_bootstrap.hpp:51-59` |

**FR-MD-07 note.** The transport loops on `poll()` timeout rather than treating it
as an error (`native_ws_transport.hpp:179-183`) and never sends a client ping. A
silently dead feed leaves the state machine parked in `FEED_HEALTH_VERIFYING`
indefinitely, with no recovery path. This is a correctness gap, not a tuning issue.

---

## 4. Functional requirements — execution

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-EX-01 | Run the paper engine on a dedicated thread, polling the tick ring every 20 ms and draining up to 2048 ticks per iteration. | IMPLEMENTED, WIRED | `native_paper_runtime.cpp:142-283` |
| FR-EX-02 | Reject quotes older than 10,000 ms, from the future, or with unusable depth before any decision. | IMPLEMENTED, WIRED | `decision_context.cpp:8-23`, `native_paper_engine.cpp:27` |
| FR-EX-03 | Trade long-only single-leg option buys; no short, no futures, no naked leg. | IMPLEMENTED, WIRED | `paper_order.hpp` (no side field on `PaperPosition`) |
| FR-EX-04 | Size every entry. | IMPLEMENTED, WIRED — **effectively pinned to 1 lot** | `empirical_model_active` returns false and has no override (`native_paper_runtime.cpp:80-115`) |
| FR-EX-05 | Refuse an entry whose premium + costs + exit reserve is not strictly below available funds. | IMPLEMENTED, WIRED | `paper_order.cpp:27-28` |
| FR-EX-06 | Supervise open positions and propose exits. | IMPLEMENTED, WIRED | `native_paper_engine.cpp:242-266` |
| FR-EX-07 | Apply a numeric stop-loss and take-profit on open positions. | **NOT IMPLEMENTED in the live loop** | Exits are authorised by the sign of expected incremental net cash versus immediate liquidation (`adaptive_policy`). The +50 %/−25 % thresholds in `position_exit_evaluator.cpp:65-81` are **reporting-only** and authorise nothing. |
| FR-EX-08 | Cash-settle long options at expiry from an official settlement price, refusing to invent one. | IMPLEMENTED, WIRED | `paper_settlement.cpp:34-165`; `settlement_price` defaults to `-1.0` (`paper_settlement.hpp:15-17`) |
| FR-EX-09 | Reject settlement when the observation is absent, non-final, provenance-unverified, or provider/underlying/expiry-mismatched. | IMPLEMENTED, WIRED | 14-step rejection ladder, `paper_settlement.cpp:61-165` |
| FR-EX-10 | Never place a live broker order. | IMPLEMENTED, WIRED | Compile-time stub returns false (`gate0_bootstrap.hpp:37-45`, `gate20_shadow_scaffolding.cpp:25-27`) |
| FR-EX-11 | Execute multi-leg credit spreads and iron condors. | IMPLEMENTED, **NOT WIRED** | `spread_position.hpp` is included only by tests; no runtime, persistence or settlement path accepts a spread |

**FR-EX-04 consequence.** Because `PaperStore::empirical_model_active()` is
hard-wired false and `DbPaperStore` never overrides it, every live entry is
classified `exploratory` and sized at exactly one lot. The Kelly / log-wealth
maximisation branch in `adaptive_policy` is **unreachable in the shipped runtime**.

**FR-EX-07 consequence.** There is no stop-loss, target, trailing stop,
maximum-holding-time, or expiry-proximity exit in the execution path. Risk is
bounded only by single-lot sizing and by the decision rule's own exit signal.

---

## 5. Functional requirements — learning and research

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-LR-01 | Generate multi-horizon forward-return labels (5/15/30 min) and evaluate a candidate model against a simple baseline with a +5 pp lift threshold. | IMPLEMENTED, TESTED, **NOT WIRED** | `gate12_ml_pipeline.cpp:21-84` |
| FR-LR-02 | Perform purged and embargoed cross-validation with a production-promotion gate. | IMPLEMENTED, TESTED, **NOT WIRED** | `gate13_validation_harness.cpp` |
| FR-LR-03 | Classify trade outcomes and gate rule promotion on sample size and win rate. | IMPLEMENTED, TESTED, **NOT WIRED** | `gate14_risk_reflexion.cpp:10-98` |
| FR-LR-04 | Run a champion/challenger promotion and rollback protocol. | IMPLEMENTED, TESTED, **NOT WIRED** | `gate15_experiment_registry.cpp:25-83` |
| FR-LR-05 | Measure 15-minute intraday seasonality with an 80/20 chronological split. | IMPLEMENTED, TESTED, **NOT WIRED** | `gate22_seasonality_patterns.cpp` |
| FR-LR-06 | Persist seasonality patterns for the dashboard. | **NOT WIRED** | `save_seasonality_pattern_record` has zero callers (`db_client.cpp:2030`); `/api/seasonality-patterns` reads an empty table |
| FR-LR-07 | Adapt position sizing from observed trade outcomes. | IMPLEMENTED, WIRED — **in exploratory mode only** | `adaptive_policy.cpp:12-157` |
| FR-LR-08 | Invoke an external ML model or LLM. | **NOT IMPLEMENTED** | No model client, dataset, or inference call exists in `src/` |

Full method-by-method detail, including the mathematics and every threshold, is in
**[LEARNING_METHODS.md](LEARNING_METHODS.md)**.

---

## 6. Functional requirements — risk and capital

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-RK-01 | Enforce an operator-authoritative capital ceiling that P&L code never rewrites. | IMPLEMENTED, WIRED | `cpp_portfolios.ceiling`; comment at `db_client.cpp:1712-1718` |
| FR-RK-02 | Fail closed on an unknown clock: refuse to trade or account if the session time zone cannot be verified. | IMPLEMENTED, WIRED | `db_client.cpp:48-97`, `native_paper_store.cpp:27-44` |
| FR-RK-03 | Serialise all wallet mutations with `SELECT ... FOR UPDATE` on the single portfolio row. | IMPLEMENTED, WIRED | `native_paper_store.cpp:60, 144, 181-184, 263-267` |
| FR-RK-04 | Compute retail short-option margin, Kelly lot sizing, an independent veto, circuit breakers, a kill switch, and a depleting daily risk budget. | IMPLEMENTED, TESTED, **NOT WIRED** | `gate16_risk_limits.cpp`; no caller outside itself |
| FR-RK-05 | Relay `cpp_strategy_config` parameter changes to the running engine with an audit row. | IMPLEMENTED, **NOT WIRED** | `StrategyConfigManager::load_from_db` has no caller in `src/`; compiled defaults govern |
| FR-RK-06 | Block entries once the session drawdown limit is breached. | IMPLEMENTED, WIRED (native path) | `fetch_today_session_drawdown` returns `known=false` on failure so unknown ≠ zero (`db_client.cpp:1792-1847`) |

**FR-RK-04/05 consequence.** The full risk engine — margin models, Kelly sizing,
circuit breakers, kill switch — is implemented and unit-tested but never
instantiated in production. The live loop's only risk controls are single-lot
sizing, the funds check (FR-EX-05), and the drawdown gate (FR-RK-06).

---

## 7. Functional requirements — persistence

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-PS-01 | Store all timestamps as UTC wall clock in `DATETIME` columns; express IST-day predicates as `value - INTERVAL 330 MINUTE`. | IMPLEMENTED, WIRED | `db_client.cpp:89-93, 1804-1817` |
| FR-PS-02 | Pin the session time zone per pooled connection and restore it on release. | IMPLEMENTED, WIRED | `db_client.cpp:48-97`, `native_paper_store.cpp:37-43` |
| FR-PS-03 | Encrypt broker tokens at rest with AES-256-CBC under a key derived from an environment secret. | IMPLEMENTED, WIRED | `crypto_util.hpp:266-268`, `db_client.cpp:789-794` |
| FR-PS-04 | Keep test data in `_test` twin tables, never touching production rows. | IMPLEMENTED, TESTED | `db_client.cpp:981-1063`; `cpp_trade_reports_test` is DELETEd per run |
| FR-PS-05 | Enforce idempotency on trade creation. | IMPLEMENTED, WIRED | `UNIQUE idx_signal_idempotency` on `cpp_trade_reports` |
| FR-PS-06 | Enforce idempotency on option-quote capture. | **NOT IMPLEMENTED** | `cpp_option_quote_observations` has only a UUID primary key; a retry writes a second row |
| FR-PS-07 | Bound the connection pool and block when exhausted. | **NOT IMPLEMENTED** | `acquire()` opens a new connection instead of waiting (`db_client.cpp:106-114`); `pool_size_` only sizes the initial fill |
| FR-PS-08 | Configure read and write timeouts. | **NOT IMPLEMENTED** | Only `MYSQL_OPT_CONNECT_TIMEOUT=5s` (`db_client.cpp:78-79`); a stalled server hangs the caller |
| FR-PS-09 | Require TLS to the database. | **NOT IMPLEMENTED** | `SSL_MODE_PREFERRED` (`db_client.cpp:80-81`); encryption may silently downgrade |
| FR-PS-10 | Sleep-write retention for the trade ledger and decision journal. | **NOT IMPLEMENTED** | No retention for `cpp_trade_reports`, `hermes_cpp_decision_journal`, `fnf_trades`, `cpp_option_quote_observations` |

---

## 8. Functional requirements — operator interface

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-UI-01 | Serve 40 exact (method, path) routes with a default-deny gate; unlisted routes are rejected. | IMPLEMENTED, WIRED | `route_table.hpp:51-96, 153-164, 215-246` |
| FR-UI-02 | Reject malformed request lines: non-HTTP/1.0–1.1 versions, control characters, paths not starting `/`. | IMPLEMENTED, TESTED | `route_table.hpp:109-150` |
| FR-UI-03 | Authenticate every non-public route with a cryptographically random session token, constant-time comparison, expiry and server-side revocation. | **IMPLEMENTED BUT NOT WIRED** | `http_auth.hpp:129-229` is exercised only by `tests/auth_tests.cpp`; the live gate still calls the legacy substring `check_auth` (`roadmap_server.cpp:1440-1445, 2345`) |
| FR-UI-04 | Require a one-time, single-use, 300-second OAuth state for broker callbacks. | IMPLEMENTED, WIRED | `http_auth.hpp:165-197`, `roadmap_server.cpp:2649-2731` |
| FR-UI-05 | Throttle repeated login attempts and provide a bounded lockout. | **NOT IMPLEMENTED** | `roadmap_server.cpp:2544-2564`; unlimited attempts |

**FR-UI-03 is a live security defect.** `check_auth` returns true when the raw
request text contains the *header name* `x-operator-password` or the literal
cookie string `auth_token=` — because the search covers the whole request, any
caller that types either string in a query parameter, body or header is
authenticated. The hardened implementation exists, is unit-tested, and is never
called by the server. Binding it is the highest-priority security item.

---

## 9. Non-functional requirements

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| NFR-01 | Bind the HTTP listener to loopback only. | **VIOLATED** | `INADDR_ANY` (`roadmap_server.cpp:2275-2283`) |
| NFR-02 | Handle termination signals and shut down cleanly. | **NOT IMPLEMENTED** | Only `SIGPIPE` is handled (`main.cpp:137`); no `SIGINT`/`SIGTERM`; PM2 must SIGKILL after 30 s |
| NFR-03 | Never interpolate request data into a shell command. | **VIOLATED** | `popen("curl ...")` with request-derived code (`roadmap_server.cpp:1574-1601, 1619-1645`) |
| NFR-04 | Log no credential values. | IMPLEMENTED | Configuration is read from env; no secret value is rendered |
| NFR-05 | Keep the process RSS within a stated budget. | **UNVERIFIED** | The 15–20 MB target in `REQUIREMENTS_AND_ARCHITECTURE.md` is unsupported; no measurement exists in-repo |
| NFR-06 | Run a blocking static analysis gate in CI. | IMPLEMENTED, WIRED | `cppcheck --enable=warning --error-exitcode=1` (`.github/workflows/cpp-agent-ci-cd.yml:77-84`) |
| NFR-07 | Run the test suite on a GCC and a Clang matrix. | IMPLEMENTED, WIRED | `g++-13`, `clang++-17` matrix (workflow `:40-48`) |
| NFR-08 | Deploy automatically on a green build. | **DISABLED BY DESIGN** | Deploy job has `if: false` (workflow `:165-173`) |
| NFR-09 | Publish a build revision readable at runtime. | IMPLEMENTED, WIRED | `HERMES_BUILD_GIT_SHA` via `git rev-parse` (`CMakeLists.txt:16-39`), surfaced by `/api/health` |

---

## 10. Traceability summary

| Subsystem | Requirements | WIRED | Implemented, not wired | Not implemented |
|---|---:|---:|---:|---:|
| Market data | 9 | 6 | 2 | 1 |
| Execution | 11 | 8 | 2 | 1 |
| Learning / research | 8 | 1 | 5 | 2 |
| Risk / capital | 6 | 3 | 2 | 1 |
| Persistence | 10 | 4 | 0 | 6 |
| Operator interface | 5 | 3 | 1 | 1 |
| Non-functional | 9 | 3 | 0 | 6 |

**Reading the table.** Roughly a third of specified capability is reachable at
runtime. The learning and risk subsystems are the most complete in isolation and
the least connected — which is why the roadmap sequences *wiring* ahead of new
feature work.

---

## 11. Acceptance criteria for release

A release is acceptable when, at minimum:

1. FR-UI-03 is wired: the live gate uses `http_auth::Authenticator`, and a
   negative test proves a request containing the legacy literals is rejected.
2. FR-MD-07 is implemented: a stalled feed forces reconnection within 60 s.
3. NFR-01, NFR-02, NFR-03 are closed: loopback bind, signal handling, no shell
   interpolation of request data.
4. FR-LR-01 through FR-LR-05 are either wired into the decision path or
   explicitly retired from the specification — a tested-but-unreachable module is
   not a shipped capability.
5. The NFR-05 memory budget is measured and recorded, or the claim is withdrawn.
