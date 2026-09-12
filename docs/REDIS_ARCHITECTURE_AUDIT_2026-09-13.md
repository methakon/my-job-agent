# Redis architecture audit — is Redis actually required? (READ-ONLY, 2026-09-13)

**Scope:** determine whether Redis is an authoritative requirement, whether it is implemented, and whether
it must be implemented. **Nothing was installed, configured or changed:** no Redis client/server, no `.env`,
no trading code, no schema, no roadmap status. Rows 877/878 were not touched.

**Method:** repository-wide search (word-boundary, `node_modules`/`dist` excluded), control-plane queries
(`project_checklist_items`, `agent_todo_log`), runtime inspection (processes, binaries, env), code tracing of
the production tick path, and independent re-measurement of the DB round trip and server counters.

**Verdict: B — Redis is NOT currently required, and cannot be safely implemented from the existing
specification in this session. Do not implement it.** See §8.

---

## 1. Authoritative requirement — findings

| Source | Redis? | What it actually says |
|---|---|---|
| `project_checklist_items` (roadmap/control plane, 227 rows) | **No row** | `SELECT … WHERE item/instr/note REGEXP 'redis|fanout|hot.?path|offload'` → **0 rows** |
| `agent_todo_log` (agent queue, 68 rows) | **No row** | same match → **0 rows** |
| `src/project-status/checklist-v4.seed.json` | **No row** | grep `redis|fanout|hot.?path|offload` → **none** |
| `AGENTS.md` | **No mention** | — |
| `docs/REDIS_HOT_PATH_OFFLOAD.md` | Design doc | Header: *"analysis only. Nothing installed … This document is the input to an approval decision."* §8 operator approvals; **§8.1: "no trading-roadmap row of its own … flagged as roadmap coverage missing — awaiting a decision"** |
| `PROJECT_PROMPT.md` (Progress 2026-09-12 12:05, L408–445) | Notes | *"Redis is NOT installed yet"*, *"Remaining order (approved): Redis implementation → Monday shadow calibration → evidence"*, *"Roadmap coverage missing (flagged, awaiting operator)"* |

**Conclusion:** Redis is **not required by any authoritative roadmap or gate item.** It is an
**operator-approved-in-principle design** recorded in a read-only analysis document, with **no roadmap row**,
whose own §8.1 states the coverage gap is unresolved. The nearest rows (109/356/388) are latency *modelling*,
not the persistence path.

## 2. Implementation state — findings

| Question | Answer | Evidence |
|---|---|---|
| Redis client installed? | **No** | `package.json` dependencies+devDependencies matching `redis|bull|ioredis` → **NONE** |
| Redis imported anywhere? | **No** | `src/**` for `from 'redis'|'ioredis'|'bullmq'` → **NONE** |
| Redis server running? | **No** | `ps aux | grep redis-server` → **no process** |
| Redis binaries present? | **No** | `command -v redis-server` / `redis-cli` → **not found** |
| Redis configured in `.env`? | **No** | `grep -iE '^\s*REDIS' .env` → **0 keys** |
| Used by any production process? | **No** | — (nothing to use) |
| Connection health check? | **N/A** | none exists |
| Producer / consumer? | **No** | — |
| Retry / backpressure? | **N/A** | none exists |
| Persistence / failure recovery? | **N/A** | none exists |
| Does any desk consume Redis? | **No** | desks read the in-process `latestQuotes`/`latestSnapshots` cache and the canonical MySQL store |

**What *does* exist (the only delivered pieces of this workstream):**
- `src/trading/unified-market-data/canonical-row-id.ts` — deterministic canonical id (uuidv5), **wired** into
  both canonical writers (`unified-market-data.service.ts` L197, L265). This was the §8.1 prerequisite. Test
  `npm run test:canonical-row-id` → **37/37**.
- `src/trading/unified-market-data/tick-fanout.ts` — the in-process bounded ring + non-blocking hand-off.
  Header states: **"NOT WIRED INTO PRODUCTION. Research/shadow only: no production module imports it."**
  Confirmed: the only reference to `tick-fanout` outside itself is `scripts/tick-fanout.test.js`. It needs **no
  Redis** — its sink is an injected `(batch) => Promise<void>`.

> **The takeover finding is confirmed: `tick-fanout.ts` exists but is not wired, and the unified store
> currently does one awaited DB `.save()` per tick.**

## 3. Production path trace

```
FYERS socket (fno-market-data.service.ts recordTicks)          Upstox REST chain loop (upstox-live-paper-market.service.ts)
        │                                                              │
        ├─ void optionChain.ingestQuote(...)   (fire-and-forget)      ├─ await persistOptionQuote(tick)      → await save()  L741
        └─ void trading.ingestSnapshots(...)   (fire-and-forget,      ├─ await persistMarketSnapshot(...)    → await save()  L746
                                                throttled by           ├─ await publishSharedSnapshot(...)   → await interpreter.ingestMessage L494
                                                persistEveryMs=1000)   └─ void interpreter.ingestMessage(...) (chain legs, fire-and-forget L673)

canonical interpreter (tick-interpreter.service.ts, MANDATORY):
  interpret() → validation (+ reject counted, never routed)  →  persist()  →  unified.ingestQuote / ingestSnapshot
                                                                              │
                                                          deterministic id (canonicalRowId)
                                                          in-memory latestQuotes/latestSnapshots.set()  ← BEFORE the write (L235/L289)
                                                          isRepeatedIngest() skip
                                                          await this.quotes.save(row) / await this.snapshots.save(row)   (L240 / L292)
                                                          catch → WARN + return the row (cache-first; no fabricated data)
```

- The **canonical store stays authoritative**: desks read `unified.sharedQuote(...)` / `latestQuote(...)`
  (in-process cache first, MySQL fallback) and use `staleQuoteMaxAgeMs` / `isStale()` for staleness.
- The interpreter is **mandatory** and is the only producer; provider-native payloads cannot reach a consumer
  (row 878). No AI in the path.
- A **DB write is awaited inside the ingestion path** for the Upstox REST loop and the canonical mirror
  (L446/451/461 → L494/L741/L746); the FNF socket handler uses `void` (not awaited). Persistence latency
  therefore *is* in the ingestion path, and delayed ingestion degrades cache freshness for later ticks.

## 4. Bottleneck measurements (independently re-measured 2026-09-13, market closed)

| Probe | Result | Note |
|---|---|---|
| **Warm pooled `SELECT 1`** (30 samples, one mysql2 connection) | **p50 331.8 ms, p95 396.4 ms** | reproduces the prior doc's 287 ms; now slower |
| Warm `SELECT 50 rows` | **332.5 ms** | ≈ `SELECT 1` ⇒ **cost is the WAN round trip, not execution** |
| `Max_used_connections` | **66** | identical to the prior measurement — pool ceiling, not server capacity |
| `Aborted_clients` / `Aborted_connects` | **22,071 / 9,464** | grew from 19,306 / 8,984; consistent with the `FEED_DB_TIMEOUT_MS=8000` watchdog aborting slow writes |
| `Com_insert` / `Com_select` | **6,727,886 / 13,527,817** | selects ≈ **2.0×** inserts |
| `Innodb_data_fsyncs` / `Innodb_os_log_fsyncs` | 8,049,368 / 6,561,029 | every commit = fsync (`flush_log_at_trx_commit=1`, `sync_binlog=1`) |
| `Slow_queries` / `Innodb_row_lock_waits` / `Uptime` | 196 / 857 / 815,910 s | low contention |
| `fnf_option_quotes_history` | 3,093,184 rows / **2,214.8 MB** | archived |
| `unified_option_quotes` | 1,951,742 rows / **1,051.9 MB** | **not archived** — grows unbounded (separate finding) |
| `upstox_live_paper_option_quotes` | 377,103 rows / 245.1 MB | — |

**Reading:** ~107–236 single-row transactions/s (prior session, [measured]) × **~332 ms RTT** ⇒ **35–78
writes in flight**, absorbed by fanning across ~66 pooled connections → `Max_used_connections = 66` pins the
peak. **The bottleneck is round trips, not storage capacity or server execution.** The fix is fewer round
trips (batching + non-blocking hand-off), which **does not require Redis**.

## 5. The correct Redis role (only if ever required)

Redis may be a **transport / hot-path buffer / fanout side channel only**, never a source of truth. If
implemented, these must hold (mostly already pinned in `docs/REDIS_HOT_PATH_OFFLOAD.md` §3):

canonical interpreter mandatory producer · no AI in the tick path · one canonical identity per economic tick ·
no competing price truth · Redis never bypasses canonical validation · broker payloads never reach desks ·
durable DB remains auditable · Redis loss never fabricates market data · stale/out-of-order/invalid ticks
still rejected · provenance / broker id / payload hash / timestamp semantics intact · trading-critical state
(orders, fills, positions, capital, risk, audit) **stays direct synchronous MySQL**.

## 6. Failure semantics — what the existing spec covers vs what is missing

**Covered by the design doc (§4.3, §4.5):** bounded backlog (soft 1,500 / hard 5,000 per stream),
`maxmemory 256 MB` + `noeviction` (writes fail loudly), single-flight batch, `XAUTOCLAIM` of entries idle
> 30 s, XACK only after INSERT commits, retry with capped backoff → `DEGRADED` after 60 s, session-start
drain, bounded shutdown drain with reported remainder, AOF `everysec`, deterministic id for
at-least-once dedupe, no `MAXLEN` trim.

**Missing / undecided (blockers):**
- **Redis unavailable at startup** — the spec assumes Redis exists; there is no "Redis down at boot" policy
  (the tick path must still decide; which is exactly what `tick-fanout`'s injected sink already gives Redis-free).
- **No producer/consumer code exists at all**, so lag/duplicate/out-of-order/reconnect behaviour is unproven.
- Cross-process authorization ("Redis outage while DB healthy" / "DB outage while Redis healthy") is described
  only at the policy level; nothing is implemented or tested.

## 7. Does Redis solve a demonstrated problem?

Partially, and not uniquely. The measured problem is **round-trip-bound persistence**. The **non-blocking
hand-off + batched write** solves it *without* Redis (the isolation boundary is already built and proven:
`scripts/tick-fanout.test.js` **44/44**, decision p99 < 1 ms under a hung sink, with the computed separation
factor from the doc's run). Redis Streams would add only **cross-process / cross-restart durability of the
in-flight buffer and multi-consumer fanout for re-derivable market data** — a resilience nicety, not a fix
for the demonstrated bottleneck. It would also add a new operational dependency whose failure semantics are
not yet tested.

## 8. Determination

**B — Redis is not currently required, and cannot be safely implemented from the existing specification in
this session.**

Precise blockers:
1. **No authoritative roadmap row** — `0` rows in both control-plane tables and none in the seed. Per the
   control plane's rule, rows are operator-created only; `docs/REDIS_HOT_PATH_OFFLOAD.md` §8.1 itself flags
   this as *roadmap coverage missing*.
2. **Batch parameters require a live session** — §4.1/§4.2/§6 state `BATCH_ROWS` / `MAX_AGE_MS` are *confirmed
   from measurement, not from the document*, and the Friday-close → Monday series is not available now
   (market closed; the calibration is explicitly "Monday").
3. **Explicit operator hold** — this audit was requested with *"Do not install/configure Redis yet. Do not
   modify trading behavior yet."* Installing/connecting Redis would violate that.
4. **Not required for the measured fix** — the round-trip bottleneck is addressable Redis-free, and nothing
   currently *requires* cross-restart stream durability for re-derivable market data.

## 9. Tests run (baseline; nothing changed)

| Suite | Result |
|---|---|
| `scripts/tick-fanout.test.js` | **44 passed, 0 failed** |
| `scripts/canonical-row-id.test.js` | **37 passed, 0 failed** |
| `scripts/canonical-tick-interpreter.test.js` | **11 passed, 0 failed** |
| `scripts/feed-arbitration.test.js` | passed |
| `scripts/feed-health-gate.test.js` | passed |
| `scripts/unified-market-data.test.js` | passed |
| `scripts/market-feed-guard.test.js` | passed |
| `scripts/upstox-isolation.test.js` | **not run to completion** — live API integration (`fetch failed`) |
| `scripts/gate0-regression.test.js` | **not run to completion** — live API integration (`portfolios list`), timed out |

The last two are live HTTP integration suites against the running desk API, unrelated to this audit's code
paths; neither was modified here. Reported, not silently ignored.

## 10. Recommendation (operator decision required)

1. **Do not install Redis now.**
2. **Create a dedicated roadmap row** for the hot-path persistence offload (rows are operator-created). Until
   then it remains `roadmap coverage missing`.
3. If/when pursued, do the **Redis-free step first**: wire `tick-fanout`'s injected sink to a **batched INSERT**
   using the already-delivered deterministic id (`rowid-v1`) — this fixes the measured round-trip bottleneck
   with no new infrastructure and no second source of truth.
4. Add Redis only if a **concrete, tested requirement for cross-process/restart durability** is demonstrated;
   it must remain a transport side channel, never a truth store.

## 11. Explicit non-actions taken

No Redis package/binary/server/env; no trading, risk, execution, capital or threshold change; no schema or
migration; no change to the canonical interpreter, desks, or `docs/REDIS_HOT_PATH_OFFLOAD.md`; rows 877/878
untouched; no roadmap row created or status changed by this audit.
