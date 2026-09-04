# D-02 — Multi-Leg Defined-Risk Strategies: Family Spec (future, separate)

> Status: SPEC (decision 2026-09-05). NOT tradeable yet — blocked on envelope reality
> (₹5k cannot margin NSE index spreads) + real broker wiring (T-06).
> Governing invariant (v4 Gate 0 #9 + Gate 7 #10): short-premium structures are a
> SEPARATE future strategy family. They must never enter the current long-option desk
> path (option-candidate-rank-v1 / session-driver). Entry requires the promotion gate
> below to pass.

---

## 1. Scope

Two defined-risk, credit-collecting topologies on NSE index underlyings
(NIFTY 65-lot / BANKNIFTY 30-lot / FINNIFTY 60-lot / SENSEX 20-lot; monthly + weekly expiries):

| Family | Legs | Topology |
|---|---|---|
| Credit Spread (vertical) | 2 | Short leg + long protective wing, same side (put credit / call credit) |
| Iron Condor (IC) | 4 | Put credit spread + call credit spread on one underlying+expiry |

Rationale for defined-risk only: max loss is known at entry (width − credit), so the
₹-envelope and risk tables stay computable without intraday margin-call modeling.

---

## 2. Hard invariants (deterministic gate — mirrors Pydantic schema in guidebook)

Enforced at the boundary in code, never by prompt/memory (v5 "negative test" rule):

1. **Topology exactness** — IC = exactly 4 legs, 2 × buy_to_open + 2 × sell_to_open,
   same underlying, same expiry; long wings strictly OTM relative to short legs
   (put wing below short put; call wing above short call). Credit spread = exactly
   2 legs, 1 short + 1 long, same underlying + expiry + side.
2. **Leg ratio** — every leg ratio = 1 (no ratio spreads in this family).
3. **Risk/reward floor** — net credit ≥ 20% of spread width:
   `net_credit / (width + net_credit) ≥ 0.20` → equivalently
   `net_credit ≥ 0.25 × max_loss` where `max_loss = width − net_credit`.
4. **Strike distance floor** — short strike |delta| ≥ 0.15 at entry (guidebook
   heuristic: no short strikes inside 0.15Δ within 5 business days of CPI/FOMC/rate
   events; encoded as event-distance gate, not a hard floor outside event windows).
5. **Liquidity floor per leg** — open interest ≥ 500 contracts AND bid/ask spread
   < 8% of mid (guidebook values; NSE-verify before activation — do not copy US
   numbers blindly, re-estimate on NSE data per v4 Gate 5/7 rule).
6. **No naked short** — every short leg has a protective long wing (by construction
   above), and no leg may be modified post-entry except the whole position closes.
7. **Envelope isolation** — this family gets its OWN capital sub-envelope and risk
   bucket. It never draws from the long-option desk headroom (ceiling = capital+netPnl
   of the long desk remains untouched), and never coexists in the same portfolio
   accounting row.

---

## 3. Margin & envelope reality (why blocked today)

NSE index option margin for short options is computed by SPAN (VaR-based) + exposure
margins. Indicative SPAN margin for a NIFTY ATM short is materially above the ₹5k
envelope even before the long wing offsets; defined-risk spreads reduce but do not
eliminate the margin requirement, and brokers (FYERS) require margin ≥ SPAN for the
net position. With `BOOTSTRAP_CAPITAL = ₹5,000`:

- A single NIFTY short vertical (1 lot) SPAN requirement is realistically ₹60k–₹1.2L
  class; an IC is 2× that before offsets.
- Therefore D-02 activation requires EITHER envelope growth (ceiling ≥ ₹1.5L per the
  live profit−charges auto-grow) OR a separate funded account/margin segment.
- Paper-trading the family for research (labels, fills, decay behaviour) is NOT margin
  blocked and can start independently — see §7 promotion gate, phase P0.

---

## 4. Exit matrix (deterministic)

| Trigger | Condition | Action |
|---|---|---|
| Take-profit | Position MTM credit captured ≥ 50% of initial credit | Close all legs (market/limit bracket) |
| Stop-loss | MTM loss ≥ 200% of initial credit | Close all legs immediately |
| Gamma-risk window | ≤ 5 DTE remaining (or expiry-week rule per v4 Gate 8 #8) | Force close entire position regardless of PnL |
| Event breach | Scheduled macro event inside strike | Pre-event de-risk: close or roll per risk gate |
| Manual/flatten | Operator or kill-switch | Close all legs, record reason (feeds T-08 Reflexion) |

Note the asymmetry: TP at 50% credit, SL at 200% credit — the guidebook's structure
keeps win-rate × payoff consistent with credit-selling math. For IC the 200% stop is
measured on the whole-position credit, not per side.

---

## 5. Risk tables (proposal — re-estimate on NSE before live)

| Control | Value | Source |
|---|---|---|
| Max risk per position | 2% of family equity | Guidebook; v4 Gate 16 #2 |
| Aggregate active risk | 15% of family account | Guidebook; v4 Gate 16 #2 |
| Net portfolio delta band | ±0.25 (neutral family) | Guidebook §risk |
| Leg liquidity | OI ≥ 500, spread < 8% | Guidebook; NSE-verify |
| Max concurrent IC/CS | 3 positions family-wide | Proposal |
| Short-strike event rule | none < 0.15Δ within 5 days of macro | Guidebook heuristic |

---

## 6. Data/journal requirements before any trade (v4 Gate 1 alignment)

Every D-02 decision must persist to the point-in-time decision journal (Gate 1):
all 4/2 leg symbols with bid/ask/OI/Δ at decision time, credit target, width,
max loss, the invariant check result for §2 (1)–(7), and expected fill vs simulated
fill. Rejections (violated invariant) must be recorded with the specific rule number —
the T-08 reflections table should later carry D-02-family outcome classes
(CS_TP / IC_SL / GAMMA_WINDOW…) when the family trades.

---

## 7. Promotion gate (phases)

- **P0 — Paper research (NOT blocked, not started):** trade IC/CS on paper with
  simulated margin (record hypothetical SPAN) to gather labels + fills + theta decay;
  requires: spread/margin estimation module (T-09 extension), decision-journal fields,
  reflection classes. NO code path may place a real order.
- **P1 — Shadow:** run complete live-data shadow decisions with orders disabled
  (v4 Gate 20), margin computed from real broker SPAN estimates.
- **P2 — Micro-live:** ONLY after (a) envelope/account reality permits SPAN (≥₹1.5L
  class), (b) T-06 real-broker wiring exists, (c) all P0/P1 metrics stable across ≥2
  regimes, (d) kill switch + order dedup verified (v4 Gate 16 #8/10).
- **P3 — Live:** v4 Gate 21 final acceptance for this family + operator approval.

Each phase is a versioned release artifact; failure blocks promotion (v5 release-gate
rule: encode the condition in the release record, make failure block).

---

## 8. Open questions for operator (when P0 starts)

1. Family capital sub-envelope value (₹5k? separate paper pot?) — needs a decision.
2. Weekly vs monthly expiries preference for IC (theta/assignment tradeoff).
3. Whether short-strike 0.15Δ event rule should be hard-coded (recommended: yes,
   deterministic negative test) or configurable.
4. Underlyings to start: NIFTY only (most liquid) vs NIFTY+BANKNIFTY.

---

## 9. Blocked-on / dependencies

- Envelope growth (auto-grow by profit−charges) or separate margin segment.
- T-06 real broker wiring (FYERS order placement).
- P0 paper harness (spread margin estimator + journal fields).
- v4 Gate 5/7 NSE data re-estimation before adopting guidebook numeric floors.
