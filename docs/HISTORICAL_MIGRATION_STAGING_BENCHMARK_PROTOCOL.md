# Historical Market Data Migration: Staging Benchmark and Validation Protocol

## 1. Scope, Objectives, and Strict Boundaries

### 1.1 Objective
This document defines an empirical, executable verification protocol for the `HistoricalMarketDataMigrator` (`scripts/historical_market_data_migrator.py`) on an isolated staging database. It specifies procedures to validate schema compatibility, query plans, execution latencies, optimizer memory limits, and data preservation invariants prior to any production execution.

### 1.2 Strict Governance and Operational Boundaries
- **Isolated Staging Only**: All operational procedures described in this protocol apply exclusively to an authorized, isolated staging environment. Connecting to production databases, running SQL against production, or interacting with production hosts is strictly prohibited.
- **Independent Operational Gates**: Authorization to execute staging validation does NOT constitute authorization for Gate G-2 (Production Phase B DDL) or Gate G-3 (Production Phase C Migration). Operational gates G-1, G-1.1, G-2, and G-3 remain on **HOLD**.
- **C++ Trading Engine Protection**: The C++ trading service (`cpp-trading-agent`) consumes live paper feeds (`upstox_live_paper_option_quotes`) and does not read or write `unified_option_quotes_history`. The C++ binary, service units, and configuration must remain completely untouched during all tests.
- **Absolute Historical Data Preservation**: In staging, source tables are strictly read-only. Zero `DELETE`, `TRUNCATE`, `DROP`, or `REPLACE INTO` statements may be executed against target or source quote tables.

---

## 2. Schema Contract Reconciliation and Preflight Verification

### 2.1 Three-Way Schema Contract Comparison
Before executing tests, the staging schema must be reconciled against the documented baseline and migrator requirements:

| Schema Element | Committed Baseline (`ddl/create_history_tables.sql`) | Proposed Phase B DDL (`migrator.py:790-822`) | Actual Live Staging Schema | Preflight Action if Missing |
| :--- | :--- | :--- | :--- | :--- |
| `unified_option_quotes_history` | Table defined with 28 columns | Baseline + 9 extension columns | **UNKNOWN** (Must verify) | Preflight halts (`schema_ready_for_migration: false`) |
| `canonicalDedupHash` | ABSENT | `VARCHAR(64) NULL` | **UNKNOWN** (Must verify) | Preflight halts; INSERT triggers Error 1054 & rolls back |
| `uq_uoq_history_dedup_hash` | ABSENT | `UNIQUE KEY (canonicalDedupHash)` | **UNKNOWN** (Must verify) | Missing uniqueness constraint flagged |
| `idx_uoq_history_key_ts` | `KEY (instrumentKey, ts)` | `KEY (instrumentKey, ts)` | **UNKNOWN** (Must verify) | Query plan must verify presence |
| `migrationRunId` | ABSENT | `VARCHAR(64) NULL` | **UNKNOWN** (Must verify) | Preflight halts (`missing_extension_columns`) |
| `sourceOrigin` | ABSENT | `VARCHAR(32) NOT NULL DEFAULT 'UNIFIED_NATIVE'` | **UNKNOWN** (Must verify) | Preflight halts (`missing_extension_columns`) |
| `sourceRecordId` | ABSENT | `VARCHAR(64) NULL` | **UNKNOWN** (Must verify) | Preflight halts (`missing_extension_columns`) |
| `underlyingPrice` | ABSENT | `DECIMAL(14,4) NULL` | **UNKNOWN** (Must verify) | Preflight halts (`missing_extension_columns`) |
| `bidDepth`, `askDepth` | ABSENT | `INT NULL` | **UNKNOWN** (Must verify) | Preflight halts (`missing_extension_columns`) |
| `instrumentToken` | ABSENT | `VARCHAR(96) NULL` | **UNKNOWN** (Must verify) | Preflight halts (`missing_extension_columns`) |
| `payloadHash` | ABSENT | `VARCHAR(64) NULL` | **UNKNOWN** (Must verify) | Preflight halts (`missing_extension_columns`) |
| `cpp_historical_migration_checkpoints` | ABSENT | Checkpoint table with lease fields | **UNKNOWN** (Must verify) | Preflight halts (`checkpoint_table_exists: false`) |

### 2.2 Preflight Code Verification (`--validate`)
Inspection of `HistoricalMarketDataMigrator.validate_environment()` (`scripts/historical_market_data_migrator.py:561-630`) confirms that the CLI command:
```bash
python3 scripts/historical_market_data_migrator.py --validate --json-report staging_preflight_report.json
```
executes strictly read-only statements:
1. `SELECT VERSION() ...` (server version, timezone offsets)
2. `SELECT CAST(DATE(...) AS DATETIME) ...` (dynamic IST midnight watermark)
3. `SELECT COUNT(*) FROM {LIVE_BUFFERS}` (live quote buffer counts)
4. `SHOW COLUMNS FROM unified_option_quotes_history` (target column inventory)
5. `SHOW TABLES LIKE 'cpp_historical_migration_checkpoints'` (checkpoint presence)
6. `SELECT CURRENT_USER()` and `SHOW GRANTS` (least-privilege inspection)

*Requirement*: Run `--validate` on staging only after credentials and database connectivity are confirmed. If `schema_ready_for_migration` is `false`, stop testing immediately until Phase B DDL is applied in staging.

---

## 3. Tier 2 Query Plan, Optimizer Behavior, and Latency Benchmarks

### 3.1 Empirical Plan Evaluation
Tier 2 constructs candidate lookup queries using an OR-chain of `(instrumentKey, ts)` equality pairs:
```sql
SELECT instrumentKey, ts, source, sourceTimestamp, ltp, bid, ask, bidQty, askQty, volume, oi, changeOi, underlyingPrice, bidDepth, askDepth
FROM unified_option_quotes_history
WHERE ((instrumentKey = %s AND ts = %s) OR (instrumentKey = %s AND ts = %s) ...);
```
**Empirical Investigation Objective**:
Index selection is an empirical query-plan finding, not an assumption. Staging operators must record the exact access path (`type`), index used, rows examined, optimizer warnings, and execution latency. If the optimizer chooses a full table scan (`type: ALL`), the operator must determine whether it is due to `range_optimizer_max_mem_size` exhaustion, low table cardinality, or cost-model decisions.

### 3.2 Read-Only Plan Inspection (`EXPLAIN FORMAT=TREE`)
Before executing any workload that consumes database CPU or timing, run read-only `EXPLAIN` on staging:
```sql
EXPLAIN FORMAT=TREE
SELECT instrumentKey, ts, source, sourceTimestamp, ltp, bid, ask, bidQty, askQty, volume, oi, changeOi, underlyingPrice, bidDepth, askDepth
FROM unified_option_quotes_history
WHERE (instrumentKey = 'NSE:NIFTY26SEP24000CE' AND ts = '2026-09-23 09:15:00')
   OR (instrumentKey = 'NSE:NIFTY26SEP24050CE' AND ts = '2026-09-23 09:15:00')
   -- repeat for N candidate pairs
;
SHOW WARNINGS;
```
**Data to Record**:
- Access method: Index range scan vs table scan vs index skip scan.
- Estimated rows examined.
- Warnings: Record whether `Code 3995` (`Range optimizer memory limit exceeded`) is returned.

### 3.3 Executable Benchmarks (`EXPLAIN ANALYZE` and Timed Batches)
*Separation Note*: `EXPLAIN ANALYZE` and timed queries execute the statement and consume server resources. They must only run on staging under explicit test authorization.

#### Chunk Size Benchmark Matrix
Execute across chunk sizes $N \in \{100, 200, 500\}$ against staging data (ideally $\ge 10\text{M}$ rows):

| Chunk Size ($N$) | Parameter Count | SQL Text Size | Observed Query Plan | Range Tree Memory Warnings | Rows Examined | Measured Latency (P50 / P95 / P99) | Provisional Latency Limit |
| :---: | :---: | :---: | :--- | :--- | :--- | :--- | :--- |
| **100** | 200 | ~4.2 KB | Record plan | Record warnings | Record count | Record ms | Provisional: $< 25\text{ ms}$ |
| **200** | 400 | ~8.4 KB | Record plan | Record warnings | Record count | Record ms | Provisional: $< 40\text{ ms}$ |
| **500** | 1000 | ~21.0 KB | Record plan | Record warnings | Record count | Record ms | Provisional: $< 80\text{ ms}$ |

*Protocol Policy*: The provisional latency limits above are operational targets requiring operator review based on actual staging hardware. If $N=500$ triggers range memory warnings or excessive execution time, `chunk_size` in `historical_market_data_migrator.py:1132` must be lowered to $N=200$ or $N=100$.

---

## 4. Functional Correctness Matrix and Test Coverage Status

### 4.1 Offline Unit Test Baseline
- **Verified Offline Test Suite**: 53 tests in `scripts/test_historical_market_data_migrator.py` executed cleanly in 0.404s (Exit Code: 0).
- **Core Tested Areas**:
  - 15 canonical market fields verified; sequence number and payload hash invariance confirmed in canonical mode.
  - Provider normalization contract (`normalize_provider_venue`): whitespace stripping, case insensitivity, alias mapping (`fyers` $\rightarrow$ `FYERS_LIVE`, `upstox` $\rightarrow$ `UPSTOX_LIVE`), rejection of `None`/empty/literal `"NULL"`.
  - Tier 2 recovery of legacy unnormalized hashes (`src=fyers;...`) without `canonicalDedupHash IS NULL` restriction.
  - Fail-fast rollback and lease release on `InvalidProviderProvenanceError`.

### 4.2 Staging Correctness Cases and Outstanding Gaps

| Test ID | Case Description | Staging Execution Details | Expected Outcome | Existing Offline Test or Outstanding Gap |
| :--- | :--- | :--- | :--- | :--- |
| **STG-01** | Exact Canonical Hash Match | Seed target row with $H_1$; ingest identical candidate with $H_1$. | Tier 1 detects duplicate; 0 rows inserted; duplicate counter incremented. | Covered offline: `TestMarketDataMigrator.test_two_tier_deduplication...` |
| **STG-02** | Legacy Hash Compatibility | Seed target row with legacy hash ($H_{\text{old}}$); candidate has normalized hash ($H_{\text{norm}}$). | Tier 1 misses; Tier 2 matches via venue normalization and market state; 0 rows inserted. | Covered offline: `TestProviderVenue...test_tier2_recovers_legacy_unnormalized_target_hash` |
| **STG-03** | Cross-Provider Isolation | Target has `UPSTOX`; candidate has `FYERS_LIVE` with identical quote prices and timestamp. | Tier 1 misses; Tier 2 evaluates venues as distinct; candidate is inserted. | Covered offline: `TestProviderVenue...test_tier2_negative_controls...` (Control B) |
| **STG-04** | Unhashed Target Matching | Target row has `canonicalDedupHash IS NULL`; candidate has matching quote. | Tier 1 misses; Tier 2 inspects unhashed target and deduplicates. | Covered offline: `TestProviderVenue...test_tier2_negative_controls...` (Control A) |
| **STG-05** | Intra-Batch Duplication | Candidate batch contains 2 identical rows. | In-memory `seen_in_batch` filter identifies second row; 1 inserted, 1 duplicate. | Covered offline: Baseline unit tests |
| **STG-06** | Sentinel Timestamp Preservation | Source contains `ts = '1980-01-01 00:00:00'`. | Mapped with `dataQuality = 'SENTINEL_TS'`; original arrival time preserved in `sourceTimestamp`. | Covered offline: `TestMarketDataMigrator.test_sentinel_preservation...` |
| **STG-07** | Invalid Provenance Abortion | Candidate has `source = ''` or literal `'NULL'`. | Mapping raises `InvalidProviderProvenanceError`; transaction rolls back; checkpoint preserved. | Covered offline: `TestProviderVenue...test_invalid_provider_provenance_aborts...` |
| **STG-08** | Multi-Venue Collision Disambiguation | Target contains 2 rows for same `(instrumentKey, ts)`: one Fyers, one Upstox. Candidate is Upstox. | Tier 2 retrieves both candidates; matches the Upstox row; correctly deduplicates without false collision on Fyers row. | **OUTSTANDING TEST GAP 1**: Must be verified empirically on staging. |
| **STG-09** | Chunk-Boundary Splitting | Batch requires Tier 2 lookup for 1,200 unique candidate tuples. | Migrator partitions lookups into 3 chunks ($500 + 500 + 200$); aggregates results seamlessly. | **OUTSTANDING TEST GAP 2**: Must be verified empirically on staging. |
| **STG-10** | Accounting Invariant | Normal batch execution. | Process asserts `len(records) == inserted + duplicates`. Discrepancies raise `RowAccountingInvariantError`. | Covered offline: Baseline unit tests |

---

## 5. Operational Safety Guardrails and Failure Procedures

### 5.1 Scoped Data Preservation Verification
To prove zero data loss and zero unauthorized mutations, evidence must be scoped directly to the target table and session statements:
1. **Source Table Read-Only Invariant**:
   - Compute bitwise row XOR or MD5 checksums of source primary keys and row counts before and after staging runs:
     ```sql
     SELECT COUNT(*), BIT_XOR(CRC32(CONCAT(id, ts))) FROM fnf_option_quotes_history;
     SELECT COUNT(*), BIT_XOR(CRC32(CONCAT(id, ts))) FROM upstox_live_paper_option_quotes;
     ```
     Checksums must match exactly.
2. **Target Table Zero-Update Invariant**:
   - Inspect MySQL session and table status specifically:
     - Verify zero `UPDATE` queries were issued against `unified_option_quotes_history` in the migration session.
     - Review binlog statements (or staging query logs) for the migration connection to prove all target statements were strict `INSERT INTO`.
3. **Rollback Verification**:
   - Inject a simulated failure (e.g. invalid column value or killed session) mid-batch:
     - Verify `conn.rollback()` was invoked.
     - Verify `cpp_historical_migration_checkpoints.last_processed_id` remained at the previous committed high-water mark.
     - Verify no partial batch records persist in the target table.

### 5.2 Circuit Breaker Thresholds
The migrator actively monitors connection and performance metrics (`_check_system_health`):
- `max_threads_connected = 140`: Halts if active connections reach threshold.
- `min_connection_headroom = 50`: Halts if headroom (`max_connections - Threads_connected`) drops below threshold.
- `Threads_running >= 6`: Halts if active database thread execution pressure is high.
- `Connection_errors_max_connections`: Any increase immediately raises `CircuitBreakerError`.
- `batch_elapsed > 5.0s`: Halts if any batch takes longer than 5 seconds.

---

## 6. Staging Execution Sequence and Decision Gates

```
[Gate 0: Review Protocol & Schema Matrix]
               |
[Gate 1: Authorize Staging Infrastructure & Deploy Phase B DDL]
               |
[Step 1: Read-Only Preflight Verification (python3 migrator.py --validate)]
               |
[Step 2: Read-Only EXPLAIN FORMAT=TREE Plan Inspection (N=100, 200, 500)]
               |
[Step 3: Staging Functional Tests (STG-01 through STG-07)]
               |
[Step 4: Resolve Test Gaps (STG-08 Multi-Venue, STG-09 Chunk Splitting)]
               |
[Step 5: Executable Benchmarks (EXPLAIN ANALYZE & Timed Batches)]
               |
[Step 6: Concurrent Load Stress Test & Failure Rollback Rehearsal]
               |
[Step 7: Go/No-Go Staging Review Dossier]
               |
[Formal Production Authorization Request: Gate G-2 (DDL) & Gate G-3 (Migration)]
```

### Protocol Next Step
1. Review this document with the engineering and DBA team.
2. Obtain formal authorization to provision the isolated staging environment.
3. Gates G-1, G-1.1, G-2, and G-3 remain on **HOLD**.
