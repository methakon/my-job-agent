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
