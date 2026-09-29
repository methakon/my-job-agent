# Expiry-Day Decision Engine — framework, data reality, and validation state

Status: **RESEARCH / PAPER ONLY. NOT ARMED.**
Last updated: 2026-09-29 (01:30 IST), branch `feat/expiry-decision-engine`.

Companion documents: `EXPIRY_DAY_RESEARCH.md` (the factor-by-factor literature
review with sources) and `EXPIRY_DAY_PLAYBOOK.md` (the manual operator playbook
and T-1 preparation runbook).

---

## 1. What this engine is, and the one thing it is not

It is a **data-driven classifier** that decides, on every expiry day, whether the
observed conditions are more consistent with bullish continuation, bearish
continuation, range/pin, opening-range breakout, false-break reversal, or
**no trade**. It produces an evidence-weighted view, a regime, a set of setup
candidates, and a machine-readable explanation for every cycle.

It is **not** a strategy that trades. It cannot. There is no order path in this
codebase, and every output carries:

```json
"authority": { "canPlaceOrder": false, "canSizePosition": false,
               "existingRiskEngineRemainsSoleAuthority": true }
```

The existing FNF risk engine remains the only sizing authority, with its
ceilings unchanged. No threshold, limit, `.env` value, PM2 process or broker
credential was modified by any of this work.

## 2. The central design decision: a phenomenon is not a rule

The single most important rule in the engine is that **no single factor can set
direction**. This is enforced in code, not by convention:

| Factor | Score weight in `EXPIRY_MICROSTRUCTURE_SCORE` / `OI_WALL_SCORE` | Why |
|---|---|---|
| max pain | 0.0 | context only; no academic support at index level |
| PCR (OI) | 0.0 | positioning statistic, not a directional vote |
| call wall / put wall | 0.0 (corridor observation only) | a wall is a *range* concept; acceptance is measured, not assumed |
| ATM straddle | used as *expected range* | priced expectation, not direction |
| dealer gamma proxy | 0.0 | the sign of the dealer book is **not observable**; the assumption is stated in the output |

`OI_WALL_SCORE` reports whether spot is inside or outside the wall corridor
because that is a **location fact**. It never votes a side. There is a test
(`max pain / PCR / walls never produce a directional vote`) that fails if this
ever changes.

A research finding is evidence that a *phenomenon exists in some sample*, not
evidence that a given strike will be tomorrow's target. `EXPIRY_DAY_RESEARCH.md`
states this per factor, and every setup in `expiry-day-setups.js` carries
`historicalTestRequired: true`.

## 3. Two-stage separation: direction is not an entry

```
STAGE 1  classifyDirection()   →  BULLISH | BEARISH | RANGE | REVERSAL | NO_TRADE
                                    + 15 evidence buckets, each with score,
                                      confidence, freshness, reason
                                    + SIGNAL_CONFLICT flag
                                    + confidence explicitly UNCALIBRATED

STAGE 2  evaluateTradeable()   →  ELIGIBLE_FOR_PAPER_ONLY | NO_TRADE
                                    12 gates: direction, conflict, freshness,
                                    location, liquidity, spread, IV, time,
                                    move-vs-cost, not-extended, R:R, policy
```

A bullish bias with a 12% bid/ask spread, 8 minutes to the close, or no
operator approval is **NO TRADE**. There are individual tests for each of those
(`wide spread blocks even when the view is bullish`, and so on).

`POLICY_PERMITS` is hard-wired `false` in the CLI. The strategy cannot be
armed by configuration accident.

## 4. Data reality (verified 2026-09-29 against the live Oracle MySQL)

### Available and good
- **Option ladder**: `unified_option_quotes` / `..._history` — 478,387 rows on
  2026-09-28 alone, 221 distinct instruments, with **100% coverage** of `bid`,
  `ask`, `bidQty`, `askQty`, `volume`, `oi`, `previousOi`, `changeOi`, `iv`,
  `delta`, `gamma`, `theta`, `vega`, `depth`. This is the strongest asset we
  have and it is genuinely usable.
- **Index tape**: `unified_market_snapshots_history` — 43,681 rows for NIFTY on
  2026-09-28 (5-minute resolution across the session), LTP + volume + depth.
- **Expired-ladder data for the T-1 report**: 21 two-sided strikes per index
  with OI, ΔOI, volume, IV, straddle.

### Unavailable — and therefore explicitly abstained, never faked
- **Index futures**: **0 rows** anywhere. `FUTURES_BASIS_SCORE` abstains with
  the reason string "NO FUTURES DATA CAPTURED".
- **Breadth / index components**: no OHLC component feed. `BREADTH_SCORE`
  abstains.
- **Index order-book depth**: the index tape has `depth` but **no bid/ask
  columns** (both NULL across all days), so `ORDERBOOK_SCORE` abstains. The
  *option* ladder does have bid/ask, so spread is measurable there.
- **Pre-open auction**: `pre_open_observations` has 3 rows, all 2026-09-11
  `CLOSED`/`UNAVAILABLE`. Effectively no usable history.
- **Historical expiry sessions**: **ZERO**. See §5.

The abstention design means a missing feed produces a visible "abstained"
bucket and a `NO_TRADE` verdict, never a silent assumption.

## 5. The honest headline: no backtest is possible yet

`node scripts/expiry-day.js backtest` reports, from the live tape:

```
NIFTY:      3 index sessions (2026-09-09 … 2026-09-11)
BANKNIFTY:  3 index sessions
SENSEX:     3 index sessions
→ NO EXPIRY SESSION HAS EVER BEEN CAPTURED.
```

Not one of the dates we hold (2026-09-09 … 09-28) is a NIFTY/BANKNIFTY expiry
(Tuesday) or a SENSEX expiry (Thursday). **2026-09-29 is the first expiry day
this system will ever see.** Consequences:

- Every setup A–H is an **unvalidated hypothesis**. `validated: false` and
  `confidenceIsCalibrated: false` appear in the output of every cycle.
- The backtest returns `INSUFFICIENT_DATA` with a collection plan instead of
  statistics. Fabricating them would be the one genuinely harmful thing this
  project could do.
- `MIN_FOR_CONFIDENCE = 20` expiry sessions (~20 weeks) is enforced in code.

**Collection plan**: capture index ticks + option ladder on every NIFTY and
BANKNIFTY Tuesday and SENSEX Thursday; the VM worker already does this for
trading days, so the data accumulates automatically from today onward. Add a
futures tape if `FUTURES_BASIS` is ever to be a live bucket, and a component
feed for breadth.

## 6. Correctness bugs found and fixed while building this

Each was caught by the engine's own run against live data, not by inspection:

1. **Session clipping.** The index tape is a **24×7 quote stream** (first ticks
   00:56 IST, last 23:59 IST on 2026-09-28). Building the opening range from
   "the first bars of the day" produced a degenerate OR (high == low) and a
   fake "held DOWN break". Fixed by clipping to 09:15–15:30 IST in
   `buildBars`, with a named regression test. Live effect: realised range
   corrected from a spurious 378 pts to the true 92.95 pts.
2. **`Number(null) === 0`.** A missing bid became a 200% spread in the cost
   gate; a null `timeToTargetMin` became a 0-minute time-to-target that
   dragged averages down. Both fixed with explicit null guards.
3. **Retest detection counted the breakout bar itself**, so every genuine
   breakout was classified as failed. Fixed; `breakFailed` is now exposed
   explicitly for the reversal setups.
4. **Abstentions diluted the regime score**, letting missing data veto a real
   trend (a textbook trend scored 38.9% and was rejected). Abstentions are now
   excluded from the denominator and reported separately.
5. **Symbol aliasing.** The tape writes NIFTY as `NSE:NIFTY50` on some days
   and `NSE:NIFTY50-INDEX` on others. A single-key query returned 0 ticks and
   read as "no market activity" rather than "wrong key". Aliases are now
   unioned.

## 7. Current state of the 2026-09-29 session (T-1 reference only)

Per the operator instruction, these are **reference levels, not a conclusion**:

| | NIFTY 29SEP | BANKNIFTY 29SEP | SENSEX 01OCT |
|---|---|---|---|
| spot (T-1 close) | 22,780.25 | 54,471.65 | 72,771.72 |
| max pain | 22,900 | 54,800 | 73,000 |
| call wall | 23,000 | 55,000 | 73,500 |
| put wall | 22,800 | 54,000 | 72,000 |
| ATM straddle | 153.55 (±0.674%) | 464 (±0.85%) | 861.9 (±1.18%) |

SENSEX has **no expiry on 2026-09-29** (Thursday series); its next is 2026-10-01.
It is monitored for lead/lag context, not as an expiry day.

"Max pain sits above spot" is **not** converted into "bullish". At the open the
engine recomputes everything from fresh data and will very likely return
`NO_TRADE`, which is the correct outcome until evidence accumulates.

## 8. Files

| File | Role |
|---|---|
| `scripts/expiry-day-core.js` | IST clock, session clipping, freshness contract, bars/OR/VWAP, Black–Scholes, OI structure |
| `scripts/expiry-day-regime.js` | PIN_RANGE / TREND / REVERSAL / UNKNOWN classifier |
| `scripts/expiry-day-signals.js` | 15 evidence buckets, conflict detection, decoupled tradeability gate |
| `scripts/expiry-day-setups.js` | Setups A–H as explicit hypotheses |
| `scripts/expiry-day-analysis.js` | READ-ONLY data access + cycle orchestration |
| `scripts/expiry-day-backtest.js` | metrics, walk-forward discipline, honest refusal |
| `scripts/expiry-day-paper-journal.js` | local JSONL hypotheticals |
| `scripts/expiry-day.js` | CLI |
| `scripts/expiry-prep.js` | T-1 universe generator + prep report |

## 9. Commands

```bash
node scripts/expiry-prep.js generate --width 12     # recentred universe from broker master
node scripts/expiry-prep.js report                   # T-1 OI/walls/max-pain/straddle report
node scripts/expiry-day.js preopen  --index NIFTY    # opening classification
node scripts/expiry-day.js regime   --index NIFTY    # regime + evidence table
node scripts/expiry-day.js signals  --index NIFTY    # all 15 buckets, verdict
node scripts/expiry-day.js analyze  --index NIFTY    # full cycle + journal append
node scripts/expiry-day.js backtest                  # session inventory + refusal
node scripts/expiry-day.js paper-report              # today's cycle summary
```

Every command writes JSON to `reports/expiry-day/` (gitignored).

## 10. What would justify arming this — in order

1. ≥20 captured expiry sessions per index (≈20 weeks, automatic from today).
2. Backtest per setup per index per regime with MAE/MFE/PF/expectancy and
   false-breakout rate, **including losing days**.
3. Walk-forward TRAIN/VALIDATION/OOS with every threshold sourced and dated;
   anything that only works in-sample is marked OVERFIT.
4. Shadow/paper run recording every hypothetical signal with full provenance.
5. Operator review of the OOS numbers, then an explicit arming decision.
6. Only then does clarification #29 (expiry-day policy) get a final answer.

Until step 6, `POLICY_PERMITS=false` stands and the correct daily output is
`NO_TRADE`.
