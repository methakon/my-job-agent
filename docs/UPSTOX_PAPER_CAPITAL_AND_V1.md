# Configurable paper capital + UPSTOX_AUTO_PAPER_ENTRY_V1

Status: implemented and verified 2026-09-10. FNF (`/fnf-trading`, `fnf_*` tables, FNF funds
and strategy) is untouched: no FNF file was modified and `fnf_trades` / `fnf_portfolios`
row counts are unchanged.

## 1. Why

The Upstox paper desk's capital used to be the number `5000` baked into the account and
its strategy. Training needs the cap to be a **configuration**, not a constant: ₹2,000,
₹5,000, ₹10,000 or any other value, changeable without touching code, with every risk
number derived from it and the trading logic unchanged.

Two rules drive the design:

* **Normalized measurement.** The strategy reasons in ratios / ATR multiples
  (confidence 0–1, spread %, ATR multiples, reward:risk). Changing the cap changes
  *position sizing and exposure only* — never a threshold, direction or signal.
* **Per-configuration history.** A capital change never rewrites the past. Trades,
  P&L events and training sessions keep the capital they were produced under.

## 2. Capital

| Where | What |
|---|---|
| `UPSTOX_LIVE_PAPER_CAPITAL` | default capital for a **new** account (default 5000) |
| `upstox_live_paper_portfolios.capital` | the account's own configured capital — the live value |
| `POST /upstox-live-paper/portfolios/:id/capital` | change it: `{ "capital": 2000, "reason": "..." }` |
| `GET /upstox-live-paper/risk` | every account's effective envelope |
| `GET /upstox-live-paper/risk/:id` | one account: policy, snapshot, active session |

`clampCapital` floors nonsense input at `MIN_CONFIGURABLE_CAPITAL` (100) and falls back to
the default when the value is not a positive number, so a bad value can never leave an
account with a zero envelope.

**Changing the cap does not require code changes and does not touch FNF.**

### Risk envelope (all from the configured capital)

| Limit | Default | Formula |
|---|---|---|
| risk per trade | 1 % | `riskBase × UPSTOX_RISK_MAX_TRADE_PCT` |
| max session loss | 10 % | `sessionStartEquity × UPSTOX_RISK_MAX_LOSS_PCT` |
| max drawdown | 20 % | `peakEquity × UPSTOX_RISK_MAX_DRAWDOWN_PCT` |
| exposure ceiling | capital | `configuredCapital` (PAPER) |
| open positions | 1 | `UPSTOX_RISK_MAX_POSITIONS` |
| lots per position | 1 | `UPSTOX_RISK_MAX_LOTS` |
| averaging down | never (policy constant, not a toggle) | — |
| min reward:risk | 1.5 | `UPSTOX_RISK_MIN_RR` |

Verified live (same account, capital changed and restored):

| configured | risk/trade | max loss | drawdown | exposure |
|---|---|---|---|---|
| ₹2,000 | ₹20 | ₹200 | ₹400 | ₹2,000 |
| ₹5,000 | ₹50 | ₹500 | ₹1,000 | ₹5,000 |
| ₹10,000 | ₹100 | ₹1,000 | ₹2,000 | ₹10,000 |

### Training sessions

Each session row (`upstox_live_paper_sessions`) records the capital it ran with:
`startingCapital`, `startingEquity`, `endingEquity`, `sessionNetPnl`, `peakEquity`, a frozen
copy of the risk policy and `strategyVersion`.

A mid-session capital change closes the active row as `SUPERSEDED` (its numbers kept
verbatim, with `supersededReason`) and opens a fresh `OPEN` row under the new capital, so
max-loss and drawdown re-anchor to what is actually configured. Measured peak/drawdown
consider only the current configuration, which is why the limits scale instead of
inheriting the old cap.

### REAL mode (interface only — NOT activated)

`UPSTOX_RISK_MODE` defaults to `FIXED_CAPITAL`. The alternative,
`ACCOUNT_BALANCE_PCT`, computes risk and exposure from the **current real account balance**
at execution time:

* risk base = `AccountBalanceProvider.balancedAtExecution()` (`RealAccountBalanceProvider`)
* risk/trade = balance × `UPSTOX_RISK_MAX_TRADE_PCT`
* exposure ceiling = balance × `UPSTOX_RISK_BALANCE_PCT` (default 25 %)

Nothing activates it: no real order path is enabled and `UPSTOX_SANDBOX_ENABLED` is
unchanged. `AccountBalanceProvider` is the seam a real balance feed plugs into.

## 3. UPSTOX_AUTO_PAPER_ENTRY_V1

Versioned, unattended entry/exit policy for the paper account, independent of FNF's rule
(`UPSTOX_AUTO_PAPER_ENTRY_V1` is stored on every trade, candidate and session).

**Entry** — all must hold; any failure is a recorded NO-TRADE:

1. ATM CE/PE only, one lot, one open position, never averaging down
2. fresh tick + acceptable liquidity (spread % / depth / tick age)
3. underlying **and** option direction confirmation
4. confidence ≥ `UPSTOX_V1_MIN_CONFIDENCE` (0.65)
5. reversal setups require reversal score ≥ `UPSTOX_V1_MIN_REVERSAL_SCORE` (0.60)
6. not excessively extended (≤ `UPSTOX_V1_MAX_EXTENSION_ATR` × ATR beyond the level)
7. structural stop defined **before** entry (structure ∓ `UPSTOX_V1_STOP_ATR_BUFFER` × ATR)
8. reward:risk ≥ `UPSTOX_V1_MIN_REWARD_RISK` (1.5), target from structure/ATR — not reverse-fitted
9. planned loss ≤ 1 % of current paper equity, else **NO TRADE** (a lot that cannot respect
   the limit with a valid stop is refused)

The thresholds are the operator's: they are deliberately *not* loosened to manufacture
trades. On 2026-09-10 the desk's best candidate scored 0.5062 confidence / 0.38 reversal —
correctly NO TRADE under V1.

**Position management:** protect the initial risk first; 2 × ATR adaptive trailing
(`UPSTOX_V1_TRAIL_ATR_MULTIPLE`); exit on setup invalidation or reversal/exhaustion; structural
stop never widened. Experimental: 50 % partial at 2 × ATR (`UPSTOX_V1_PARTIAL_ENABLED`,
off by default) and the expiry-day time stop (`UPSTOX_V1_EXPIRY_DAY_TIME_STOP_MINUTES`, 15:15 IST).

**Every candidate is journalled** (`upstox_live_paper_candidates`) — executed *and*
refused: all feature scores, thresholds in force, stop/target/R:R, sizing, refusal reasons,
MFE/MAE, post-decision outcomes at 5/10/15/30/60 min, and a classification
(`MISSED_WINNER`, `FALSE_BREAKOUT`, `PREMATURE_EXIT`, `LATE_ENTRY`, …).

Rejects use the shared feature engine (`pattern-features.ts`), so a V1 confidence means the
same thing as the engine's confidence — comparable across desks and to the recorded history.

| Endpoint | Purpose |
|---|---|
| `GET /upstox-live-paper/entry-policy` | version, enable flag, thresholds in force |
| `POST /upstox-live-paper/auto-entry/run` | run the loop once (skips outside the session) |
| `GET /upstox-live-paper/journal?portfolioId=…&sessionDate=…` | candidates + stats |
| `POST /upstox-live-paper/journal/:candidateId/label` | fill post-exit outcomes |

The loop runs every `UPSTOX_AUTO_PAPER_INTERVAL_SEC` (30 s) inside 09:15–15:30 IST only,
for accounts with `autoTradeEnabled`. Off-session it is inert (verified after hours:
`session: false`, `considered: 0`). It opens at most one position and manages exits before
considering new entries. It reads the desk's own live tick store; the shared normalized
tick store remains the one stream, with broker specifics behind the desk adapter.

## 4. Tests

`npm run test:entry-policy` — 89 pure checks (no DB, no HTTP): capital configurability and
scaling, sizing scaling with 1-lot cap, envelope refusals (positions, averaging, session
loss, drawdown, deployable), V1 gates incl. the 2026-09-10 NO-TRADE evidence, exit/trailing
behaviour, the REAL-mode interface, and a static check that the desk's strategy code
references no FNF account/fund state.

Regression: `test:desks`, `test:pattern`, `test:precleared`, `test:clarifications`.
