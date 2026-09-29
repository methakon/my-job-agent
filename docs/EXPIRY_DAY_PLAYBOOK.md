# Expiry Day Playbook — preparation, analysis, and techniques

Status: ADVISORY (research + tooling). Trading-behaviour rules on expiry day (entry cut-offs,
size limits, spread caps) are gated by operator clarification **#29** — nothing in this document
overrides the FNF freeze, risk ceilings, or the paper-only / long-options-only constraints.

Companion tooling: `scripts/expiry-prep.js` (universe generator + prep report), tests in
`scripts/expiry-prep.test.js`. First real prep run: 2026-09-28 night for the 2026-09-29 monthly expiry.

---

## Part 1 — Mechanics that matter (India)

- **Expiry schedule (from the FYERS master, 2026-09-28):** NIFTY weekly+monthly = **Tuesday**
  (monthly = last Tuesday; 2026-09-29 = September monthly). NIFTY BANK = monthly only (last
  Tuesday; same 2026-09-29). SENSEX = **Thursday** weekly (next 2026-10-01); SENSEX monthlies =
  last Thursday. Verify every week against the broker master — holiday shifts occur (the master
  shows an Oct-19 Monday NIFTY pattern consistent with a shift).
- **Settlement:** index options are **cash-settled**; the settlement price is the underlying
  closing/settlement value at 15:30. In-the-money options are **auto-exercised** at settlement —
  a long desk that wants its P&L as a *trade* should close before the close rather than ride
  into settlement.
- **STT (Finance Act 2026, effective 2026-04-01, source: NSE STT page):**
  - Sale of an option in securities: **0.15% of premium** (seller pays) — was 0.10%.
  - Option exercised: **0.15% of intrinsic value** (purchaser pays) — was 0.125%.
  - Sale of futures: 0.05%. 
  - Practical consequence: an ITM long that expires and settles pays exercise STT on intrinsic;
    closing it intraday pays sale STT on the (much smaller) premium. For 0DTE longs, plan an exit
    **before** the close or budget for exercise STT.
- **Margins / hygiene:** short-side peak-margin spikes and ban-list rules are seller/prop concerns;
  for our long-only paper desk the expiry-day hygiene is: token validity, symbol subscription
  freshness (master check), and knowing which strikes remain quoted into the last hour.
- **Rollover:** the day before/at monthly expiry, next-month OI climbs; pre-registering the next
  expiry is ordered (§3.3) and now automatable (see Part 4).

## Part 2 — What the evidence says

- **Expiration-day volume/price effects (US academic tradition, Stoll & Whaley 1987 and their
  later "Expiration-Day Effects: What Has Changed?")**: historically large volume and some price
  effects in the last hour of quarterly expirations ("triple witching"), driven by index-arbitrage
  unwinds; effects **diminished** over time as markets/contracts changed. Lesson: expect
  session-structure effects (closing-auction pressure, last-hour flows) but do not assume a fixed
  direction.
- **Strike-price clustering / pinning (Ni, Pearson & Poteshman, J. Financial Economics 78(1),
  2005, 49–87)**: on expiration dates, closing prices of optionable stocks cluster at option
  strike prices; average return alteration **at least 16.5 bps** per expiration (~$9bn aggregate
  shifts), attributed to **market-maker hedge rebalancing** and manipulation. Lesson: strikes with
  large expiring OI act like magnets *statistically* — a bias, not a guarantee.
- **Dealer gamma theory (industry mechanism)**: when dealers are net long gamma near a big strike,
  their hedging dampens moves ("pinning"); beyond their gamma breakeven, hedging can *accelerate*
  moves. This explains both classic expiry-day regimes: **pin/range day** vs **trend/acceleration
  day**. Treat as a hypothesis to score, not a rule — our gate-7 research (GEX/gamma-flip, with
  explicit positioning assumptions) is the in-house instrument for this.
- **Max pain (practitioner heuristic)**: the strike where expiring open interest loses least
  aggregate value; widely used as a weak magnet estimate for expiry day. No strong academic
  support at index level — use as one input among walls/PCR, never alone.
- **IV crush & theta on 0DTE**: ATM implied vol is typically rich early on expiry day and decays
  through the session; ATM premium needs an increasingly large move to pay. After roughly
  13:00–13:30 IST, decay steepens (gamma/theta ratio worsens for long premium). Long-premium
  entries are structurally better early; late entries need fast, directional follow-through.

## Part 3 — The playbook

### T-1 night (last night before expiry) — now automated
1. **OI profile per strike** for the expiring series: OI, ΔOI, volume — build the ladder from the
   unified store (works after market close; source tonight: UPSTOX_LIVE ladders).
2. **Derived levels**: max pain (weak magnet), largest CE wall (resistance), largest PE wall
   (support), PCR(OI), total OI.
3. **Implied move**: ATM straddle premium (CE+PE) ≈ market's expected ±range for expiry day.
4. **Spot vs levels**: distance to max pain / walls → candidate pin corridor.
5. **Strike plan**: recentred ATM±N strike list per index, validated against the broker master
   (generator output), so tomorrow's in-band strikes are subscribed *before* the open.
6. **Pre-commit**: budget (Path A ceilings), max entry premium, exit rules (target/stop/time),
   do-not-trade conditions (e.g., no entries after the policy cut-off — pending #29).
7. **Hygiene**: broker token renewal plan (FYERS token dies 06:00 IST daily), master
   re-download, ban-list glance.
8. **Context**: global cues that will print overnight (US close, Asia, GIFT NIFTY proxy), event
   calendar, prior day's close/H-L, 100/500-point round numbers in play.

### Pre-open (08:30–09:15)
1. **Gap classification** vs prior close: flat (±0.15%), small, large; note gap direction vs
   max-pain/walls (gap through a wall changes the day's regime).
2. **Global sync check**: overnight US close, Asia trading, any event released; confirm no
   outlier (crude/rates) that invalidates yesterday's plan.
3. **Pre-open auction (09:00–09:08)**: indicative price / order imbalance — if our pre-open
   capture is armed on the producing box, read it; otherwise fall back to first ticks.
4. **Re-center strikes** if the gap moved spot: regenerate/select ATM±N so the delta band
   (0.10–0.40) is covered by subscribed strikes.
5. **Bias matrix** (pin vs trend):
   - Walls close to spot + PCR balanced + small gap → *pin/range day* bias.
   - Spot outside both walls at open or gap through a wall with volume → *trend day* bias.
   - Big OI right at spot strikes → expect chop around those strikes.

### Intraday techniques (long-premium only — our constraint)
- **T1 Corridor mean-reversion (pin day):** when spot is between the major walls and near max
  pain, fade excursions toward corridor edges back **toward** max pain with defined risk; strikes:
  near-ATM with delta 0.25–0.4. Stop beyond the wall; target the corridor midline/pain.
- **T2 Wall-break continuation (trend day):** only after spot *accepts* beyond a major wall
  (holds >10–15 min / retest holds) — buy pullback continuation (CE above CE-wall break / PE
  below PE-wall break). Do not sell the breakout side. Avoid entries when the move is already
  extended (no chasing — mirrors the V1 rule).
- **T3 Timing:** prefer entries 09:30–13:00; the theta cliff steepens into the last 90 minutes;
  policy proposal (#29) = last entry 14:30, exits before 15:15. A long entry after ~14:00 needs
  fast, immediate follow-through or gets scratched.
- **T4 IV discipline:** if ATM straddle implies a move already > typical daily range (compare to
  recent realized), demands for big follow-through rise — size down or skip.
- **T5 Exercise hygiene:** if holding an ITM long into the last hour, decide explicitly: close
  (sale STT on premium) vs settle (exercise STT 0.15% of intrinsic). Default: close before 15:15.
- **T6 Magnets:** strike ladders and round numbers (e.g., NIFTY 23,000/22,500; BN 54,500/55,000)
  — expect order flow clumping; don't place stops exactly at them.
- **T7 Never-do (expiry or any day):** averaging down, martingale, auto-reversal after loss,
  widening stops to avoid being right-sized, trading unsubscribed/unquoted strikes.

### Risk management (unchanged ceilings apply)
- Path A ceilings: per-trade ₹20, portfolio ₹40, max 2 open, exposure ₹100, daily ₹20,
  drawdown ₹40 — **ceilings, not targets**.
- Expiry-day spreads widen: slippage assumptions must be conservative (15% slippage parameter
  already in force); avoid market orders in thin far strikes.
- Pin-risk near the close: settlement moves can whipsaw; the last 15 minutes are for exits,
  not entries.

## Part 4 — Implementation in this system (2026-09-28)

Shipped tonight:
- **`scripts/expiry-prep.js`** (deterministic, SELECT-only, tests 15/15):
  - `generate`: recentred subscription universe per index from the broker master (ATM±N,
    two-sided strikes only, lot/tick validated) → emits `FNO_MARKET_DATA_SYMBOLS`,
    `FNO_OPTION_CONTRACTS`, registry upsert SQL, summary JSON.
  - `report`: OI ladders, walls, max pain, PCR, ATM straddle, coverage/source stamps →
    `reports/expiry-prep-<date>.md` (+ raw JSON in the artifact dir).
- **Subscription cap fixed**: `fno-market-data.service.ts` hard-coded `.slice(0, 50)` →
  configurable `FNO_FEED_MAX_SYMBOLS` (default 200). VM now subscribes **153 symbols**
  (3 indices + 50 × NIFTY/BANKNIFTY/SENSEX recentered contracts).
- **Registry**: 150 recentred contracts upserted; the 8 pre-existing NSE rows sharing symbols
  had their wrong expiry (2026-09-25/26) corrected to **2026-09-29**.
- **VM**: Sep-28 build + this change deployed (`dist.bak-capfix` backup); both procs restarted
  clean 23:04 IST; 153-symbol subscribe confirmed in log.

Known gaps / next steps:
- Clarification **#29** decisions (entry cut-offs, spread caps, 0DTE vs next-expiry focus) —
  until answered, no expiry-day *behaviour* changes are active.
- `underlyingOfOptionSymbol` (feed-arbitration state) does not recognise BSE weekly notation
  (`SENSEX26O01…`) → SENSEX weekly options are not registered as an arbitrated universe.
  NIFTY/BANKNIFTY unaffected. Fix accompanied by a producer-side review (who owns SENSEX
  canonical rows) before enabling.
- NOT_SUBSCRIBED candidate labelling (registry rows without subscription) — pending code item.
- Auto pre-registration of the NEXT expiry at each roll (run `generate` after Thursday/Tuesday
  closes) + optionally arm the prep report on a T-1 schedule (08:00 IST) once #29 is answered.
- The prep report currently relies on the unified store's Upstox ladders for off-hours OI;
  during market hours the desk's own FYERS feed provides the same strikes (subscribed).

## Part 5 — Tonight's actual numbers (for the 2026-09-29 open)

Source: unified store, UPSTOX_LIVE, ~22:55 IST 2026-09-28. Full report:
`~/.hermes/cache/scratch/expiry-prep-2026-09-29.md`.

| | NIFTY 29SEP | BANKNIFTY 29SEP | SENSEX 01OCT |
|---|---|---|---|
| spot | 22,780.25 | 54,471.65 | 72,771.72 |
| PCR(OI) | 0.80 | 1.12 | 1.04 |
| max pain | 22,900 (+120) | 54,800 (+328) | 73,000 (+228) |
| call wall | 23,000 | 55,000 | 73,500 |
| put wall | 22,800 | 54,000 | 72,000 |
| ATM straddle | 153.6 (±0.67%) | 464 (±0.85%) | 862 (±1.18%) |

Read (advisory): all three max-pain strikes sit ABOVE spot with heavy call walls one step up —
a mild upside-pin configuration; NIFTY's corridor 22,800–23,000 is the tightest of the three.
If the market opens inside the corridor, T1 rules apply; through 23,000 with acceptance, T2.

## References (verified sources)

- NSE — Securities Transaction Tax (rates w.e.f. 2026-04-01):
  https://www.nseindia.com/static/products-services/equity-derivatives-securities-transaction-tax
  and https://www.nseindia.com/static/invest/first-time-investor-sebi-turnover-fees-stt-other-levies
- Stoll, H.R. & Whaley, R.E. — "Expiration day effects of index options and futures" (1987);
  and "Expiration-Day Effects: What Has Changed?" (JSTOR 4479396); "Program Trading and
  Expiration-Day Effects" (CFA Institute / FAJ 1987).
- Ni, S.X., Pearson, N.D. & Poteshman, A.M. — "Stock price clustering on option expiration
  dates", Journal of Financial Economics 78(1), 2005, pp. 49–87 (DOI 10.1016/j.jfineco.2004.08.005).
- Contract schedule, lot sizes, symbol notations: FYERS F&O master files (NSE_FO.csv, BSE_FO.csv),
  downloaded 2026-09-28, parsed by `scripts/expiry-prep.js`.
