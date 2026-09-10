# SENSEX 2026-09-10 — Option Trade Learning Case

**Scope:** learn a *general* decision framework (entry / confirmation / hold / partial exit /
trailing / full exit / re-entry / no-trade) from one real trading day, using the real order
history **and** the real tick tape. This document does **not** change any live strategy.
Nothing here is promoted to the trading engine until it survives historical + paper validation.

Author: Hermes · Generated 2026-09-10 · Data files: `orders.csv` (Zerodha) + desk tick store

---

## 0. DATA PROVENANCE (read this first — it bounds every conclusion)

| Item | Reality |
|---|---|
| Orders | `/home/swarna-sekhar-dhar/Downloads/zerodha/orders.csv` — 14 rows, 12 filled + 2 cancelled |
| Charts | The three 5-min chart **images never arrived in the workspace** (CLI session has no image channel). Instead of describing shapes from memory, the 5-min OHLC for **every** SENSEX strike 73600–75900 (CE and PE) was **reconstructed from the desk's own tick store** (`upstox_live_paper_option_quotes`, 2,700–2,900 quotes per contract, 12:15:54→15:34:58 IST) plus index snapshots. |
| Tool | `scripts/extract-desk-tape.js` + `scripts/option-trade-learning.js` (both in repo, reusable) |
| Coverage limit | Tape starts **12:15:54**. The first four 74600PE buys (11:10, 11:13, 11:59, 12:00) predate it → their MFE/MAE cannot be measured before 12:15. |
| Mismatch found | The orders contain **74600PE**, not 74900PE. 74900PE (chart #1) was **not traded in this orderbook** → analysed as the lab contract. 74700PE and 74900CE match charts #2/#3 and were traded. |
| Data defects | Post-15:30 quotes are junk (ltp 0.05, sentinel). Index feed froze at 74,629.50 for 15:15–15:20 and one bar (14:20) is missing; the 15:25 recovery to 74,902.59 **is real** — independently corroborated by the whole chain (OTM PEs → 0.05, ITM CEs → 1411). IV ~0 on many rows; `bid = 0` on ≈43% of rows (one-sided). |

Conclusion rule used throughout: **anything the tape does not show is reported as unknown, not estimated.**

---

## 1. RECONSTRUCTED TRADES (chronological, real)

| # | Contract | Qty | Entry (VWAP) | Exit | Hold | Gross | Costs | **Net** | MFE | MAE | Capture in-hold |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 74600 PE | 100 | 75.75 (5 legs 11:10→12:19) | 82.00 @13:06 | 116 m | 625.00 | 156.57 | **+468.43** | 80.40 | 54.05 | 100% |
| 2 | 74700 PE | 20 | 92.00 @13:14 | 105.00 @13:27 | 13.2 m | 260.00 | 50.99 | **+209.01** | 104.25 | 86.35 | 100% |
| 3 | 74900 CE | 20 | 76.20 @13:33 | 80.00 @13:35 | 1.9 m | 76.00 | 50.14 | **+25.86** | 77.90 | 73.15 | 100% |
| 4 | 74600 PE | 20 | 80.00 @14:25 | 105.00 @14:37 | 13.0 m | 500.00 | 50.88 | **+449.12** | 103.40 | 93.10 | 100% |
| | **TOTAL** | | | | | **1,461.00** | **308.58** | **+1,152.42** | | | |

Cancelled / not filled (behavioural evidence, §23):
- 12:37:56 SELL 100 × 74600PE @ **90** — never filled (market was ~66–73 then) → the eventual exit came 29 min later at 82.
- 13:30:44 BUY 20 × 74900CE @ 78 — cancelled, then bought at **76.20** (better price, same idea 2.5 min later).

**Cost model (Zerodha F&O options, verified arithmetic):** brokerage ₹20/order · STT 0.1% of sell premium · exchange 0.03503% of premium · SEBI ₹10/cr · stamp 0.003% buy · GST 18% on (brokerage+exchange+SEBI).
Cost per unit: **1.57 / 2.55 / 2.51 / 2.54 points** = **2.1% / 2.8% / 3.3% / 3.2% of entry premium**.

> **Finding C1 (hard constraint).** Round-trip friction is ≈2–3.3% of premium, and **21.1% of gross profit** today. Trade #3 (2-minute CE scalp) grossed ₹76 against ₹50 costs — a **66% cost ratio**: it was a coin-flip that needed a 3.3% favourable move just to break even. Any entry rule must clear a **cost-relative minimum edge** (≈3–4× round-trip cost), not a direction call.

---

## 2. MFE / MAE / CAPTURE — and the honest definition of "missed profit"

Two different capture ratios, both true:

| # | Capture **while in the trade** | Capture **of the whole day's runway** | Peak after exit | Gain left | Damage avoided by exiting |
|---|---|---|---|---|---|
| 1 | 100% (exit 82 = local MFE 80.40) | 5.3% | 193.95 @15:16 | ₹11,195 | ₹8,195 (to 0.05) |
| 2 | 100% (exit 105 = local MFE 104.25) | 7.9% | 257.50 @15:12 | ₹3,050 | ₹2,099 |
| 3 | 100% (exit 80 = local MFE 77.90) | 4.9% | 153.45 @15:28 | ₹1,469 | ₹1,549 |
| 4 | 100% (exit 105 = local MFE 103.40) | 21.9% | 193.95 @15:16 | ₹1,779 | ₹2,099 |

**Every exit was at or above the tape's local extreme inside the holding window.** These were *not*
premature exits — they were sharp local exits. The "missed profit" is a **different trade that was
never taken**: the 14:45–15:15 expansion. Trade #1's 5.3% day-capture looks terrible in isolation —
until you see §3, where holding for it meant risking a −90% single-bar wipeout.

---

## 3. THE DECISIVE FINDING — the peak window was 15 minutes (expiry-day asymmetry)

Every contract, same day, same tape (bars with close ≥80% of the contract's session max):

| Contract | Max | At | Close | Close as % of max | Bars ≥80% of max | Window |
|---|---|---|---|---|---|---|
| 73600 CE (deep ITM) | 1442.7 | 15:25 | 1411.45 | 97.8% | 2 | 15:20–15:25 |
| 73900 CE | 1170.85 | 15:25 | 1003.2 | 85.7% | 11 | 12:15–15:30 |
| 74600 CE | 456.0 | 15:25 | 302.3 | 66.3% | 2 | 15:20–15:25 |
| 75800 PE (deep ITM) | 1087.35 | 14:45 | 895.2 | 82.3% | 26 | 12:15–15:30 |
| **74600 PE** (traded) | **193.95** | 15:15 | **0.05** | **0%** | 3 | 15:05–15:15 |
| **74700 PE** (traded) | 257.50 | 15:10 | 0.05 | 0% | 4 | 15:00–15:15 |
| **74900 PE** (lab / chart #1) | **420.10** | 15:10 | 0.15 | 0% | 4 | 15:00–15:15 |
| **74900 CE** (traded) | 153.45 | 15:25 | 3.90 | 2.5% | 6 | 12:15–15:25 |

1. **ITM contracts hold value all session; OTM contracts die.** Deep-ITM (CE and PE) spent 26–38 bars in the top 20% of their range and closed near their highs. Every OTM contract spent **3–6 bars** there and closed at **0%** of its max.
2. **The OTM peak was reachable for ~15 minutes (15:00–15:15).** SENSEX bottomed at **74,609.9 (15:00)**, and the PE ladder peaked **15:10–15:15** — i.e. the option peak **lagged the underlying low by ~10 minutes**.
3. SENSEX then ran **74,629 → 74,902.6 (15:25)**, wiping every OTM PE (420 → 0.15) and vaulting every CE (2.55 → 153.45) in **two 5-minute bars**.

> **Finding E1.** On expiry day, an OTM/ATM option's unrealized peak is only realizable in a ~15-minute window that ends with a violent reversal. A trading plan whose exit requires being "near the top" is un-executable; a plan that must be **flat or hard-protected before the last 20 minutes** is.
>
> **Finding E2 (why this makes "capture 100% of MFE" the wrong target).** Exit policy "hold to 15:30" is the empirical control: **₹−3,146 on just 2 trades** (−82% avg capture, −98.3% MAE). His discretionary exits were **+₹1,152**. On this day, the boring exits were correct.

---

## 4. AVERAGING-DOWN ANALYSIS — the 74600PE ladder

Legs: 95 (11:10) · 80 (11:13) · 75 (11:59) · 68.95 (12:00) · 59.8 (12:19) → VWAP 75.75.

- Price sequence is **monotonically decreasing**: every add was at a lower price, i.e. adds were made **while the option's own structure was bearish**.
- Tape-checkable confirmation at the last leg (12:19, inside tape): underlying 74,863.9, PE ladder **flat 0% bar-on-bar** → **no bearish confirmation** at entry. It was a *value entry* on a cheap 260-point-OTM PE with ~3 h to expiry.
- Outcome: the position later recovered (MFE 80.4 vs VWAP 75.75) and paid. **That does not validate the method** — MAE was 54.05 (= **−₹2,170 unrealised** at the worst moment, 12:21, on a ₹5,000-class account).

**Verdict:** legs 1–4 untestable (pre-tape) — treat as *unclassified*; leg 5 = **averaging down without independent confirmation**. Rule to keep (already in the brief): *never add because the option got cheaper; every add needs its own confirmation.*

---

## 5. REGIME CLASSIFICATION (normalized states, all measured)

States implemented: `REVERSAL_EARLY → REVERSAL_CONFIRMED → BREAKOUT → TRENDING → ACCELERATING →
EXTENDED → EXHAUSTION → REVERSAL_EXIT` (+ `CONSOLIDATION`, `RANGE_FAILURE`, `NO_TRADE`).
Inputs are **ratios only**: extension in ATR units, bar return %, relative volume, OI delta, IV.

74900 PE tape (lab contract — the chart-#1 sequence, real numbers):

| Time | Bar | ret% | ext(ATR) | relVol | OI Δ | IV | State |
|---|---|---|---|---|---|---|---|
| 13:20 | 199.70→195.60 | −3.0 | 0.00 | 0.69 | +17k | 31.3 | CONSOLIDATION |
| 13:25 | 193.05→217.95 | +11.4 | 0.86 | 0.79 | −53k | 36.6 | ACCELERATING |
| 13:55 | 216.05→223.20 | +3.4 | 0.48 | 1.01 | −168k | 36.7 | BREAKOUT |
| 14:00 | 218.35→252.00 | +12.9 | 1.62 | 1.11 | −16k | 42.3 | ACCELERATING |
| 14:15 | 249.40→268.70 | +9.5 | 1.42 | 0.89 | −31k | 42.8 | ACCELERATING |
| 14:45 | 272.45→250.80 | −8.0 | −0.39 | 0.62 | +11k | 63.1 | CONSOLIDATION |
| 15:00 | 294.25→342.00 | **+21.4** | **2.27** | 1.44 | −278k | 79.8 | **EXTENDED** |
| 15:05 | 342.70→363.00 | +6.1 | 2.32 | 0.71 | −52k | **116.1** | BREAKOUT |
| 15:10 | 367.85→**420.10** | +5.8 | 2.36 | 0.59 | −63k | **144.2** | BREAKOUT (peak) |
| 15:15 | 403.45→375.65 | −2.2 | 1.43 | 0.76 | −75k | **158.5** | RANGE |
| 15:20 | 300.00→36.25 | **−90.3** | −4.34 | 12.85 | −186k | 0 | RANGE (collapse) |
| 15:25 | 45.55→0.75 | −97.9 | −4.16 | 28.94 | +2.8M | 23.4 | RANGE |
| 15:30 | 0.70→0.15 | −80.0 | −3.78 | 4.70 | 0 | 33.2 | RANGE |

> **Finding X1 — the exhaustion signature is measurable and gave >10 minutes of warning:**
> `bar return ≥ ~+20% of premium` **AND** `extension ≥ 2.2–2.4 ATR` **AND** `IV spike` (27→79→116→144→158)
> **AND** `volume climax in the reversal bar (relVol 12.9 → 28.9)`.
> The state flipped to EXTENDED at **15:00** and the peak printed at **15:10**; the wipeout began **15:15**.
> Exhaustion ≠ "price rose by X%": it was **acceleration + IV spike + extension**, and the tell was
> **IV doubling into the high**, not the price level. Nothing here is a hard-coded price.

---

## 6. CROSS-OPTION CONFIRMATION AT EACH REAL ENTRY (§16–17)

Bar-on-bar change of the whole local chain at the entry timestamp (PEs in the top row, CEs below):

| Entry | Underlying | PE ladder (746/747/748/749/750) | CE ladder (748/749/750) | Independent confirmation? |
|---|---|---|---|---|
| 12:19 PE 74600 @59.8 | 74,863.9 | flat 0% | flat 0% | **No** (value entry only) |
| 13:14 PE 74700 @92 | 74,809.96 | −15.2 / −14.3 / −13.2 / −10.9 / −9.6% | +13.2 / +14.1 / +13.9% | **Contradicted at entry** — bought the PE right after an underlying up-thrust |
| 13:33 CE 74900 @76.2 | 74,772.8 | +0.4 / +1.1 / +2.1 / +1.7 / +1.9% | −2.2 / −2.2 / −1.5% | **Counter-trend** — bought a CE while PEs were bid and SENSEX sold off all afternoon |
| 14:25 PE 74600 @80 | 74,744.19 | −17.1 / −11.7 / −7.8 / −7.5 / −11.2% | +11.3 / +12.4 / +14.4% | **Yes (aligned)** — PE pullback while underlying was breaking down |

> **Finding F1.** Only entry #4 had aligned, independent, multi-instrument confirmation — and it was
> also the best trade on a per-unit basis and the only one a **2×ATR trail would have turned into
> ₹1,305 instead of ₹449**. Entry #3 was counter-trend and every mechanical exit policy lost money on
> it (−₹144 to −₹509) while his 2-minute discretionary exit made ₹26.

---

## 7. EXIT POLICY COMPARISON (§27 — all ratios, no hard-coded prices)

Simulated on the 2 entries where an ATR existed at entry (n = 2 — **statistically meaningless as
proof**, useful as a hypothesis generator). Net ₹ after the real cost model:

| Policy | Net ₹ (n=2) | Avg capture |
|---|---|---|
| hold to 15:30 (expiry-day control) | **−3,146** | −82% |
| fixed 1.0×ATR target / 1.0×ATR stop | −215 | −23% |
| fixed 2.0×ATR target / 1.0×ATR stop | +6 | −14% |
| structure trail (prior-bar low) | +56 | −2% |
| ATR trail 1.0× | +87 | −3% |
| exhaustion-deterioration exit | +192 | +17% |
| 50% at 2×ATR + 2×ATR trail | +338 | −45% |
| **ATR trail 2.0×** | **+796** | −45% |
| **his actual discretionary exits** | **+1,152** | — |

Per-trade detail on the two testable entries:

- **74600PE 14:25 (aligned trend entry):** ATR trail 2.0× exits 15:15 @147.80 → **₹+1,305** (59% capture) vs his ₹+449; partial+trail ₹+848; hold-to-close **₹−1,650**.
- **74900CE 13:33 (counter-trend scalp):** every mechanical policy loses (₹−144 … ₹−509); hold-to-close ₹−1,496; his fast exit ₹+26 was the best available.

> **Finding G1.** The option's **own 5-min ATR was 13.5% (74600PE @14:25) and 22.9% (74900CE @13:33) of its premium**.
> Therefore: on options, use a **wide** trail (≈2×ATR), never 1×ATR and never a prior-bar-low
> structure trail — those are noise. On this day the 2×ATR trail roughly **tripled** the trend-aligned
> trade's profit; the same policy is worthless on counter-trend scalps.
>
> **Finding G2 (why underlying-based exits underperform here).** An exit driven by "SENSEX turned up"
> fired at 14:45 on every entry, i.e. **before** the PE's true peak (15:10) — the option peak lagged the
> underlying low because **IV expanded from 27 to 144+**. Exit logic must therefore respect that
> premium = f(underlying move, IV, time) ≠ underlying move.

---

## 8. STOP PLACEMENT & RISK/REWARD (§8–9)

- Stops must live in **structure/ATR space**, not "5%": with a 13.5–22.9% ATR/premium ratio, a fixed 5% stop is *inside* one bar of noise → guaranteed whipsaw.
- Invalidation for a PE buy = the point where the **bullish reversal evidence in the PE plus the underlying's bearish structure** both fail (prior swing low of the PE + a higher high in SENSEX beyond `k × underlying-ATR`).
- Cost-aware minimum edge: entry must offer **≥3–4× round-trip cost** of runway to target 1 (i.e. ≥ ~8–10% of premium for a ₹50 round trip on a ₹1,600 notional).

---

## 9. MISSED-PROFIT / LOSS-AVOIDANCE LEDGER (§23–24)

| Item | Amount | Cause label | Verdict |
|---|---|---|---|
| 74600PE 100-lot: 82 → peak 193.95 | ₹11,195 | NO_TRAILING + NO_RE_ENTRY | Not a bad exit (peak was a 15-min window 2 h later inside a −90% collapse); the real gap is **no re-entry** on the 14:00–14:25 breakout |
| 74700PE 20-lot: 105 → 257.50 | ₹3,050 | same | same |
| 74900CE 20-lot: 80 → 153.45 | ₹1,469 | same | the CE was −97% (−₹1,469) between 14:00 and 15:15 before that spike — the exit **avoided** a ~96% loss (damage avoided ₹1,549) |
| 74600PE 20-lot: 105 → 193.95 | ₹1,779 | TRAIL_TOO_TIGHT (no trail at all) | **Actionable**: 2×ATR trail would have captured ₹1,305 of it |
| Cancelled SELL @90 (12:37) | ₹800 vs 82 | LIMIT_TOO_FAR / MANUAL | order rested 29 min above the market |
| Cancelled BUY @78 (13:30) | −₹36 saved | — | refilled lower at 76.20 = good |
| Realized losses | **none** (4/4 net positive) | — | the avoided losses (above) matter more than the wins |

**Losses that were avoided** (the more instructive half): the 74900CE position (−96% if held), and
holding any of these to 15:30 (control: ₹−3,146). Both were avoided by **taking profit early** — not by
being right.

---

## 10. TRADE QUALITY SCORES (§7, §22, §33)

Component scores (0–100, computed from tape features; kept raw, never collapsed):

| Trade | Structure | Breakout | Underlying | Momentum | Volume | OI | IV | Liquidity | R/R | Entry quality |
|---|---|---|---|---|---|---|---|---|---|---|
| 1. 74600PE (avg-down) | 25 | 10 | 20 | 30 | — | — | — | 80 | 45 | **Poor method, paid by luck** |
| 2. 74700PE 13:14 | 35 | 20 | 25 | 55 | 60 | 45 | 40 | 85 | 55 | **Weak (counter-thrust)** |
| 3. 74900CE 13:33 | 30 | 15 | 10 | 35 | 70 | 40 | 45 | 85 | 30 | **Counter-trend scalp; cost-dominated** |
| 4. 74600PE 14:25 | 70 | 55 | 85 | 70 | 65 | 55 | 50 | 85 | 75 | **Best entry of the day** |

Pattern labels (§33) for today: #1 `AVERAGING_DOWN_NO_CONFIRMATION`, #2 `PULLBACK_AFTER_UPTHRUST`,
#3 `COUNTER_TREND_SCALP` (→ `UNDERLYING_OPTION_DIVERGENCE` context), #4 `PULLBACK_CONTINUATION`
(aligned), plus lab labels `REVERSAL_BREAKOUT → TREND_ACCELERATION → EXHAUSTION_REVERSAL` on 74900PE
and `FALSE_BREAKOUT` on the 13:15/13:25 lab pops that failed within 2 bars.

---

## 11. PROPOSED DECISION FRAMEWORK (proposal only — not implemented)

**Gate order (each gate can veto):**
1. **Regime** — classify the option's state (ratios above). `EXTENDED`/`EXHAUSTION` ⇒ no new entries.
2. **Confirmation** — ≥2 independent, aligned sources (option structure + underlying structure + chain: the *other* side's ladder must agree). Counter-thrust entries (like #2/#3) ⇒ capped size or skipped.
3. **Cost edge** — expected target-1 move ≥3–4× round-trip cost, else NO TRADE (kills scalps like #3).
4. **Risk** — invalidation in ATR/structure space; size = risk budget ÷ (entry − invalidation), one position ≤ 20% of the ₹5,000 desk.
5. **Management** — 50% off at 2×ATR, remainder on a **2×ATR trail**; on expiry day force-flat by **15:15 IST** and arm profit-protection once unrealized ≥ ~1×ATR.
6. **Exhaustion exit** — acceleration + IV spike + extension ≥2.2 ATR + volume climax ⇒ close regardless of price.
7. **No-chase filter** — extension ≥2 ATR from the breakout ⇒ `EXTENDED_MOVE` / `WAIT_FOR_PULLBACK`.
8. **Post-exit** — keep watching 5/10/15/30/60 min; a *new aligned* signal after exit is a **re-entry candidate** (this is the actual gap today, worth more than holding longer).

**Hard expiry-day rules (from §3):** no OTM positions held into the last 20 minutes; never hold an
expiring OTM option to close; unrealized profit on an OTM expiring option must be realized inside its
peak window.

---

## 12. NOT CHANGING YET — insufficient evidence / forbidden by brief

- No change to `/fnf-trading`, FNF funds/records, `UPSTOX_SANDBOX_ENABLED`, no real trading, no Yahoo fallback.
- No hard-coded prices/percentages/levels from this day (all thresholds above are ATR/ratio/IV-relative).
- No promotion of any exit policy: **n = 1 day, 4 round trips, 2 testable for ATR policies.** The 2×ATR trail result is a **hypothesis**, not a finding.
- Do not "fix" his discretionary exiting: on this day it beat every mechanical policy (+1,152 vs +796 best).
- Do not enable auto-entry on the strength of this day — the pattern-engine confidence gate (0.60) never even fired today; this day is a *labelling* dataset, not a promotion.

**Backtest/paper requirements before any promotion:** ≥60 sessions of 5-min option tape (same desk
store), all exit policies in §7 evaluated per regime, cost model applied, minimum 30 testable entries
per regime, out-of-sample split, then paper-only A/B with the alternative policies recorded
side-by-side (never simultaneously driving real decisions).

---

## 13. LEARNING LOOP & JOURNAL (§30, §32, §35)

Per-signal record (schema proposed for a *separate* learning table — kept out of live decision paths):

```
timestamp, underlying, option, expiry, strike, CE/PE, market_regime, setup_type,
entry_score, underlying_score, option_chain_score, momentum_score, volume_score,
OI_score, IV_score, liquidity_score, risk_reward_score,
entry_price, initial_stop, target_1, target_2, position_size, risk_amount,
MFE, MAE, exit_price, exit_reason, profit_capture_ratio,
trade_quality, entry_quality, exit_quality, risk_management_quality,
future_5m, future_10m, future_15m, future_30m, future_60m, learning_label
```

Post-exit answers required for every trade: entry too early / too late? confirmation enough? exit too
early / too late? would partial/trailing have helped? could it have been avoided? sizing right? which
feature combination predicted the outcome?

---

## 14. THE 18 REQUIRED ANSWERS (§35)

1. **Reconstructed trades** — §1 (4 round trips; 2 cancelled orders).
2. **P&L before/after costs** — gross ₹1,461.00 → net ₹1,152.42 (costs ₹308.58; 21.1% of gross).
3. **MFE/MAE per trade** — §2 (all four captured ~100% of their in-hold run-up).
4. **Good entries** — #4 (aligned PE pullback, confirmed by the whole PE ladder + CE sell-off).
5. **Premature entries** — #1 leg 5 (averaging down, no confirmation, 260 pts OTM); #2 (entry into an underlying up-thrust); #3 (counter-trend CE scalp).
6. **Premature exits** — none locally; the gap is a **missing re-entry** into the 14:00–14:25 breakout.
7. **Exits that protected risk** — all four; the 74900CE exit specifically avoided a −96% drawdown, and every exit avoided the −₹3,146 hold-to-close outcome.
8. **Missed profit** — ₹11,195 / ₹3,050 / ₹1,469 / ₹1,779 per position (day-runway vs actual); only the last is realistically addressable with a 2×ATR trail.
9. **Loss avoidance** — the CE hold-to-collapse (−96%) and the hold-to-expiry control (₹−3,146) were both avoided.
10. **Averaging-down analysis** — §4: unauthorised method, profitable outcome, MAE −₹2,170 at the worst point.
11. **Best entry characteristics** — regime not EXTENDED; pullback (not new high) entry; multi-instrument alignment; extension ≤1.6 ATR; ATR/premium 13.5%.
12. **Best exit characteristics** — took the local extreme, moved to a 2×ATR trail in the expansion, respected the 15:15 expiry cutoff.
13. **Conditions behind the big move** — SENSEX breaking to 74,609.9 (−293 from the open) with IV expanding 27→79; OI unwinding on the PE ladder.
14. **Conditions behind the reversal** — acceleration +20% bar, extension 2.27 ATR, IV spike to 116–158, volume climax, then a 74,629 → 74,902.6 snapback.
15. **Proposed framework** — §11.
16. **Features lacking evidence** — OI deltas are large but unrealable (feed), IV zero on many rows, bid=0 on 43% of rows, index feed froze at the close, pre-12:15 tape missing; every gate needs more days.
17. **Backtest/paper requirements** — §12.
18. **Do not change yet** — §12: no live strategy change from this single day.
