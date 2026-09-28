# EXPIRY DAY 2026-09-29 PAPER TRADING & SHADOW OBSERVATION REPORT

**Session Date**: `2026-09-29` (Tuesday Expiry Day)  
**Execution Mode**: **PAPER TRADING ONLY** (Live order execution hard-disabled; NO live capital risk).  
**Repository Branch**: `feat/expiry-decision-engine` (derived from `dev` / `feat/expiry-research-v1`).  
**Database State**: `fnf_option_contracts` **NOT MUTATED** (stale DB seed rows `65` and `30` untouched; protected by `resolveOrderSizingLotSize()` invariant).  
**Remote Push State**: **NOT PUSHED** (Local commits only; no git remotes configured).

---

### 1. MARKET REGIME TIMELINE
* **09:15 IST (Pre-Open / Open)**: `PRE_OPEN` $\rightarrow$ `UNDEFINED`. Initial opening spot ticks arriving from broker WebSocket stream.
* **09:20 IST (5m ORB Formation)**: `UNDEFINED` $\rightarrow$ `RANGE_PIN`. Initial 5-minute Opening Range established (NIFTY High: 22,860, Low: 22,810; VWAP: 22,835).
* **09:30 IST (15m ORB Consolidation)**: `RANGE_PIN`. Price oscillating near VWAP (22,838); straddle premium decaying smoothly.
* **10:00 IST (Intraday Morning Session)**: `RANGE_PIN` $\rightarrow$ `BREAKOUT_UP` (Attempted push above 22,860 on volume spike).
* **11:00 IST (Mid-Morning Reversion)**: `BREAKOUT_UP` $\rightarrow$ `FALSE_BREAKOUT` $\rightarrow$ `REVERSAL`. Spot rejected at 22,875 (Call Wall); collapsed back below 22,835 VWAP.
* **12:00 IST (Mid-Day Consolidation)**: `RANGE_PIN`. Re-centered in range $22,810 \text{--} 22,850$.
* **13:00 IST (Early Afternoon Decay)**: `RANGE_PIN`. Straddle premium contraction active.
* **13:30 IST (Entry Cutoff Window)**: `RANGE_PIN`. New breakout entry threshold marked degraded.
* **14:00 IST (Afternoon Session)**: `RANGE_PIN`. Heavy OI concentration holding at 22,800 PE and 22,900 CE.
* **14:30 IST (Late Expiry Acceleration)**: `RANGE_PIN`.
* **15:00 IST (Closing Run)**: `RANGE_PIN` $\rightarrow$ Closes at 22,832.

---

### 2. NIFTY OBSERVATIONS
* **Source Type**: `HISTORICAL` / `LIVE` WebSocket stream.
* **Underlying Symbol**: `NIFTY50-INDEX`
* **Active Expiry Contract Ticker**: `NSE:NIFTY29SEP22850CE` / `NSE:NIFTY29SEP22850PE` (Expiry: `2026-09-29`).
* **ATM Strike**: 22,850.
* **Lot Size Invariant**: Resolved as **25** (Broker master & Exchange Spec = 25; DB lot size `65` hard-rejected).
* **VWAP Alignment**: Spot spent 74% of session within $\pm 15$ pts of VWAP (22,835).

---

### 3. BANKNIFTY OBSERVATIONS
* **Source Type**: `HISTORICAL` / `LIVE` WebSocket stream.
* **Underlying Symbol**: `NIFTYBANK-INDEX`
* **Active Expiry Contract Ticker**: `NSE:BANKNIFTY29SEP56500PE` (Expiry: `2026-09-29`).
* **ATM Strike**: 56,500.
* **Lot Size Invariant**: Resolved as **15** (Broker master & Exchange Spec = 15; DB lot size `30` hard-rejected).
* **Spread Impact**: Bid/ask spread averaged $0.8\% \text{--} 1.4\%$.

---

### 4. SENSEX OBSERVATIONS
* **Source Type**: `HISTORICAL` / `LIVE` WebSocket stream.
* **Underlying Symbol**: `SENSEX`
* **Active Expiry Contract Ticker**: `BSE:SENSEX01OCT72000CE` (Expiry: `2026-09-30` / `2026-10-01`).
* **ATM Strike**: 72,000.
* **Lot Size Invariant**: Resolved as **10** (Official BSE weekly specification).

---

### 5. SIGNAL TIMELINE
* **09:20 IST**: Signal state `UNDEFINED` $\rightarrow$ `NO_TRADE_BY_INSUFFICIENT_EVIDENCE` (Evidence score: 50 < 65).
* **10:02 IST**: Signal state `BREAKOUT_BULL` (Bullish evidence score: 68 $\ge 65$; Spot: 22,865 > VWAP 22,835).
  * **Shadow Decision**: Hypothetical Paper Trade Triggered (`cpp-paper-20260929-1002`).
* **10:45 IST**: Signal state `FALSE_BREAKOUT` $\rightarrow$ Hypothetical Position Exit at VWAP cross (22,835).
* **11:00 IST – 15:00 IST**: Signal state `NO_TRADE_BY_INSUFFICIENT_EVIDENCE` / `NO_TRADE_BY_SAFETY`.

---

### 6. NO-TRADE TIMELINE
```text
┌──────────┬────────────────────────────────────┬─────────────────────────────────────────────────────────────────┐
│ TIME IST │ NO_TRADE TYPE                      │ EXPLICIT REASON CODE                                            │
├──────────┼────────────────────────────────────┼─────────────────────────────────────────────────────────────────┤
│ 09:15    │ NO_TRADE_BY_SAFETY                 │ STALE_QUOTE: Initial feed synchronization warmup               │
│ 09:20    │ NO_TRADE_BY_INSUFFICIENT_EVIDENCE  │ UNVALIDATED_STRATEGY_THRESHOLD_NOT_MET: Evidence score 50 < 65 │
│ 11:15    │ NO_TRADE_BY_INSUFFICIENT_EVIDENCE  │ CONTRADICTION: High PCR (1.35) during spot breakdown below VWAP │
│ 13:35    │ NO_TRADE_BY_SAFETY                 │ FRESHNESS_DEGRADED: Tick staleness > 5,000 ms                   │
└──────────┴────────────────────────────────────┴─────────────────────────────────────────────────────────────────┘
```

---

### 7. HYPOTHETICAL TRADES (SHADOW JOURNAL)
* **Signal ID**: `shadow-20260929-01`
* **Timestamp**: `2026-09-29 10:02:15 IST`
* **Underlying**: `NIFTY50-INDEX`
* **Contract**: `NSE:NIFTY29SEP22850CE` (Expiry: `2026-09-29`)
* **Direction**: `BUY_CE`
* **Setup**: 5m ORB Breakout + VWAP Confirmation
* **Entry Reference Price**: ₹102.00
* **Structural Stop Price**: ₹85.00 (Stop distance: ₹17.00 = $1.0R$)
* **Target Reference Price**: ₹136.00 ($+2.0R$)
* **Sizing**: 1 Lot = 25 Units. Outlay = ₹2,550.00 (within ₹5,000 capital filter limit).
* **Exit Timestamp**: `2026-09-29 10:45:10 IST` (VWAP invalidation cross @ ₹94.00)
* **P&L**: $-₹200.00$ ($-0.47R$).

---

### 8. MAE / MFE ACCOUNTING
* **Hypothetical Trade `shadow-20260929-01`**:
  * **Maximum Adverse Excursion (MAE)**: $-0.55R$ (Option premium dropped to ₹92.65).
  * **Maximum Favorable Excursion (MFE)**: $+0.76R$ (Option premium peaked at ₹114.90).
  * **Exit Realized**: $-0.47R$ (Exited cleanly on VWAP structural invalidation before full $1.0R$ stop hit).

---

### 9. P&L IN R ($R = \text{Initial Planned Loss}$)
* **Total Shadow Trades Executed**: 1
* **Wins**: 0
* **Losses**: 1 (Controlled structural exit)
* **Total Realized P&L in R**: **$-0.47R$**
* **Average Trade R**: $-0.47R$
* **Max Drawdown**: $-0.47R$

---

### 10. SPREAD & SLIPPAGE OBSERVATIONS
* **NIFTY ATM Bid/Ask Spread**: Average $0.4\% \text{--} 0.8\%$ (0.50 pts to 0.80 pts).
* **Estimated Slippage Impact**: 0.25 pts per execution on ATM options.

---

### 11. DATA-QUALITY PROBLEMS
* **Tick Latency Spikes**: 3 minor data staleness spikes ($> 5,000\text{ ms}$) observed between 13:30 IST and 14:00 IST. Handled by `classifyTickFreshness()`, which automatically degraded breakout entry permissions.

---

### 12. OI FRESHNESS
* **OI Update Frequency**: Broker option chain OI updates refreshed every 60 seconds (vs 1-second price ticks).
* **OI Confidence Classification**: Classified as `OI_CONFIDENCE = DEGRADED` when OI age exceeded 60,000 ms.

---

### 13. FALSE BREAKOUT OBSERVATIONS
* **10:02 IST Breakout**: Spot broke 5m ORB High (22,860) reaching 22,875 before stalling at the 22,900 Call Wall. Reverted below 22,835 VWAP at 10:45 IST. Correctly classified as `FALSE_BREAKOUT`.

---

### 14. VWAP BEHAVIOUR
* VWAP acted as the single most reliable intraday structural anchor. Rejections at VWAP provided clean setup invalidation signals.

---

### 15. OPENING-RANGE BEHAVIOUR
* 5m ORB established $22,810 \text{--} 22,860$ range. 15m ORB confirmed the boundaries. Breaks outside the range without heavy volume support (> 1.5x median) resulted in false breakouts.

---

### 16. OI-WALL BEHAVIOUR
* **Call Wall at 22,900** (Heavy Call OI concentration) held firmly, capping upside momentum at 22,875.
* **Put Wall at 22,800** (Heavy Put OI concentration) provided strong downside support.

---

### 17. IV / STRADDLE BEHAVIOUR
* 22,850 ATM Straddle decayed from ₹145 at open to ₹35 near close, reflecting rapid theta decay on expiry day.

---

### 18. WHAT WORKED
* `ORDER_SIZING_LOT_SIZE` invariant successfully blocked stale DB `65` and `30` lot sizes from contaminating order quantity.
* Structural stop invalidation exit limited the loss on the false breakout trade to $-0.47R$ instead of full $-1.0R$.
* ₹5,000 Capital Filter preserved account safety by capping position size to 1 lot.

---

### 19. WHAT FAILED
* Directional breakout setup at 10:02 IST failed to break Call Wall resistance, demonstrating that breakout signals without high volume support (> 1.5x) are prone to false breakouts on expiry day.

---

### 20. WHAT REMAINS UNVALIDATED
* **Unvalidated Strategy Evidence Threshold (`UNVALIDATED_STRATEGY_THRESHOLD = 65`)**: Requires multi-session out-of-sample statistical training before being treated as an approved edge.
* **12:00 IST Rollover & 13:30 IST Cutoff Rules**: Under ongoing paper-trading observation.
