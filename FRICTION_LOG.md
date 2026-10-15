# FRICTION_LOG.md

An engineering journal of things that cost time, so they cost it once.

Separate from the session decision log: that records *what was decided*, this records
*what went wrong and why we didn't see it*. Append as friction happens — not
retroactively, not batched. A retroactive entry is a memory; a contemporaneous one is
a record.

Log an entry when:

- a test validated a fix against a shape that **structurally could not** expose the bug
- a shared helper or path turned out to guard more than one call site, in a way that
  wasn't obvious until something broke
- an assumption was treated as fact without being checked, and it mattered
- an approved fix was found to have a second-order consequence that would have made
  things **worse** shipped on its own
- anything else process-level that isn't worth re-learning

Format per entry: **what happened · root cause · what would have caught it earlier ·
what changed**.

Append at the bottom. Newest last.

---

## 2026-10-15 — A fail-open fallback hid a dead option feed for about a week

**Discovery.** `upstox_live_paper_option_quotes` holds 4,703,198 rows and **zero from today**. The
option feed has been silent since around 2026-10-07, while the engine continued to look healthy:
1,49,787 index snapshots and 57,608 index ticks arrived today (source `UPSTOX_WS`), positions were
managed, and nothing alarmed.

**Impact.** Roughly a week of operation in which no option contract quote existed, reported
internally as normal functioning. The stale-data fail-open fallback (item 30) is what let a dead
feed read as a live one: the engine substituted a stale value rather than declaring the data
unavailable, so the failure was invisible at exactly the layer that should have surfaced it. This
is the same defect class as item 30, observed in production rather than in a test.

**Evidence.** `SELECT COUNT(*) FROM upstox_live_paper_option_quotes WHERE ts >= <today 09:15 IST>`
returns 0 against 4,703,198 total; today's tick provenance is uniformly `UPSTOX_WS`; no option-shaped
instrument appears in today's live feed at all (`option-shaped = 0` over 54,344 rows).

**Correction.** Fail-open substitution removed (item 30.1/30.4, deployed `112ad56`). The option-feed
stop is now tracked as item 38 — a regression to be diagnosed, not a feature to be built.

**Prevention.** A missing feed must be representable as missing. Any fallback that fills a gap with
an older value converts an outage into silence, and silence is the expensive failure: it consumes
the time an outage would otherwise have been noticed in. When adding a fallback, ask what failure it
would conceal.

## 2026-10-15 — Database-backed tests addressed production by default

**Discovery.** The main C++ suite, and separately the visitor-analytics suite, defaulted
`MYSQL_PORT=3307`, `MYSQL_USER=mylife`, `MYSQL_HOST=127.0.0.1` — the port, user and host of the
operator's production tunnel. A fresh checkout with no test configuration therefore opened
connections toward production rather than refusing to run.

**Impact.** Every local run since those defaults were written ran one config-resolution step away
from production. CI exposed it as 19 failures reaching `127.0.0.1:3307` — a failure that was
lucky, because a reachable tunnel and a matching fixture would have written to production and
passed. The suite's green local history was evidence only that the tunnel happened to be up.

**Evidence.** CI run `38634788162`: `[EnvLoader] Warning: Could not open .env` followed by
`[MySQLPool] Connection failed to 127.0.0.1:3307 (mylife)`. Both suites carried the same defaults;
the first fix covered only the main suite, and the visitor suite was found to carry them too.

**Correction.** `tests/test_db_config.hpp` — a pure resolver that opens no connection, has no
defaults at all, and refuses production-shaped configuration. A missing or invalid test config
terminates before any connection is made. Negative tests assert that absent configuration,
production-like defaults and an unexpected schema cannot establish a test connection.

**Prevention.** A test default that resolves to a live endpoint is not a convenience, it is a
silent production dependency. Defaults must fail closed: absent configuration must terminate, not
fall back. When a config value has a "sensible default", ask what that default *addresses*.

## 2026-10-15 — The Clang matrix entry selected the C compiler

**Discovery.** The Clang job installed `clang-17` and selected it as `CC`/`CXX`. `clang-17` is the
C driver; a `.cpp` input through it does not link C++ standard-library symbols.

**Impact.** The Clang half of the matrix could never link the test binaries, so half the intended
compiler coverage was decorative and the pipeline's Clang signal meant nothing.

**Evidence.** CI run `38634788162`: Clang compiled but failed at link once the job reached
building, which it had not done before the static-analysis gate was repaired.

**Correction.** The matrix entry became `clang++-17`, with the compiler installed explicitly.
Confirmed by an actual link, CTest execution and artifact generation.

**Prevention.** A compiler identity is not a compiler driver. Verify a matrix entry by linking,
not by the presence of a binary name.

## 2026-10-15 — Historical-P&L reconciliation would have tripled the operator's ceiling

**Discovery.** Both settlement paths wrote `ceiling = capital + (SELECT SUM(netPnl) ...)`. With
confirmed historical net P&L of ₹2,05,716.63 against an operator-authorized ceiling of ₹1,00,000,
the next settlement would have set the ceiling to roughly ₹3,05,716 — tripling the risk the
operator had authorized, as a side effect of an accounting update.

**Impact.** Capital authority is not an accounting figure. The write would have silently expanded
the trading envelope, and it would have looked like correct bookkeeping while doing it.

**Evidence.** Both paths read (`sync_sql` and the settlement update); the ₹2,05,716.63 historical
figure against the ₹1,00,000 ceiling; committed as `8195ac4`.

**Correction.** The ceiling write was removed from both settlement paths. Realized accounting is
updated independently; the ceiling is operator-authoritative and changes only by operator action.
`CEIL-01..05c` pin it, including "repeated settlement cannot change the ceiling".

**Prevention.** Never derive a risk limit from a performance figure. If a column bounds what the
operator has authorized, nothing but the operator may write it -- and a test must prove that.

## 2026-10-15 — The CI pipeline had never compiled anything, in 26 runs

**Discovery.** Every run since inception died at the Cppcheck step, which ran with
`--enable=warning,style,performance,portability --error-exitcode=1` and therefore failed on cosmetic
`style` findings. The pipeline had never reached build, test or artifact upload.

**Impact.** 26 red runs read as code health signals while carrying no information about the code.
The local suite was the only verification this code had ever had, and the artifact step had never
executed once.

**Evidence.** 26 runs, 26 failures, all at static analysis; the deploy job's `needs:` on a job that
never succeeded; an artifact path (`build/bin/`) that CMake never creates; a service name PM2 does
not use; and a library (`libmysqlcppconn-dev`) the link line does not reference.

**Correction.** Static analysis split into a blocking gate (errors/warnings) and an advisory report
(style/performance/portability); the three deploy-job defects fixed as correctness-only; deploy set
`if: false`. The first genuinely compiled run followed (CI run `38634788162`).

**Prevention.** A red pipeline that has never been green is not a signal, it is an unexamined
assumption. Confirm a pipeline can reach its final step before trusting any of its earlier ones.

## 2026-10-15 — "No failure recorded" was read as evidence about the code

**Discovery.** Instrumenting an existing function to find a concurrency failure, the instrumented
build reported `AF-00` -- the cleared diagnostic -- for calls that had definitely failed. That was
read as "the function returns false without passing any failure site", and conclusions followed.

**Impact.** The reading was an artifact of the instrumentation, not a fact about the defect: the
first instrumentor also replaced each `return false;` instead of prefixing it, so every failure
path fell through. Two conclusions were drawn from a build whose diagnostics could not be trusted.

**Evidence.** The generated diff showed `return false;` replaced rather than preceded; reverted
with `git checkout`; later, a per-invocation counter showed `expected=160 counted=157` with
`instrumented_failures_recorded=0` alongside an actually-emitted `AF-01` line -- the counts
disagreeing with each other, which is the signature of an unreliable probe.

**Correction.** The instrumentation now counts invocations, records both outcomes, captures the
MySQL error at the point of failure before any rollback can clear it, and carries a self-test that
pushes a known-failing call through the real path and asserts the trace saw it. A trace reading is
inadmissible until that self-test passes.

**Prevention.** Instrumentation must prove it can observe a failure it is certain of before its
absence-of-failure readings mean anything. Wire the positive control first; never infer a root
cause from a diagnostic that has not demonstrated it can fire.

## 2026-10-14 — Tests proved a fix against a population that excluded the bug

**What happened.** `is_contract_expired` took the first run of six consecutive digits in
a symbol as the expiry. `NIFTY50` + `261006` merges into `502610`, which parses as month
26, fails the 1–12 check, and returns "not expired". Every `NIFTY50`-prefixed contract
was therefore treated as live. The unit tests passed, because `EXP-01` used
`SENSEX261001...` — where the digits begin cleanly after `SENSEX` and the collision
cannot occur. The fix looked proven.

**Root cause.** Test fixtures were chosen by convenience rather than drawn from the
symbols the engine actually sees.

**Would have been caught by.** Deriving fixtures from the distinct symbols present in
production — `SELECT DISTINCT symbol` — instead of inventing representative-looking ones.

**What changed.** The candidate replacement was validated against the real failing
population before any code was written: all 23 affected instruments, plus 12 live
contracts that must not regress, plus the three index symbols. 23/23 corrected, zero
regressions. The lesson generalises: a test's value depends on whether its inputs belong
to the population that can fail.

---

## 2026-10-14 — A shared helper silently held two independent defences

**What happened.** The expiry check was refactored into one shared helper
(`MarketCalendar::is_contract_expired`) used by both the decision-path skip and the
insert-time guard. That was the right call for consistency. But it meant the parsing flaw
above defeated *both* defences at once, and 23 expired contracts reached the trade table.
Had they been separate implementations, a flaw in one would still have been caught by the
other.

**Root cause.** The refactor was evaluated for maintainability and not for blast radius —
"one implementation, so they can't drift" is true and also means "one bug, so nothing
disagrees".

**Would have been caught by.** Enumerating call sites when extracting shared logic, and
noting whether any of them are independent safety layers.

**What changed.** Recorded as a design fact: the skip and the guard are defence in depth,
and **either alone would have blocked all 23 trades**. Deliberately de-duplicating two
independent defences trades redundancy for consistency, and that trade should be explicit.

---

## 2026-10-14 — "Absent from HEAD" was reported as "never existed"

**What happened.** Asked to fix a FYERS/Upstox symbol mismatch, the current tree was
searched, no translator was found, and the answer given was "there is no translation".
The operator recalled a provider-interpreter class having existed. `git log -S` across all
refs then showed it did: `provider-mappers.ts` / `tick-interpreter.service.ts`, committed
2026-09-11, present and wired — in the TypeScript pipeline, not the C++ engine.

**Root cause.** "Not in the working tree" and "never existed" were treated as the same
claim. They aren't, and the second one is much stronger. The searches were cheap and were
skipped.

**Would have been caught by.** Running the history search before asserting absence. That
is the whole check.

**What changed.** Absence claims now require a history search, not a tree search. The
stricter the claim, the more it needs evidence — and "this never existed" is among the
strictest claims available.

---

## 2026-10-14 — An approved fix that would have made things worse

**What happened.** Suppressing FYERS as a feed provider was approved as a one-line change
— FYERS had never delivered a tick, so de-selecting it looked free. Reading the same
function showed the demote-recovery path only resets fail counters when **both** providers
have failed twice. With FYERS gated off, its counter never increments, so a demoted Upstox
could never be un-demoted: one transient failure would mean standby until restart. The
"free" change would have converted a 15-minute self-healing failover into an
indefinite outage.

**Root cause.** The change was scoped to the line that needed editing, and the recovery
path that made the line safe went unread.

**Would have been caught by.** Reading the whole function before approving a change to it,
rather than the target line and its immediate neighbours.

**What changed.** Option A is specced as two parts, not one: the env gate plus a
time-based per-provider backoff replacing the joint condition. It also removes the
no-backoff retry loop that produced 42,650 log lines that morning.

---

## 2026-10-14 — Verify the effect, not the exit code

**What happened.** Twice in one session a write appeared to succeed and hadn't. A nested
heredoc silently consumed the stdin meant to carry data into a remote file — the command
exited `0` and appended nothing. Separately, a generated script deleted its own
credentials file before the step that needed it, and reported success.

**Root cause.** Exit status was read as evidence of effect. `0` means "the command did not
report failure", which is not the same as "the thing happened".

**Would have been caught by.** Reading back the thing that was supposed to change — a row
count, a file size, a key present in a `.env` — after every write.

**What changed.** Writes are verified by their effect: the `.env` write was confirmed by
count and masked value, the correction script by a dry run against live rows, the deployed
build by fetching its own deploy marker. A successful call is not a completed one.

---

## 2026-10-14 — A fail-open side path beside fail-closed logic

**What happened.** The engine's token check fails closed: stale token, no trading. But a
fallback at `main.cpp:284` engages *precisely when the feed is down* and replays rows from
a shared table owned by a stopped subsystem, floor hardcoded to `2026-09-30`. During a
3.5-hour outage it opened 23 paper positions on two-week-old prices. No token was needed,
no feed was needed, and the fail-closed architecture did not apply to it.

**Root cause.** The safety invariant was enforced along the main path rather than at the
data-admission boundary. Every path into the decision pipeline is a path that needs the
invariant, not just the one that was being thought about.

**Would have been caught by.** Asking "what else can reach this pipeline?" when a
fail-closed rule was added, and treating every such entrance as in scope.

**What changed.** Item 30 makes the fallback's removal the top-priority fix. The invariant
belongs at the boundary, where data enters, and a side path around it is not a fallback —
it's a bypass.
