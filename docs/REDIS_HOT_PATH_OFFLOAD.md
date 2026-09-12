# Redis hot-path offload — architecture & workload analysis (READ-ONLY, not implemented)

**Status:** analysis only. Nothing installed, no MySQL/schema change, no trading code touched, no
Redis deployed. This document is the input to an approval decision.

**Author/session:** 2026-09-12, trading-roadmap session (Saturday, market closed).
**Measurement window:** last four sessions (2026-09-08 … 2026-09-11) + live idle sampling 2026-09-12.
**Measurement scripts (read-only, kept OUT of the repo):** `~/redis_measure_1.js` … `~/redis_measure_4.js`.

Every number below is either **[measured]** (query/counter/log output from this session) or
**[derived]** (arithmetic on measured values) or **[modelled]** (stated assumption, to be confirmed
in a live session). Nothing here is a guess presented as a measurement.

---

## 1. What the workload actually is (measured)

### 1.1 Hot write paths — one transaction per tick

| Path | Code | Table | Rows/session (avg) | Peak rows/s |
|---|---|---|---|---|
| FNF desk option quotes | `fnf-option-chain.service.ts:198` `quotes.save(create(quote))` | `fnf_option_quotes` → `_history` | 764k–1.16M (34–52/s) | **127.8** |
| Canonical option quotes | `unified-market-data.service.ts:229` `quotes.save(row)` | `unified_option_quotes` | 986k–988k (44/s) | **88.7** |
| Canonical index snapshots | `unified-market-data.service.ts:273` `snapshots.save(row)` | `unified_market_snapshots` | 42k–47k (1.9–2.1/s) | 5.0 |
| Upstox paper quotes | `upstox-live-paper-market.service.ts:741` `optionQuotes.save(entity)` | `upstox_live_paper_option_quotes` | 163k–226k (7–10/s) | 10.5 |
| Upstox paper snapshots | `upstox-live-paper-market.service.ts:746` `marketSnapshots.save(entity)` | `upstox_live_paper_market_snapshots` | 3.6k–4.2k (0.2/s) | 0.3 |
| FNF index snapshots | `fnf-trading.service.ts:719` (batched rows) | `fnf_market_snapshots` → `_history` | 28k–46k (1.3–2.0/s) | 3.8 |
| FNF tick archival (bulk) | `fnf-trading.service.ts:1544` `INSERT..SELECT` + `DELETE` | `*_history` | nightly/bulk | n/a |

- **Combined tick-write peak: ≈236 rows/s** (sum of the peak column). **Session average ≈107 rows/s.**
  [derived from measured per-minute counts]
- `Com_insert 6,723,220` vs `Innodb_rows_inserted 12,067,597` → **1.8 rows per INSERT statement**
  [measured] ⇒ the three `.save()` paths dominate and each row is its own statement/commit.
- Per-tick saves on the desk paths are **awaited** (`await this.quotes.save(...)`), so the provider
  socket handling inherits the DB round-trip latency (see §2).
- Batch/archive paths already exist and are set-based (`fnf-trading.service.ts:1544`), so the tick
  archival is *not* the overload; the per-tick inserts are.

### 1.2 Row sizes & table growth (measured)

| Table | Rows | Data+Idx | Avg row |
|---|---|---|---|
| `fnf_option_quotes_history` | 3,093,184 | 2,214.8 MB | 457 B |
| `unified_option_quotes` | 1,951,742 (2,066,408 now) | 1,051.9 MB | 356 B |
| `upstox_live_paper_option_quotes` | 377,103 | 245.1 MB | 380 B |
| `fnf_market_snapshots_history` | 212,885 | 79.4 MB | 289 B |
| `unified_market_snapshots` | 86,683 | 32.2 MB | 297 B |
| `upstox_live_paper_market_snapshots` | 8,443 | 2.4 MB | 188 B |

One session ≈ 1.8 M quote rows ≈ **650–700 MB/session** of durable market-data growth.

### 1.3 The latency that explains everything (measured, live)

| Probe (200 samples, 50 for the second) | p50 | p95 | p99 | max |
|---|---|---|---|---|
| `SELECT 1` over the tunnel | **287 ms** | 484 ms | 550 ms | 583 ms |
| `SELECT … LIMIT 50` (same link) | 292 ms | 368 ms | — | 437 ms |

A 50-row read costs the same as `SELECT 1` ⇒ **the cost is the WAN round trip, not server execution**.
The app talks to Oracle Cloud MySQL through the SSH tunnel (`127.0.0.1:3307` → VM → `10.0.0.99`).

### 1.4 Consequence: the pipeline is round-trip-bound and sitting at its pool ceiling

[derived] concurrency needed = rows/s × RTT = 236 × 0.287 s ≈ **68 connection-writes in flight at peak**.

| Counter (measured) | Value | Reading |
|---|---|---|
| `Max_used_connections` | **66** | matches the derived 68 almost exactly — the peak is pinned to the pool, not to the server |
| `Threads_connected` (Sat idle) | 20–22 | our own 16 visible; 9 held open ~20,653 s |
| `Aborted_clients` / `Aborted_connects` | **19,306 / 8,984** | +6,387 aborted clients **today alone** while the market was closed |
| `Slow_queries` | 196 | server-side slow statements |
| `Innodb_row_lock_waits` | 857 | contention, low but non-zero |
| `innodb_flush_log_at_trx_commit` / `sync_binlog` | **1 / 1** | every tick commit = 2 fsyncs |
| `innodb_buffer_pool_size` | 4 GB | server-side, not the bottleneck |
| App RSS / trading-agent RSS | 288 MB / 92 MB | host: 7,761 MB total, 3,096 MB available |
| Idle baselines (Sat) | data fsyncs 2.5/s, log fsyncs 1.0/s, `Com_insert` 0.2/s | the method for a live-session measurement |
| `FEED_DB_TIMEOUT_MS` | 8000 | a per-write watchdog that aborts a slow write — the aborted-client source |

**Root cause:** ~107–236 single-row transactions per second, each paying a ~300 ms WAN round trip,
plus per-statement fsyncs, are absorbed by fanning out across ~66 pooled connections. Any write that
exceeds the 8 s watchdog is aborted mid-flight (`Aborted_clients` +6,387/day), which is exactly the
class of failure behind the previously observed tick drops / heartbeat freezes. **The fix is not more
server capacity — it is fewer round trips.**

---

## 2. What may and may not move behind Redis

| Path | Verdict | Why |
|---|---|---|
| Option-quote ticks (FNF, canonical, Upstox paper) | **MOVE** (buffer+batch) | high-frequency, re-derivable from the provider stream, not trading-critical state |
| Index-snapshot ticks (all three writers) | **MOVE** (buffer+batch) | same |
| Hot reads for decision support (latest quote / chain) | **MOVE to a Redis read cache** | today each is a ~300 ms WAN read; a cache is legitimate for market data **with a staleness gate** |
| Orders (`upstox_live_paper_orders`), fills/trades, positions, portfolios, capital | **STAY direct, synchronous MySQL** | trading-critical, must be durable before acting; Redis never authoritative |
| Risk sessions, `pnl_events`, `fnf_decision_journal`, trade reports/reflections, calibrations | **STAY** | audit/risk state |
| `market_data_feed_leases` | **STAY** (already throttled) | ownership/control-plane state; 30 s cadence, upsert |
| FNF tick archival (`INSERT..SELECT`+`DELETE`) | **STAY** | set-based bulk, not per-tick; runs outside the hot path |
| Pre-open capture / `pre_open_observations` | **STAY** | low-volume, audit-facing, row is evidence |
| Pattern-engine / label writes | **STAY** | fail-closed label integrity is an existing gate (row 159) |
| `Com_select` load (13.3 M over uptime, ~2× inserts) | **REDUCE via cache, not move** | status/metrics queries count rows over windows; they should read Redis aggregates, not MySQL |

---

## 3. Target architecture

**Correction (2026-09-12, operator clarification — this section was wrong before):** an earlier
version of this diagram had the trading desks reading prices from a Redis-backed cache. That made the
decision path depend on Redis consumer-group progress. **Redis must never sit in the trading hot
path at all.** The hot path stays in-process and synchronous:

```
  FYERS socket ─┐
                ├→ canonical interpreter → validation → TRADING ENGINE → signal → risk → execution
  Upstox REST ──┘   (mandatory, unchanged)        │            (in-process, no Redis, no MySQL wait)
                                                  │
                                     non-blocking hand-off (enqueue only, never await)
                                                  ↓
                                   bounded in-process persistence queue
                                                  ↓
                             Redis Streams (side channel)  →  batched MySQL persistence

  trading-critical writes (orders, fills, positions, capital, risk, audit):
        desks ───────────────────────────────────────────────→ MySQL (direct, synchronous, unchanged)
```

**The one rule that makes this safe:** the tick is handed to the engine *first and synchronously*, and
only *enqueued* (an O(1) array append) for persistence. Nothing on the decision path awaits Redis, a
batch flush, or a MySQL write. If persistence is blocked, slow, or dead, the engine keeps deciding and
exits/stops keep firing; only the *persistence* copy degrades (bounded, counted drops) — never a
decision. This is the opposite of the current code, where `await this.quotes.save(row)` in
`fnf-option-chain.service.ts:198` / `unified-market-data.service.ts:229` puts a measured ~287 ms WAN
write inside the tick path.

Entry **and especially EXIT/stop-loss** decisions therefore cannot be delayed by persistence: the
stop-loss path reads the in-process latest-tick state (today's `latestQuotes` map pattern) and acts
immediately. Redis read models are allowed **for observability only** (dashboards, status endpoints),
never as an input to signal, risk or execution.

Streams (one per provider family × data class, so a stall in one cannot starve the other and
provenance stays explicit):

| Stream | Payload | Batch writer |
|---|---|---|
| `md:ticks:fyers` | canonical option ticks, `source='FYERS'` | `persist-fyers` |
| `md:ticks:upstox` | canonical option ticks, `source='UPSTOX'` | `persist-upstox` |
| `md:snaps:fyers` / `md:snaps:upstox` | canonical index snapshots | same writers |

Canonical entry fields (identity + provenance + timestamp semantics preserved):
`source`, `providerSymbol`, `exchange`, `instrumentKey`, `segment`, `expiry`, `strike`, `optionType`,
`ltp`,`bid`,`ask`,`bidQty`,`askQty`,`volume`,`oi`,`iv`,`greeks`, `depth` (json),
`sourceTimestamp` (**declared IST**), `receivedTimestamp` (IST), `ingestBasis` tag, `sequenceNumber`,
`dataQuality`, `payloadHash`, `canonicalVersion`, `dedupeKey`.

Rules this design enforces:

1. **Canonical interpreter stays mandatory** — the only producer is the canonical layer
   (`canonical-tick.ts` + `tick-interpreter.service.ts`, permanently ON, row 878). A provider-native
   payload cannot reach a stream; the producer type is the interpreter's output type.
2. **Redis is never authoritative** for orders/fills/positions/capital/risk/audit — none of those
   paths touch Redis in this design (they stay exactly as they are today).
3. **Trading-critical state stays durably persisted** — unchanged synchronous MySQL writes; the Redis
   path only carries re-derivable market data.
4. **Consumer groups + explicit XACK after MySQL commit** — persistence resumes after transient
   failure via `XAUTOCLAIM` of entries idle > 30 s.
5. **No AI anywhere in the hot path** — deterministic validation + typed interpreter only.
6. **Fail closed**: if the durable pipeline cannot guarantee required trading state (MySQL down, or
   market data older than the staleness bound), the desks refuse to act rather than acting on a cache.
   The existing `isStale()` / `staleQuoteMaxAgeMs` gate in `upstox-live-paper-market.service.ts` is
   the natural hook; it must become mandatory for any Redis-served price.

---

## 4. Bounded dual-trigger batch policy (design, to be calibrated live)

### 4.1 Measured inputs to the policy

- flush cost ≈ **round trip p50 287 ms** + server insert (unmeasured — the server-side component must
  be measured Monday; only the floor is known).
- arrival rate: avg 107 rows/s, peak 236 rows/s [measured].
- per-row payload: 356–457 B in MySQL; ~300 B packed as stream fields [measured/modelled].
- current statement cost: 1 statement/tick ⇒ 236 statements/s at peak, each with 2 fsyncs.

### 4.2 The trigger

**Flush when `rows >= BATCH_ROWS` OR `age >= MAX_AGE_MS`, whichever first** — one writer per stream,
**one flush in flight at a time** (serialized), so batches cannot pile up.

Proposed starting point (to be confirmed Monday with §6):
**BATCH_ROWS = 100, MAX_AGE_MS = 250 ms.**

Justification (from measurements, not preference):
- 250 ms is inside the 250–1000 ms candidate window but at the low end, because the metric that
  matters is *oldest unpersisted tick age*, and the statement-count saving is already ~99% there:
  at peak 236 ticks/s a 250 ms trigger flushes ~59 rows → with a 100-row cap the cap governs only in
  bursts; statements/s ≈ 4/stream at peak vs **236 single-row statements/s today = 98.3% fewer**.
- "smallest stable batch that substantially reduces transactions": 100 rows is a 100× reduction per
  statement; going to 500 would cut statements a further 5× while multiplying the retry blast radius
  and the oldest-tick bound by 5 — the operator's stated preference therefore selects ~100, not 500.
- oldest-tick bound [derived]: `MAX_AGE_MS + flush p50` ≈ 0.25 + 0.30 = **0.55 s p50**, ≈ 0.80 s at
  flush-p99 — bounded and independent of volume because the age trigger always fires.

Per-table calibration is expected (a snapshot row is 188–297 B, a quote row 356–457 B), so
`BATCH_ROWS` is per-stream configuration with one documented ceiling, not one global magic number.

### 4.3 Bounds, backpressure, no unbounded queue

| Bound | Value | Behaviour when hit |
|---|---|---|
| `BATCH_ROWS` ceiling (hard) | 250 rows | batch is flushed at the ceiling; never grows past it |
| `MAX_AGE_MS` | 250 ms (hard ceiling 1000 ms) | guarantees a batch is never pending indefinitely at low volume |
| Unacked backlog (soft) | 1,500 entries/stream (≈6 s at peak) | **bounded backpressure**: pause admission for that stream, WARN + metric, keep consuming; no batch growth |
| Unacked backlog (hard) | 5,000 entries/stream (≈21 s) | producer refuses further ticks for that stream only, increments `dropped/rejected`, logs loudly |
| Redis memory | `maxmemory 256 MB`, `maxmemory-policy noeviction` | writes fail loudly instead of silently evicting; the ceiling above means this should never be reached |
| MySQL slowness | flush p95 > 400 ms for 3 cycles | halve `BATCH_ROWS` (floor 25); never grow the batch under pressure |
| MySQL unavailability | write error | retry with capped exponential backoff (1 s → 10 s, jitter), keep entries **unacked** so `XAUTOCLAIM` can recover them; after 60 s mark the stream `DEGRADED` and let backpressure/drop policy apply |
| Recovery | — | `XAUTOCLAIM` entries idle > 30 s; a batch is acknowledged **only after the INSERT commits** |

### 4.4 Idempotency — the blocker this measurement exposed

[measured] The hot tables have **only a random-uuid `@PrimaryGeneratedColumn('uuid')`** — no unique
business key. And the *natural* key is not unique either:

| Table | Window | Rows | Distinct key | Duplicate pairs |
|---|---|---|---|---|
| `fnf_option_quotes_history` | 09-11 15:20–15:26 (peak) | 29,715 | 10,406 `(contractSymbol, ts)` | **19,309 (65%)** |
| `unified_option_quotes` | 09-10 13:35–13:45 | 28,579 | 18,672 `(instrumentKey, ts)` | **9,907 (35%)** |
| `upstox_live_paper_option_quotes` | 09-11 15:00–15:10 | 4,158 | 4,032 | 126 |
| `unified_market_snapshots` | 09-10 14:30–14:40 | 1,430 | 1,419 | 11 |
| `fnf_market_snapshots_history` | 09-09 full session | 45,020 | 44,890 | 130 |

⇒ `(symbol, ts)` **cannot** be used as a unique key, and today a replayed batch would silently
duplicate rows (at-least-once with no dedupe).

**Required before the batcher is enabled:** a **deterministic canonical id**. The canonical
interpreter already derives a payload hash and the writer already skips repeated ingests
(`isRepeatedIngest`); use the same identity to compute `id = uuidv5(namespace, canonicalIdentity)`
and write with `INSERT … ON DUPLICATE KEY UPDATE` (or `INSERT IGNORE`) against the **existing
PRIMARY KEY**. Benefits: replay-safe, no DDL, no duplicate historical rows, and the dedupe key is
auditable. This is a small writer change and a **hard prerequisite** — without it, at-least-once
recovery cannot be guaranteed duplicate-free.

### 4.5 Lifecycle

- **Start of session:** drain any leftover backlog from the previous session *before* admitting live
  ticks (bounded, oldest-first).
- **Graceful shutdown:** stop admission → one final flush per stream → `XACK` → report unpersisted
  count/ids; bounded drain timeout (10 s) and anything still queued is reported, not silently lost
  (it stays in the stream, and AOF keeps it across a Redis restart).
- **Market close (15:30):** controlled drain — admission stops with the feed, then the backlog is
  drained in **adaptive** batches at a rate that keeps flush p95 < 400 ms, with a hard deadline
  (e.g. 15:45). Whatever remains is *not* dumped in one statement: it stays queued and is drained at
  the next session start. No "blind dump at close".
- **Metrics** (the list the operator asked for, emitted per stream): batch rows, achieved flush
  interval, rows/s, MySQL statements/s (target < 5 vs 236 today), flush latency p50/p95/p99, Redis
  backlog (XLEN), **oldest unpersisted tick age**, retry count, dropped/rejected count,
  `XAUTOCLAIM` count, AOF rewrite count, and the applied `BATCH_ROWS`.

---

## 5. Minimum Redis capacity

[basis: measured payload sizes, chosen ceilings]

| Item | Math | Result |
|---|---|---|
| Stream entry | ~300 B payload + ~100 B stream overhead | ~400 B/entry |
| Backlog at the hard ceiling | 4 streams × 5,000 entries × 400 B | ~8 MB |
| PEL / consumer-group overhead | ~1–2× entry size worst case | ~16 MB |
| Read cache (latest quote per contract, ~5,000 contracts) | 5,000 × 300 B | ~1.5 MB |
| Index/metadata/misc | — | < 2 MB |
| **Working set** | — | **< 40 MB busy** |

- **Recommended `maxmemory 256 MB`** (≈6× the busy working set; ~8% of the host's 3,096 MB available,
  which also holds 288 MB app + 92 MB trading-agent).
- `maxmemory-policy noeviction` (never silently evict market data or stream state),
  `appendonly yes` with `appendfsync everysec` (≤1 s of re-derivable market data at risk on a crash;
  never used for trading-critical state), AOF rewrite bounded,
  bind to loopback + unix socket only, authentication on, and **no persistence of anything
  trading-critical**.
- No `MAXLEN` trimming on the critical streams (trimming would discard unacked ticks): bounds come
  from the producer ceiling + backpressure. Entries are reclaimed after commit by `XACK` plus
  `XTRIM … MINID` using the **minimum `last-delivered-id` across all consumer groups**, i.e. trim
  only what every consumer has acknowledged. A `MAXLEN ~ 200k` last-resort cap exists only as a
  runaway guard and must alarm loudly if it ever engages.
- Placement: same host as the writers (localhost latency, no extra WAN hop). No Redis cluster, no
  sentinel needed at this size; a single instance with AOF is sufficient and simpler to operate.

---

## 6. Live calibration procedure (Monday, the step that finalises the numbers)

Batch size and interval are **confirmed from measurement**, not from this document:

1. Before the session, capture the idle baselines (`redis_measure_2.js` §3 method) and record the
   pre-change counters (`Com_insert`, `Innodb_data_fsyncs`, `Innodb_os_log_fsyncs`, `Aborted_clients`).
2. Run the batcher in **shadow mode**: stream + batch writes enabled for one table only (the canonical
   quotes), the direct per-tick write still in place, both paths writing to the *same* table with the
   deterministic id (so shadow cannot duplicate).
3. Sample every 30 s: flush latency p50/p95/p99, batch rows, statements/s, XLEN, oldest unpersisted
   age, plus the server counters above.
4. Set `BATCH_ROWS` to the **smallest** value whose flush p95 stays < 400 ms and whose oldest-tick
   age stays < 1 s at the session's peak minute; verify `statements/s` dropped by ≥ 95%.
5. Only then move a desk's *read* path to the cache, with the staleness gate armed, and confirm the
   desks' decisions are unchanged (no execution/risk behavior change).
6. Rollback at any point = stop the batcher and re-enable the direct write (one flag); no schema or
   data migration is involved.

---

## 7. What this change explicitly does not touch

Execution, order sizing, risk gates, capital, thresholds, FYERS/Upstox arbitration, the canonical
interpreter's mandatory status, the feed lease ownership model, `.env` credentials, and every
trading-critical write path. No schema change is proposed here; the only DB-side recommendation
(deterministic id on the existing PK) requires no DDL.

## 8. Decisions (APPROVED by the operator, 2026-09-12)

1. **Deterministic canonical ID prerequisite — APPROVED, implemented first, no DDL.** Delivered in
   `src/trading/unified-market-data/canonical-row-id.ts`, wired into both canonical writers
   (`unified-market-data.service.ts` `ingestQuote` + `ingestSnapshot`). `rowid-v1` =
   uuidv5 of `source | instrumentKey | sourceTimestamp(ISO) | providerPayloadHash | economic-content
   hash` against the existing uuid primary key. The per-process `sequenceNumber` is deliberately NOT
   part of identity (it resets on restart); `receivedTimestamp` and row bookkeeping are excluded too.
   A weak identity returns `null` and the writer falls back to the generator rather than minting a
   guessable key. Tested: 37/37 (`npm run test:canonical-row-id`).
2. **Redis instance — APPROVED on the app host**: 256 MB `maxmemory`, `noeviction`, AOF `everysec`,
   local-only access, bounded streams/backlog. Never authoritative for orders, fills, positions,
   capital, risk or audit state.
3. **Monday shadow-mode calibration — APPROVED.** Do not switch trading reads immediately: measure
   peak-session behaviour and derive the smallest stable batch parameters from evidence (§6).
4. **Staleness contract — the EXISTING `staleQuoteMaxAgeMs`** (no competing threshold). Stale or
   unavailable cached prices must never make a trading decision.
5. **Isolation rule (CRITICAL).** Batching and MySQL persistence must never block the trading
   decision or execution path; a slow Redis/MySQL path must not delay a stop-loss or other exit.
   Proven — see §9.

**Implementation order (operator-directed):** deterministic ID → Redis implementation → shadow
calibration → evidence → only then consider a controlled read-path migration.

## 9. Isolation proof: a blocked/slow persistence writer cannot delay a decision

Implemented as a pure boundary plus a hostile-sink simulation (research/shadow only; nothing in
production imports it yet).

- Boundary: `src/trading/unified-market-data/tick-fanout.ts` — `ingest(tick, decide)` hands the tick
  to the engine FIRST, synchronously, then does an O(1) ring-buffer append for persistence. No
  `await`, no promise, no timer, no clock (the host injects the clock for a bounded drain), no I/O.
- Simulation: `scripts/tick-fanout.test.js` (`npm run test:tick-fanout`), 44/44.

| Scenario | Result |
|---|---|
| Persistence writer HUNG forever (10,000 ticks) | all 10,000 decisions taken, decision p99 < 1 ms, 10,000 ingested in < 100 ms, queue bounded at capacity, overflow counted as drops-for-persistence, sink never called on the hot path |
| Persistence writer SLOW at the measured MySQL p50 (287 ms/batch) | 1,000/1,000 decisions, decision p99 < 1 ms, no persistence ran during ingest, the drain (not the engine) paid 287 ms |
| Persistence writer THROWS every time | 300/300 decisions, failure counted, batch retained in order as retryable, no unhandled rejection |
| EXIT/stop-loss with a hung writer AND a full queue | the exit fired in < 1 ms and the position closed on the breaching tick; only the persistence copy of that tick was dropped |
| Bounded shutdown drain | persisted what fit the deadline, reported the remainder + timeout; a persistently failing sink stops the loop instead of spinning |

**Separated latency accounting (the operator's requirement, measured in one run):**

| Path | n | p50 | p95 | p99 |
|---|---|---|---|---|
| decision → execution (signal/risk/entry/exit) | 2,000 | **0.0006 ms** | 0.0039 ms | 0.0048 ms |
| persistence (per 100-row batch) | 5 | **287.7 ms** | 287.8 ms | — |

Separation factor ≈ **517,000×** — the two latencies are measured independently, so a slow or dead
persistence path is visible in the persistence column and provably absent from the decision column.

### 8.1 Open item

The Redis market-data-persistence offload workstream has **no trading-roadmap row of its own** (the
nearest rows, 109 / 356 / 388, are latency *modelling*, not the persistence path). Per the control
plane's rule, rows are operator-created: flagged as **roadmap coverage missing** — awaiting a
decision (create a dedicated row, or attach this workstream to the canonical row 878).
