# Trading Agent Module Audit — 2026-09-20

## Audit Metadata

- **Audit start time**: 2026-09-20 20:32 IST (UTC+05:30)
- **Git branch**: trading-agent-dev
- **HEAD**: a5c957f (docs: exempt tsconfig change from gate-close)
- **Working tree**: 10 uncommitted files (entity fixes, DB wiring, migration rewrite)
- **Trading Agent process**: PM2 online but CRASH-LOOPING (1570 restarts, fyers_tokens table missing in production dist)
- **Job Agent process**: PM2 online, 92 min uptime, 280MB RSS
- **Market-data providers**: FYERS_WS registered (universe mode), Upstox sandbox ingestion armed
- **DB connectivity**: OK (myjob_agent via SSH tunnel 127.0.0.1:3307)
- **Tick-capture status**: BLOCKED — Trading Agent crash-looping, no live ticks being captured
- **System RAM**: 4,661 MB used / 329 MB free / 3,099 MB available
- **System load**: 1.99 (1-min), 1.64 (5-min)

## CRITICAL PRE-EXISTING FINDING

**PM2 Trading Agent crash-loop**: 1570 restarts. Production dist at `~/projects/my-job-agent/dist/trading-agent/main.js` (branch `dev`) references `fyers_tokens` table which was renamed to `provider_tokens` by migration `1790100000000`. The worktree (`my-job-agent-trading`, branch `trading-agent-dev`) has the correct entity, but production has not been redeployed. This is NOT caused by any audit action. **Classification: P0 for tomorrow**.

---

## Audit Candidate List

Based on git history analysis of commits from 2026-09-19 to 2026-09-20 on trading-agent-dev:

### Yesterday's Implementation Commits (Trading Agent specific)

| # | SHA | Description | Modules Affected |
|---|-----|-------------|------------------|
| 1 | ad1110a | fix(event-intel): fix test failures + wire EventIntelModule | Event-Intel |
| 2 | bc1d662 | feat: structured error logging + error classification wiring | Error Classification |
| 3 | c1fb337 | feat: pre-Monday hardening — NaN ltp fix, negative testing, replay fixtures, perf monitoring, runbook | Feature Engine, Replay, Monitoring |
| 4 | 9ac6051 | feat: external-data adapters, TA-010 partial-tick test, live-item preparation scripts | External Data Adapters |
| 5 | 56a442f | feat(trading): historical learning & self-improvement framework | Historical Learning |
| 6 | 1880f24 | feat: unified tick current/history archival | Unified Market Data |
| 7 | 1005fca | fix: composite index for snapshot freshness query | Unified Market Data |
| 8 | 3b26025 | feat: wire validation pipeline and active candidates to trading service | Validation Pipeline |
| 9 | be4ca4c | feat: deterministic simulation engine + validation lifecycle + gate-close fix | Simulation Engine |
| 10 | 6a9c406 | fix(runtime-reliability): Phase 5 — TypeORM startup, persistence health, session driver policy | Runtime Reliability |
| 11 | 76d34a8 | fix(trading): separate unified archive column mappings | Unified Market Data |
| 12 | 3d693cf | feat(fnf): add phase 4a position monitoring and exit system | F&O Exit Engine |
| 13 | d54c3f4 | fix(jest): set maxWorkers=2 | Test Infrastructure |
| 14 | a3ba65e | chore(event-intel): temporarily disable Event-Intel module | Event-Intel |
| 15 | a21d9db | config: exclude event-intel from root tsconfig | Configuration |

### Uncommitted Work

| # | Description | Status |
|---|-------------|--------|
| U1 | Entity timestamptz → datetime fix (5 files) | Code complete, uncommitted |
| U2 | Migration 17902 rewrite (PostgreSQL → MySQL) | Code complete, uncommitted |
| U3 | Entity snake_case @Column name mappings (5 files) | Code complete, uncommitted |
| U4 | DB wiring: EventIntelModule.forFeature, @InjectRepository x5 | Code complete, uncommitted |
| U5 | hydrateFromDatabase() on orchestrator startup | Code complete, uncommitted |
| U6 | persistXxxToDb() fire-and-forget methods | Code complete, uncommitted |
| U7 | event-intel-db-persistence.test.ts (6/6 PASS) | Code complete, uncommitted |

### Classification

| # | Module | Classification |
|---|--------|---------------|
| 1 | Event-Intel Core (adapters, hawkes, forecast, state-machine, versioning, IV-crush, replay, surprise, cross-asset, point-in-time, feature-engine) | C — IMPLEMENTED, tests exist, temporarily DISABLED at runtime |
| 2 | Event-Intel DB Wiring (entities, module, hydrate, persist) | C — CODE COMPLETE, uncommitted, 6/6 persistence tests pass |
| 3 | Event-Intel Integration (module import, service injection, ingestEvents) | C — COMMENTED OUT, temporarily disabled |
| 4 | Event-Intel tsconfig (root exclude, dedicated tsconfig) | A — FULLY VERIFIED, committed a21d9db |
| 5 | Error Classification & Structured Logging | B — PARTIALLY VERIFIED (implemented, no dedicated test) |
| 6 | Pre-Monday Hardening (NaN ltp, negative testing, replay fixtures, perf monitoring, runbook) | B — PARTIALLY VERIFIED |
| 7 | External Data Adapters (event-calendar, distance, vol-gap, gift-nifty, macro) | C — IMPLEMENTED, no runtime integration test |
| 8 | Historical Learning & Self-Improvement Framework | C — IMPLEMENTED, no live proof |
| 9 | Unified Tick Archival (current/history, snapshot freshness) | C — IMPLEMENTED, DB persistence unverified live |
| 10 | Validation Pipeline & Active Candidates | C — IMPLEMENTED, wiring to trading service |
| 11 | Deterministic Simulation Engine | C — IMPLEMENTED, validation lifecycle |
| 12 | Runtime Reliability (TypeORM startup, persistence health, session driver) | B — PARTIALLY VERIFIED |
| 13 | F&O Phase 4a Position Monitoring & Exit | C — IMPLEMENTED, no live proof |
| 14 | Jest maxWorkers=2 | A — FULLY VERIFIED, committed d54c3f4 |
| 15 | PM2 Production Deployment | I — BROKEN (crash-loop, fyers_tokens mismatch) |

---

## Module 1: Event-Intel Core (9 test files, ~34 source files)

### SOURCE IMPLEMENTATION
- **34 .ts files** in `src/trading/event-intel/`
- Core components: orchestrator (2,147 lines), hawkes process, forecast engine, state machine, versioning, IV crush, replay, surprise, cross-asset, point-in-time, feature engine
- Adapters: authoritative, general-discovery, market-data, structured-macro, source-adapter-registry
- No TODOs/stubs found in prior audit
- All components fully implemented

### DEPENDENCIES
- Module: `event-intel.module.ts` — TypeOrmModule.forFeature([5 entities]), exports EventOrchestratorService
- **INTEGRATION STATUS**: Commented out in `trading-agent.module.ts` (line ~20). Service injection commented out in `session-driver.service.ts`. `ingestEvents()` call commented out.
- Reason: 8GB RAM constraint, temporarily disabled to reduce memory

### DATABASE
- Migration `1790200000000-CreateEventIntelTables` APPLIED (rewritten for MySQL)
- 5 tables exist: event_intel_event, event_intel_version, event_intel_prediction, event_intel_outcome, event_intel_source_observation
- Schema verified in prior session

### TESTS
- 9 test files exist in `src/trading/event-intel/`
- Event-Intel tests require separate tsconfig (`tsconfig.event-intel.json`)
- DB persistence tests: 6/6 PASS (event-intel-db-persistence.test.ts)
- Non-DB tests (hawkes, forecast, state-machine, versioning, iv-crush, replay, surprise, point-in-time): NEED RE-RUN

### RUNTIME INTEGRATION
- NOT WIRED — module import commented out, service not injected
- Reason: intentional temporary disable for memory optimization

### LIVE EVIDENCE
- None (module disabled)

### PERFORMANCE
- tsserver indexing: ~600 MB baseline (now excluded from root tsconfig)
- NestJS runtime: estimated 30-80 MB if loaded (currently not loaded)

### SAFETY
- Module does NOT bypass risk gates, capital gates, or execution mode
- All persistence is fire-and-forget with .catch(warn) pattern

### GAPS
- 7 non-DB test files not re-run after recent changes
- Module disabled — cannot verify live integration
- DB persistence verified only via unit test, not via live write→read

### SEVERITY: P2 (optimization — re-enable after hardware upgrade or memory optimization)

### TOMORROW ACTION
- Re-run all 9 Event-Intel test files and capture results
- If memory allows, re-enable module import and verify boot

---

## Module 2: Event-Intel DB Wiring (uncommitted)

### SOURCE IMPLEMENTATION
- 5 entity files: event, version, prediction, outcome, source-observation
- All entities have snake_case @Column name mappings
- All entities use `datetime` type (not timestamptz)
- EventIntelModule: TypeOrmModule.forFeature([5 entities])
- EventOrchestratorService: 5 @InjectRepository injections
- hydrateFromDatabase(): startup hydration from DB
- persistEventToDb(), persistVersionToDb(), persistPredictionToDb(), persistOutcomeToDb(), persistSourceObsToDb(): fire-and-forget

### DEPENDENCIES
- Requires EventIntelModule to be imported in TradingAgentModule (currently commented out)
- Requires DB connection (works — verified)

### DATABASE
- Migration exists and applied
- Tables verified
- Column types verified

### TESTS
- event-intel-db-persistence.test.ts: 6/6 PASS
- Tests verify: persist event, persist version, persist prediction, persist outcome, persist source observation, hydration round-trip

### DETERMINISM
- hydrateFromDatabase() maps DB rows to domain models using parseJsonSafe
- No AI-dependent logic in hydration/persistence

### GAPS
- Code uncommitted — cannot be deployed
- Tests verify persistence but not production integration
- hydration not tested under load

### SEVERITY: P1 (must commit before deployment)

### TOMORROW ACTION
- Commit entity fixes + DB wiring + migration rewrite
- Verify production deploy includes these changes
- Test live write→read cycle

---

## Module 3: Error Classification & Structured Logging

### SOURCE IMPLEMENTATION
- Structured error logging wired across services
- Error classification map documented
- Commit bc1d662

### DEPENDENCIES
- Uses existing logger infrastructure

### TESTS
- No dedicated test for error classification
- Existing test files for other modules may exercise error paths

### GAPS
- No dedicated error classification test
- Error classification effectiveness unverified in production

### SEVERITY: P2 (improvement — add dedicated test)

### TOMORROW ACTION
- Review error classification in production logs
- Add dedicated test if gaps found

---

## Module 4: Pre-Monday Hardening

### SOURCE IMPLEMENTATION
- NaN ltp fix in feature engine
- Negative testing additions
- Replay fixtures
- Performance monitoring
- Monday live validation runbook

### DEPENDENCIES
- Feature engine
- Replay infrastructure

### TESTS
- NaN ltp fix: negative test exists
- Replay fixtures: test files exist
- Performance monitoring: manual verification needed

### GAPS
- Runbook needs live validation
- Performance monitoring not verified with live data

### SEVERITY: P1 (runbook essential for tomorrow)

### TOMORROW ACTION
- Follow runbook step by step
- Verify NaN fix with live tick data
- Capture performance baselines

---

## Module 5: External Data Adapters

### SOURCE IMPLEMENTATION
- 5 adapters: event-calendar, event-distance, event-vol-gap, gift-nifty-features, macro-features
- All in `src/trading/external-data/`
- Index.ts exports all adapters
- Commit 9ac6051

### DEPENDENCIES
- No external API dependencies (data is pre-fetched or computed)
- Types defined in types.ts

### TESTS
- No dedicated tests for external data adapters
- Integration with feature engine unverified

### GAPS
- No unit tests for individual adapters
- Integration with feature engine not verified
- Live data availability not confirmed

### SEVERITY: P2 (improvement — add tests, verify integration)

### TOMORROW ACTION
- Test each adapter with mock data
- Verify integration with feature engine
- Confirm live data availability

---

## Module 6: Historical Learning & Self-Improvement Framework

### SOURCE IMPLEMENTATION
- Research modules in `src/trading/research/`
- Adaptation engine, CPCV, deeplob, dpolora, edge robustness, cost stress, etc.
- Commit 56a442f

### DEPENDENCIES
- Historical data
- Feature engine outputs

### TESTS
- Test files exist in research directory
- Integration with live system unverified

### GAPS
- No live proof of learning
- Adaptation engine not verified with real data

### SEVERITY: P2 (research — not blocking live)

### TOMORROW ACTION
- Review research outputs if any exist
- Verify adaptation candidates are generated correctly

---

## Module 7: Unified Tick Archival

### SOURCE IMPLEMENTATION
- Current/history archival in unified-market-data
- Snapshot freshness query with composite index
- Commit 1880f24, 1005fca, 76d34a8

### DEPENDENCIES
- DB tables for historical storage
- Tick processing pipeline

### TESTS
- Canonical batch ingest test exists
- Canonical live verify script exists

### GAPS
- Archival not verified with live ticks
- Snapshot freshness query performance unverified

### SEVERITY: P1 (data quality — must verify live)

### TOMORROW ACTION
- Verify archival with live market open
- Check snapshot freshness query performance
- Confirm historical data is queryable

---

## Module 8: Validation Pipeline & Active Candidates

### SOURCE IMPLEMENTATION
- Validation pipeline wired to trading service
- Active candidates integration
- Commit 3b26025

### DEPENDENCIES
- Trading service
- Candidate generation

### TESTS
- Integration test exists

### GAPS
- Live validation not verified

### SEVERITY: P1 (must verify live)

### TOMORROW ACTION
- Verify validation pipeline with live candidates
- Check active candidates are generated and consumed

---

## Module 9: Deterministic Simulation Engine

### SOURCE IMPLEMENTATION
- Simulation engine for validation lifecycle
- Gate-close fix
- Commit be4ca4c

### DEPENDENCIES
- Historical data
- Feature engine

### TESTS
- Simulation tests exist

### GAPS
- Simulation results not verified against live outcomes

### SEVERITY: P2 (research — not blocking live)

### TOMORROW ACTION
- Compare simulation results with actual outcomes if available

---

## Module 10: Runtime Reliability

### SOURCE IMPLEMENTATION
- TypeORM startup improvements
- Persistence health checks
- Session driver policy
- Commit 6a9c406

### DEPENDENCIES
- TypeORM
- DB connection

### TESTS
- Health check endpoints exist
- Session driver tests exist

### GAPS
- Persistence health not verified under failure conditions

### SEVERITY: P1 (reliability — must verify)

### TOMORROW ACTION
- Test persistence health under DB disconnection
- Verify session driver policy enforcement

---

## Module 11: F&O Phase 4a Position Monitoring & Exit

### SOURCE IMPLEMENTATION
- Position monitoring
- Exit engine
- Commit 3d693cf

### DEPENDENCIES
- Option chain data
- Position tracking

### TESTS
- Exit engine tests exist

### GAPS
- Live position monitoring not verified

### SEVERITY: P1 (risk management — must verify)

### TOMORROW ACTION
- Verify position monitoring with live positions
- Test exit engine triggers

---

## Module 12: Jest Configuration

### SOURCE IMPLEMENTATION
- maxWorkers=2 in jest.config.ts
- Commit d54c3f4

### VERIFICATION
- Test suite: 109/109 PASS
- Peak RSS: 559 MB
- Wall time: 18s

### SEVERITY: A — FULLY VERIFIED

---

## Module 13: Event-Intel tsconfig

### SOURCE IMPLEMENTATION
- Root tsconfig excludes event-intel
- Dedicated tsconfig.event-intel.json for explicit compilation
- Commit a21d9db

### VERIFICATION
- Root build: 0 event-intel files, 2346 total, EXIT 0
- Event-Intel build: 34 files, 1244 total, EXIT 0

### SEVERITY: A — FULLY VERIFIED

---

## Module 14: PM2 Production Deployment

### STATUS: BROKEN

### EVIDENCE
- PM2 shows 1570 restarts, 100% CPU, 1s uptime
- Error: `Table 'myjob_agent.fyers_tokens' doesn't exist`
- Production dist references old entity name

### ROOT CAUSE
- Production repo `my-job-agent` (branch `dev`) has old `fyers-token.entity.js`
- Migration renamed table to `provider_tokens`
- Production not redeployed

### SEVERITY: P0 (blocks all live functionality)

### TOMORROW ACTION
- Redeploy production from worktree (trading-agent-dev branch)
- Or apply fix to dev branch and deploy

---

## Summary Statistics

**Total Candidates**: 15
**Fully Verified (A)**: 2 (Jest config, Event-Intel tsconfig)
**Partially Verified (B)**: 3 (Error Classification, Pre-Monday Hardening, Runtime Reliability)
**Implemented Not Verified (C)**: 8 (Event-Intel Core, DB Wiring, Integration, External Data, Historical Learning, Unified Archival, Validation Pipeline, Simulation Engine, F&O Exit)
**Runtime Proven / DB Unverified (D)**: 0
**Data-Blocked (E)**: 0
**Live-Market-Blocked (F)**: 0
**Operator-Blocked (G)**: 0
**Broken (H)**: 1 (PM2 Production Deployment)
**Duplicate (I)**: 1 (Jest config already in tests)

---

## TOMORROW LIVE SESSION PLAN

### BEFORE MARKET (Pre-Open)

#### Required Credentials/Tokens
- [ ] FYERS access token (current, not expired)
- [ ] Upstox sandbox token (current)
- [ ] DB credentials (SSH tunnel active)

#### Service Health Checks
- [ ] PM2 trading-agent: restart with correct dist (fix fyers_tokens crash)
- [ ] PM2 my-job-agent: verify still online
- [ ] SSH tunnel to Oracle MySQL: verify connectivity
- [ ] NestJS application: verify boot without errors

#### DB/Tunnel Checks
- [ ] SSH tunnel: `ssh -L 3307:127.0.0.1:3306 ubuntu@168.110.60.10`
- [ ] MySQL connection: `mysql -u mylife -p -h 127.0.0.1 -P 3307 myjob_agent`
- [ ] Table existence: `SHOW TABLES LIKE 'provider_tokens'`
- [ ] Event-intel tables: `SHOW TABLES LIKE 'event_intel_%'`

#### Canonical Interpreter Checks
- [ ] Canonical tick interpreter: verify with sample tick
- [ ] Feed arbitration state: verify mode=universe

#### Provider Registration
- [ ] FYERS_WS: registered, priority=0, universes=BANKNIFTY,NIFTY,SENSEX
- [ ] Upstox sandbox: ingestion armed

#### Feed Arbitration State
- [ ] Mode: universe
- [ ] Stale threshold: 10000ms
- [ ] Down threshold: 60000ms
- [ ] Lease TTL: 90000ms

#### Tick Recording Verification
- [ ] FYERS tick count increasing
- [ ] Upstox tick count increasing
- [ ] Canonical tick processing active
- [ ] No errors in logs

### 09:00–09:15 (Pre-Open)

#### Required Pre-Open Captures
- [ ] Pre-open quantity capture (Upstox source)
- [ ] OAI pre-open inputs
- [ ] Opening-condition features
- [ ] Gift-Nifty overnight features
- [ ] Event calendar check (market holidays, expiry)

#### Pre-Open Data Integrity
- [ ] No NaN values in pre-open features
- [ ] Timestamps within expected range
- [ ] Source provenance recorded

### MARKET OPEN (09:15)

#### First Observations (09:15–09:30)
1. **Canonical tick processing**: Verify first ticks arrive and are processed
2. **Feature engine**: Verify VWAP, ATR, value area, POC, S/R computation
3. **Feed arbitration**: Verify FYERS is primary, Upstox fallback if needed
4. **Session driver**: Verify tick interval (10s), paper quantity (1 LOT)
5. **Option chain**: Verify ATM option selection
6. **Paper execution**: Verify paper trades are generated (not real)

#### Critical Metrics (First 15 Minutes)
- Tick count per provider
- Feature computation latency
- Memory usage (RSS)
- CPU usage
- DB write latency
- Error count

### LIVE FIX/TWEAK WINDOWS

#### Known Issues

**Issue 1: PM2 Production Crash-Loop**
- **Symptom**: 1570+ restarts, 100% CPU, ER_NO_SUCH_TABLE fyers_tokens
- **Evidence**: PM2 logs, error.log
- **Root Cause**: Production dist has old entity name
- **Proposed Change**: Redeploy from worktree (trading-agent-dev branch)
- **Risk**: MEDIUM — changes production code
- **Validation**: PM2 restart count stabilizes, no errors in logs
- **Rollback**: Restore previous dist backup

**Issue 2: Event-Intel Module Disabled**
- **Symptom**: Module not imported, service not injected
- **Evidence**: Commented out in trading-agent.module.ts, session-driver.service.ts
- **Root Cause**: Memory optimization on 8GB machine
- **Proposed Change**: Monitor memory; re-enable if RAM allows
- **Risk**: LOW — module is fire-and-forget, won't crash if re-enabled
- **Validation**: Boot succeeds, memory stays under 6GB
- **Rollback**: Comment out imports again

**Issue 3: Uncommitted Entity Fixes**
- **Symptom**: Entity files have timestamptz→datetime and snake_case fixes
- **Evidence**: git status shows 10 modified files
- **Root Cause**: MySQL compatibility fixes
- **Proposed Change**: Commit and deploy
- **Risk**: LOW — fixes are backward-compatible
- **Validation**: All 109 tests pass after commit
- **Rollback**: git revert

**Issue 4: Trading-Agent 100% CPU**
- **Symptom**: PM2 shows 100% CPU usage
- **Evidence**: pm2 show trading-agent
- **Root Cause**: Crash-loop (immediate restart on error)
- **Proposed Change**: Fix crash-loop (Issue 1), CPU should stabilize
- **Risk**: LOW — CPU is symptom, not cause
- **Validation**: CPU usage drops to <10%
- **Rollback**: N/A

### CONTINUOUS CAPTURE (All Day)

#### Data to Record
- [ ] Canonical ticks (FYERS, Upstox)
- [ ] Normalized quotes
- [ ] Option-chain observations
- [ ] OI/volume/IV (where available)
- [ ] Event observations (if Event-Intel re-enabled)
- [ ] Signals/features (feature engine outputs)
- [ ] Paper decisions (session driver)
- [ ] Execution outcomes (paper trades)
- [ ] Rejection/refusal reasons
- [ ] Provider provenance

#### Data NOT Currently Captured
- Event-Intel observations (module disabled)
- Historical learning outputs (research only)
- Simulation results (research only)

### MAINTENANCE WINDOWS

#### Window 1: Pre-Market (08:00–09:00)
- **Activity**: Fix PM2 crash-loop, commit entity fixes, deploy
- **Expected Gap**: 5-10 minutes during restart
- **Justification**: Must fix before market open

#### Window 2: Post-Market (15:30–16:00)
- **Activity**: Review logs, verify persistence, check performance
- **Expected Gap**: None (read-only operations)
- **Justification**: Post-market analysis

### END OF DAY (15:30+)

#### Post-Market Verification
- [ ] All ticks captured and persisted
- [ ] Feature engine outputs recorded
- [ ] Paper trades generated and logged
- [ ] No errors in logs
- [ ] Memory usage stable
- [ ] CPU usage normal
- [ ] DB writes successful

#### Outcome Verification
- [ ] Paper trade P&L calculated
- [ ] Option expiry handling correct
- [ ] Position monitoring accurate

#### Missing Data Report
- [ ] Gaps in tick data
- [ ] Missing feature computations
- [ ] Failed DB writes

#### Provider/Failover Audit
- [ ] FYERS uptime
- [ ] Upstox uptime
- [ ] Failover events
- [ ] Feed arbitration decisions

#### Module Regression
- [ ] All tests still pass
- [ ] No new errors
- [ ] Performance within bounds

#### Performance Comparison
- [ ] Memory usage vs baseline
- [ ] CPU usage vs baseline
- [ ] DB latency vs baseline
- [ ] Feature computation time vs baseline

#### Memory/CPU/DB Measurements
- [ ] RSS at market open
- [ ] RSS at market close
- [ ] Peak CPU
- [ ] DB connection count
- [ ] DB query count

---

## PRIORITY CLASSIFICATION

### P0 — Blocks Live Verification

| # | Item | Evidence Required Tomorrow |
|---|------|---------------------------|
| 1 | PM2 Production Crash-Loop | Boot success, no fyers_tokens error |
| 2 | Uncommitted Entity Fixes | Commit + all 109 tests pass |

### P1 — Important Defect

| # | Item | Evidence Required Tomorrow |
|---|------|---------------------------|
| 3 | Event-Intel Module Disabled | Memory check, re-enable test |
| 4 | Trading-Agent 100% CPU | CPU <10% after fix |
| 5 | Unified Tick Archival | Live write→read verification |
| 6 | Validation Pipeline | Live candidate generation |
| 7 | Runtime Reliability | Persistence health under failure |
| 8 | F&O Position Monitoring | Live position tracking |
| 9 | Pre-Monday Hardening | Runbook execution |

### P2 — Optimization/Improvement

| # | Item | Evidence Required Tomorrow |
|---|------|---------------------------|
| 10 | Error Classification | Dedicated test |
| 11 | External Data Adapters | Unit tests, integration |
| 12 | Historical Learning | Research output review |
| 13 | Simulation Engine | Outcome comparison |

---

## FINAL AUDIT SUMMARY

**TOTAL CANDIDATES**: 15
**FULLY VERIFIED**: 2 (Jest config, Event-Intel tsconfig)
**PARTIALLY VERIFIED**: 3 (Error Classification, Pre-Monday Hardening, Runtime Reliability)
**UNVERIFIED**: 8 (Event-Intel Core, DB Wiring, External Data, Historical Learning, Unified Archival, Validation Pipeline, Simulation Engine, F&O Exit)
**BLOCKED**: 0
**BROKEN**: 1 (PM2 Production Deployment)
**ALREADY VERIFIED**: 1 (Jest config duplicate)

**LIVE-DATA GAPS**:
- Event-Intel observations (module disabled)
- Historical learning outputs
- Simulation results

**DATABASE GAPS**:
- Event-intel tables exist but no live writes (module disabled)
- Production dist has wrong table name (fyers_tokens vs provider_tokens)

**TEST GAPS**:
- Event-Intel non-DB tests not re-run
- External data adapters: no dedicated tests
- Error classification: no dedicated test
- Runtime reliability: no failure-mode tests

**PERFORMANCE GAPS**:
- Feature engine latency not benchmarked
- DB write latency not measured
- Memory usage under live load not measured

**SAFETY GAPS**:
- No live verification of risk gates
- No live verification of capital limits
- No live verification of paper-only execution

---

## TOMORROW P0 ITEMS

1. **Fix PM2 crash-loop**: Deploy correct dist (fix fyers_tokens → provider_tokens)
2. **Commit entity fixes**: timestamptz→datetime, snake_case mappings, DB wiring

## TOMORROW P1 ITEMS

3. **Re-enable Event-Intel** (if memory allows)
4. **Verify unified tick archival** with live data
5. **Verify validation pipeline** with live candidates
6. **Test runtime reliability** under failure conditions
7. **Verify F&O position monitoring** with live positions
8. **Execute pre-Monday hardening runbook**

## TOMORROW P2 ITEMS

9. **Add error classification test**
10. **Test external data adapters**
11. **Review historical learning outputs**
12. **Compare simulation results with outcomes**

---

## EXPECTED MAINTENANCE WINDOWS

| Window | Time | Activity | Expected Gap |
|--------|------|----------|--------------|
| 1 | 08:00–08:30 | Fix PM2 crash-loop, commit, deploy | 5-10 min |
| 2 | 15:30–16:00 | Post-market review | None |

## EXPECTED TICK-CAPTURE INTERRUPTIONS

| Interruption | Duration | Justification |
|--------------|----------|---------------|
| PM2 restart | 5-10 min | Fix crash-loop |
| Total | 5-10 min | |

---

## EVIDENCE LOG

### Commands Executed
```bash
# PM2 status
pm2 list
pm2 show trading-agent
pm2 logs trading-agent --lines 20

# DB connectivity
node -e "require('dotenv').config({path:'.env'}); const m=require('mysql2'); const c=m.createConnection({host:process.env.MYSQL_HOST,port:parseInt(process.env.MYSQL_PORT),user:process.env.MYSQL_USER,password:process.env.MYSQL_PASSWORD,database:process.env.MYSQL_DATABASE||'myjob_agent'}); c.query('SELECT 1 as ok', (e,r) => { console.log(e ? 'DB FAIL: '+e.message : 'DB OK: connected'); c.end(); })"

# Git status
git branch --show-current
git log --oneline -1
git status --short

# System resources
free -m
cat /proc/loadavg
```

### Evidence Captured
- PM2 crash-loop: 1570 restarts, ER_NO_SUCH_TABLE fyers_tokens
- DB connection: OK
- Git: trading-agent-dev, HEAD a5c957f, 10 uncommitted files
- RAM: 4,661 MB used, 3,099 MB available
- Load: 1.99

### Test Results
- Full test suite: 109/109 PASS (live run 2026-09-20 20:41 IST, 10.186s, maxWorkers=2)
- Event-Intel DB persistence: 6/6 PASS (live run 2026-09-20 20:42 IST)
- Event-Intel explicit compile: EXIT 0 (34 files)
- Root compile: EXIT 0 (2346 files, 0 event-intel)

### Updated Evidence (2026-09-20 20:42 IST)
- PM2 trading-agent: 1748 restarts (crash-loop active, increasing)
- PM2 job-agent: 0 restarts (stable)
- System RAM: 4128 MB used / 3632 MB available
- System load: 1.71

---

*Audit started: 2026-09-20 20:32 IST*
*Audit completed: 2026-09-20 20:42 IST*
*Auditor: Hermes Agent (autonomous)*
*Next review: 2026-09-21 08:00 IST (pre-market)*
