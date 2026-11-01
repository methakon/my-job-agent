# Learning Methods Specification — C++ options trading engine

**Baseline:** `feat/cpp-trading-agent` @ `05130a9`

This document defines every statistical and learning method in the engine: the
mathematics as implemented, the thresholds as literals, where state is persisted,
and — critically — whether the method runs in the live path.

---

## 1. The AI/ML boundary

**There is no trained model, no inference runtime, and no external model call
anywhere in `src/`.**

- `"LightGBM_Proxy_Tree_Model"` (`gate12_ml_pipeline.cpp:70`) is a **record label
  string**. No model object, feature matrix, or training loop exists; both
  accuracies are function arguments supplied by the caller.
- The "LLM reflexion" in `gate14` is `std::ostringstream` text formatting
  (`gate14_risk_reflexion.cpp:60-63`). No LLM client exists in the tree.
- `gate18`'s five advanced model types (HMM, GARCH, Kalman, Hawkes, DeepLOB) are
  **enum members only** — no parameters, no computation, no training code.

Everything below is deterministic statistics, fixed-constant calibration, or
acceptance gating. Any external document describing "AI-driven" behaviour is
describing intent, not implementation.

---

## 2. Method catalogue

### 2.1 Multi-horizon labelling — `gate12_ml_pipeline`

**Type:** supervised labelling for a future model. **Learning:** none.

Forward return over horizon *h*:

```
r_h = (P(t0 + h) − P(t0)) / P(t0)        h ∈ {5, 15, 30} minutes
label = +1  if r_h ≥  θ
        −1  if r_h ≤ −θ
         0  otherwise
θ = 0.002  (0.2%)
```

Labels are produced at `gate12_ml_pipeline.cpp:33-35, 57-59`. When a future tick is
missing, the price remains at `base_price` and the label **silently becomes 0
(neutral)** — a missing-data artefact indistinguishable from a genuine flat
outcome.

**Acceptance test** (`:77`):

```
promote  ⟺  leakage_test_passed  ∧  (tree_accuracy − baseline_accuracy) ≥ 0.05
```

A +5 percentage-point lift. Both accuracies are inputs; nothing is measured here.

**Status:** IMPLEMENTED, TESTED, **NOT WIRED**. `leakage_test_passed` is a caller
boolean, so the leakage test cannot fail on its own.

---

### 2.2 Purged and embargoed cross-validation — `gate13_validation_harness`

**Type:** time-series model validation.

Generates chronological folds with a purge gap (removing samples whose label
window overlaps the test fold) and an embargo (dropping samples immediately after
the test fold to remove serial correlation). Production promotion is a separate
gate over the resulting fold statistics.

**Status:** IMPLEMENTED, TESTED, **NOT WIRED**.

**Defect:** the leakage flag is structurally always false —
`gate13_validation_harness.cpp:24` assigns the flag from a condition that `:29`
makes invariant. The check is tautological and cannot detect overlap.

---

### 2.3 Outcome taxonomy and rule promotion — `gate14_risk_reflexion`

**Type:** deterministic attribution + sample-size gate (no statistical learning).

Outcome classification (`:10-36`):

```
pnl > 0:  pnl ≥ 15.0 points → SUCCESS_TARGET_HIT
          otherwise          → SUCCESS_PROFIT_TRAILED
pnl ≤ 0:  catalyst_active         → FAIL_CATALYST_JUMP
          regime_mismatched       → FAIL_REGIME_MISMATCH
          slippage  ≥ 2.0 points  → FAIL_SLIPPAGE_EXCESS
          latency   ≥ 100 ms      → FAIL_LATENCY_DELAY
          otherwise               → FAIL_BAD_SENSING
```

Attribution is a **priority-ordered list**, not an inference: the first matching
cause wins.

Rule promotion (`:80-94`):

```
if trades < 30:              stage = HYPOTHESIS,      promote = false
elif win_rate ≥ 0.60:        stage = TESTED_RULE,     promote = true
else:                        stage = REJECTED_RULE,   promote = false
```

**Status:** IMPLEMENTED, TESTED, **NOT WIRED**.

---

### 2.4 Champion/challenger and rollback — `gate15_experiment_registry`

**Type:** pre-registered A/B promotion with a post-deployment rollback rule.

```
pnl_lift = (challenger_pnl − champion_pnl) / champion_pnl    if champion_pnl > 0
           1.0                                               otherwise

promote  ⟺  challenger_sharpe ≥ 1.2  ∧  pnl_lift ≥ 0.10

rollback ⟺  post_deploy_drawdown_pct ≥ 0.15  ∨  consecutive_losing_sessions ≥ 3
```

**Status:** IMPLEMENTED, TESTED, **NOT WIRED**.

**Defect:** forcing `pnl_lift = 1.0` when the champion is flat or losing
(`:41`) means the 10 % improvement requirement imposes **no constraint** in
exactly the case where a challenger is most needed; only the Sharpe gate binds.

---

### 2.5 Kelly and margin models — `gate16_risk_limits`

**Type:** fixed-constant calibration (frozen, not learned at runtime). This is
the most complete risk mathematics in the tree, and it does not run.

**Short-option margin** (`:39-41`):

```
margin_per_lot = 0.076 × lot_size × spot + lot_size × entry_price
```

**Defined-risk spread margin** (`:52-56`):

```
margin = max(0, strike_width − net_credit) × lot_size
```

**Kelly sizing** (`:89-98`) — applies to **one** bucket only
(`algo_source == "OFI_Microstructure_Breakout"` ∧ underlying `SENSEX`):

```
W  = 0.5762          (observed win rate)
R  = 1.0174          (observed payoff ratio)
f* = W − (1 − W)/R   = 0.1596
quarter-Kelly        = f*/4 = 0.0399
lots = ⌊ 0.0399 × capital / margin_per_lot ⌋
```

All other buckets fall back to a single lot if
`margin_per_lot ≤ per_trade_pct × capital`, else zero lots (`:100-110`).

**Deploying daily risk budget** (`:252-270`):

```
base       = per_trade_pct × capital            on date rollover
base      -= |net_pnl|                          on each losing trade
remaining  = max(0, base)
```

**Cost-aware edge filter** (`:272-337`): brokerage 20.00 × 2, STT 0.0015,
exchange 0.000355 (NSE) / 0.000325 (BSE), stamp 0.00003, SEBI 0.000001, GST 0.18;
entry blocked unless expected edge exceeds costs × a 2.0 safety multiplier.

**Status:** IMPLEMENTED, TESTED, **NOT WIRED**. The kill switch has no side
effects — it echoes caller-supplied counters into a result struct
(`:239-250`); no order is cancelled and no position is flattened.

**Defect:** constructor default `max_session_drawdown = 1000.0`
(`gate16_risk_limits.hpp:54`) contradicts the env fallback `1500.0`
(`gate16_risk_limits.cpp:17`).

---

### 2.6 Adaptive sizing and exit — `adaptive_policy` — **the only wired learner**

**Type:** bounded empirical log-wealth maximisation with a path-similarity kernel.

Entry sizing maximises expected log wealth over an empirical sample of prior
closed trades, subject to a hard cap. The "learning" is the empirical distribution
of realised returns from `PaperStore::history()`.

Exit authorisation is a sign test: hold while the expected incremental net cash
from continuation exceeds immediate liquidation; exit otherwise.

**Path similarity kernel** (`position_path.cpp:52-77`):

```
w = exp( −0.5 (d_gain² + d_drawdown² + d_time²) )      clamped to ≤ 1
bandwidths: gain 0.25, drawdown 0.25, elapsed 1.0
d_time = log1p(Δms / 60000)
```

Path state measures entry mark (first observed bid — **not** the premium paid),
MFE, MAE, and elapsed time (`position_path.cpp:20-50`).

**Status:** IMPLEMENTED, TESTED, **WIRED — but pinned to its exploratory branch.**

`PaperStore::empirical_model_active()` returns `false`
(`native_paper_engine.hpp:11-26`) and `DbPaperStore` never overrides it
(`native_paper_runtime.cpp:80-115`). Consequently every entry is flagged
`exploratory` and sized at **exactly 1 lot**. The validated Kelly/log-wealth
branch is **unreachable in the shipped runtime**.

This is the single most important fact in this document: the system's only
adaptive component is deliberately held in exploration and never exits it.

---

### 2.7 Seasonality detection — `gate22_seasonality_patterns`

**Type:** intraday persistence measurement with a chronological holdout.

Buckets are 15-minute intraday windows keyed by `(underlying, day-of-week,
days-to-expiry)`, computed from archived tick rows. Directional persistence is
measured per bucket; the model is fitted on the first 80 % of sessions
chronologically and evaluated on the last 20 %.

Advisory confidence modifier is bounded and never authoritative.

**Status:** IMPLEMENTED, TESTED, **NOT WIRED**.

**Defects:**
- The clean-session threshold is `count ≥ 10` (`:71`) while the adjacent comment
  describes a 200,000-tick baseline — a near-empty day passes health screening.
- Tick-to-tick returns carry `prev_px` across session-date boundaries within a
  bucket (`:176-199`), so the first tick of a new day is differenced against the
  prior day's last price and the overnight gap enters realised volatility.
- Bucket-key parsing uses `std::stoi` on fixed offsets with no `try`/`catch`
  (`:145-146`); a malformed key throws out of `analyze_archived_ticks`.
- `save_seasonality_pattern_record` (`db_client.cpp:2030`) has **zero callers**, so
  `cpp_seasonality_patterns` is never populated and `/api/seasonality-patterns`
  always returns an empty set.

---

### 2.8 Cross-market as-of join — `gate17_cross_market`

**Type:** point-in-time alignment with an explicit look-ahead rejection.

Event distance is the nearest future scheduled event in minutes; a window of
**30 minutes** marks the event as active (`:54-71`). Feature alignment scans
historical snapshots in reverse for the newest snapshot with
`timestamp_ms ≤ decision_timestamp_ms` (`:92-97`). Look-ahead is a single
inequality: reject when `feature_timestamp_ms > decision_timestamp_ms` (`:78-82`).

**Status:** IMPLEMENTED, TESTED, **NOT WIRED**. `historical_snapshots_` grows
without bound (`:38`); the archetype is a linear reverse scan.

---

### 2.9 Advanced-model approval gate — `gate18_advanced_research`

**Type:** fail-closed conjunction over caller-supplied evidence.

```
approve ⟺ registered ∧ baseline_plateau_proven ∧ off_box_trained
          ∧ perf_lift_pct ≥ 5.0 ∧ is_enabled_for_production
```

Unregistered model → reject (`:11-14`). **Status:** IMPLEMENTED, TESTED, **NOT
WIRED**. No metric is computed here; every field is stored data.

---

### 2.10 Feature engineering — `feature_engine`

Computes a microstructure feature vector from ticks. Several fields are
**placeholders, not measurements**:

| Field | Implementation | Assessment |
|---|---|---|
| `rv_percentile` | constant `0.52` (`:63`) | placeholder |
| `gamma_flip_level` | `strike × 0.995` (`:64`) | placeholder |
| `max_pain_strike` | `strike` (`:65`) | placeholder |
| `iv_skew` | `0.05 × iv` (`:60`) | placeholder |
| `multi_day_oi_trend` | binarised at OI 10000 (`:62`) | placeholder |
| `vpin` | instantaneous depth imbalance (`:57`) | not a volume-bucketed VPIN |
| VWAP accumulators | never reset (`:43-46`) | process-lifetime "VWAP" |

**Status:** used only by `backtest_engine` and tests; the live engine recomputes a
narrower OFI inline (`native_paper_engine.cpp:63-67`).

---

### 2.11 Backtest replay — `backtest_engine`

Replays ticks through a fixed OFI rule. **Status:** IMPLEMENTED, TESTED, **NOT
WIRED**; `run_parallel_backtest` generates its own synthetic ticks (`:73-89`)
rather than reading stored data.

**Defect:** `sharpe_ratio` is computed as
`total_net_pnl / (initial_capital × 0.05 + 1.0)` (`:64`) — a PnL-to-capital
ratio with no mean or standard deviation of period returns. Any report quoting it
as a Sharpe ratio is mislabelled. Parallel chunks each start with fresh capital
and no position (`:94-101`), so the aggregate is not equivalent to a sequential
replay.

---

## 3. The learning loop — designed versus wired

**As designed:**

```
historical ticks → features → edge/model → validation (G13) → adaptation (G14/G15)
                                                        → risk sizing (G16) → execution
```

**As wired:**

```
historical closed trades → adaptive_policy.allocate() → 1 lot → execution
```

Every join between the designed stages exists as a function; **none is called**.
No gate output is ever passed to the next gate anywhere in `src/` — the only
ordering that exists is the assertion sequence in
`tests/unit_and_integration_tests.cpp`.

---

## 4. Safety caps actually in force

| Cap | Value | Enforced where | Status |
|---|---|---|---|
| Live order placement | impossible | compile-time stub | WIRED |
| Position size | 1 lot | `empirical_model_active == false` | WIRED |
| Entry affordability | premium + costs + reserve < available | `paper_order.cpp:27-28` | WIRED |
| Tick freshness | 10,000 ms | `decision_context.cpp:8-23` | WIRED |
| Operator capital ceiling | operator-set, never rewritten | `cpp_portfolios.ceiling` | WIRED |
| Session drawdown gate | config-driven | `fetch_today_session_drawdown` | WIRED |
| Unknown clock | refuse to trade | `db_client.cpp:48-97` | WIRED |
| Settlement without an official price | refuse | `paper_settlement.cpp:34-165` | WIRED |
| Margin / Kelly / circuit breakers / kill switch | — | `gate16` | **NOT WIRED** |
| Daily risk budget depletion | — | `gate16:252-270` | **NOT WIRED** |
| Outcome-based rule promotion | — | `gate14` | **NOT WIRED** |

**Effective risk envelope in production today:** one lot per entry, a funds
check, a drawdown gate, and a settlement provenance check. The margin models,
Kelly sizing, circuit breakers and kill switch do not participate.

---

## 5. Validation methodology

What exists versus what is claimed:

| Practice | Implemented | Wired | Note |
|---|---|---|---|
| Purged/embargoed CV | yes | no | leakage flag tautological (D-12) |
| Chronological holdout | yes (G22, 80/20) | no | |
| Baseline-lift gate | yes (+5 pp) | no | accuracies supplied by caller |
| Sample-size gate | yes (≥ 30 trades) | no | |
| Pre-registration | yes (G15) | no | |
| Post-deploy rollback rule | yes | no | |
| Point-in-time / no look-ahead | yes (G17) | no | |
| Test weakening prohibited | yes | — | see [acceptance-criteria.md](../acceptance-criteria.md); no consolidated testing-strategy document exists yet (ROADMAP W5-7) |

**There is no backtest-to-live equivalence evidence.** The only replay path
generates synthetic ticks and its "Sharpe" is not a Sharpe ratio.

---

## 6. Gap register

| ID | Gap | Consequence | Priority |
|---|---|---|---|
| LG-01 | 12 of 13 gate/research modules are unwired | Specified learning capability does not affect any trade | P0 |
| LG-02 | `empirical_model_active` hard-wired false | Validated sizing unreachable; always 1 lot | P0 |
| LG-03 | `gate21` returns true unconditionally | Release acceptance provides no assurance | P0 |
| LG-04 | Seasonality never persisted | Dashboard feature permanently empty | P1 |
| LG-05 | `gate13` leakage check tautological | CV cannot detect target leakage | P1 |
| LG-06 | Feature placeholders presented as measurements | Any model trained on them would be misled | P1 |
| LG-07 | Backtest "Sharpe" is not a Sharpe | Performance claims uninterpretable | P1 |
| LG-08 | `gate15` treats non-positive champion PnL as 100 % lift | Improvement gate inert when it matters | P2 |
| LG-09 | `gate16` kill switch has no side effects | Emergency stop is a no-op | P2 |
| LG-10 | `gate14` attribution is priority-ordered, not causal | Misattributes multi-cause failures | P3 |

**Recommendation.** Before any new modelling work, close LG-02 and LG-03. A
system that reports unconditional acceptance and can never leave exploration
cannot generate trustworthy learning evidence, regardless of how good the
downstream mathematics is.
