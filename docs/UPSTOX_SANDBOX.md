# Upstox Sandbox / Paper Trading — Isolation Guide

> **UPSTOX SANDBOX = PAPER/TESTING ONLY.** It is a completely separate environment
> from the FYERS real-market pipeline. FYERS remains the existing real data/trading
> source and its behaviour is unchanged by this feature.

Status: **architecture complete, credentials not yet configured** (Upstox account
pending approval). Sandbox is disabled by default and has zero effect on FYERS.

---

## 1. How Sandbox mode works

```
FYERS REAL                    UPSTOX SANDBOX
   |                               |
   v                               v
real pipeline                sandbox ingestion (async)
   |                               |
   v                               v
real ticks → real tables      sandbox_ticks (SEPARATE table)
   |                               |
   v                               v
real analytics/signals        sandbox analytics / paper orders
```

The two domains are separated at **database, service, analytics and result
levels** — not merely by UI labels. Every record carries an explicit environment
identity. The FYERS real path never waits on sandbox I/O: sandbox ticks are
enqueued and flushed by a background worker every 2s, and sandbox failures are
logged + dropped, never propagated.

## 2. Which tables contain Sandbox data

| Table | Contents | Environment identity |
|---|---|---|
| `sandbox_ticks` | Upstox sandbox market ticks (instrument, ts, price, bid/ask, expiry/strike/type, source=UPSTOX, environment=SANDBOX, on_real_data=0) | source=UPSTOX, environment=SANDBOX, onRealData=0 |
| `fnf_trades` | executions/positions/P&L — **sandbox rows coexist with real rows but are partitioned by flags** | on_real_data + execution_provider + execution_mode |
| `fnf_portfolios` | capital envelopes (a sandbox envelope is on_real_data=0/UPSTOX/SANDBOX) | same three flags |
| `fnf_decision_journal` | signals/decisions | same three flags |
| `fnf_trade_reflections` | post-trade learning | on_real_data + execution_provider |
| `fnf_trade_reports` | report outbox | on_real_data + execution_provider |

**Real tables never written by sandbox:** `fnf_market_snapshots`,
`fnf_market_snapshots_history`, `fnf_option_quotes`, `fnf_option_quotes_history`
are FYERS real tick storage only. Sandbox ticks physically cannot land there.

## 3. How Sandbox differs from REAL

| | REAL (FYERS) | SANDBOX (Upstox) |
|---|---|---|
| data source | FYERS WebSocket | Upstox Sandbox API |
| on_real_data | `1` | `0` |
| execution_provider | `FYERS` | `UPSTOX` |
| execution_mode | `REAL` | `SANDBOX` |
| tick storage | fnf_market_snapshots / fnf_option_quotes (+history) | `sandbox_ticks` (separate) |
| execution | internal paper fills on real data (existing engine) | Upstox Sandbox endpoints (paper) — provider is SANDBOX-ONLY |
| default queries | real-only filters | explicit /sandbox endpoints |

## 4. Required environment variables

All in `.env` (repo convention). Credentials are **empty until provided** —
do not invent them:

```
UPSTOX_SANDBOX_ENABLED=false        # master switch; MUST be false until creds exist
UPSTOX_SANDBOX_MODE=SANDBOX         # refusing anything != SANDBOX (fail closed vs live)
UPSTOX_SANDBOX_BASE_URL=https://api-sandbox.upstox.com
UPSTOX_SANDBOX_CLIENT_ID=           # ← provided later
UPSTOX_SANDBOX_CLIENT_SECRET=       # ← provided later
UPSTOX_SANDBOX_ACCESS_TOKEN=        # ← provided later
```

`UPSTOX_SANDBOX_*` is deliberately namespaced apart from any future
`UPSTOX_LIVE_*` and from `FYERS_*`, so credentials carry their environment in
their own name. Never put credentials in source, seeds, docs, logs or examples.

## 5. How to configure credentials (when approved)

1. Get the Sandbox client id/secret + access token from Upstox (developer portal,
   sandbox section).
2. Set the three `UPSTOX_SANDBOX_*` vars in `.env`.
3. Set `UPSTOX_SANDBOX_ENABLED=true`.
4. Restart: `pm2 restart my-job-agent --update-env` (portal) and redeploy Dhargent
   for the trading-agent.
5. Verify: boot log shows
   `[UpstoxSandboxIngestionService] [SANDBOX][UPSTOX] ingestion armed ...`.

## 6. How to enable / disable Sandbox

- Enable: `UPSTOX_SANDBOX_ENABLED=true` (+ creds) then restart.
- Disable: set `UPSTOX_SANDBOX_ENABLED=false` (or remove creds) then restart.
  With it false, Hermes behaves **exactly** as before — no sandbox code path runs,
  no sandbox tables are written, FYERS is untouched.
- The provider also refuses to start if `UPSTOX_SANDBOX_MODE` is anything other
  than SANDBOX (live Upstox is out of scope and fail-closed).

## 7. How to inspect sandbox_ticks

```sql
SELECT instrument, ts, price, bidPrice, askPrice, expiry, strike, optionType
FROM sandbox_ticks
WHERE environment='SANDBOX' AND onRealData=0
ORDER BY ts DESC LIMIT 100;
```

API: the sandbox tick data is read via the same service layer once the sandbox
feed is connected; real dashboards never query `sandbox_ticks`.

## 8. How to run Sandbox paper trading

Once credentials are live:
1. A sandbox envelope: `POST /trading/portfolios` with
   `{"label":"upstox-sandbox","capital":5000,"onRealData":false,
   "executionProvider":"UPSTOX","executionMode":"SANDBOX"}`.
2. Sandbox orders flow through `UpstoxSandboxProvider` (place/modify/cancel/
   status/positions) — every call goes to `api-sandbox.upstox.com` only.
3. Sandbox executions persist as `fnf_trades` rows with on_real_data=0 /
   UPSTOX / SANDBOX (never in real aggregates).

## 9. How to verify no real orders can be generated from Sandbox

- `UpstoxSandboxProvider.enabled` requires UPSTOX_SANDBOX_ENABLED=true **and**
  all three credentials non-empty; otherwise every method throws
  `[UPSTOX][SANDBOX][PAPER] not enabled ...`.
- Provider source contains **no live Upstox host**; base URL is
  `https://api-sandbox.upstox.com`.
- `UPSTOX_SANDBOX_MODE != SANDBOX` → constructor throws.
- Real signal engine (`generateSignals`) reads only real data; sandbox rows are
  `on_real_data=0` and excluded from `learningSummary()`, `rectifyDecay()`,
  `listTrades()` (default), `listPortfolios()` (default) and all dashboards.
- Automated proof: `scripts/upstox-isolation.test.js` (tests A–L + regression).

## 10. Distinguishing Sandbox and REAL analytics

- **REAL analytics**: everything on `/option-trading`, `/fnf-trading`,
  `/trading/trades`, `/trading/portfolios`, `/trading/summary` — all filter
  `on_real_data = 1` server-side (not just UI).
- **SANDBOX analytics**: `/trading/trades/sandbox`, `/trading/portfolios/sandbox`
  — these return **only** `on_real_data = 0` rows.
- Aggregates for real performance MUST filter `on_real_data = 1`; sandbox reports
  MUST filter `on_real_data = 0` (and prefer provider=UPSTOX, mode=SANDBOX).
- Logs: sandbox operations log `[SANDBOX][UPSTOX]`; FYERS real operations log
  `[FYERS][REAL]`.

## Database fields used for isolation

| Field | Type | Meaning |
|---|---|---|
| `on_real_data` | tinyint(1) NOT NULL | 1 = real/FYERS, 0 = sandbox |
| `execution_provider` | varchar(16) NOT NULL | FYERS \| UPSTOX |
| `execution_mode` | varchar(16) NOT NULL | REAL \| SANDBOX |
| `sandbox_ticks.source/environment/onRealData` | — | always UPSTOX/SANDBOX/0 |

Indexes: `idx_trades_mode (onRealData, executionProvider, executionMode)`,
`idx_trades_status_mode (status, onRealData)`, `idx_journal_mode (onRealData,
executionProvider)`, `idx_sbt_instrument_ts`, `idx_sbt_symbol_ts`, `idx_sbt_env`.

## Confirmation (spec §20 acceptance)

- [x] Upstox Sandbox enableable independently (UPSTOX_SANDBOX_ENABLED=false default)
- [x] Sandbox credentials isolated from live credentials (UPSTOX_SANDBOX_* namespace)
- [x] Sandbox ticks stored separately in `sandbox_ticks`
- [x] FYERS real ticks remain in existing real storage (untouched; regression-tested)
- [x] Every relevant record carries environment/source identification
- [x] `on_real_data` enforced (defaults + explicit writes + fail-closed guards)
- [x] Sandbox data never enters real analytics by default (real-only filters at every aggregate)
- [x] Real data never enters sandbox analytics by default (sandbox endpoints filter on_real_data=0)
- [x] Sandbox signals cannot execute real orders (partitioned; tested C/D/F)
- [x] Sandbox orders cannot reach live endpoints (SANDBOX-only host; tested I/J)
- [x] Sandbox processing cannot block FYERS (async ingest; tested G/H)
- [x] Sandbox DB writes cannot delay real tick processing (background flush queue)
- [x] Sandbox API failures cannot stop real services (independent failure; tested G)
- [x] Existing FYERS behaviour unchanged (defaults preserve; regression suite green)
- [x] Tests prove the above (`scripts/upstox-isolation.test.js` A–L + regression)
- [x] Docs explain later credential configuration (this document)

## What to provide when the account is approved

Only the three values for: `UPSTOX_SANDBOX_CLIENT_ID`,
`UPSTOX_SANDBOX_CLIENT_SECRET`, `UPSTOX_SANDBOX_ACCESS_TOKEN` (then flip
`UPSTOX_SANDBOX_ENABLED=true`). No code or schema changes needed — the system is
credential-ready. No live Upstox credentials will ever be accepted.
