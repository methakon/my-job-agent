---
name: trading-broker-authentication-isolation
description: Use when integrating or auditing broker authentication where providers must be strictly separated (FYERS OAuth2 v3 for real market-data, Upstox Sandbox token-based for training, Upstox LIVE future). Rejects generic broker providers, credential reuse, SANDBOX/LIVE mode confusion, and DB/API mixing.
---

# trading-broker-authentication-isolation

**Use when:** You need to integrate or audit broker authentication in an environment with multiple providers (e.g., FYERS for real market-data, Upstox Sandbox for execution training, Upstox LIVE as future). Anywhere broker authentication, environment, and data pipeline must be strictly separated.

**Trigger conditions:**
- User mentions "Upstox integration" or "broker OAuth" alongside existing FYERS auth — stop and verify separation.
- User says "stop" or "don't conflate" regarding broker authentication — this is a first-class architectural signal.
- You see code that proposes a "generic broker provider" or "unified OAuth flow" — reject and demand broker-specific adapters.

---

## Required separation (spec v2)

### A. FYERS — Existing primary market-data provider
- Real market data, option-chain data, historical/replay data, deterministic F&O calculations, existing paper-trading workflow.
- **Authentication:** OAuth2 v3 flow (`/generate-authcode` → `validate-authcode` with `appIdHash`).
- **Environment:** LIVE (real trading).
- **Credentials:** `FYERS_APP_ID`, `FYERS_APP_SECRET`, `FYERS_REDIRECT_URI` (secrets) + single-row DB token `fyers_tokens` (AES-encrypted under `ENCRYPTION_KEY`, status-tracked). `FYERS_ACCESS_TOKEN` / `FYERS_REFRESH_TOKEN` in `.env` are legacy/optional — runtime and scripts read the token from the DB row (see `references/fyers-auth-v3.md`).
- **Do NOT replace** because of Upstox.

### B. Upstox Sandbox — Training/integration environment
- API integration training, broker adapter testing, order lifecycle testing, execution plumbing validation.
- **Authentication:** Pre-generated sandbox access token. **NO OAuth.**
- **Environment:** SANDBOX only. LIVE is disabled and must remain so.
- **Credentials:** `UPSTOX_SANDBOX_CLIENT_ID`, `UPSTOX_SANDBOX_CLIENT_SECRET`, `UPSTOX_SANDBOX_ACCESS_TOKEN`, `UPSTOX_SANDBOX_ENABLED`, `UPSTOX_SANDBOX_MODE`.
- **Mode enforcement:** `UPSTOX_SANDBOX_MODE` must be `SANDBOX`. Any request for `REAL` must fail-closed at construction.

### C. Upstox LIVE — market-data paper desk (IN PROGRESS — another agent session)
- Separate from Sandbox (B). New `UPSTOX_LIVE_*` credential namespace — never shared with `UPSTOX_SANDBOX_*` or FYERS.
- **Status (2026-09-10):** UNDER ACTIVE DEVELOPMENT by a separate agent session (untracked `src/trading/upstox-live-paper/`, `upstox_live_paper_*` tables). Not committed/final — do NOT document it as settled; re-sync this skill when that work lands.
- **Intent:** Upstox LIVE market data (`api.upstox.com` REST v2 quote/option-chain + WS) feeding a PAPER-ONLY F&O desk with its own ledger. The Upstox order API must never be called — execution stays paper.
- **Standing safety invariants (apply to any WIP state):** `UPSTOX_SANDBOX_ENABLED` remains the master lock (true ⇒ real orders impossible for every broker); no generic broker provider; no cross-provider credential reuse; environment tag on every record.

---

## Required code architecture

### Provider separation
- **No generic broker provider.** Use broker-specific adapters:
  - `FyersAuthProvider` → FYERS OAuth2 v3
  - `UpstoxSandboxProvider` → Upstox SANDBOX (token-based)
  - `UpstoxLiveProvider` → Upstox LIVE (OAuth, future)
- **Per-provider config namespace:**
  - `FYERS_*` → FYERS only
  - `UPSTOX_SANDBOX_*` → Upstox Sandbox only
  - `UPSTOX_LIVE_*` → Upstox LIVE only (future)
- **Environment tags on every record:**
  ```
  provider: 'FYERS' | 'UPSTOX'
  environment: 'LIVE_DATA' | 'SANDBOX' | 'LIVE_DATA' (future)
  onRealData: true  // FYERS only
  onRealData: false // Sandbox only
  ```

### Market-data vs execution training
- **Market-data training** uses FYERS WebSocket (primary) + Yahoo fallback.
  - Purpose: features → regime → probability → expected value → entry/exit research → paper trading.
- **Execution/API training** uses Upstox Sandbox.
  - Purpose: place/modify/cancel/reconcile test. Does NOT become market-data source.
- **Never merge** sand ticks into real tick table.

### Architecture diagram (simplified)
```
Real Market Data (FYERS)
  ↓
FNO Market Data Service
  ↓
Feature Engine
  ↓
Decision Engine (deterministic)
  ↓
AI Shadow Review (advisory only)

Decision Engine Output
  ↓
Execution Provider (interface)
  ├──→ FYERS Paper Fill (REAL, onRealData=true)
  └──→ Upstox Sandbox (SANDBOX, onRealData=false)
```

---

## Pitfalls

1. **Generic OAuth provider** — Never create `GenericBrokerAuthProvider`. Broker auth flows differ (FYERS → token exchange, Upstox Sandbox → pre-generated token, Upstox LIVE → OAuth). Each requires its own adapter.

2. **Credential reuse** — Never copy `FYERS_APP_ID` → `UPSTOX_SANDBOX_CLIENT_ID`. Namespace is part of the contract.

3. **Mode confusion** — `UPSTOX_SANDBOX_MODE=REAL` must throw at construction. Never automatically "upgrade" sandbox to live.

4. **DB table mixing** — Sandbox data must never appear in `fnf_market_snapshots`, `fnf_trades` (onRealData=1). Real data must never appear in `sandbox_ticks`.

5. **API endpoint mixing** — Sandbox provider must only call `https://api-sandbox.upstox.com`. Hardcoded. No fallback to `api.upstox.com`.

6. **AI confusion** — AI receives snapshots for research. AI never obtains broker secrets or decides LIVE vs SANDBOX.

---

## Verification script

Run `scripts/upstox-isolation.test.js` to verify separation between FYERS real pipeline and Upstox Sandbox pipeline.

---

## References

- `references/fyers-auth-v3.md` — FYERS OAuth2 v3 spec (app_id, app_secret, appIdHash, validate-authcode, refresh-token).
- `references/upstox-sandbox-spec.md` — Upstox Sandbox spec (V2, A–L isolation tests, table mapping).
- `references/fyers-auth-v3.md` — also covers the DB single-row token model + GET THE TOKEN flow.
- `scripts/upstox-isolation.test.js` — Deterministic test suite for provider isolation.
- Project truth docs: `docs/FNO_PAPER_PLAN.md` (FYERS LIVE feed state, shared DB-token on both hosts, auto-reconnect) and `docs/UPSTOX_SANDBOX.md`.

---

## Related skills
- `hermes-fo-quant-framework` — Market-data pipeline uses FYERS as source.
- `trading-ai-shadow-module` — AI never modifies execution; broker separation ensures AI cannot access LIVE credentials.
- `hermes-fo-training-curriculum` — Execution training uses Sandbox; market-data training uses FYERS.
