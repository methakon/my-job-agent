# System and Technical Audit — 2026-11-02

## Audit Metadata

| Field | Value |
|---|---|
| **Audit date** | 2026-11-02 (Monday), IST |
| **Repository** | `my-job-agent` — C++ engine subtree |
| **Branch** | `feat/cpp-trading-agent` |
| **Audited revision** | `6fe0ec3` |
| **Companion spec set** | `docs/product/` (README, SRS, TECHNICAL_SPECIFICATION, LEARNING_METHODS, ROADMAP) |
| **Method** | Clean-build verification, full CTest execution, static source inspection, runtime state inspection |
| **Evidence policy** | Every finding carries a command result or `file:line`. Unverifiable items are marked **UNVERIFIED**. |

---

## Executive Summary

The engine builds cleanly and its unit-test layer largely passes, but **four
conditions make the current state unsuitable as a basis for further feature
work**:

1. **The operator interface is open.** The live authentication gate is a
   substring search over the raw request; the hardened implementation exists,
   is unit-tested, and is never called. Confirmed: `Authenticator` has **zero**
   references in `roadmap_server.cpp`.

2. **The research pipeline is inert.** The G0–G22 gates compile into the binary
   and have **no call site outside their own files**. Confirmed by searching ten
   gate class names: zero references each; zero gate references in `main.cpp`;
   zero gate includes in `native_paper_runtime.cpp`.

3. **The test suite is red — 2 of 16 failing**, both with identified causes, not
   flakiness:
   - `SOLID_ACID_TestSuite` — **257 checks pass, 1 fails**:
     `EXP-03: expiring today is still tradable - NOT_EXPIRED`.
   - `Visitor_Analytics_TestSuite` — **aborts on an InnoDB deadlock**:
     `❌ [Analytics] Page Visit Insert Failed: Deadlock found when trying to get
     lock` followed by `AF-05 line=3083 errno=0 in_txn=1`.

4. **27 distinct compiler warnings**, emitted 220 times because all 17 targets
   compile the same `GLOB_RECURSE`d sources (8.15× amplification). Two are
   `-Wtype-limits` — "unsigned expression `>= 0` is always true" — genuine dead
   guards, not style noise. One is `is_new_visitor` set-but-unused at
   `db_client.cpp:2841`, **inside `record_analytics_event` — the same function
   that aborts the visitor suite** at line 2826.

The build is healthy; the *system* is not. Two of the four conditions above
(1 and 3) are release-blocking.

---

## 1. Scope and Method

**In scope:** source tree, build system, test suite, CI workflow definition,
local runtime state, and the local database populated by the in-progress import.

**Out of scope:** the Oracle VM production instance (not contacted), the
TypeScript service, and any network path to production.

**Checks actually executed:**

| Check | Command class | Result |
|---|---|---|
| Clean configure + build | `cmake -S . -B /tmp/build-audit -DCMAKE_BUILD_TYPE=Release` | exit 0, 17 targets |
| Warning inventory | parsed from clean build log | **220 lines / 27 unique source locations** |
| Test suite | `ctest --test-dir build --output-on-failure` | **14 passed / 2 failed of 16** |
| Gate wiring | repo-wide symbol search | 0 call sites |
| Live auth path | source inspection | substring search confirmed |
| Runtime DB state | `information_schema` queries | 125 tables / 12 views / 2 triggers |
| Import progress | chunk-marker count | 235 / 280 |

**Note on the warning figure.** An incremental build reported the same 220, but
only a clean build is authoritative; the clean figure is used throughout.

---

## 2. System State

### 2.1 Local MySQL

```
service      : active
socket       : present
ping         : mysqld is alive
schemas      : land_record, lr_probe, hermes_cpp_test, schema_cmp,
               hg_tick_staging, myjob_agent
```

The instance recovered successfully from the earlier unclean shutdown; the
`TimeoutStartSec` correction (60 s → 600 s) has removed the restart livelock
that previously produced competing `mysqld` processes on `ibdata1`.

### 2.2 Import state — incomplete

| Metric | Value |
|---|---|
| Chunks applied | **235 / 280 (83.9 %)** |
| Payload applied | 6.58 / 9.27 GB **(71.0 %)** |
| Schema objects | 125 tables, 12 views, 2 triggers |
| On-disk size | 11 GB |
| Outstanding | `unified_option_quotes_history` (19 parts), `upstox_live_paper_option_quotes` (25 parts), view block |

**Finding A-15.** The import is stalled, not failed. Structure is complete; two
large tables are partial and the 12 views are still placeholders. Any analytical
work against this copy is invalid until it completes.

### 2.3 Host

```
cores 40   RAM 7.9 GiB used / 7.6 GiB available   load 2.70
disk  1.3 TB free on /dev/sdc3
```

Resources are not a constraint. The datadir and the import chunks share one
spinning disk (`ROTA=1`), which caps bulk throughput near 1.4 MB/s — the reason
the import is slow rather than stuck.

---

## 3. Build Verification

| Property | Value |
|---|---|
| Configure | exit 0 |
| Build | exit 0 |
| Targets built | 17 |
| **Errors** | **0** |
| **Warnings** | **220 emitted lines / 27 unique source locations** |
| Binary | `cpp-trading-agent`, 2.2 MB, ELF 64-bit LSB PIE |
| Wall time | ~1 min 15 s on 40 cores |

**Finding A-16 (Medium).** 220 warning **lines** resolve to **27 unique source
locations** — an 8.15× amplification, because `CMakeLists.txt:41` globs every
`src/**/*.cpp` into 17 targets (the binary plus 16 test binaries), so each
finding is re-emitted per translation unit.

| Category | Sites | Character |
|---|---:|---|
| `-Wunused-parameter` | 15 | Mostly deliberate (interface conformance, compile-time stubs) |
| `-Wunused-variable` | 4 | Dead locals |
| `-Wreorder` | 3 | All one class: `NativeWsTransport` |
| **`-Wtype-limits`** | **2** | **"unsigned `>= 0` is always true" — dead guards, real defects** |
| `-Wcomment` | 1 | Multi-line comment |
| `(none)` | 1 | `"ALLOW" redefined` in a test |
| **`-Wunused-but-set-variable`** | **1** | **`is_new_visitor` — inside the failing function** |
| **Total** | **27** | All resolvable |

Full inventory with `file:line` and per-category remediation:
[WARNINGS_2026-11-02.md](WARNINGS_2026-11-02.md).

Five observations:

- **The headline number was misleading, and this audit got it wrong twice before
  settling.** 220 is a line count. A `(file, message)` grouping gave 31, which
  still understated the work because two different lines sharing a message are
  two different fixes. The stable, countable figure is **27 source locations** —
  the granularity at which a fix is a fix. Both earlier figures are recorded here
  rather than quietly replaced.
- `-Wreorder` is **one** logical fix: three lines all reporting that
  `NativeWsTransport::ssl_` is initialised out of declaration order
  (`native_ws_transport.hpp:29, 355, 362`).
- `-Wunused-parameter` (15) is largely by design, and concentrated: 5 of the 15
  are `gate0_bootstrap.hpp`, the compile-time live-order stub whose parameters
  exist only to match an interface it must never implement — deleting them would
  break the contract.
- **`is_new_visitor` is not noise.** It is computed at `db_client.cpp:2841` and
  discarded, inside `record_analytics_event` — the function whose write path
  aborts the visitor suite. A dead "is this a new visitor" result there is a
  candidate contributor, not a lint nit.
- Silencing a warning in one target reduces the line count without reducing the
  site count — which is why the metric is locations, not lines.

---

## 4. Test Verification

```
88% tests passed, 2 tests failed out of 16
Total Test time (real) = 82.66 sec
```

| # | Test | Result | Time |
|---|---|---|---|
| 1 | SOLID_ACID_TestSuite | **FAILED** | 61.53 s |
| 2 | Visitor_Analytics_TestSuite | **ABORTED** | 16.16 s |
| 3–16 | remaining suites | passed | 0.00–1.97 s |

### 4.1 Finding A-04 (High) — `Visitor_Analytics_TestSuite` aborts on a deadlock

The suite emits **two different failure signals**, and conflating them produced
an incorrect diagnosis in the first draft of this audit. They must be read
separately.

**Signal 1 — the instrumentation self-test (expected, and passing):**

```
❌ [MySQLPool] Connection failed to 127.0.0.1:3399 (nobody) - (111)
✅ [MySQLPool] Native C++ Connection Pool Initialized (Active Connections: 0 / 5)
❌ [Analytics] AF-01 line=2826 errno=0 in_txn=0 retries=0
[selftest] invocations=1 failures=1 furthest=POOL_ACQUIRE_FAILED code=1 line=2824
✅ INSTRUMENTATION INTEGRITY: the trace saw the known-failing call
```

This block is **deliberate**. The suite points a pool at a closed port to prove
the failure path works, the pool correctly reports `0 / 5`, and the self-test
asserts that it *did* observe the failure — and passes. Recording
`POOL_ACQUIRE_FAILED` as the root cause of the abort was wrong: this is the test
succeeding at what it was written to do.

**Signal 2 — the actual abort:**

```
❌ [Analytics] Page Visit Insert Failed: Deadlock found when trying to get lock; try restarting transaction
❌ [Analytics] AF-05 line=3083 errno=0 in_txn=1
```

`AF-05` at `db_client.cpp:3083`, raised while **inside a transaction**
(`in_txn=1`), with InnoDB reporting a genuine lock-order conflict on the
page-visit insert. The process aborts after this.

**Assessment.** The abort is a **concurrency defect in the analytics write path**,
consistent with concurrent transactions acquiring locks in different orders —
exactly the class of defect an earlier investigation was pursuing. The
pool-starvation reading is therefore **retracted**: the pool failure is the
self-test, and the writer's own retry logic does not cover `1213`.

Two things follow:

1. The page-visit insert needs deadlock handling (retry on `1213`) or a lock
   ordering that cannot deadlock. `record_analytics_event` already retries
   duplicate-key `1062` (`db_client.cpp:2882-2903`) but **not** `1213`.
2. The pool observations remain valid as a *separate* finding (A-13) — the pool
   still has no capacity contract — but they do not explain this abort.

### 4.2 Finding A-05 (High) — `SOLID_ACID_TestSuite` assertion failure

```
❌ FAIL: EXP-03: expiring today is still tradable - NOT_EXPIRED
```

A single failing assertion out of **257 passing checks** in the suite; everything
before it in the expiry tri-state group passes. The expiry classifier returns `NOT_EXPIRED` where
the test expects the contract to be treated as still tradable.

**Assessment:** narrowed to one predicate, not a broad regression. It must be
resolved before the expiry gate can be trusted for risk purposes.

**Not a finding:** the duplicate-key journal message at log line 47 and the
`Access denied for user 'u'` lines are **intentional negative tests** that
verify rejection behaviour. They are expected output, not defects, and are
recorded here so a later reader does not re-open them.

---

## 5. Findings Register

### Critical

| ID | Finding | Evidence | Impact |
|---|---|---|---|
| **A-01** | Live auth gate is a substring search | `roadmap_server.cpp:1440-1445` matches `req.find("x-operator-password")` (header **name**) and a literal cookie string; `Authenticator` references in that file: **0** | Every non-public route is reachable by any caller who types a known string anywhere in the request |
| **A-02** | Request data interpolated into a shell command | `popen("curl …")` with the OAuth code at `roadmap_server.cpp:1574-1601, 1619-1645` | Command injection through the callback path |

### High

| ID | Finding | Evidence |
|---|---|---|
| **A-03** | G0–G22 pipeline has no runtime call site | 0 references to 10 gate classes outside gate files; 0 gate refs in `main.cpp`; 0 gate includes in `native_paper_runtime.cpp` |
| **A-04** | Visitor suite aborts on an InnoDB **deadlock** in the page-visit insert | `AF-05 line=3083 in_txn=1`; `Deadlock found when trying to get lock` |
| **A-05** | Expiry assertion fails | `FAIL: EXP-03 … NOT_EXPIRED` |
| **A-06** | `gate21` accepts unconditionally | `gate21_final_acceptance.cpp:7-26` returns true; hardcodes 14 sessions, 0 breaches |
| **A-07** | Validated sizing unreachable | `empirical_model_active()` false, no override (`native_paper_runtime.cpp:80-115`) → every entry 1 lot |
| **A-08** | HTTP binds all interfaces | `INADDR_ANY` (`roadmap_server.cpp:2275-2283`) |
| **A-09** | No termination-signal handling | only `SIGPIPE` (`main.cpp:137`); no `SIGTERM`/`SIGINT`; PM2 SIGKILLs after 30 s |

### Medium

| ID | Finding | Evidence |
|---|---|---|
| **A-10** | Half-open feed never detected | no client ping, no read deadline; `should_reconnect_` set only on disconnect |
| **A-11** | Tick table stores wrong OHLC semantics | `open=bid, high=ask, low=bid, close=ltp` (`db_client.cpp:748-751`) |
| **A-12** | Two read paths select non-existent columns | `db_client.cpp:3704-3707`, `:3741` |
| **A-13** | Pool has no capacity contract, no read/write timeout, TLS PREFERRED | `db_client.cpp:78-122` |
| **A-14** | Option-quote capture lacks an idempotency key | table has only a UUID PK |
| **A-15** | Import stalled at 71 % by bytes | 235/280 chunk markers |
| **A-16** | **27 unique source locations** for warnings (220 emitted lines); 2 are `-Wtype-limits` dead guards | clean build log; `WARNINGS_2026-11-02.md` |
| **A-17** | `is_new_visitor` computed then discarded in the throttled visitor path | `db_client.cpp:2841` `-Wunused-but-set-variable` |

### Low

| ID | Finding |
|---|---|
| A-18 | Display paths append `IST` to unshifted UTC values (`db_client.cpp:884, 1161, 1190`) |
| A-19 | `changePct` hardcoded to `0.5` in snapshot reads (`db_client.cpp:1174`) |
| A-20 | Market holidays hardcoded for 2026 only (`market_calendar.cpp:40-56`) |
| A-21 | Backtest "sharpe_ratio" is a PnL/capital ratio (`backtest_engine.cpp:64`) |
| A-22 | `Sec-WebSocket-Key` hardcoded; mask from unseeded `rand()` (`native_ws_transport.hpp:139-144, 257`) |

---

## 6. Gap Analysis against `docs/product/SRS.md`

| Subsystem | Requirements | Wired | Implemented, not wired | Not implemented |
|---|---:|---:|---:|---:|
| Market data | 9 | 6 | 2 | 1 |
| Execution | 11 | 8 | 2 | 1 |
| Learning / research | 8 | **1** | 5 | 2 |
| Risk / capital | 6 | 3 | 2 | 1 |
| Persistence | 10 | 4 | 0 | 6 |
| Operator interface | 5 | 3 | 1 | 1 |
| Non-functional | 9 | 3 | 0 | 6 |
| **Total** | **58** | **28 (48 %)** | **12 (21 %)** | **18 (31 %)** |

**The decisive gap is not "missing features" — it is disconnected capability.**
Twelve requirements are fully built and unit-tested yet unreachable. The
learning subsystem is the extreme case: 5 of 8 implemented, 1 wired.

Three structural gaps explain most of the rest:

1. **No integration layer.** Nothing joins a gate's output to the next gate's
   input anywhere in `src/`. The pipeline exists as isolated units.
2. **No acceptance integrity.** `gate21` cannot fail, so "acceptance passed" is
   vacuous and cannot detect gap 1.
3. **No capacity contract and no deadlock handling.** The pool neither bounds nor
   blocks (A-13), and the analytics writer retries duplicate-key `1062` but not
   deadlock `1213` (A-04). These are two separate defects that the test suite
   surfaces together, which is why they were initially mistaken for one.

---

## 7. Recommendations

Sequenced by risk, mirroring `docs/product/ROADMAP.md`:

| Priority | Action | Closes |
|---|---|---|
| **P0** | Wire `http_auth::Authenticator` into the live gate; delete the substring `check_auth` | A-01 |
| **P0** | Replace `popen("curl …")` with an in-process HTTP client | A-02 |
| **P0** | Retry `1213` on the analytics write path, or fix the lock ordering in the page-visit insert | A-04 |
| **P0** | Define a pool capacity contract: bound the pool, block on acquire, add timeouts | A-13 |
| **P1** | Fix the `EXP-03` predicate | A-05 |
| **P1** | Make `gate21` read real gate outcomes | A-06 |
| **P1** | Bind loopback; add signal handling | A-08, A-09 |
| **P2** | Staleness-driven feed reconnect | A-10 |
| **P2** | Correct tick OHLC mapping and the two broken read queries | A-11, A-12 |
| **P2** | Clear the 27 warning sites per `WARNINGS_2026-11-02.md` — and fix the 8.15× compile amplification that inflates the log | A-16 |
| **P3** | Wire the learning pipeline — **only after** A-06 is fixed | A-03, A-07 |

**Ordering constraint.** Do not wire the decision gates (A-03) while `gate21`
still returns true unconditionally. Doing so produces a system that reports
success without evidence — the precise failure mode this audit exists to
document.

---

## 8. Audit Limitations

- The **Oracle VM production instance was not contacted.** Its binary revision,
  runtime state and log health are **UNVERIFIED** in this audit.
- The TypeScript service was not audited.
- The import database is **71 % loaded**; findings about data correctness
  (A-11, A-12) are static-analysis findings, not observed data defects.
- Test results reflect **this host and this revision**. The CI matrix
  (`g++-13` / `clang++-17`) was not executed here; only `g++ 13.3.0` was
  available, and `clang++-17` and `cppcheck` are absent locally.
- Warning counts are from a clean local Release build with
  `-Wall -Wextra`; CI's blocking `cppcheck` gate was not run locally.

---

## 9. Verdict

| Dimension | Assessment |
|---|---|
| Builds | **Pass** — 0 errors, reproducible |
| Unit tests | **Fail** — 2 of 16 red, both diagnosable |
| Security posture | **Fail** — auth bypass and shell interpolation live |
| Spec conformance | **Partial** — 48 % of requirements reachable |
| Operability | **Weak** — no clean shutdown, no feed-stall recovery |
| Data integrity | **At risk** — 2 broken read paths, wrong OHLC semantics |

**The engine is buildable and largely test-covered, but not releasable.** The
blocking items are A-01, A-02, A-04 and A-05. A-03/A-07 are not defects in
existing behaviour — they are the gap between what the system was built to do and
what it currently does.
