# F&O paper-options plan — interim Yahoo mode

Status: paper-only; no live orders. Yahoo is used only for experimental underlying/index analysis while the broker account is under document review. FYERS credentials, when approved and provided by the user, must remain environment-only and must never be committed or retained in summaries.

## Starting envelope

- Simulated balance: ₹5,000.00
- Risk per paper trade: at most 1% of current balance (initially ₹50.00)
- Session loss stop: at most 2% of current balance (initially ₹100.00)
- Maximum simultaneous open positions: 1
- No averaging down, martingale sizing, or revenge trades
- Closed paper profits increase the next simulated balance; losses reduce it
- Costs must be included in maximum-loss and P&L calculations

## Non-negotiable entry gate

A trade is rejected unless all of these are available and fresh:

1. A new underlying observation (Yahoo timestamps are deduplicated per instrument).
2. An explicitly registered option contract: symbol, underlying, expiry, strike, CE/PE, lot size, and tick size.
3. A provider option quote with LTP; bid/ask, timestamp, and liquidity fields are checked when available.
4. Entry, stop, target, quantity/lots, maximum rupee loss, and scenario-based profit are recorded before opening.
5. Maximum loss including costs is within the remaining session and account risk budget.
6. Decay-adjusted confidence, astro/muhurta gates, and Friday policy all permit the trade.

No CE/PE premium, option P&L, strike, or lot size may be inferred from an index price or a stale signal. If Yahoo returns only underlying data, the correct decision is HOLD/no option trade.

## Five-session progression

| Session | Objective | Paper-trade limit | Required evidence |
|---|---|---:|---|
| 1 | Validate Yahoo underlying freshness, timestamp deduplication, and signal logging | 0 unless an approved option-quote fixture is available | Clean feed status, no stale/duplicate-triggered signal |
| 2 | First controlled option simulation | 1 | Explicit contract + quote + pre-trade risk record |
| 3 | Repeat only if Session 2 was fully auditable | 1 | Fresh quote, costs, stop/target outcome, updated balance |
| 4 | Test consistency, not higher leverage | 1 | Same gates; no size increase after a win |
| 5 | Review outcomes and rectify day-wise decay/timing | 0–1 | Five-session ledger, drawdown, win/loss, data-quality review |

A session ends immediately at its loss stop, after one open position is unresolved at the configured cutoff, or whenever the quote/feed becomes stale. Unavailable option data means observation only—not a synthetic paper fill.

## Interim Yahoo operating rule

Polls may repeat the current 1-minute candle. The feed now accepts only a newer Yahoo candle timestamp per instrument for snapshot persistence and status tick counting. Yahoo remains unsuitable as the sole source for unrestricted NSE option-chain selection, Greeks, or reliable option premiums; those capabilities remain blocked until a validated broker/derivatives feed is available.
