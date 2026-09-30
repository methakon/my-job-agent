# Lot Size Correction — 2026-09-29

## Finding

`fnf_option_contracts.lotSize` held **25 for NIFTY** and **15 for BANKNIFTY** on
every contract. The live paper loop sizes positions directly from that column
(`expiry-learning-loop.js` → `sizePaperPosition({ lotSize: contract.lotSize })`),
so every paper trade would have been sized on lot 25 instead of 65 — a 2.6×
error in committed capital, R-multiples and net P&L.

The wrong values match the pre-2024 exchange lot sizes, not a transient glitch.

## Authority

NSE circular **FAOP/70616** (dated 2025-10-03, effective EOD 2025-10-28; first
weekly expiry carrying the revised lot: **2026-01-06**):

| Index | Symbol | Present | Revised |
|---|---|---|---|
| Nifty 50 | NIFTY | 75 | **65** |
| Nifty Bank | BANKNIFTY | 35 | **30** |
| Nifty Financial Services | FINNIFTY | 65 | 60 |
| Nifty Mid Select | MIDCPNIFTY | 140 | 120 |

Corroborated independently by the FYERS contract master (`NSE_FO.csv`), which
carries `lot=65` for every NIFTY contract and `30` for BANKNIFTY. Both sources
agree; the database did not.

## Change applied

Lot size column only. Transactional, each UPDATE guarded on the current value.

```sql
UPDATE fnf_option_contracts SET lotSize=65
 WHERE underlying='NIFTY50-INDEX' AND lotSize=25;   -- 833 rows

UPDATE fnf_option_contracts SET lotSize=30
 WHERE underlying='NIFTYBANK-INDEX' AND lotSize=15; -- 391 rows
```

Result: **1,224 rows changed** (833 NIFTY + 391 BANKNIFTY), 0 precondition
failures, committed in a single transaction.

## Post-correction verification

- `NIFTY50-INDEX 65 → 859 rows` (833 corrected + 26 already correct)
- `NIFTYBANK-INDEX 30 → 391 rows`
- `SENSEX 20 → 112 rows` — **untouched** (unresolved metadata, outside scope)
- Identity hash over `symbol|expiry|strike|optionType` **identical before and
  after** (`db0ab5296343d25c31b903b74dca2d13`) — proves no contract identity,
  expiry, strike or option type changed.
- `unified_option_quotes` = 101,178 rows, untouched. That table has **no
  lot-size column**, so no historical quote interpretation, backtest selection
  or DTE calculation is affected by this correction.

## Sizing sanity after the fix

With lot 65 and ₹5,000 paper capital:

| premium | 1 lot cost | outcome |
|---|---|---|
| 40 | ₹2,600 | allowed |
| 60 | ₹3,900 | allowed |
| 100 | ₹6,500 | refused — `ONE_LOT_UNAFFORDABLE` |

The affordability ceiling is the only hard financial gate, and it behaves.

## Not changed

- SENSEX contracts (112 rows) — reconciliation still unresolved.
- `upstox_live_paper_candidates.lotSize` / `upstox_live_paper_instructions.lotSize`
  — belong to the legacy Upstox desk, outside this workstream's scope.
- Any historical quote row, credential, `.env` value or PM2 risk limit.

## Safety state

`LIVE_EXECUTION = DISABLED` · `PAPER_MODE = ENABLED` · `canPlaceOrder = false`
· `STRATEGY_ARMED = false`. No broker order path exists in the learning code.
