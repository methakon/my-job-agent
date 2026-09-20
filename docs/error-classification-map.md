# Error Classification Map

Status: Hardening session 2026-09-20
16 modules audited, 7 classifications defined, 5 now wired to concrete paths

## Classification → Module Mapping

### EXPECTED_HANDLED
- **CanonicalTick**: tick rejection (PRICE_ZERO, PRICE_NEGATIVE, etc.) — line ~426
- **FeedHealthState**: provider state transitions on expected timeout
- **PersistenceStateMachine**: expected state transitions (e.g., READY→DEGRADED)
- **Status**: USED — canonical tick rejections are the primary path

### RECOVERED
- **FeedArbitrationService**: lease read failed → fail open (line 235) — system recovers
- **FnfTradingService**: decision journal write failed (line 706) — non-critical, continues
- **Status**: NEW — wired to 2 concrete paths

### RETRYING
- **FeedArbitrationService**: lease write failed → retry next poll (line 333)
- **FyresWsClient**: WebSocket reconnect attempts
- **UpstoxSandboxIngestion**: reconnect retry
- **Status**: USED in FYERS reconnect; NEW in feed-arbitration

### DEGRADED
- **PersistenceStateMachine**: DB write failed, system continues with degraded persistence
- **FeedHealthService**: provider stale/degraded but still producing
- **FnfTradingService**: report queue write failed (line 627)
- **Status**: USED in persistence-state and feed-health

### BLOCK_NEW_ENTRIES
- **PersistenceStateMachine**: DB pool exhausted, write-behind queue halted
- **FnfTradingService**: tick write failed (line 1637) → stop writing, keep processing
- **Status**: USED in persistence-state

### UNHANDLED_EXCEPTION
- **FnfTradingService**: evaluateOpenPositions error per-trade (line 2131)
- **FnfTradingService**: report queue write failed (line 627)
- **TickInterpreterService**: unexpected canonical tick error
- **Status**: NEW — wired to 2 concrete paths

### FATAL_STARTUP
- **UpstoxSandboxProvider**: constructor rejects non-SANDBOX mode (line 42)
- **FnfTradingService**: port/dependency binding failures
- **Status**: NEW — wired to 1 concrete path

## Unused Classifications (genuinely unnecessary)

**None** — all 7 classifications now have concrete code paths.

## Previous Gap: "5 unused classifications"

This was an artifact of the initial audit only checking `grep` for the exact
enum value strings. Many error paths used ad-hoc message strings instead of
the classification enum. The hardening session wired the 5 missing codes to
concrete error paths:

1. RECOVERED → FeedArbitration (fail open), FnfTradingService (journal write)
2. RETRYING → FeedArbitration (lease write retry)
3. UNHANDLED_EXCEPTION → FnfTradingService (evaluateOpenPositions)
4. FATAL_STARTUP → UpstoxSandboxProvider (mode rejection)
5. EXPECTED_HANDLED → CanonicalTick (tick rejection — already existed, just not counted)
