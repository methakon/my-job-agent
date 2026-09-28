# Expiry-Day Research Reference — factors A to Z (Indian index options)

Status: **RESEARCH ONLY.** No factor below is an approved rule. Nothing here is
armed; the engine treats every factor as a hypothesis until it survives an
out-of-sample test on our own NIFTY / BANKNIFTY / SENSEX expiry data.

Compiled 2026-09-29 from two independently verified research passes. Every
factual claim carries an inline source that was checked live (HTTP 200) by the
researcher; anything that could not be verified is labelled **unverified**
inline and collected in §Verification notes.

**The distinction that governs this document.** A published result is evidence
that a *phenomenon* existed in a *specific market over a specific period*. It is
**not** evidence that a particular strike, level or pattern will repeat in
tomorrow's session. Strike-price clustering is documented; that is not a
forecast that a given strike will be tomorrow's target. Our engine therefore
enforces, in code and in tests, that no single factor — max pain, PCR, a call
wall, a put wall — can set direction on its own.

**Data reality (verified 2026-09-29):** the intraday index tape begins
2026-09-09 and contains **no prior expiry day**; there is **no index-futures
tick history** and **no order-book depth history**; breadth data is absent.
Factors C, D, J and M are blocked pending data collection. A/B/E/F/G have no
India-specific evidence in the sources found; H has exactly one, and it is
daily 2001–2013 aggregate data, not intraday expiry-day data.

---

## Part 1 — Option microstructure factors (A–M)

**Scope.** NSE NIFTY / BANKNIFTY and BSE SENSEX index options, cash-settled, session 09:15–15:30 IST. Following SEBI's 2025 approval, NSE index derivatives expire Tuesday and BSE SENSEX Thursday, effective 2025-09-01 ([ET, 2025-06-17](https://economictimes.indiatimes.com/markets/stocks/news/sebi-approves-nses-expiry-day-change-to-tuesday-report/printarticle/121908178.cms)). On 2026-09-29 both NIFTY and BANKNIFTY carry weekly *and* monthly expiries; SENSEX has none.

**Standing caveat.** A published result is evidence that a *phenomenon* existed in a *specific market over a specific period*. It is not evidence that a particular strike, level, or pattern will repeat tomorrow. Every entry below is a hypothesis to be tested on our own Indian index data out-of-sample before becoming a rule.

### A. Strike-price clustering / pinning at expiration

**What it is.** Dealer hedging of long option positions creates a mechanical pull toward heavily-held strikes as expiration nears: time decay reduces dealer delta, forcing re-hedging, and in-the-money options are exercised or sold, which trades against the underlying in the direction of the strike.

**Evidence.** Ni, Pearson & Poteshman, "Stock price clustering on option expiration dates," *Journal of Financial Economics* 78(1), 2005, 49–87 ([doi:10.1016/j.jfineco.2004.08.005](https://doi.org/10.1016/j.jfineco.2004.08.005)) — US optionable stocks; abstract: on expiration dates closes cluster at strike prices, with returns of optionable stocks altered by an average of at least 16.5bp, implying ~$9bn aggregate market-cap shifts; attributes this to hedge rebalancing *and* proprietary price manipulation ([HKBU record](https://scholars.hkbu.edu.hk/en/publications/stock-price-clustering-on-option-expiration-dates-3/)). Golez & Jackwerth, "Pinning in the S&P 500 futures," *JFE* 106(3), 2012, 566–585 ([doi:10.1016/j.jfineco.2012.06.010](https://doi.org/10.1016/j.jfineco.2012.06.010); [working-paper PDF](https://kops.uni-konstanz.de/bitstreams/9a1772fe-3a5e-49f5-9a86-b2387ba8e167/download)) — S&P 500 futures, Jan 1990–Dec 2009: pinning defined as settling within $0.25 of the ATM strike, elevated on expiry days vs ±5 days, stronger from above the strike (an arbitrage-limit asymmetry), stronger in later sub-periods. Mechanism modelled by Avellaneda & Lipkin, *Quantitative Finance* 3(6), 2003, 417–425 ([doi:10.1088/1469-7688/3/6/301](https://doi.org/10.1088/1469-7688/3/6/301)); Avellaneda, Kasyan & Lipkin, *Comm. Pure Appl. Math.* 65(7), 2012, 949–974 ([doi:10.1002/cpa.21404](https://doi.org/10.1002/cpa.21404)).

**Limitations.** Effects are small in absolute terms and asymmetric. Golez–Jackwerth's own finding that pinning strengthened over time and is stronger above the strike shows the effect is regime- and arbitrage-limit-dependent, not a constant. Ni–Pearson–Poteshman bundle pinning with manipulation, so "closing near a strike" is not purely mechanical. Neither study covers index options; both concern single stocks and index *futures*.

**India.** Not established for Indian index data in the sources found.

**Test.** For each of the last 20 NIFTY expiries, measure distance of the 15:30 close to the ATM strike (and to the highest-OI strike) in units of that day's realised range; compare against a matched non-expiry control sample (same weekday, ±2 weeks). Falsification: if the distribution of normalised distance is statistically indistinguishable from control, reject clustering as an exploitable regularity. Requires a large enough window of expiries before any inference — see warnings.

**Caution.** Observed clustering at *historical* high-OI strikes is evidence of a hedging mechanism, not a forecast that a given strike will attract price tomorrow.

### B. Delta-hedging effects

**What it is.** Dealers hold short options and hedge dynamically in the underlying. As expiry and spot moves change option delta, hedge ratios change, generating mechanical spot flow that can dampen or amplify moves.

**Evidence.** Golez & Jackwerth (2012, above) attribute pinning to time-decay-driven delta rebalancing plus ITM reselling. Avellaneda & Lipkin (2003) formalise the hedging channel. Chiang, "Stock returns on option expiration dates: Price impact of liquidity trading," *Journal of Empirical Finance* 28, 2014, 273–290 ([doi:10.1016/j.jempfin.2014.03.003](https://doi.org/10.1016/j.jempfin.2014.03.003)) — stocks with large deeply-ITM call OI drop ~0.8pp on expiry then reverse; attributes this to ITM call exercise-and-sell, *not* offset by writers or put rebalancing.

**Limitations.** Chiang is single-name, not index. Delta-hedging flow is state-dependent: it is stabilizing when dealers are long gamma and destabilizing when short — so "delta hedging" is not a directional signal on its own. Requires futures or index OI to observe dealer positioning, which we lack.

**India.** Not established for Indian index data in the sources found.

**Test.** Regress next-day-to-close return on the estimated net dealer delta (from published OI-by-strike × sign convention) across expiries; falsification: coefficient indistinguishable from zero after controlling for realised volatility and event-day return.

**Caution.** Delta-hedging is a *mechanism*, not a direction; it cannot be used alone to classify bullish versus bearish days.

### C. Gamma exposure / dealer gamma

**What it is.** Aggregate gamma across the option chain determines how much underlying a given spot move forces dealers to trade. Positive gamma damps moves; negative gamma amplifies them.

**Evidence.** Amaya, Garcia-Ares, Pearson & Vasquez, "0DTE Index Options and Market Volatility: How Large is Their Impact?", Cboe research, 25 Jan 2025 ([PDF](https://cdn.cboe.com/resources/education/research_publications/gammasqueezes.pdf)) — SPX/SPXW, Jan 2020–Jun 2023 using Cboe trade data to infer market-maker positions; estimates *maximum* OMM-gamma impact at ~3.3pp change in annualised realised volatility, which the authors themselves note is not large relative to the ~20% of days on which realised volatility moves ≥3pp anyway. The paper's own framing — "maximum impact," with proprietary position data — is itself a limitation: it is an upper bound, not a typical effect.

**Limitations.** Requires proprietary trade-level data to identify who is long/short. Estimates are upper bounds. Effect is concentrated in 0DTE, which is structurally different from weekly/monthly index expiry in India.

**India.** Not established for Indian index data in the sources found. This factor is **blocked pending data collection**: computing dealer gamma requires OI-by-strike, which we do not capture, plus a sign convention that public data cannot resolve uniquely.

**Test.** Not testable with current data. Minimum requirement: daily OI by strike and expiry for NIFTY and BANKNIFTY over many expiries, then regress intraday realised vol on lagged aggregate gamma sign.

**Caution.** A vendor "gamma exposure" number computed from OI alone is a modelling assumption, not an observation.

### D. Gamma flip / zero-gamma concepts

**What it is.** The spot level where aggregate gamma crosses zero, below which dealer hedging switches from dampening to amplifying moves. Practitioner-originated concept.

**Evidence.** No peer-reviewed study establishing the gamma-flip level as a predictive variable was found in the sources searched. The nearest rigorous work is Amaya et al. (2025) above, which measures gamma *impact* but does not validate a zero-gamma threshold as a trading signal. Treat gamma-flip levels as practitioner/anecdotal.

**Limitations.** Entirely dependent on the same unavailable OI-by-strike and sign-convention inputs as C; doubly parameterised (sign assumption *and* level). Inherits every limitation of C and adds a threshold that is sensitive to small input changes.

**India.** Not established for Indian index data in the sources found. **Requires data collection first.**

**Test.** Deferred with C. If ever tested, use a sign convention and report sensitivity across ±1 sign flips; a signal that inverts under a plausible alternative sign assumption is not a signal.

**Caution.** Practitioner concept, unverified as a distinct phenomenon in the academic literature located.

### E. OI concentration and OI migration

**What it is.** Open interest concentrates at a few strikes; that concentration *migrates* between expiries and through the day as new weekly/monthly contracts roll in and old ones decay.

**Evidence.** Underlying to Ni–Pearson–Poteshman (2005) and Golez–Jackwerth (2012), both of which use OI at/near the ATM strike as the pinning object. Avellaneda–Kasyan–Lipkin (2012) model OI-driven pinning dynamics. No source found that isolates *migration* per se as a separate causal factor; the concept is largely implicit in the expiry-rotation literature.

**Limitations.** OI is a stock, not a flow — it does not reveal whether positions are being built or closed. OI-based measures inherit any strike-selection or sign assumptions. Effects documented in US markets where option share of volume differs structurally from India.

**India.** Not established for Indian index data in the sources found.

**Test.** Track the strike holding the maximum OI for each NIFTY expiry from T-5 to T; measure whether close-to-max-OI-strike distance is smaller on days when concentration is high. Falsification: no relationship between OI concentration (e.g. top-3 strike OI share) and normalised close-to-max-OI distance.

**Caution.** OI concentration identifies where hedging pressure *may* sit, not where price *will* go.

### F. Call-wall / put-wall behaviour

**What it is.** Practitioner shorthand for the strike with highest call OI (resistance) or highest put OI (support), treated as levels price is expected to respect or reverse at.

**Evidence.** Not established in the peer-reviewed literature as an independent effect. It is a re-description of the OI-concentration objects used in Ni–Pearson–Poteshman (2005) and Golez–Jackwerth (2012), which document *pinning at* heavily-traded strikes — that is the opposite of the directional "wall blocks price" framing. Golez–Jackwerth's asymmetry result (stronger from above) is specifically a limits-to-arbitrage finding, not a wall-resistance finding.

**Limitations.** Confuses a *descriptive statistic* (where OI sits) with a *directional prediction*. Directionally symmetric by construction, so it cannot supply direction without a separate rule — which is precisely why our engine must not derive direction from call wall or put wall individually. Practitioner/anecdotal as a trading rule.

**India.** Not established for Indian index data in the sources found.

**Test.** Measure whether expiry-day highs/lows terminate near the max-call-OI and max-put-OI strikes more often than a strike-matched null (shuffled-strike control). Falsification: termination frequency equal to null. Must be tested with a *shuffled* strike control, not a uniform one, to absorb the fact that round strikes attract OI regardless of any hedging effect.

**Caution.** A wall that is often *touched* is not a wall that is often *respected*; test the second, not the first.

### G. Max-pain limitations

**What it is.** The strike at which option buyers' aggregate intrinsic loss at expiry is maximised (equivalently, writers' gain). Widely promoted as a price attractor.

**Evidence.** **No peer-reviewed study establishing max pain as a price-attractor was located in the sources searched.** The closest verified India-adjacent item was Yang, "An Empirical Analysis of Stock Price Manipulation in the Expiration Days of Futures and Options," *Korean Journal of Financial Studies* 2018 ([doi:10.26845/kjfs.2018.10.47.5.709](https://doi.org/10.26845/kjfs.2018.10.47.5.709)) — framed as *manipulation*, not natural pinning, which is a materially different claim. Max-pain as a predictive rule is practitioner/anecdotal in the sources found.

**Limitations.** It is a **computational artefact** — the unique minimiser of a convex payoff function — not an estimate of any participant's position. It ignores strike-wise OI weighting in most published formulations, and it embeds a strong assumption (that option buyers are uniformly long and writers uniformly short at every strike) which is empirically false and not observable from public data. It is a *consequence* of payoff geometry, not a cause of flow.

**India.** Not established for Indian index data in the sources found.

**Test.** If tested at all, compare distance-to-max-pain with a null in which max-pain is recomputed on randomly permuted OI across strikes (preserving the OI level distribution). Falsification: real max-pain explains no more close-distance than the permuted null. This is a demanding null and most published max-pain claims will not survive it.

**Caution.** Max pain is the most over-claimed factor in retail expiry-day practice; treat any rule derived from it as unproven until it beats a permutation null.

### H. PCR (put-call ratio) limitations

**What it is.** Total put OI (or volume) divided by call OI (or volume). Read as a sentiment/positioning gauge.

**Evidence.** The one verified India-specific study: Jena, Tiwari & Mitra, "Put–Call Ratio Volume vs. Open Interest in Predicting Market Return: A Frequency Domain Rolling Causality Analysis," *Economies* 7(1), 2019, 24 ([doi:10.3390/economies7010024](https://doi.org/10.3390/economies7010024); [PDF](https://mdpi-res.com/d_attachment/economies/economies-07-00024/article_deploy/economies-07-00024.pdf)) — **NSE Nifty options, 1 Jun 2001 to 16 May 2013**. Finding: volume PCR predicted returns over a short ~2.5-day horizon; OI PCR over a longer ~12-day horizon; results robust to controlling for Nifty index futures volume. Critically, the horizons differ by construction and neither is intraday or expiry-day-specific. The paper also uses frequency-domain *rolling causality*, not a directional sign rule — it does not establish "high PCR means up."

**Limitations.** Horizon-dependence is structural: PCR at different aggregation levels means different things, so a single PCR threshold is meaningless without a stated horizon. Aggregation across all expiries and strikes (as in Jena et al.) mixes weekly, monthly, ITM and OTM — precisely the cross-contamination that matters on a double-expiry day. PCR is a *ratio of stocks*, so it is scale-free but confounded: a small absolute change in either leg moves it a lot. It is a positioning/sentiment proxy, not a price-mechanism, and cannot by itself distinguish bullish from bearish continuation.

**India.** Yes — tested, but on **daily aggregate data 2001–2013**, not intraday and not on 2024–26 weekly/monthly expiry structure. The regime since weekly expiries (Feb 2019 per [Kiran, *IJBE* 7(1), 2022](https://doi.org/10.58885/ijbe.v07i1.066.kk)) is materially different and untested in that paper.

**Test.** Recompute PCR restricted to the expiring contract only, at fixed times (e.g. 09:30, 12:00, 15:00), and test whether it predicts same-day remaining-session return across NIFTY expiries; compare against the same statistic aggregated across all strikes. Falsification: no incremental explanatory power over realised vol and event-day return once the expiring-only definition is used.

**Caution.** A PCR number without a stated horizon, leg definition, and expiry filter is not interpretable.

### I. ATM straddle implied-move behaviour

**What it is.** The ATM straddle price implies a market-priced move for the remainder of the session; the tradable question is whether realised range exceeds or falls short of it.

**Evidence.** The foundational implied-vs-realised result: Christensen & Prabhala, "The relation between implied and realized volatility," *JFE* 50(2), 1998, 125–150 ([doi:10.1016/S0304-405X(98)00034-8](https://doi.org/10.1016/S0304-405X(98)00034-8); [PDF](https://finance.martinsewell.com/stylized-facts/volatility/ChristensenPrabhala1998.pdf)) — S&P 100 options, **Nov 1983 – May 1995**: implied volatility outperforms past volatility in forecasting future volatility and subsumes past-vol information in some specifications; the authors attribute conflicting earlier results to a **regime shift around the October 1987 crash**. That is a direct, citable warning that implied-move relationships are regime-dependent. Cross-sectional vol-structure evidence: Dumas, Fleming & Whaley, "Implied Volatility Functions: Empirical Tests," NBER WP 5500, 1996 ([10.3386/w5500](https://doi.org/10.3386/w5500); [abstract](https://econpapers.repec.org/paper/nbrnberwo/5500.htm)) — S&P 500 index options, **Jun 1988 – Dec 1993**; implied vol varies systematically with strike and maturity; a deterministic-volatility-function model performs *worse* than ad hoc Black-Scholes with variable IVs.

**Limitations.** Christensen–Prabhala's own regime finding means any implied-move relationship estimated on one era may not hold in another. Both studies predate 0DTE and the current Indian weekly-expiry structure entirely. Implied move is a *variance* forecast — it says nothing about direction, so on its own it cannot separate bullish from bearish continuation. Straddle-implied moves embed the volatility risk premium, so realised < implied is the expected case, not a signal.

**India.** Not established for Indian index data in the sources found.

**Test.** For each NIFTY expiry, compute the ATM straddle implied move (straddle price ÷ spot) and the realised intraday range-to-close move; regress realised on implied with expiry-day and non-expiry-day samples. Falsification: realised/implied ratio indistinguishable from its non-expiry-day control, or the relationship's sign flips across sub-periods.

**Caution.** Implied move prices *magnitude*, not direction; using it for direction is a category error.

### J. IV expansion and IV crush on expiry day

**What it is.** Implied volatility tends to fall as time to expiry shrinks (volatility surface normalisation), and can jump on event or flow shocks; post-expiry the next contract's IV reprices.

**Evidence.** Dumas, Fleming & Whaley (1996) — IV is systematically related to time to expiration ([abstract](https://econpapers.repec.org/paper/nbrnberwo/5500.htm)). Amaya et al. (2025), Cboe research ([PDF](https://cdn.cboe.com/resources/education/research_publications/gammasqueezes.pdf)) — SPX, Jan 2020–Jun 2023: short-dated options have large gammas whose hedge rebalancing may impact the index, with a modelled maximum contribution of ~3.3pp annualised realised vol. Supporting the crush side, Xu, "Expiration-Day Effects of Stock and Index Futures and Options in Sweden," *Journal of Futures Markets* 34(9), 2013, 868–882 ([doi:10.1002/fut.21620](https://doi.org/10.1002/fut.21620)) documents expiration-day effects in a developed non-US index market.

**Limitations.** "IV crush" is largely a *mechanical consequence of the Black-Scholes time-decay of the variance term*, not a tradable event — the expected move shrinks as τ→0 whether or not anything happens. The surprise component (IV change *beyond* the mechanical decay) is the only candidate signal, and that requires correctly specifying the decay term, which is model-dependent. Amaya et al. is an upper bound on gamma impact, and its 0DTE focus is structurally unlike Indian weekly/monthly expiry.

**India.** Not established for Indian index data in the sources found.

**Test.** Compute realised IV change on expiry day minus the model-implied decay from the prior day's surface; test whether the residual predicts same-day realised volatility. Falsification: residual has no relationship to realised vol beyond the mechanical term. **Requires intraday option quotes by strike, which we do not capture — data collection required first.**

**Caution.** A large part of "IV crush on expiry" is an identity of the pricing model, not an empirical fact about the market.

### K. Theta acceleration on expiry day

**What it is.** Time value decays at an accelerating rate as expiry approaches, so the option's price responds increasingly to spot moves relative to time decay.

**Evidence.** This is a direct mathematical property of Black-Scholes time value, not a contested empirical finding; the verified cross-sectional evidence that IV varies systematically with time to expiration is Dumas, Fleming & Whaley (1996) ([10.3386/w5500](https://doi.org/10.3386/w5500)). **No peer-reviewed study was located that documents theta acceleration as an independent, testable predictor of index expiry-day direction** in the sources searched.

**Limitations.** As a mechanism it is certain and therefore not a source of edge; as a *signal* it is unverified. It says nothing about direction. The acceleration is largest for ATM and near-expiry options and requires a specific strike/maturity to quantify, making it a cost/positioning input rather than a directional input.

**India.** Not established for Indian index data in the sources found.

**Test.** Where used, test only the *residual* beyond mechanical decay, as in J; the mechanical component is a known constant and cannot be validated.

**Caution.** Certain mechanism, unproven signal — do not let certainty about the maths transfer to confidence about a trading rule.

### L. Opening-range breakout / opening-range failure

**What it is.** Classifying the day by whether price breaks beyond a defined opening range (typically the first 15–30 minutes) and whether the break persists or fails.

**Evidence.** Peer-reviewed profitability evidence is thin and mostly negative or market-specific: Tsai et al., "Assessing the Profitability of Timely Opening Range Breakout on Index Futures Markets," *IEEE Access* 7, 2019, 32061–32071 ([doi:10.1109/access.2019.2899177](https://doi.org/10.1109/access.2019.2899177)) — index futures, not Indian. A recent pre-registered study argues the effect does not survive trading costs: Fetna, "Opening-Range Breakout Does Not Survive Trading Costs: A Pre-Registered 225-Cell Study on Sixteen Years of Futures Data," SSRN, 2026 ([doi:10.2139/ssrn.7428398](https://doi.org/10.2139/ssrn.7428398)) — **working paper, unrefereed**. Broad context on the fragility of rule-based technical findings: Park & Irwin, "What do we know about the profitability of technical analysis?", *Journal of Economic Surveys* 21(4), 2007, 786–826 ([doi:10.1111/j.1467-6419.2007.00519.x](https://doi.org/10.1111/j.1467-6419.2007.00519.x)) — survey concludes published profitability results are dominated by data-snooping and ex-post rule selection.

**Limitations.** Definition-sensitive: results change materially with the opening-range window length, breakout buffer, and session boundaries, all of which are chosen by the researcher. Fetna (2026) is a working paper and unreviewed — label accordingly. Park & Irwin is the key caution: ORB profitability claims across all technical-rule families are substantially contaminated by selection effects. Expiry days may have distinctive opening behaviour driven by settlement flow rather than information, so non-expiry ORB results do not transfer.

**India.** Not established for Indian index expiry days in the sources found.

**Test.** Fix the OR window (e.g. 09:15–09:45) *before* testing and hold it constant; measure next-30-minute continuation conditional on a buffered break, on expiry days vs matched non-expiry days. Falsification: no significant difference between expiry and non-expiry, or effect vanishes after costs/STT.

**Caution.** Parameter selection is the main risk here; a rule that only works at one lookback is a fitted artifact, not an edge.

### M. VWAP reclaim / rejection

**What it is.** Classifying intraday price action by whether price reclaims or rejects the session's volume-weighted average price, used as a state descriptor for continuation vs mean-reversion.

**Evidence.** **No peer-reviewed study was located in the sources searched that establishes VWAP reclaim/rejection as a validated expiry-day directional signal for index options.** The nearest related verified work concerns intraday momentum rather than VWAP specifically: Gao, Han, Li & Zhou, "Market intraday momentum," *JFE* 129(2), 2018, 394–414 ([doi:10.1016/j.jfineco.2018.05.009](https://doi.org/10.1016/j.jfineco.2018.05.009)), and Baltussen, Da, Lammers & Martens, "Hedging demand and market intraday momentum," *JFE* 142(1), 2021, 377–403 ([doi:10.1016/j.jfineco.2021.04.029](https://doi.org/10.1016/j.jfineco.2021.04.029)) — the latter links options hedging demand to intraday momentum. **These are about intraday return continuation, not VWAP levels, and should not be cited as VWAP evidence.** VWAP as a trading signal is practitioner/anecdotal in the sources found.

**Limitations.** Inherits all intraday-momentum caveats. VWAP is path- and volume-dependent: a single large block early in the session anchors the level for the whole day, so the "signal" is partly an artefact of flow concentration — and expiry days have unusually concentrated settlement-day volume, which mechanically changes VWAP behaviour. On a double-expiry day the anchor is even more distorted.

**India.** Not established for Indian index data in the sources found.

**Test.** Requires intraday index volume, which an index-level tape does not provide — **data collection required first**. Once available: test whether close-above-VWAP predicts same-day-to-close continuation conditional on a buffered break, on expiry vs non-expiry days. Falsification: no difference between expiry and control, or effect disappears when the largest 1% volume prints are excluded (anchoring test).

**Caution.** On expiry days VWAP is anchored by settlement flow, so its behaviour may differ structurally from normal sessions — do not assume normal-session VWAP results transfer.

---

## Part 2 — Decision factors (N–Z)

**Standing methodological note.** Every entry below describes a *phenomenon* observed in a specific sample, not a repeatable level or pattern. Each is a hypothesis to be validated out-of-sample on our own Indian index data before becoming a rule. **We currently have zero historical expiry sessions captured** (intraday index tape begins 2026-09-09, no prior expiry day), **no index-futures tick history**, and **no order-book depth history** — so all futures-basis, depth, and multi-expiry factors are marked *requires data collection first*.

### N. Futures basis and futures-vs-spot divergence
**What it is.** Basis = (F − S)/S for the expiring index future. On expiry, F converges to S by construction, so a large pre-close basis is a mechanical imbalance, not necessarily a directional forecast; the informative content is the *rate* of convergence and whether futures lead spot.
**Evidence.** Golez & Jackwerth, "Pinning in the S&P 500 futures," *Journal of Financial Econometrics* 2012, 106(3), 566–585 (https://ideas.repec.org/a/eee/jfinec/v106y2012i3p566-585.html): US futures are pulled toward ATM on serial-option-expiry days and pushed *away* from the cost-of-carry-adjusted ATM strike just before index-option expiry (anti-cross-pinning). Indian cost-of-carry/liquidity work on the futures–cash basis exists (e.g. https://onlinelibrary.wiley.com/doi/10.1002/fut.21540, *Journal of Futures Markets*, "Impact of Liquidity on the Futures-Cash Basis: Evidence from the Indian Market") but I could **not** verify its abstract text (Wiley bot-wall) — treat the specific findings as **unverified**. Indian spot–futures price discovery for Nifty/Bank Nifty exists in the literature but I did not verify a specific citable claim — **unverified**.
**Limitations.** Basis near zero on expiry is mechanical; its predictability is regime- and liquidity-dependent; Indian basis is distorted by retail-heavy flow and index rebalancing. Requires futures tick history.
**India-tested?** Not established for Indian index *expiry-day* data in the sources found.
**Test on our data.** Collect NIFTY/BANKNIFTY/SENSEX near-month futures 1-min bars; measure signed basis return (Δ ln F/S) from 09:15 to 14:00 vs realised spot return 14:00–15:30; test Granger causality and out-of-sample R² vs matched non-expiry days. Falsification: no positive out-of-sample R² on 2027 holdout.
*Phenomenon ≠ rule:* documented convergence is not a repeatable intraday trade.

### O. Breadth and index-component confirmation
**What it is.** Fraction of index constituents advancing, or constituents trading within a band of index level. A cap-weighted index can rise on a few heavyweights while breadth is negative — divergence is the signal.
**Evidence.** No peer-reviewed study verifying intraday index-breadth → next-hour index return on Indian data was found. Breadth-as-sentiment is documented in practitioner and index-provider material (e.g. https://www.niftytrader.in/advance-decline-ratio) — **practitioner/anecdotal**, not evidence. Global cross-sectional breadth work exists (https://sciencedirect.com/science/article/pii/S0264999319312982) but is cross-sectional monthly-horizon, not intraday expiry — not applicable.
**Limitations.** NIFTY is only 50 names and heavily concentrated; breadth can be mechanically skewed by index rebalancing and by stocks in halt. Not validated for intraday expiry.
**India-tested?** Not established for Indian index data in the sources found.
**Test.** Build 1-min advance/decline line for the 50 constituents plus 20 Nifty Bank names; correlate breadth-within-±0.3% of index move against 30-min forward index return across expiries vs matched non-expiry sessions; Falsification: |Spearman ρ| < 0.15 out-of-sample.
*Phenomenon ≠ rule:* a decoupling between index and breadth is a state, not a trigger.

### P. Volume confirmation
**What it is.** Whether a directional move is accompanied by above-median traded value, particularly in expiring (ATM) strikes.
**Evidence.** Stoll & Whaley (cited in Agarwalla & Pandey, IIMA W.P. 2012-11-03, https://www.iima.ac.in/sites/default/files/rnpfiles/19191060542012-11-03.pdf) find significantly increased trading volume in index stocks during the last hour on S&P 500 futures-expiry days. SEBI's own expiry-day data (Sept 2026 Consultation Paper, https://www.sebi.gov.in/sebi_data/attachdocs/sep-2026/1789202841824.pdf) show NSE expiring benchmark index options averaged ₹176.74 crore premium/minute over 09:15–15:30 pre-CAS, with the last 30-min share elevated — direct Indian expiry-day confirmation of end-of-day concentration. Indian volume/OI evidence: Srivastava, "Informational content of trading volume and open interest," *Indian Journal of Finance and Research* 2004, 14(1&2), 49–72 (https://indianjournals.com/article/ijfr-14-1and2-005).
**Limitations.** Volume spikes on expiry are a function of hedging unwinds and settlement, not information; heavily regime-dependent; intraday volume level scales with index level and STT change.
**India-tested?** Yes for expiry-day volume concentration (SEBI; Stoll/Whaley via IIMA) and for OI/volume price discovery (Srivastava).
**Test.** Compute ATM-strike premium turnover share of day by 15-min bucket on the first 20 captured expiries vs 20 matched non-expiry Tuesdays; Falsification: last-30-min share not significantly > midday share.
*Phenomenon ≠ rule:* elevated volume confirms activity, not direction.

### Q. Bid/ask imbalance and market-depth pressure
**What it is.** Order-flow imbalance (OFI) at top of book predicts short-horizon price change.
**Evidence.** Cont, Kukanov & Stoikov, "The Price Impact of Order Book Events," *Journal of Financial Econometrics* 2014, 12(1), 47–88 (https://econpapers.repec.org/RePEc:oup:jfinec:v:12:y:2014:i:1:p:47-88.): short-interval price changes are driven by OFI with a near-linear relation whose slope is inversely proportional to depth; robust to intraday seasonality. **India-specific:** Tripathi & Dixit, "Information content of order imbalance in an order-driven market: Indian evidence," *Financial Research Letters* 2021, 41 (https://ideas.repec.org/a/eee/finlet/v41y2021ics1544612320316779.html): using 195 most-active NSE stocks, order-imbalance info makes short-term returns predictable, "strong for the first five minutes, and perishes within thirty minutes," and reaches deeper book levels.
**Limitations.** CKS is US equity, single-stock; Tripathi & Dixit is single-stock NSE, not index options. We have **no depth history** — requires collection.
**India-tested?** Yes, for NSE single stocks; not for index options or expiry days.
**Test.** Start L1/L2 collection on NIFTY expiring ATM futures/options; compute OFI per Cont et al.; regress 1/5/15-min forward index returns; Falsification: coefficient sign flips or |t| < 2 out-of-sample.
*Phenomenon ≠ rule:* OFI is a short-horizon flow measure, not a directional day call.

### R. Price / OI / volume relationships
**What it is.** Co-movement of price, open interest and volume across strikes (e.g. price up + call OI up = fresh buying vs. short covering).
**Evidence.** Avinash & Mallikarjunappa, "Information embedded in options open interest and their utility in directional trading," *Asian Journal of Management Science and Applications* 2018, 3(4), 279–301, DOI 10.1504/AJMSA.2018.098900 (https://www.inderscience.com/info/inarticle.php?artid=98900): using Nifty50 + 10 stock options at NSE (FY2011–2016), OI-distribution-based active strategies beat passive ones for predicting direction at expiry. Srivastava (2004, above) finds OI more significant than volume in Indian price discovery. IIMA Paper 81 (NSE, https://nsearchives.nseindia.com/content/research/Paper81.pdf) tests Bhuyan–Yan OI/volume predictors on Indian stock options and finds significant explanatory power. *Caveat:* these argue predictability, not reliability; max pain / PCR / walls are **never** to be used alone.
**Limitations.** Predictive power is period- and regime-specific, tested at daily frequency mostly; heavily retail-influenced OI can be stale/wrong; OI-based strategies are not robust to costs.
**India-tested?** Yes (NSE), but not specifically expiry-day intraday.
**Test.** Compute per-expiry call/put OI-weighted strike distribution at 09:30, 11:00, 13:30; measure next-2h index return vs strike-of-max-OI; Falsification: no monotone relation out-of-sample. Treat max-pain as **one bucket at most**, never a direction source.
*Phenomenon ≠ rule:* an OI wall is an observed position, not a barrier the market must respect.

### S. Gap-up / gap-down expiry behaviour
**What it is.** Overnight gap (open vs prior settle) and whether it is filled during the session. India has no overnight futures session, so the gap is a spot-led artifact.
**Evidence.** Overnight-vs-intraday asymmetry in Indian markets is documented in the literature (e.g. "The Effects of Overnight Events on Daytime Return," *Applied Financial Economics* 2024, https://ideas.repec.org/a/kap/apfinm/v31y2024i3d10.1007_s10690-023-09424-9.html) but I could **not** verify full text — **partially unverified**. No verified study ties gap-fill *rates* specifically to Indian index expiry days.
**Limitations.** Gaps are dominated by global overnight moves (US, SGX Nifty) and macro, not expiry mechanics.
**India-tested?** Not established for Indian index expiry data in the sources found.
**Test.** Once ≥20 expiries captured, compute gap size (open−prior close) in % and gap-fill (does price cross prior close by 15:30?) vs matched non-expiry Tuesdays; Falsification: fill rate on expiry ≈ fill rate on non-expiry.
*Phenomenon ≠ rule:* gap-fill asymmetry, if any, must be measured before use.

### T. Previous-day high/low and overnight range as levels
**What it is.** Prior-day H/L, prior close, and the SGX overnight range act as reference levels for expiry-day reaction.
**Evidence.** Agarwalla & Pandey (IIMA 2012, above) find high volatility in the first one-hour after weekends — an overnight-information-absorption effect, not an expiry effect. Overnight information drives opening variance (McInish & Wood 1990; Foster & Viswanathan 1990, as cited therein). No verified expiry-specific prior-H/L study for India.
**Limitations.** Levels are regime-dependent; frequent breaks render them useless; expiry-day range can be compressed by pinning-type forces.
**India-tested?** Not established for Indian index expiry data in the sources found.
**Test.** Count prior-day H/L breaks before 10:00 and close inside/outside, on expiries vs matched days; Falsification: no significant difference in break-and-fail rate.
*Phenomenon ≠ rule:* a level is a reference point, not a magnet or trigger.

### U. Pre-open auction information
**What it is.** Order-book-implied opening price. **Verified exchange facts (NSE):** pre-open is **09:00–09:15**, not 09:00–09:08. Cash ([Pre-Open Session](https://www.nseindia.com/static/products-services/equity-market-pre-open)) and equity-derivatives ([Pre-Open Session, F&O](https://www.nseindia.com/static/products-services/equity-derivatives-pre-open-session)) both run 09:00–09:15: order entry 09:00–09:05 (limit+market), 09:05–09:10 (limit only, random closure in last 2 min), matching 09:10–09:12, buffer 09:12–09:15. Equilibrium = max executable volume, tie-broken by minimum unmatched imbalance, then closeness to prior close. **Critical:** the F&O pre-open applies to *futures* (single-stock and index), **not options**. Options open only at 09:15 continuous.
**Evidence.** NSE pages above (verified). SEBI (https://www.sebi.gov.in/sebi_data/attachdocs/sep-2026/1789202841824.pdf) notes the closing CAS analogue for stocks.
**Limitations.** Pre-open covers futures only; option-market sentiment is not directly observable pre-open; auction imbalance is a short-horizon flow signal, not a day-direction forecast.
**India-tested?** Exchange mechanics verified; predictive value not established for Indian index expiry.
**Test.** Log pre-open futures equilibrium, imbalance and prior close each session; correlate with 09:15–10:00 index return; Falsification: no stable sign.
*Phenomenon ≠ rule:* the auction is a price-discovery mechanism, not a directional signal by itself.

### V. First 5/15/30-minute behaviour
**What it is.** Opening-window return and range set the day's tone; used to classify trend vs range.
**Evidence.** Gao, Han, Li & Zhou, "Intraday Momentum: The First Half-Hour Return Predicts the Last Half-Hour Return" (2014, https://www.smallake.kr/wp-content/uploads/2015/01/SSRN-id2440866.pdf): SPY 1993–2013, first-half-hour return predicts last-half-hour with R²≈1.6%, stronger on high-volatility and high-volume days — **US ETF, not India, not expiry**. Indian intraday periodicity: Patnaik & Shah, "Intraday Behaviour of Stock Markets: A Study of the Indian Equity Markets" (2004, https://papers.ssrn.com/sol3/papers.cfm?abstract_id=568346) — NSE every-trade data Mar1999–Feb2001, distinct U-shaped intraday volatility, Fourier Flexible Form; and Sampath & ArunKumar (2013, https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2255391) — Nifty tick returns Aug2000–Dec2003, high volatility through first 30 min and rising in last 15 min.
**Limitations.** Gao et al. is US; transfer to Indian index expiry is unproven. India evidence is generic intraday, not expiry-conditional.
**India-tested?** Partially — Indian intraday periodicity yes; expiry-conditional open-window prediction no.
**Test.** Compute 5/15/30-min returns and range/ATR on captured expiries; regress 14:00–15:30 return on first-30-min return; Falsification: no positive out-of-sample relation.
*Phenomenon ≠ rule:* open-window information may not survive to the close in India.

### W. Trend day vs range day classification
**What it is.** Classifying the session by efficiency ratio (net move ÷ total path length) to select continuation vs mean-reversion logic.
**Evidence.** No verified peer-reviewed study of trend-vs-range day classification on Indian index expiry sessions was found. Regime/classification frameworks in the general literature (Admati & Pfleiderer 1988; Brock & Kleidon 1992, as summarised in Agarwalla & Pandey IIMA 2012) explain *why* periodic volatility arises but not a classifier.
**Limitations.** Classifier thresholds are arbitrary without validation; trend/range mix is regime-dependent.
**India-tested?** Not established for Indian index data in the sources found.
**Test.** Compute efficiency ratio (|P_15:30 − P_09:15| ÷ Σ|ΔP|) for each captured expiry; label top/bottom tercile; compare continuation vs reversal hit rates of the same directional signal across terciles; Falsification: no conditional difference.
*Phenomenon ≠ rule:* a day's character must be measured, not assumed.

### X. False breakout / liquidity sweep behaviour
**What it is.** Price breaks a level then closes back inside, "sweeping" resting liquidity.
**Evidence.** Opening-range-breakout (ORB) profitability is contested: Holmberg, Lönnbark & Lundström, "Assessing the profitability of intraday opening range breakout strategies," *Financial Research Letters* 2013, 10(1), 27–33 (https://ideas.repec.org/a/eee/finlet/v10y2013i1p27-33.html) tests ORB success/profitability. Practitioner blogs on ORB (e.g. https://www.equiti.com/sc-en/news/trading-ideas/opening-range-breakout-strategy) are **anecdotal**. I could not verify a peer-reviewed false-breakout-rate study for Indian index expiry — **not established in sources found**.
**Limitations.** Breakout/filter rules are highly parameter-sensitive; transaction costs dominate marginal edges; regime- and volatility-dependent.
**India-tested?** Not established for Indian index data in the sources found.
**Test.** Measure false-breakout rate = share of opening-range (or prior-H/L) breaks that close back inside within N minutes, across captured expiries vs matched non-expiry sessions; Falsification: no significant difference in false-break rate.
*Phenomenon ≠ rule:* a sweep is a path statistic, not a reversal signal until measured.

### Y. Expiry-day reversal patterns
**What it is.** Intraday reversals concentrated near expiry, often tied to pinning then post-settlement profit-taking.
**Evidence.** Mahalwala, "A Study of Expiration-day Effects of Index Derivatives Trading in India," *Metamorphosis: A Journal of Management Research* 2016, 15(1) (https://journals.sagepub.com/doi/10.1177/0972622516629029): CNX Nifty daily data, ARMA-EGARCH, finds "significant but non-disastrous" expiry-day effects in volume, return, volatility and price reversal. Kumar (IIM Indore), "Does Short-dated Options Introduction Mitigate Expiry Day Effects?" *International Journal of Business and Economics* 2022, 7(1), 66–76 (https://ielas.org/ijbe/index.php/ijbe/article/download/16/20): before weekly index options (pre-Feb2019) an upward price shift and transitory volatility shift on expiry; these "disappear" after. Singh & Shaik, "Re-examining the Expiration Effects of Index Futures: Evidence from India," *IJEFI* 2020, 10(3) (https://econjournals.com/index.php/ijefi/article/view/9429): 74 Bank Nifty expiry dates (Apr2013–Jun2019), 37 before/37 after weekly options; expiry-group volume significantly different; post-weekly evidence of "high return, low volatility and decrease in volume." Golez & Jackwerth (above) document pinning/anti-cross-pinning. IV crush is a standard practitioner concept but I found **no** verified peer-reviewed empirical citation specific to Indian expiry IV crush — **unverified**.
**Limitations.** Daily-frequency studies cannot locate intraday reversals; regime changes (weekly-index introduction, 2026 STT) invalidate older samples; "reversal" definitions vary.
**India-tested?** Yes (daily frequency), the strongest India-specific evidence base here.
**Test.** On captured expiries, measure reversal rate = share of ≥1-sigma intraday excursions that retrace >50% by 15:30, split pre-/post-14:00; Falsification: reversal rate not > matched non-expiry days.
*Phenomenon ≠ rule:* a documented expiry reversal tendency is a prior, not a per-day rule.

### Z. Time-of-day effects, especially theta/gamma acceleration and late-session liquidity deterioration
**What it is.** Intraday volatility/liquidity periodicity; on expiry, gamma/theta accelerate near close while liquidity thins.
**Evidence.** Strong India-specific: Agarwalla & Pandey, IIMA W.P. 2012-11-03 (https://www.iima.ac.in/sites/default/files/rnpfiles/19191060542012-11-03.pdf) — 500 most-liquid NSE stocks, 2001–2009, FFF regressions: Indian market shows "reverse J"-shaped intraday volatility; and critically, "Volatility of the stocks with derivative contracts increases in the last half-an-hour trade on the expiry day… but not in other time intervals." Patnaik & Shah (2004) and Sampath & ArunKumar (2013) above document U-shape/evening surge. Krishnan & Mishra, "Intraday liquidity patterns in Indian stock market," *Journal of Asian Economics* 2013, 28, 99–114, DOI 10.1016/j.asieco.2013.05.005 (https://research.monash.edu/en/publications/intraday-liquidity-patterns-in-indian-stock-market): NSE NIFTY stocks, volume *and* spread liquidity measures U-shaped, with the anomalous coexistence of high volume and wide spreads. Singh & Gangwar, "A Temporal Analysis of Intraday Volatility of Nifty Futures on the NSE," ZBW Working Paper (2018, https://www.econstor.eu/bitstream/10419/183471/1/Nifty-Intraday-Volatility.pdf): Nifty 50 futures 1-min ticks, Jan2011–Aug2018, U-shaped intraday volatility, declining over time. **SEBI's own data (https://www.sebi.gov.in/sebi_data/attachdocs/sep-2026/1789202841824.pdf)** documents expiry-day end-of-session concentration: NSE expiring benchmark index options 8.83% of daily premium in 14:30–15:00 and 5.72% in 15:00–15:30 (pre-CAS), rising per-minute in the CAS window. **Costs:** Budget 2026 (Memorandum, Clause 143, https://www.indiabudget.gov.in/doc/memo.pdf) raises STT on option sale from 0.1%→**0.15% of premium**, on exercise 0.125%→**0.15% of intrinsic**, and futures 0.02%→0.05%, effective **1 April 2026** — raising the cost of late-day churn (verified from the primary Budget memo; corroborated by ET: https://m.economictimes.com/wealth/tax/from-april-1-2026-stock-market-fo-trading-gets-costlier-know-how-much-extra-you-need-to-pay-budget-2026-announcement/articleshow/127839141.cms).
**Limitations.** Much of the India evidence is pre-2026 regime; the 2026 STT hike and Aug-2026 CAS change microstructure mid-sample; single-stock studies may not transfer to index; theta/gamma mechanics are structural (not statistically tested here).
**India-tested?** Yes, most thoroughly of all factors (IIMA 2012; ZBW 2018; Krishnan & Mishra 2013; SEBI 2026).
**Test.** Compute realised vol and bid–ask spread by 15-min bucket on expiries vs non-expiries; test for a distinct last-30-min vol/spread spike on expiry days; Falsification: no distinguishable expiry-day intraday profile after controlling for day-of-week.
*Phenomenon ≠ rule:* a documented evening volatility/volatility spike is a structural prior, not a timing cue.

---

## Part 3 — Time-window and intraday-seasonality research

### Time-window research
Exchange-verified structural anchors (NSE, links above): pre-open **09:00–09:15** (cash & F&O; F&O = futures only); continuous trading **09:15–15:30**; Closing Auction Session (CAS) in the **cash** segment for F&O stocks, with order entry 15:15–15:30, matching ~15:30–15:35, transition 15:35–15:50, post-close 15:50–16:00 (https://www.nseindia.com/static/products-services/closing-auction-session). SEBI (Sept 2026) confirms derivatives keep trading while the underlying runs CAS on expiry — derivatives activity concentrates into the close.

**Most public commentary on specific intraday windows (e.g. "trade 09:15–09:20", "avoid 11:00–13:00") is anecdotal/broker material and is NOT evidence.** What the peer-reviewed/primary record actually supports:
- **Evidence-based:** Indian intraday volatility is reverse-J/U-shaped with a late-day (last 15–30 min) concentration; expiry-day last-half-hour volatility is elevated for derivative stocks (IIMA 2012); expiry-day premium turnover concentrates at the close (SEBI 2026).
- **Must be measured empirically, not assumed:** the specific sub-windows 09:15–09:20, 09:20–09:30, 09:30–10:00, 10:00–11:00, 11:00–13:00 (midday lull), 13:00–14:00, 14:00–15:15, and the final 15 minutes. For each, we must compute realised vol, range, spread, and volume on our captured expiries and compare to matched non-expiry sessions before treating any window as special. Midday lull and afternoon-trend are hypotheses to test, not established expiry-day facts.

### Intraday seasonality in Indian markets
The **09:15–09:30 opening volatility burst** is well documented: Patnaik & Shah (https://papers.ssrn.com/sol3/papers.cfm?abstract_id=568346) find a distinct U-shaped intraday volatility profile on NSE every-trade data (1999–2001); Sampath & ArunKumar (https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2255391) find high opening volatility sustained through the first 30 minutes on Nifty (2000–2003); Agarwalla & Pandey (https://www.iima.ac.in/sites/default/files/rnpfiles/19191060542012-11-03.pdf) show a "reverse J" shape with elevated first-hour volatility (2001–2009) and attribute the open to overnight-information absorption. The **midday lull** and **14:00–15:00 afternoon/evening trend** follow from the same U/reverse-J periodicity and the last-15–30-min evening volatility surge in these studies, and Krishnan & Mishra (DOI 10.1016/j.asieco.2013.05.005, https://research.monash.edu/en/publications/intraday-liquidity-patterns-in-indian-stock-market) document U-shaped volume *and* spread liquidity on NSE. Singh & Gangwar (https://www.econstor.eu/bitstream/10419/183471/1/Nifty-Intraday-Volatility.pdf) independently confirm the Nifty-futures U-shape (2011–2018). **Caveat:** these are generic intraday patterns, **not** established as expiry-day-specific or as directional signals; the morning burst and evening concentration are phenomena, and turning them into timing rules requires out-of-sample validation on our own data.

---

### Cross-cutting methodological warnings

- **Look-ahead bias.** Every OI, wall, max-pain, and gamma figure must be computed from data available *before* the decision timestamp. End-of-day OI used to explain the same day's intraday price is the most common and most fatal error in this domain. Max pain in particular is *always* a full-day, end-of-day quantity — it cannot inform an intraday decision without look-ahead.
- **Data-mining on a small sample.** Our intraday index tape begins 2026-09-09 and contains **no prior expiry day**. A pattern fitted to a handful of observations is a fitted artifact. The pre-registered, multi-cell approach in Fetna (2026, working paper) and the bootstrap data-snooping framework of Sullivan, Timmermann & White, *Journal of Finance* 54(5), 1999, 1647–1691 ([doi:10.1111/0022-1082.00163](https://doi.org/10.1111/0022-1082.00163)) are the appropriate standards; Park & Irwin (2007) documents how systematically technical-rule results fail these tests.
- **Survivorship and instrument-listing bias.** Weekly contracts added or retired over time, strike intervals that changed historically, and NSE's 2025 Thursday→Tuesday expiry shift all mean any "consistent" history is partly a changing-instrument artifact. The regulatory regime has shifted materially: SEBI approved NSE to Tuesday and BSE SENSEX to Thursday effective 2025-09-01 ([ET, 2025-06-17](https://economictimes.indiatimes.com/markets/stocks/news/sebi-approves-nses-expiry-day-change-to-tuesday-report/printarticle/121908178.cms)), and weekly index options began Feb 2019 ([Kiran, *IJBE* 7(1), 2022](https://doi.org/10.58885/ijbe.v07i1.066.kk)). Results from before and after these dates are not drawn from the same market.
- **Phenomenon ≠ tradable edge.** Even where an effect is real (Ni–Pearson–Poteshman find ≥16.5bp average return alteration; Golez–Jackwerth find statistically elevated pinning), the effect size is a fraction of round-trip transaction costs, and the 2026 Finance Act STT regime on options (0.15% of premium on sale, 0.15% of intrinsic on exercise) is large relative to these magnitudes. A documented phenomenon is a necessary, not sufficient, condition for an edge.
- **Validate out-of-sample on Indian data.** No factor in this section has been validated on NIFTY, BANKNIFTY or SENSEX expiry sessions. Factors C, D, J and M additionally require data we do not currently capture (OI-by-strike, intraday option quotes, intraday index volume) and must be marked *requires data collection first*. Until a factor survives an out-of-sample test on Indian expiry days — with costs, with a fixed specification chosen before testing, and against a proper null (permuted, shuffled, or matched control) — it remains a hypothesis. **Insufficient evidence must produce NO TRADE**, not a directional guess.

## Verification notes

### Research method notes (A–M batch)

- - Several DOIs I expected to use did not resolve on Crossref (404s), so I dropped them rather than cite from memory. Notably I could **not** verify Han (2008) "Pin Risk" in JFQA, Bruner et al. (2008) "Gamma Trading and Gamma Bumps" in JFQA, or Baltussen/Bekker/van Vliet on pinning — all three are commonly cited in this area. I found no authoritative record for them and did not guess DOIs. Treat them as unverified if you want to include them.
- Entries C, D, J and M are blocked on data we do not have, as flagged inline. Entry A/B/E/F/G have no India-specific evidence at all; H has exactly one, and it is daily 2001–2013 aggregate data, not intraday expiry-day data.

### Unverified / flagged items (N–Z batch)

(1) the Wiley futures–cash-basis Indian paper's specific findings (bot-walled, not read); (2) the *Applied Financial Economics* overnight-events paper's full text (abstract only); (3) expiry-specific IV-crush evidence for India (no verified citation found); (4) any peer-reviewed false-breakout / trend-vs-range / breadth studies on Indian index expiry sessions (none found). All other URLs above returned HTTP 200 and their claims were confirmed in the retrieved text.
