# Timestamp Conventions — trading-agent database

Scope: the C++ trading agent's tables. Written for the item-30.5 / IST-standardization review
so that a future writer cannot silently mix meanings in one column.

## The rule

Trading-agent MySQL sessions run in **IST (+05:30)**, set per connection by
`MySQLConnectionPool::apply_session_time_zone()` from `MYSQL_SESSION_TIME_ZONE`. The shared
server's *global* time zone is never changed — this is connection-scoped by design, so other
workstreams on the same server keep their own behaviour.

The session zone changes three things at once, and the **column type** decides which applies:

| Column family | Stores | Server converts? | Read it as | Write it with |
|---|---|---|---|---|
| `TIMESTAMP` | a UTC instant | **yes** — to and from the session zone, both directions | already IST, no shift | `NOW()` — the server does the rest |
| `DATETIME` (UTC-valued) | a raw wall clock, **UTC by convention** | **no** | shift explicitly, `col + INTERVAL 330 MINUTE` | `UTC_TIMESTAMP()` — **never** `NOW()` |

The convention is the whole point of the DATETIME rule: the server does not know those columns
are UTC, so nothing but discipline keeps them that way.

## Which columns are which

### TIMESTAMP — converted by the server, no manual handling

| Table | Column |
|---|---|
| `cpp_trade_reports` | `orderedAt` |
| `cpp_portfolios` | `createdAt` |
| `cpp_portfolio_audit` | `created_at` |
| `cpp_strategy_config` | `updated_at` |
| `cpp_strategy_config_audit` | `created_at` |

### DATETIME — UTC-valued, must be handled explicitly

| Table | Column | Written by |
|---|---|---|
| `cpp_trade_reports` | `closedAt` | settlement, via `UTC_TIMESTAMP()` |
| `cpp_trade_reports` | `signal_timestamp` | upstream signal ingestion |
| `fnf_market_snapshots` | `ts`, `createdAt` | tick capture |
| `upstox_live_paper_option_quotes` | `ts`, `createdAt`, `providerTs` | quote capture |
| `cpp_historical_intraday_candles`, `cpp_historical_daily_candles` | `timestamp`, `ingested_at` | rollup / archival |

Historical rows were written while the server ran UTC, so they hold UTC wall clocks. The IST
standardization does not reinterpret them: they are read with the explicit shift, which is what
preserves their meaning.

## The two failure modes

1. **Do not shift a `TIMESTAMP`.** The server already converted it; adding 5h30 double-counts.
   `DATE(NOW() + INTERVAL 330 MINUTE)` was an instance of this — correct under a UTC session,
   wrong the moment the session became IST, and it rolled the day over from 18:30 IST onward.

2. **Do not write `NOW()` into a UTC-valued `DATETIME`.** Under an IST session `NOW()` returns
   IST, so the column ends up holding two different meanings and the read-side shift is wrong for
   exactly the new rows. This is why `closedAt = NOW()` became `closedAt = UTC_TIMESTAMP()`.

A third, related one: **do not apply `DATE()` to a time column in a predicate.** It is unsargable,
and on a UTC-valued DATETIME it silently buckets by UTC instead of IST. The rollup's `WHERE` had
exactly this after its subqueries were fixed, so the row set and the open/close lookups disagreed.

## Session-day boundaries

An IST calendar day *D* is the half-open UTC interval `[D − 330m, D − 330m + 1 day)`.

Prefer:

```sql
WHERE closedAt >= ('2026-10-15' - INTERVAL 330 MINUTE)
  AND closedAt <  ('2026-10-15' - INTERVAL 330 MINUTE + INTERVAL 1 DAY)
```

over `DATE(closedAt + INTERVAL 330 MINUTE) = '2026-10-15'`. Semantically identical; the range
leaves the column bare so an index can be used, and the boundary is evaluated once.

## Verification queries

```sql
-- which columns belong to which family
SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE
FROM information_schema.columns
WHERE TABLE_SCHEMA = DATABASE() AND DATA_TYPE IN ('timestamp','datetime')
ORDER BY TABLE_NAME, COLUMN_NAME;

-- confirm a DATETIME column really is UTC-valued: it should track a server-stamped sibling
SELECT AVG(ABS(TIMESTAMPDIFF(SECOND, ts, createdAt))) FROM fnf_market_snapshots;

-- rows whose session day differs between UTC and IST interpretations
SELECT COUNT(*) FROM fnf_market_snapshots
WHERE DATE(ts) <> DATE(ts + INTERVAL 330 MINUTE);

-- the session zone actually in force on this connection
SELECT @@session.time_zone;
```

## Known gap

The convention is **not enforced by the schema**. These columns carry no comment or metadata
marking them UTC, so a future writer using `NOW()` reintroduces the mixed-meaning defect and
nothing will reject it. Closing that properly needs a DDL change on the production tables
(column comments, or moving to `TIMESTAMP` where a UTC instant is what is meant) — a production
schema change, deliberately not made here. Until then the regression tests `IST-02`..`IST-10`,
`ARCH-01` and `REENTRY-*` are the guard, and this document is the reference for reviewers.

Also noted: `cpp_trade_reports.closedAt` has **no index** on production. The session queries are
now sargable, but they will not actually use an index until one exists. That is a schema change
and is therefore out of scope here.
