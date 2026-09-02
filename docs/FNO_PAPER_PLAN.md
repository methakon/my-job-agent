# F&O paper-trading plan — interim Yahoo mode

Status: paper-only; no live orders. Yahoo is used only for experimental underlying/index analysis while the broker account is under document review. FYERS credentials, when approved and provided by the user, must remain environment-only and must never be committed or retained in summaries.

## Starting envelope

- Simulated balance: ₹5,000.00
- Position sizing: at most 1% of current balance per trade (initially ₹50.00) — used as the sizing guideline, not a price-based stop trigger
- **No rigid session loss stop.** In F&O trading, positions routinely swing 5–50% against before reversing to +150–200%; a fixed percentage stop would exit before the recovery. The agent must evaluate each open position dynamically and calculatively instead of hitting a hard line.
- **Position layering for recovery is allowed.** When a F&O position drops and there's a reasonable possibility the price will reverse back up, an additional (cover) trade at a lower price may be taken to reduce the net drawdown — as long as the combined cost and risk stay within the remaining balance/risk budget. The agent should prefer entering the cover trade near the lowest point of the drop rather than chasing mid-fall. This is a learnable behavior, not a fixed rule: the exact trigger (how deep the drop must be, how to recognize the bottom) is to be fine-tuned from session outcomes.
- Maximum simultaneous open positions: governed by the remaining balance and per-trade risk budget, not capped at 1. Because the simulated balance is limited, the preferred default is **one F&O trade at a time**; additional layering is taken only when the recovery logic justifies it and the budget allows.
- No averaging down for the sake of averaging down, no martingale sizing, and no revenge trades. Recovery layering is a measured, evidence-backed decision — not an automatic response to every dip.
- Closed paper profits increase the next simulated balance; losses reduce it
- Costs must be included in maximum-loss and P&L calculations

## Non-negotiable entry gate

A trade is rejected unless all of these are available and fresh:

1. A new underlying observation (Yahoo timestamps are deduplicated per instrument).
2. An explicitly registered **F&O instrument**: symbol, underlying, expiry, strike (for options: CE/PE), lot size, and tick size. The plan supports both **options** (CE/PE premiums) and **futures** (contract-based price) — the exact instrument is decided per trade, not inferred from a signal.
3. A provider F&O quote with LTP; bid/ask, timestamp, and liquidity fields are checked when available.
4. Entry, stop, target, quantity/lots, maximum rupee loss, and scenario-based profit are recorded before opening.
5. Maximum loss including costs is within the remaining session and account risk budget.
6. Decay-adjusted confidence, astro/muhurta gates, and Friday policy all permit the trade.

No CE/PE premium, option P&L, strike, lot size, or future contract value may be inferred from an index price or a stale signal. If Yahoo returns only underlying data, the correct decision is HOLD/no F&O trade.

## Five-session progression (paper-training curriculum)

|| Session | Objective | Paper-trade limit | Required evidence |
|---|---|---|---:|---|
| 1 | Validate Yahoo underlying freshness, timestamp deduplication, and signal logging | 0 unless an approved F&O-quote fixture is available | Clean feed status, no stale/duplicate-triggered signal |
| 2 | First controlled F&O simulation | 1 | Explicit instrument + quote + pre-trade risk record |
| 3 | Repeat only if Session 2 was fully auditable | 1 | Fresh quote, costs, stop/target outcome, updated balance |
| 4 | Test consistency, not higher leverage | 1 | Same gates; no size increase after a win |
| 5 | Review outcomes and rectify day-wise decay/timing | 0–1 | Five-session ledger, drawdown, win/loss, data-quality review |

This five-session sequence is the desk's **Mode 1–3 paper-training curriculum**. It maps onto the five-mode deployment pipeline in the training reference at `~/Downloads/Hermes_FO_Trading_Master_Guide.pdf`: Session 1 = Mode 1 minimum-viable pathfinder, Sessions 2–4 = Phase 1 simulations with decay-calibrated entries, and Session 5 = Phase 1 plus a four-session auditable ledger review. The desk **must not** drift paper behavior toward Mode 4 (small live capital) until it demonstrates at least four sessions of above-random directional skill with decay-calibrated entries and full auditability. Production deployment (Mode 4/5) is gated by evidence; this five-session block is the evidence-gathering stage, not the deployment gate.

A session ends when the quote/feed becomes stale, when one open position is unresolved at the configured cutoff, or when the agent's own dynamic evaluation of the open position and remaining session risk budget calls for it. Unavailable F&O data means observation only—not a synthetic paper fill.

## Historical underlying import

A retry-safe importer is available at `scripts/fetch-yahoo-history.js`:

```bash
node scripts/fetch-yahoo-history.js
```

It fetches Yahoo chart data with `range=5y` and `interval=1d` by default for the configured NIFTY 50, BANK NIFTY, and SENSEX mappings, then stores daily OHLCV rows in `fnf_market_snapshots` through the existing paper-trading ingestion route. Set `YAHOO_HISTORY_RANGE` or `YAHOO_HISTORY_INTERVAL` in the environment to change the request. Imports are de-duplicated by instrument plus market timestamp, so rerunning the importer is safe.

This is historical underlying/index data only. It must not be used to create F&O premiums, CE/PE P&L, Greeks, strikes, lot sizes, future contract values, or synthetic F&O fills. Historical F&O option-chain and future-contract data remains blocked until a validated broker/derivatives source is available.

## Interim Yahoo operating rule

Polls may repeat the current 1-minute candle. The feed now accepts only a newer Yahoo candle timestamp per instrument for snapshot persistence and status tick counting. Yahoo remains unsuitable as the sole source for unrestricted NSE F&O option-chain selection, Greeks, option premiums, or future contract pricing; those capabilities remain blocked until a validated broker/derivatives feed is available.
