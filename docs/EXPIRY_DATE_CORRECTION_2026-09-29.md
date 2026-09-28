# Expiry-date correction — 2026-09-29 (operator-approved, executed)

Scope: **40 rows only** in `fnf_option_contracts`. No SENSEX change, no lot-size
change, no DELETE/DDL, no historical quote row touched.

## Why

`fnf_option_contracts.expiry` held `2026-09-26` for 40 NIFTY/BANKNIFTY contracts.
2026-09-26 is a **Saturday** and is not an NIFTY/BANKNIFTY expiry. The FYERS
contract master (exact-symbol lookup) resolves every one of them to
**2026-09-29**, cross-checked on strike, option type and lot size.

This mattered at runtime: `src/trading/fnf-trading.service.ts:1318-1320` computes
DTE from this column and rejects `dte < 1` as *"expiry is today or past"*, so
valid live contracts were being rejected as candidates because of stale metadata.

## Invariant applied

```
CONTRACT MASTER EXPIRY  >  DATABASE EXPIRY  >  SYMBOL PARSING
```

Every proposed expiry came from an exact-symbol lookup in the broker contract
master. Symbol strings were never parsed for a date. (Confirmed separately:
`NSE:NIFTY26SEP*` encodes **month+year**, not a date — the real expiry is
2026-09-29; `NSE:NIFTY29SEP*` in the Upstox tape is the *same* contract under a
day+month broker convention.)

## Pre-flight (all PASS)

| Check | Result |
|---|---|
| Row count | 40 (24 NIFTY + 16 BANKNIFTY) |
| SENSEX in mutation set | 0 |
| All current = `2026-09-26` | yes |
| All proposed = `2026-09-29` | yes |
| Master agrees on every row | yes |
| Master lot == DB lot (no lot change) | yes |
| `WHERE ... AND expiry='2026-09-26'` on every UPDATE | 40/40 |
| DELETE / DDL in the statement file | 0 |

## Mutation

One transaction, 40 `UPDATE fnf_option_contracts SET expiry='2026-09-29' WHERE
id=… AND expiry='2026-09-26'`. The current expiry is in every WHERE clause as a
concurrency precondition, so a concurrent write cannot be silently overwritten.
mysql exit 0, no unmatched rows, no precondition failures.

## Post-update verification

| Check | Result |
|---|---|
| 40 rows now `2026-09-29` | 132 NSE contracts carry `2026-09-29` (92 pre-existing + 40 corrected) |
| Remaining NIFTY/BN `2026-09-26` errors | **0** |
| 62 SENSEX unresolved rows | **unchanged** (40 @ `2026-09-26`, 22 @ `2027-09-26`) |
| Lot sizes | unchanged — 20/30/65 only |
| Total row count | 244 (unchanged) |
| Historical quote rows | untouched (`fnf_option_quotes_history.expiry` still `2026-09-26` on 381,953 rows) |
| Reconciliation re-run | 0 require change · 182 already correct · 62 unresolved |

## Historical-data impact assessment

`fnf_option_quotes_history` and `unified_option_quotes_history` each carry their
**own** `expiry` column; neither is populated by a JOIN against
`fnf_option_contracts`, and no historical query joins that table. The contract
table is read only by the live registry (`fnf-option-chain.service.ts`).

Therefore the correction changes **contract-master metadata only**:
- historical quote rows keep their own stored expiry — untouched
- historical session/expiry classification — unaffected
- backtest selection — unaffected (and still blocked: 0 expiry sessions captured)
- DTE — now computed from the correct date for *new* eligibility decisions

One deliberate consequence: on expiry day itself a contract expiring today shows
`dte = 0` and is still excluded by the `dte < 1` gate. That is existing designed
behaviour (do not open into same-day settlement), not a regression from this fix.

## Not done (deliberately)

- 62 `BSE:SENSEX26SEP*` rows: absent from the current BSE master, so
  `EXPIRY_RECONCILIATION_UNRESOLVED` — no guessing.
- Historical quote rows: not modified.
- Strategy: still unarmed; `POLICY_PERMITS=false`; `canPlaceOrder=false`.

Artifacts: `reports/expiry-day/expiry-date-reconciliation-DRYRUN.{json,md}`,
`expiry-date-reconciliation-PROPOSED.sql`.
