# Product Roadmap — C++ options trading engine

**Baseline:** `feat/cpp-trading-agent` @ `05130a9`
**Status:** PLAN. Nothing in this document is implemented; each item names the
evidence that would prove it done.

---

## 1. Where the system actually is

Production runs a **single-lot, long-only option paper trader** driven by one
decision engine, fed by one broker, writing to one wallet row.

| Capability | State |
|---|---|
| Live market data (Upstox v3) | working |
| Tick persistence | working |
| Paper execution, ledger, journal | working |
| Expiry cash settlement | working |
| Operator dashboard / API (40 routes) | working, **with a live auth defect** |
| Pre-market readiness, EOD analysis, archival | working (in-process) |
| Gate research pipeline (G0–G22) | **compiled, tested, never called** |
| Adaptive sizing beyond 1 lot | **unreachable** |
| Full risk engine (margin, Kelly, breakers, kill switch) | **never instantiated** |

The dominant engineering fact is the gap between the third and fourth rows: the
system's analytical depth is not connected to its execution.

---

## 2. Gate status

| Gate | Subject | Implemented | Tested | Wired |
|---|---|:--:|:--:|:--:|
| G0 | Paper-only guards, allowlist, capital cap, feed quality | ✅ | ✅ | ❌ |
| G3 | Expanded feature set | ✅ | ✅ | ❌ |
| G4 | Gap taxonomy → fade/follow | ✅ | ✅ | ❌ |
| G5 | Microprice / OFI | ✅ | ✅ | ❌ |
| G6 | Volume profile, value area | ✅ | ✅ | ❌ |
| G7 | Greeks, GEX, gamma flip | ✅ | ✅ | ❌ |
| G8 | Statistical arbitrage | ✅ | ✅ | ❌ |
| G9 | Fill simulation, cost stress | ✅ | ✅ | ❌ |
| G10 | Regime machine | ✅ | ✅ | ❌ |
| G11 | Strategy taxonomy | ✅ | ✅ | ❌ |
| G12 | ML labelling, baseline gate | ✅ | ✅ | ❌ |
| G13 | Purged/embargoed CV | ✅ (defective) | ✅ | ❌ |
| G14 | Outcome taxonomy, rule promotion | ✅ | ✅ | ❌ |
| G15 | Champion/challenger, rollback | ✅ | ✅ | ❌ |
| G16 | Risk engine, Kelly, breakers | ✅ | ✅ | ❌ |
| G17 | Cross-market alignment | ✅ | ✅ | ❌ |
| G18 | Advanced-model approval | ✅ | ✅ | ❌ |
| G19 | Observability serialiser | ✅ | ✅ | ❌ |
| G20 | Shadow submission | ✅ | ✅ | ❌ |
| G21 | Phase-1 acceptance | ✅ (stub, always true) | ✅ | ❌ |
| G22 | Seasonality | ✅ | ✅ | ❌ |

**Wired total: 0 of 21.**

---

## 3. Workstreams

Ordered by risk, then by the system's ability to learn anything trustworthy.
Security first because the operator interface is network-exposed; wiring second
because until it lands, every learning claim is unfalsifiable.

### W1 — Close the operator-surface security defects

| # | Item | Acceptance evidence |
|---|---|---|
| W1-1 | Wire `http_auth::Authenticator` into the live gate; delete the substring `check_auth` | Negative test: a request carrying `x-operator-password` or `auth_token=` in body/query is rejected 401 against the built binary |
| W1-2 | Replace `popen("curl …")` OAuth exchange with an in-process HTTP client | No `popen` in `src/roadmap/roadmap_server.cpp`; callback test passes with a request containing shell metacharacters |
| W1-3 | Bind loopback only, or add explicit bind-address config | `ss -ltnp` shows `127.0.0.1:8080` |
| W1-4 | Login throttling with a bounded, recoverable lockout | Test proves N failures lock for a window and recovery is documented |
| W1-5 | Constant-time operator password compare | Code review + timing test |

**Why first:** D-01 makes every authenticated route open to anyone who types a
known string. No other work matters while that stands.

---

### W2 — Make the feed resilient

| # | Item | Acceptance evidence |
|---|---|---|
| W2-1 | Staleness-driven reconnect: if no tick for N seconds while `ACTIVE`, force reconnect | Test with a silent socket recovers within 60 s |
| W2-2 | Client ping / read deadline on the transport | Idle socket closed and reconnected, proven by test |
| W2-3 | Surface feed age on `/api/health` | Field present and non-zero during a stall |
| W2-4 | Decide FYERS: remove the dead adapter or make it selectable | Either deleted, or a config flag selects it and a test exercises failover |

**Why second:** a half-open socket parks the state machine indefinitely with no
recovery (FR-MD-07, D-05). Silent stall is worse than a visible crash.

---

### W3 — Wire the learning path

The highest-value engineering work in the product. Sequence matters: each step
must be observable before the next is trusted.

| # | Item | Acceptance evidence |
|---|---|---|
| W3-1 | Fix `gate21` to read real gate outcomes (or delete it) | Returns false when any gate is not green; test proves the negative |
| W3-2 | Fix `gate13` leakage check | A deliberately leaky fixture is rejected |
| W3-3 | Persist seasonality; wire `/api/seasonality-patterns` | `cpp_seasonality_patterns` populated; API returns rows |
| W3-4 | Wire `StrategyConfigManager::load_from_db` + periodic reload | Changing a key in `cpp_strategy_config` changes behaviour without restart; audit row written |
| W3-5 | Expose `empirical_model_active` as a real gate over sample size and OOS evidence | Validated branch reachable; sizing leaves 1 lot only when the evidence threshold is met |
| W3-6 | Wire `gate16` risk engine into the entry path | Margin, breaker and kill-switch tests fail the build when bypassed |
| W3-7 | Wire the decision gates (G4–G10) into `NativePaperEngine::process` | A recorded tick replay produces identical decisions with gates on and off, differing only where gated |

**Acceptance theme:** every wired stage must be observable in the decision
journal. An unobservable wiring is indistinguishable from no wiring — which is
exactly the defect being fixed.

---

### W4 — Data integrity and correctness

| # | Item | Acceptance evidence |
|---|---|---|
| W4-1 | Fix `fnf_market_snapshots` OHLC mapping (currently bid/ask/bid/LTP) | Written row matches documented semantics; regression test |
| W4-2 | Fix `fetch_latest_post_session_record` column names | Query returns rows instead of an empty map |
| W4-3 | Fix `count_historical_candles_for_date` (`candle_date`) | Returns the real count |
| W4-4 | Idempotency key on `cpp_option_quote_observations` | Replaying a capture writes one row |
| W4-5 | Bound the connection pool; add read/write timeouts; require TLS | Pool never exceeds its size under load; timeout test; `SSL_MODE_REQUIRED` |
| W4-6 | Fix connection leaks on error paths | Leak test over N failures shows stable handle count |
| W4-7 | Add DDL under `ddl/` for the money-carrying tables | `ddl/` recreates the schema from empty |
| W4-8 | Fix display readers that append `IST` to unshifted UTC | Rendered time matches the stored value + 5:30 |
| W4-9 | Extend market-calendar holidays beyond 2026 | 2027 dates present |

---

### W5 — Operability

| # | Item | Acceptance evidence |
|---|---|---|
| W5-1 | Handle `SIGTERM`/`SIGINT`; stop accepting, drain, join, exit 0 | `pm2 stop` completes within 5 s without SIGKILL |
| W5-2 | Retry `1213`/`1205` on the persistence path | Injected deadlock retried successfully |
| W5-3 | Compile `src/post_session_cli.cpp` as a real target | Target exists; `--date` run works |
| W5-4 | Measure and record RSS; withdraw or confirm the 15–20 MB claim | Number in `docs/product/TECHNICAL_SPECIFICATION.md` |
| W5-5 | Remove the hardcoded DB/broker identity defaults | Missing `.env` fails fast instead of connecting with a guessed identity |
| W5-6 | Log-level gate on the per-frame hex dump | No per-tick stdout at default level |
| W5-7 | Write the missing standard documents: `docs/TESTING.md` (what the suite actually enforces, which parts are hermetic, and the rule that a test is never weakened for green), `docs/STATUS.md` (terse completed-work table with evidence), `docs/DECISIONS.md` (backfilled ADRs) | All three exist, are indexed from the repo README, and each states its scope limits |

---

## 4. Sequencing rationale

```
W1 (security)  ──► W2 (feed)  ──► W3 (wiring)  ──► W4 (data)  ──► W5 (ops)
     │                │                │                │
  blocks any    blocks trust      blocks any      blocks trust
  external use  in the data       learning claim  in the numbers
```

W1 and W2 are independent of the research workstream and can proceed in parallel
with W3 preparation. W4 may interleave with W3 — both touch the persistence layer,
so they should not be edited concurrently by different workstreams.

**Do not start W3-7 (decision-gate wiring) before W3-1 and W3-2.** Wiring gates
while the acceptance harness always returns true and the leakage check cannot
fail would produce a system that reports success without evidence — the exact
failure mode this roadmap exists to remove.

---

## 5. Explicit non-goals

Recorded so they are not re-litigated:

- **Live broker order execution.** Compile-time blocked by design
  (`gate0_bootstrap.hpp:37-45`). Enabling it requires a new decision, not a flag.
- **Multi-leg execution.** `spread_position.hpp` stays declared-but-inert until a
  persistence and settlement model for spreads exists.
- **External ML inference.** No model runtime is planned in this component.
- **Multi-tenancy.** The single wallet row `cpp-portfolio-v1` is intentional.
- **Automatic deployment.** The CI deploy job stays `if: false`; deployment is a
  manual, operator-approved step.
- **Rewriting the persistence layer.** The 3,756-line `RoadmapDbClient` is
  repaired incrementally; a rewrite is out of scope for this roadmap.

---

## 6. Definition of done for the roadmap

The roadmap is complete when:

1. Every requirement in `SRS.md` marked IMPLEMENTED is also WIRED or explicitly
   retired from the specification.
2. `LEARNING_METHODS.md` §3 "designed versus wired" collapses to a single
   diagram — the loop it describes is the loop that runs.
3. No entry in the `TECHNICAL_SPECIFICATION.md` defect register remains at
   Critical or High.
4. A recorded tick replay reproduces a session's decisions from the journal,
   independently of the live feed.
