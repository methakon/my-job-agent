# FNF trading module — decay engine + day-wise rectification (2026-09-01)

Verified patterns from the FNF (Friday Night Funkin' style algo-trading) module
in `~/projects/my-job-agent/src/trading/`. All verified by build + reviewed source.

## Decay engine — "always predict considering decay"

Every algo signal passes through `decayConfidence()` before the decision is made;
there is no bypass.

### Formula
```
decayed = confidence × exp(-rate × ageHours) × timingFactor
```
- `rate` — hourly exponential coefficient, per-weekday, rectified from outcomes.
- `ageHours` — (now − snapshot timestamp) in hours. Stale data ⇒ weaker signal.
- `timingFactor` — 1.0 inside the weekday timing window, 0.85 outside.
- Below `confidenceFloor` (default 35) the signal flips to HOLD.

### Signal shape
`AlgoSignal.decayedConfidence` is the actual value used for the decision;
`AlgoSignal.confidence` is the raw pre-decay model output. Both are returned so
the caller can see what changed.

## Day-wise rectification — "always rectify the decay value and timings day wise"

A `FnfDecayCalibration` row per weekday (0=Sun…6=Sat) holds:
- `decayRate`
- `windowStartHour`, `windowEndHour` (e.g. 9.5 → 09:30 IST, 15.25 → 15:15 IST)
- `samples` — count of trades already absorbed, so rectification is incremental.
- `lastRectifiedAt`

### When rectification runs
1. **After every trade close** — `closeTrade()` fires `rectifyDecay()` as a
   fire-and-forget background task. No caller waits for it.
2. **On demand** — `POST /trading/decay/rectify?portfolioId=...`.
3. **At signal generation** — the active weekday's calibration is fetched; if
   stale, rectification can be triggered (currently it is fetched and used; the
   explicit on-demand call is the rectification entry point).

### How rectification works
Per weekday, it looks at closed trades for that weekday not yet absorbed
(`trades.slice(cal.samples)`).

- **Decay rate**: each fresh winner multiplies rate by `(1 − learningRate)`;
  each fresh loser multiplies by `(1 + learningRate)`. Clamped to
  `[minRate, maxRate]`. Default learningRate = 0.15.
- **Timing window**: if there are winning entry hours, the mean winning entry
  hour pulls the window edges. If meanWinHour < current start ⇒ start drifts
  earlier by `windowStep`; if meanWinHour > current end ⇒ end drifts later.
  Clamped to `[minWindowStart, maxWindowEnd]`.
- **Escape hatch**: if start ≥ end after drift, reset to full default window.

### Defaults
```
rate            0.04   (hourly exponential coefficient)
minRate          0.005
maxRate          0.30
learningRate     0.15   (per-trade rectification step)
windowStart      9.5    (09:30 IST)
windowEnd        15.25  (15:15 IST)
windowStep       0.25   (hours edges drift per rectification)
minWindowStart   9.0    (market open 09:15)
maxWindowEnd     15.5   (market close 15:30)
timingPenalty    0.85   (multiplier outside the window)
confidenceFloor  35     (below this → HOLD)
```

## API surface (FnfTradingController)

| Route | Method | Purpose |
|---|---|---|
| `/trading/signals` | GET | Generate decay-adjusted signals for all instruments |
| `/trading/decay` | GET | List all weekday calibrations |
| `/trading/decay/rectify` | POST | Trigger day-wise rectification now |
| `/trading/decay` | PATCH | Manual override of one weekday's rate + window |

## Astro-muhurta integration

`generateSignals()` calls `AstroMuhurtaService.nextWindow()` for the next 24h
and attaches the shubh score + label to every signal. A shubh window adds +15
to raw confidence and is listed in the signal's `reasons`. Friday trading is
blocked unless the portfolio's `fridayTradingEnabled` flag is set.

## Cost model

Indian discount-broker (Zerodha-style) cost breakdown returned from
`calculateCost()`: brokerage (0.03% or ₹20 min), STT (0.025% sell side),
exchange transaction (0.00275%), GST (18% on brokerage+exchange), SEBI
(₹10/crore), stamp duty (0.015% buy side).

## Pitfalls

- **Fire-and-forget rectification**: `rectifyDecay()` is called with `void ...catch`
  inside `closeTrade()`. If it throws, the trade close still succeeds — the
  calibration just doesn't update. Check logs for `decay rectify failed` warnings.
- **Incremental absorption**: `cal.samples` gates which trades are consumed. If
  you manually edit calibration rows, reset `samples` to 0 to re-absorb all
  historical trades, or the old ones are skipped forever.
- **Timing window drift can collapse**: the escape hatch (reset to full window)
  only triggers when start ≥ end. A steady stream of winning trades at one edge
  can still push the window to its clamp boundary and stay there — that's by
  design (the window has hardened), but it means the penalty for off-window
  trading never relaxes.
- **`getCalibration()` fallback chain**: portfolio override → global (portfolioId
  IS Null) → seed if absent → fetch again. The double-fetch on the fallback path
  is intentional (seed is async, so a second find is needed after ensureCalibrations
  completes).
