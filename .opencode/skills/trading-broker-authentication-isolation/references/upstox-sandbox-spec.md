# Upstox Sandbox Integration — Spec v2 (Isolation Tests A–L)

## Environment tags

| Field | Required | Values |
|-------|----------|--------|
| `provider` | Yes | `'FYERS'` \| `'UPSTOX'` |
| `environment` | Yes | `'LIVE_DATA'` \| `'SANDBOX'` `\| `'LIVE_DATA'` (future) |
| `onRealData` | Yes | `true` \| `false` |

---

## DB table mapping

| Table | provider | environment | onRealData | Purpose |
|-------|----------|-------------|------------|---------|
| `fnf_market_snapshots` | FYERS | LIVE_DATA | true | Real market ticks (FYERS WebSocket) |
| `sandbox_ticks` | UPSTOX | SANDBOX | false | Sandbox ticks (never mixed) |
| `fnf_trades` | FYERS | REAL | true | Real paper/trading ledger |
| `fnf_trades` | UPSTOX | SANDBOX | false | Sandbox execution ledger |

---

## Test suite (spec v2)

### A. sandbox tick cannot enter real tick table
```sql
SELECT COUNT(*) FROM fnf_market_snapshots WHERE instrument LIKE '%SANDBOX%';
→ must be 0
```

### B. real FYERS tick cannot enter sandbox_ticks
```sql
SELECT COUNT(*) FROM sandbox_ticks WHERE instrument LIKE '%NIFTY%' OR instrument LIKE '%BANK%';
→ must be 0
```

### C. sandbox signal cannot trigger real order execution
- Sandbox trades (`on_real_data=0`) must never appear in `/trading/trades` (real ledger).
- Real trades (`on_real_data=1`) must never appear in `/trading/trades/sandbox`.

### D. real signal cannot accidentally use sandbox execution
- Same as C, inverse direction.

### E. on_real_data=true never accepted for UPSTOX_SANDBOX
- Provider constructor must accept only `SANDBOX` mode.
- `UPSTOX_SANDBOX_MODE=REAL` → throw error at construction.

### F. on_real_data=false never treated as real trading signal
- `learningSummary` endpoint must sum only `onRealData=1`.
- Sandbox trades (win/loss) must not inflate real P&L metrics.

### G. sandbox API failure does not stop real data processing
- Disabled sandbox provider throws but real endpoints remain reachable.
- Async sandbox ingestion does not block FYERS WebSocket.

### H. sandbox DB slowdown does not block real-data path
- Sandbox ingest uses queue + background flush.
- Real tick insert happens synchronously; sandbox is O(1) enqueue.

### I. sandbox order cannot be sent to production/live endpoint
- Sandbox provider must hardcode `api-sandbox.upstox.com`.
- No fallback to `api.upstox.com`.

### J. live credentials cannot be accepted by the sandbox provider
- Config with `mode=REAL` must be rejected at construction.
- Sandbox provider never attempts live OAuth flow.

### K. dashboard/analytics default queries do not mix environments
- `/trading/summary` → real only.
- `/trading/trades/sandbox` → sandbox only.
- `/trading/portfolios/sandbox` → sandbox only.

### L. restart does not corrupt or merge datasets
- PM2 restart must not duplicate or mix sand/real tables.
- Count mismatch after restart = bug.

---

## Provider config namespace

| Config | Namespace | Required | Purpose |
|--------|-----------|----------|---------|
| `UPSTOX_SANDBOX_ENABLED` | UPSTOX_SANDBOX | Yes | Enable/disable sandbox provider |
| `UPSTOX_SANDBOX_MODE` | UPSTOX_SANDBOX | Yes | `SANDBOX` only |
| `UPSTOX_SANDBOX_BASE_URL` | UPSTOX_SANDBOX | Yes | `https://api-sandbox.upstox.com` |
| `UPSTOX_SANDBOX_CLIENT_ID` | UPSTOX_SANDBOX | Yes | Client ID from Upstox Sandbox App |
| `UPSTOX_SANDBOX_CLIENT_SECRET` | UPSTOX_SANDBOX | Yes | Client Secret from Upstox Sandbox App |
| `UPSTOX_SANDBOX_ACCESS_TOKEN` | UPSTOX_SANDBOX | Yes | Pre-generated access token |

---

## Sandbox token generation (manual)

1. Log into **Upstox Sandbox** dashboard.
2. Navigate to **Developers → Sandbox Apps**.
3. Generate a new app or select existing.
4. Copy `API Key` → `UPSTOX_SANDBOX_CLIENT_ID`.
5. Copy `API Secret` → `UPSTOX_SANDBOX_CLIENT_SECRET`.
6. Generate **Sandbox Access Token** (not OAuth, pre-generated).
7. Copy → `UPSTOX_SANDBOX_ACCESS_TOKEN`.
8. Set `UPSTOX_SANDBOX_ENABLED=true`.
9. Set `UPSTOX_SANDBOX_MODE=SANDBOX`.

---

## Safety guards

1. **Execution-only** — Sandbox provider never receives market data.
2. **Disabled by default** — `UPSTOX_SANDBOX_ENABLED` defaults to `false`.
3. **Fail-closed** — No credentials → provider reports `enabled=false`, every call throws.
4. **Mode check** — Any config with `mode=REAL` is rejected at construction.
