# Deployment & Rollback Plan — C++ trading agent, IST standardization release

Status: **proposed, for operator review. Nothing here has been executed.** No deployment is
authorized. The running VM is unchanged at `112ad56` and continues capturing ticks and paper
trading.

This plan exists because the change set touches time semantics, the risk gate, accounting and the
archival path at once, and because the current deployment mechanism is manual.

---

## 1. What is being deployed

`origin/feat/cpp-trading-agent` (CI green at run `38643048238`, commit `ead0c6b`), 27 commits ahead
of the deployed `112ad56`. Grouped by risk:

| Group | Contents | Risk |
|---|---|---|
| Risk gate | fail-closed `SessionDrawdownReading`; unknown blocks entries at the order-authorization boundary | **Highest** — changes when the engine will and will not open a position |
| Time semantics | IST sessions (`+05:30`), TIMESTAMP/DATETIME handling, sargable UTC ranges, archival boundary | **High** — touches every timestamp comparison and one `DELETE` |
| Accounting | finalized predicates (`CLOSED`/`ARCHIVED`), ceiling preservation, MTM completeness | Medium — reporting and capital sizing |
| Eligibility | tri-state expiry; `UNKNOWN` refused at the entry path | Medium — fewer contracts evaluated |
| Archival | stable-ID-set deletion in bounded transactional batches | Medium — destructive path |
| Test/CI | isolated MySQL, explicit test config, static-analysis split, deploy job disabled | None in production |

## 2. Preconditions

1. Operator authorization for this specific commit SHA. Not a branch name — the SHA.
2. A fresh Upstox login token, obtained after 03:30 IST, verified present before the swap.
3. The market closed (after 15:30 IST), or an explicit acceptance of restarting mid-session.
4. `~/cpp-trading-agent` on the VM has at least one known-good binary to roll back to.
5. Confirmation that the VM has no other writer to `cpp_trade_reports` or
   `fnf_market_snapshots` during the swap window.

## 3. Deployment procedure

Manual, over SSH. The CI deploy job remains `if: false` and is not the mechanism.

```bash
# 1. Record the current state (evidence before change)
sha256sum ~/cpp-trading-agent/bin/cpp-trading-agent
pm2 describe cpp-trading-agent | grep -E 'script path|exec cwd|restarts'

# 2. Back up the running binary with a dated name
cp ~/cpp-trading-agent/bin/cpp-trading-agent \
   ~/cpp-trading-agent/bin/cpp-trading-agent.bak-$(date +%Y%m%d-%H%M)

# 3. Copy the new binary (scp from the local build)
scp build/cpp-trading-agent ubuntu@<vm>:~/cpp-trading-agent/bin/cpp-trading-agent.new

# 4. Verify the transfer before it becomes live
sha256sum ~/cpp-trading-agent/bin/cpp-trading-agent.new   # must match the local sha256

# 5. Swap atomically, then restart
mv ~/cpp-trading-agent/bin/cpp-trading-agent.new ~/cpp-trading-agent/bin/cpp-trading-agent
pm2 restart cpp-trading-agent

# 6. Verify, do not assume
pm2 list | grep cpp-trading-agent          # expect online, restarts +1
tail -50 ~/.pm2/logs/cpp-trading-agent-out.log
```

## 4. Post-deployment validation

Run in this order; stop at the first failure and roll back.

1. **Startup.** The process is `online`, the log shows the MySQL pool initialised and the session
   time zone applied, and no repeated restart loop (`↺` count stable over two minutes).
2. **Session identity.** The engine logs `phase=CLOSED` (or the correct phase for the time), a
   valid trading day, and IST times. **This is the single highest-value check**: a wrong session
   zone is silent otherwise.
3. **Feed.** Ticks increment. `FeedGuard` present if the feed is down. Compare the tick count
   against the pre-deployment trend rather than accepting any non-zero value.
4. **Risk gate.** Confirm the engine reports a *known* daily-loss reading. If it reports UNKNOWN,
   the engine will (correctly) refuse to open positions — that is the new fail-closed behaviour
   working, not a fault, but it must be understood before the next session opens.
5. **Ceiling.** `SELECT ceiling FROM cpp_portfolios WHERE id='cpp-portfolio-v1';` must still be
   `100000.00`. If settlement ran, this is the check that the ceiling fix held in production.
6. **Archival.** Immediately after the first archival pass, compare
   `SELECT COUNT(*) FROM fnf_market_snapshots_history` before and after, and confirm the log's
   "Archived N, removed M" line has `N == M`. An `N < M` line means a row was removed without
   reaching history — stop and investigate before the next run.
7. **Reporting.** The dashboard and daily email render IST and mark any unpriced position as
   PARTIAL rather than showing a fabricated zero.

## 5. Rollback

Trigger any of these findings and roll back immediately:

- The engine does not reach a stable `online` state within 5 minutes.
- Session phase or timestamps are not IST.
- The ceiling is not `100000.00`.
- An archival pass reports `copied < removed`.

```bash
# Stop, restore the backed-up binary, restart
pm2 stop cpp-trading-agent
cp ~/cpp-trading-agent/bin/cpp-trading-agent.bak-<stamp> ~/cpp-trading-agent/bin/cpp-trading-agent
pm2 restart cpp-trading-agent
# then re-run validation steps 1-3 against the restored binary
```

**Rollback is a binary swap, not a database change. No migration is involved** — the change set
alters what the code writes and reads, not the schema. This is deliberate and worth preserving:
any future change that needs a migration makes rollback materially harder and should be planned
separately.

### Data written by the new version, read by the old

Two cases, both benign if the old binary comes back:

- `closedAt` is now written with `UTC_TIMESTAMP()` instead of `NOW()`. Under the VM's current UTC
  session these are the same value, so rows written by either version mean the same thing.
- New statuses are not introduced. `ARCHIVED_STALE_SOURCED` already exists from the item-30
  correction; the old binary ignores it (`WHERE status='OPEN'` and `='CLOSED'` both exclude it),
  which is exactly the behaviour we want.

## 6. What this plan does not cover

- **No staging environment.** Validation is post-deployment on the live VM, with rollback as the
  mitigation. A shadow/replay validation would be better and does not exist.
- **The VM's tick capture is not paused** during the swap. A few seconds of feed downtime is
  expected; the engine's guards should absorb it, but it is an accepted risk rather than a designed
  handover.
- **The IST change is all-or-nothing.** There is no flag to run the old time semantics, because a
  half-applied time zone is worse than either. Rollback is the only lever.

## 7. Open items that should be settled before deployment

1. The visitor concurrency race (§ findings, item 2) is a real defect _and_ it is in the analytics
   subsystem, not the trading path. Decide whether to fix it before deploying or accept it.
2. `UNKNOWN` expiry now refuses contracts whose symbols cannot be parsed. Confirm that no live
   instrument the desk trades has an unparseable symbol, or the engine will silently evaluate
   fewer contracts than before.
3. Decide whether the CI deployment job should be repaired and used, or formally retired. As it
   stands it is disabled and misconfigured; leaving it in that state is honest but temporary.
