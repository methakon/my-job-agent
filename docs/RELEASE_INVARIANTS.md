# Release Invariants

Five properties that must hold for a release of the C++ trading agent. They are not desirable
behaviours — each one corresponds to a defect that reached the codebase or the dashboard, and
each has tests that fail loudly if it regresses.

`INVARIANT-1..5` in `tests/unit_and_integration_tests.cpp` re-asserts all five together, so a
release gate has one place to look. The detail tests below are where each is actually proved.

---

## 1. The operator ceiling cannot change through settlement

`cpp_portfolios.ceiling` is operator-authorized trading capital, not derived metric. Both
settlement paths used to write `ceiling = capital + SUM(netPnl)`, which against the corrected
finalized predicate evaluates to `100000 + 205716.63` — silently undoing a mandated rebase to
₹1,00,000 and tripling the capital the engine sizes against. Neither path writes it now; `netPnl`
still is, over finalized rows.

**Carried by:** `CEIL-01`..`CEIL-05c` (settle path, repeated settlement), `SET-02` (direct close
path), `INVARIANT-1`.

**Not to be fixed by:** clamping the ceiling after computing it. The derived value must never be
written in the first place.

---

## 2. An unknown daily-loss state blocks new paper entries

`fetch_today_session_drawdown()` returned a bare double whose failure value was `0.0`, so a failed
connection, a SQL error and an empty result were indistinguishable from "no losses today" — and
all three authorized new entries. A risk input that fails open is worse than a missing one,
because nothing downstream can tell.

`SessionDrawdownReading` carries `known`/`unknown` explicitly, and
`daily_loss_state_blocks_entries()` returns true for an unknown reading. The gate is enforced
**at the order-authorization boundary**, immediately before a position can be created.

**Carried by:** `DLG-01`..`DLG-05b`, `INVARIANT-2`.

**Not to be fixed by:** treating a query failure as zero loss, or moving the gate earlier in the
pipeline so it no longer sits between the decision and the order.

---

## 3. Unknown or expired contracts cannot enter execution

Expiry was read from the symbol, and an unreadable expiry returned "not expired" — an explicit
fail-open, on the argument that the insert-time guard was a sufficient backstop. It was not: that
guard is the unique idempotency index, which constrains duplicate writes, not tradability.

Expiry is a tri-state. `UNKNOWN` is refused at the entry path exactly as `EXPIRED` is, and
unverifiable ticks are counted and reported separately so nothing is dropped silently.

**Carried by:** `EXP-01`..`EXP-09`, `REENTRY-01`..`REENTRY-05`, `INVARIANT-3`.

**Not to be fixed by:** relying on the idempotency index, or on insert-time rejection. Eligibility
is a property of the symbol and is decided before the contract is evaluated at all.

---

## 4. An incomplete MTM cannot be displayed as complete

The portfolio aggregate substituted `entryPrice` for a missing quote, which forces an unpriced
position's contribution to exactly `0.00` — so a partially-priced book rendered identically to a
genuinely flat one. Unpriced positions are counted and excluded, `UserPortfolioData` carries
`mtmComplete`, and the panel marks the figure `PARTIAL` rather than presenting it as the whole.

**Carried by:** `MTM-01a`..`MTM-04`, `INVARIANT-4`.

**Not to be fixed by:** displaying an explicit zero. A fabricated zero is the defect; a visibly
incomplete valuation is the fix.

---

## 5. Database-backed tests cannot connect to production

The test harness carried production defaults — `127.0.0.1:3307`, user `mylife`, schema
`myjob_agent`, the production SSH tunnel's values. A checkout with no `.env` therefore addressed
production instead of failing. CI surfaced it by being unable to reach that tunnel from a runner.

There are now no defaults. `tests/test_db_config.hpp` refuses unless given an explicit
`CPP_TEST_DB` opt-in, a complete set of values, a loopback host, a non-tunnel port, a restricted
account name, and a schema named as a test schema. A refusal terminates database-backed testing
with exit 2 **before any connection is opened**.

**Carried by:** `TESTCFG-01`..`TESTCFG-09`, `ISO-01`/`ISO-02`, `INVARIANT-5`.

**Not to be fixed by:** adding defaults back for convenience. The convenience is the defect.

---

## Standing operational invariants

These are not code properties but constraints on how the system is operated; they are listed here
because violating them is how the defects above became reachable.

- **Deployment is manual.** The CI workflow's deploy job is disabled (`if: false`). When it was
  armed it restarted a systemd unit that does not exist — the VM runs the agent under PM2 — so it
  would have overwritten the binary before failing to restart it.
- **Trading-agent sessions are IST, connection-scoped.** `MYSQL_SESSION_TIME_ZONE=+05:30`. The
  shared server's global time zone is never changed.
- **DATETIME vs TIMESTAMP.** UTC-valued DATETIME columns are written with `UTC_TIMESTAMP()` and
  read with an explicit shift; TIMESTAMP columns are converted by the server. See
  `docs/TIMESTAMP_CONVENTIONS.md`.
- **No thresholds are ever loosened to manufacture trades**, and the daily/per-trade ceilings are
  operator settings.
