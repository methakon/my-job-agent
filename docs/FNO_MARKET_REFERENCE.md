# F&O Market Reference

Structured project reference doc for the F&O (Futures & Options) paper-trading desk. Consolidates market literacy, instrument mechanics, signals, and the gap-trading reference from the local PDFs into one navigable document. This is the desk's "what the market does" reference; it does not replace the session-risk policy (that lives in `docs/FNO_PAPER_PLAN.md`) or the build guide (that lives in the `option-paper-trading` skill).

**Scope:** NSE F&O (Nifty 50, Bank Nifty, FinNifty, index futures, CE/PE options, ~182 F&O stocks). The desk's envelope is ₹5,000 simulated balance; realistic instrument is option buying (CE/PE) because naked futures and naked option selling need margin the envelope can't support.

## Contents

1. [F&O instrument mechanics](#1-fo-instrument-mechanics)
2. [NSE / Indian market specifics](#2-nse--indian-market-specifics)
3. [Option pricing drivers (Greeks + IV)](#3-option-pricing-drivers-greeks--iv)
4. [Open Interest + price confirmation](#4-open-interest--price-confirmation)
5. [PCR and max pain](#5-put-call-ratio-pcr-and-max-pain)
6. [IV regime and instrument choice](#6-iv-regime-and-instrument-choice)
7. [Entry discipline](#7-entry-discipline)
8. [Common strategies (orientation)](#8-common-strategies-orientation)
9. [Risk management (the envelope)](#9-risk-management-the-envelope)
10. [Central stat: 89% of individual F&O traders lose money](#10-central-stat-89-of-individual-fo-traders-lose-money)
11. [Gap-trading reference (from DOC-20250115-WA0020..pdf)](#11-gap-trading-reference-from-doc-20250115-wa0020pdf)
12. [Sources](#12-sources)

---

## 1. F&O instrument mechanics

**Futures** — a binding agreement to buy/sell the underlying at a pre-agreed price on expiry. Both sides have obligation. Marked-to-market daily. Margin calls apply. Symmetric, unlimited payoff on both sides. Lot-based, cash-settled on NSE.

**Options** — give the *buyer* a right, not an obligation. The buyer pays a premium; maximum loss = premium. Profit potential is theoretically unlimited (calls) or large (puts). The *seller* (writer) collects the premium but takes on obligation — unlimited risk on naked calls, must maintain margin. Non-linear payoff.

The single structural distinction — "right without obligation" vs "obligation" — drives almost every practical difference in margin, risk, breakeven, and strategy. Do not blur the two. This is the desk's core mental model.

## 2. NSE / Indian market specifics

- Nifty 50 lot = 75 units; Bank Nifty = 30; FinNifty = 60; Sensex (BSE) = 20. Always whole lots — never fractional.
- Nifty at ~22,000 → 1 lot notional ≈ ₹16.5 lakh; margin ≈ 10-15% of contract value (~₹1.5-2.5 lakh). This is why a small simulated balance like ₹5,000 makes **option buying** the realistic F&O instrument, not naked futures.
- Index options: European-style (exercisable only at expiry). Weekly expiry every Thursday; monthly also available.
- Stock options: monthly expiry; ~182 stocks in the F&O segment (reviewed quarterly by SEBI for liquidity, market cap, median quarter-sigma order size).
- Index derivatives dominate retail participation; Nifty + Bank Nifty options are the most liquid.
- Derivatives now contribute roughly 96-97% of total market turnover in India; cash/delivery market is ~3-4%. For every ₹1 traded in delivery, ₹250-300 trade in F&O.

## 3. Option pricing drivers (Greeks + IV)

An option premium is not just a function of where the underlying is. The Greeks and volatility matter:

- **Delta** — how much the option price moves per 1-point move in the underlying. ATM options have delta near 0.5 (calls) / -0.5 (puts). Deep ITM approaches 1.0 / -1.0; OTM approaches 0.
- **Gamma** — rate of change of delta. Highest near ATM, especially near expiry. This is why ATM/near-ATM options can swing violently in the last hours.
- **Theta** — time decay. Options lose value every day as expiry approaches; decay accelerates near expiry. This is the force that eats option buyers who hold too long or buy too far OTM.
- **Vega** — sensitivity to implied volatility changes. High IV = expensive options (favors selling strategies); low IV = cheap (favors buying).
- **Implied Volatility (IV)** — the market's forecast of future move, priced into the premium. High IV percentile = options costly; low IV percentile = options cheap. Don't buy OTM when IV is already elevated and expected to crush.

Key practical point: a ₹5 OTM option losing 60% is a bigger percentage loss than a ₹50 ATM option losing 20%. Affordability is NOT value. Buying OTM to reduce capital outlay is one of the most capital-destructive habits in Indian retail F&O.

## 4. Open Interest (OI) + price confirmation

OI + price direction together tell you whether money is entering or leaving a position:

- **Rising price + rising OI** = fresh long buildup (new money entering longs). More informative than price alone.
- **Falling price + rising OI** = fresh short buildup (new money entering shorts).
- **Rising price + falling OI** = short covering (existing shorts exiting, not fresh longs).
- **Falling price + falling OI** = long unwinding (existing longs exiting).

Pull OI data after the first 15 minutes of price discovery settles (around 9:30 AM). Look for OI change ≥5% from the opening print alongside a directional price move. Separate buildup from covering before acting.

## 5. Put-Call Ratio (PCR) and max pain

- **PCR (put-call ratio)** — ratio of put volume/OI to call volume/OI. PCR > 1 = bullish bias (more puts being written/bought); PCR < 1 = bearish bias (more calls being written). Extreme readings (e.g. < 0.7 or > 1.3) often signal sentiment extremes.
- **Max pain** — the strike at which option writers (sellers) lose the least money; options buyers lose the most. Acts as a magnet or resistance/support depending on whether price is above or below it. The highest-OI strike in weekly options often acts this way.

These are sentiment references, not triggers. Use them to orient, not to enter.

## 6. IV regime and instrument choice

- **High IV regime** — options are expensive; time decay is costly to buyers; IV crush can kill a directionally-correct option trade. Favors *selling/writing* strategies (where the seller profits from decay) — but only with appropriate risk controls and margin, and generally not for a small-balance paper desk.
- **Low IV regime** — options are cheap; buying has better risk/reward because less premium is being burned by theta. Favors *buying* strategies.
- For a small-balance desk (₹5,000 simulated), the realistic F&O path is **option buying** (CE/PE), because naked futures require margin the envelope can't support, and naked option selling requires margin + risk controls the envelope can't support. Futures may become viable as the balance grows.

Do not infer the instrument from the signal. Decide CE vs PE vs future per trade on its own merits.

## 7. Entry discipline (what the desk should respect)

- Enter only after price breaks and *closes* above/below the previous day's high or low on a 15-minute chart, with simultaneous OI addition of at least 5% from the opening print. Breakouts without OI confirmation are often fakeouts.
- For option buyers: buy ATM or one-strike ITM to avoid excessive theta decay on entry day. OTM entry on day 1 is usually a theta-and-IV trap.
- For futures: place stop at the swing low/high of the entry candle — not a fixed percentage. A fixed % stop on a futures position ignores the structure of the move.
- For option buyers: the stop is often a 25-30% drop in premium from entry, not the underlying's price level. An option can drop 50%+ while the underlying barely moves.

## 8. Common strategies (orientation, not a catalog to run)

- **Long futures** — bullish directional; symmetric risk; margin-managed.
- **Short futures** — bearish directional; symmetric risk; margin + margin calls.
- **Bull call spread** — buy lower-strike call, sell higher-strike call. Reduces cost vs naked call; limited profit, limited risk. Moderate upward expectation.
- **Bear put spread** — buy higher-strike put, sell lower-strike put. Mirror of bull call spread for downward expectation.
- **Iron condor** — sell OTM call + OTM put, buy further OTM call + put for protection. Range-bound, low-volatility periods. Popular during calm markets.
- **Expiry-day theta selling** — sell OTM options on Thursday (weekly expiry) when theta decay is at maximum. Requires careful strike selection and strict stops. Popular among Bank Nifty traders. Not suitable for a small-balance paper desk without explicit risk review.

These are orientation only. The desk does not have a fixed strategy catalog to cycle through. The instrument and structure are decided per trade.

## 9. Risk management (the part that matters for the envelope)

- **Never risk more than ~2% of capital on a single F&O idea.** Leverage means small mistakes become large losses fast.
- **For a ₹5,000 envelope:** 1% per-trade sizing (₹50 initial) is more conservative than the 2%-per-idea rule — appropriate given the balance size. This is a sizing guideline, not a price-based stop trigger.
- **No rigid session loss stop.** F&O positions routinely swing 5-50% against before reversing to +150-200%; a fixed % stop exits before the recovery. The agent evaluates each open position dynamically and calculatively instead.
- **Recovery layering is allowed but learnable.** When a F&O position drops and reversal looks possible, a second cover trade at a lower price may reduce net drawdown — preferred near the local low, not mid-fall. This is a learnable behavior, not an automatic rule; the exact trigger is tuned from session outcomes.
- **Maximum simultaneous open positions is governed by the remaining balance and risk budget, not capped at 1.** Preferred default is one F&O trade at a time because balance is limited; layering happens only when recovery logic justifies it and budget allows.
- **No averaging down for its own sake, no martingale sizing, no revenge trades.** Layering is a measured, evidence-backed decision.
- **Costs matter.** Brokerage, exchange transaction charges, SEBI fees, GST add up to ~0.05-0.07% of turnover on derivatives; brokerage at most discount brokers is ₹20 per executed order on F&O. Include costs in max-loss and P&L calculations.

## 10. Central stat: 89% of individual F&O traders lose money

SEBI's own study (2024) found that **89% of individual F&O traders lost money** over the preceding three years, with average losses of ₹1.1 lakh per trader per year. The opportunity is massive; so is the risk. This is why the desk runs paper-only with tight envelopes and explicit learning gates, not live capital.

---

## 11. Gap-trading reference (from DOC-20250115-WA0020..pdf)

The PDF `~/Downloads/DOC-20250115-WA0020..pdf` is a scan/print compilation of three Active Trader articles on gap trading (March 2001, December 2004, May 2003). The bar-gap images in it (Amgen short squeeze, Transwitch profit-taking hook, American Power Conversion earnings miss, mini Dow Figs 1-4, Apple Computer AAPL daily gap sequence, Gold futures GC daily gap sequence) are chart examples illustrating the concepts below — they are not raw signals to copy. The value is in the methodology the articles describe. The agent should treat gap trading as a discretionary intraday setup discipline, not as a mechanical fill rule, and should adapt the ideas to the NSE F&O desk's instruments (Nifty/Bank Nifty futures + CE/PE) rather than treating the US stock/future examples as literal.

### 11a. What a gap is

A gap is the distance between the regular-session opening price and the previous day's closing price. A "bar gap" or "open gap" appears when price opens above the previous high or below the previous low — a void in which no trades occurred. Because no positions exist inside the gap zone, there is an absence of the usual upside resistance caused by traders exiting at breakeven/profit — which is why gaps often get filled but not always quickly.

Key point: the size or cause of a gap has little predictive power on its own. A 62-point gap, a 44-point gap, a 13-point gap, and a gap caused by a terror warning all behaved according to the same fill-probability dynamics. Size and cause are stories, not edges.

### 11b. John Carter's opening-gap setup (Active Trader, Dec 2004)

This is the most directly usable framework in the PDF. It is a **fade-the-gap** discipline (trade against the gap direction expecting fill), not a momentum setup.

**Pre-market volume filter (the key indicator):** Check pre-market volume at 9:20 AM ET in a specific set of representative stocks. The volume tier determines the fill probability and the trade management:

| Pre-market volume (per stock) | Gap-fill probability (same day) | Midpoint-hit probability | Position size | Trade target |
|---|---|---|---|---|
| < 30,000 shares | ~80% | — | Full size | Exit entire position at gap fill |
| 30,000-70,000 | ~60% | ~85% | 2/3 size | Exit half at 50% of gap fill, half at gap fill |
| > 70,000 | ~30% | — | No fade trade | No fade trade (follow gap direction) |

Low pre-market volume = lack of conviction = likely head-fake = good fade setup. High pre-market volume = real conviction = follow the gap, don't fade it.

**Instrument choice:** Individual stocks are poor gap-trade candidates (one-stock news). Index futures are better (components diversify idiosyncratic news). For the NSE F&O desk, the analogue is: Nifty/Bank Nifty index futures and ATM/near-ATM options are the natural gap-fill candidates, not individual F&O stocks.

**Reward/risk rule:** For gaps smaller than 40 mini-Dow points or 4 E-mini S&P points, use 1:1.5 reward/risk. For larger gaps, use 1:1. The article argues against the beginner's 3:1 mantra: wider stops produce more winners when the setup has >80% win probability; tightening the stop turns an 80%-win setup into a loser.

**Post-entry behavior:** Once the trade is on, walk away and let orders work. Professionals don't second-guess. Using a trailing stop on a high-probability gap fill setup hurts the win/loss ratio. This maps directly onto the desk's existing "no rigid stoploss, evaluate dynamically" philosophy.

**Trade management (Table 2):** as volume rises, position size shrinks and profit-taking becomes more conservative. Below 30K: full size, exit all at fill. 30-70K: 2/3 size, exit half at 50% fill + half at full fill. Above 70K: no fade, follow direction.

### 11c. What the bar-gap images show (interpretation)

- **Figure 1 (mini Dow 47-point gap up, Oct 15 2003):** Intel earnings caused a 47-point gap up with low pre-market volume (<30K). The fade setup: short the open at full size, target the pre-gap close. Filled within the first hour for a 47-point profit ($235/contract). Canonical "low volume gap = fade it" example.
- **Figure 2 (mini Dow gap down next day, Oct 16 2003):** After the Figure 1 fade, market sold off post-close (IBM earnings), gapped down next day, triggered a long fade setup. Small open loss, but the strategy is to hold through the 11 AM pullback because the setup has 80% win rate — most traders would have been stopped out at the pullback. Point: don't tighten stops on high-probability setups.
- **Figure 3 (E-mini S&P downside gap, Aug 2 2004, terrorist threat):** Market gapped down on terror news, spent the day filling the gap. 6.75-point S&P E-mini profit ($337.50/contract). Even "scary news" gaps get filled — the cause doesn't matter, the volume/friction does.
- **Figure 4 (mini Dow, multiple gaps Aug 18-26 2004):** A sequence: 44-point gap up on Aug 18 that didn't fill for six days (no trade, 30-70K volume, 2/3 size fade), then 62-point gap up on Intel earnings that was shorted full-size and filled in 6 bars for 62 points ($310/contract), then 52-point gap down next day filled in 9 bars for 44 points ($220/contract) on bear flag entry, then 44-point gap up short that nearly hit stop but filled for 255 points ($2,295). Illustrates: multiple gap setups in a week, different size rules per volume tier, a stop-out on one that still left profitable net for the week. The gap that stayed open for 6 days is the warning: some gaps don't fill quickly.

### 11d. The "Gap Closer" stock system (Active Trader, May 2003, Wealth-Lab)

Experimental backtest: go long the day after a large down gap (gap > 20-bar ATR), hold until price reaches the pre-gap low (gap filled), no protective stops. Rules: (1) enter long on open the day after a down gap > 20-bar ATR; (2) limit-sell at the pre-gap low; (3) hold indefinitely; (4) risk 9% of equity per trade.

**Results (Jan 1993-Jan 2003, 18-stock portfolio, 62 gaps):** 80% win rate (50 of 62 closed for profit), 11.94% net profit, 1.27 profit factor, 0.34 payoff ratio, 0.35 recovery factor, **-24.75% max drawdown**, 148-day average hold for winners, 348-day average hold for losers. The 12 uncrossed gaps averaged -32% loss and were open ~350 days (1.5 years).

**What this means:** "Gaps eventually close" is only 80% true. The 20% that don't destroyed most of the profits — average uncrossed gap lost -32% and sat open for 1.5 years. Trading gaps on their own (no stop, no confirmation) entails significant risk. Combine gaps with other tools. This supports the desk's philosophy of not trading a single signal in isolation.

### 11e. The "Gap Closer" futures system (Active Trader, May 2003, Wealth-Lab)

The futures version enters **as price begins to fill a down gap** (buy-stop at the high of the down-gap bar + 1 tick), exploiting the lack of resistance in the gap zone for momentum. Exits: (1) limit profit at the pre-gap low; (2) wide stop-loss at 3x the entry-to-target distance; (3) breakeven stop once the contract is up at least 1%. Risk: 10% equity per trade.

**Results (Aug 1993-Nov 2002, 20-future portfolio, 69 trades):** 69.57% win rate (counting breakevens as losers), 94.66% net profit, 1.79 profit factor, 0.96 payoff ratio, 2.08 recovery factor, -25.27% max drawdown, 16.62-day average hold, 8.96-day average hold for winners, 34.14-day for losers. Average gain on winners: 2.54%; average loss on losers: -2.65%. 11 breakeven-stop trades, 48 winners, 10 losers.

**What this means:** The futures version is more practical than the stock version because it enters on fill momentum rather than holding open gaps indefinitely. The breakeven-stop + wide-stop-loss exit structure is a real, testable exit framework. But 10% equity risk per trade and -25% max DD are institutional-scale; on a ₹5,000 envelope, size far smaller. Treat the futures gap-closer as: (a) confirmation that gap-fill momentum is a real short-term phenomenon, (b) a reference exit framework, (c) a caution that even a 70%-win system has -25% max DD and 34-day average loser hold time.

### 11f. What the desk should actually take from this PDF

1. **Gaps are a setup, not a signal.** A gap is a candidate setup that needs confirmation — the PDF's volume filter is one confirmation approach; the desk's existing OI+price, IV regime, and PCR filters are others. Don't trade a gap just because it exists.
2. **Volume/conviction matters more than gap size or cause.** Whether a gap fills depends on how much real money is behind the move. For NSE: index-futures volume, India VIX context, and OI buildup — not individual stock pre-market volume.
3. **Fade vs follow is a volume/conviction call.** Low conviction → fade expecting fill; high conviction → follow, don't fade. NSE analogue: a Nifty gap on low futures volume / low VIX momentum is a fade candidate; a Nifty gap on high volume / high VIX / strong OI buildup is a follow candidate.
4. **Position sizing should shrink as conviction rises (for fades).** The PDF's Table 2 is a concrete model: smaller position when volume is high (fade less likely), full position when volume is low (fade more likely). Use as reference for sizing gap-fade ideas relative to conviction, scaled to ₹5,000.
5. **Reward/risk for high-probability setups should be wider, not tighter.** The PDF's 1:1 for large gaps and 1:1.5 for small gaps, plus the argument against 3:1 on 80%-win setups, supports the desk's "no rigid stoploss" approach.
6. **"All gaps close" is only 80% true and the 20% that don't are brutal.** Don't hold a gap-fade position indefinitely waiting for a fill that may never come. The desk's dynamic evaluation + session risk budget + Friday lockout are the guardrails.
7. **Entry on gap-fill momentum is a real short-term edge for futures.** Enter when price penetrates back into the gap zone, target the pre-gap level, use a breakeven stop after 1% gain, and a wide stop below. Testable setup, not a blind rule.

### 11g. The bar-gap images: how the agent should use them

The bar-gap chart images in the PDF (Amgen, Transwitch, APC, mini Dow Figs 1-4, AAPL daily gap sequence, Gold GC daily gap sequence) are teaching examples, not trade templates. The agent should use them as visual reference for what a "short squeeze + hook close," a "profit-taking hook," an "earnings-miss gap down," and a "gap-fill sequence across multiple days" look like on a 5-minute chart — so that when the desk sees a similar pattern on a Nifty/Bank Nifty 5-minute chart, it can recognize the structure. Do NOT try to match the exact price levels, tick counts, or volume numbers from the US examples; those are specific to those stocks/futures on those days. The transferable content is the pattern logic: gap → low-volume fade setup vs high-volume follow setup → fill vs continuation → exit management.

### 11h. Gap trading and the desk's existing rules

Gap trading does not override any existing desk rule:

- The ₹5,000 envelope and 1%-per-trade sizing still apply. The PDF's 9-10% equity risk is institutional-scale and would be far too aggressive for this desk.
- The no-rigid-stoploss dynamic evaluation still applies. The PDF's wide-stop + breakeven-after-gain exit framework is compatible with dynamic evaluation.
- The five-session progression and auditability gates still apply. Any gap-fade setup the desk tries must go through the evidence gates in FNO_PAPER_PLAN.md.
- Recovery layering is still allowed under budget.
- Friday lockout still applies.

### 11i. Scope note

Gap trading in this PDF is primarily a **stock and US index future** methodology. The desk's real instruments are NSE Nifty/Bank Nifty futures and CE/PE options. Adapt the concepts (volume/conviction filter, fade vs follow, position sizing by conviction, entry on gap-fill momentum, exit framework) to NSE instruments and NSE data (futures volume, India VIX, OI, PCR) rather than importing the US stock examples literally. The PDF is reference literacy for gap dynamics, not a NSE trading system.

---

## 12. Sources

Material drawn from public F&O education sources (2026):

- BottomStreet — "F&O Trading Guide India — Futures and Options Trading on NSE Explained" — https://bottomstreet.com/learn/f-and-o-trading-guide-india
- TradingZenith — "8 Proven F&O Trading India (2026)" — https://tradingzenith.net/artigos/f-and-o-trading-india-guide
- VestAI — "Options Trading for Beginners India 2026" — https://vestai.io/learn/options-trading-beginners-india
- Aditya Trading — "F&O Trading Calls — Futures & Options Analyst Recommendations" — https://adityatrading.in/analyst-opinion/fno
- Sahi.com — "Futures vs Options India: A Structured Guide to F&O Trading" — https://sahi.com/blogs/futures-vs-options-india-a-structured-guide-to-f-and-o-trading
- Bankopedia — "F&O Trading in India: Basics, Risks & SEBI Rules" — https://bankopedia.co.in/investing/fo-trading-india-basics-risks-sebi-rules
- OneTradeJournal — "Futures vs Options India: Payoff, Margin and Tax" — https://onetradejournal.com/learn/futures-vs-options
- PSConnect — "Futures and Options (F&O) Trading: Essential Strategies for Indian Traders" — https://psuconnect.in/articles/futures-and-options-f-o-trading-essential-strategies-for-indian-traders
- Samco — "Best Futures And Options Trading Strategies For Beginners" — https://samco.in/knowledge-center/articles/future-and-option-trading-strategies
- WelthWest — "Understanding F&O Trading with AI Analytics: Nifty & Bank Nifty Guide 2026" — https://welthwest.com/blogs/understanding-fo-trading-with-ai-analytics-nifty-bank-nifty-guide-2026

**Desk-specific training guides (local PDFs in ~/Downloads/):**

- `Hermes_FO_Trading_Master_Guide.pdf` — "Hermes F&O Trading Master Guide: A practical curriculum for Futures & Options trading, quantitative algorithms, predictive modelling, risk management, and training Hermes for disciplined automated trading." — the directly actionable training/deployment curriculum for this agent. 12-month progression, 5-mode pipeline (research → backtest → paper/live shadow → small live → scale), V1 spec (NIFTY, 5m/15m/1h, LightGBM/XGBoost + DeepLOB thesis, HMM regime, 0.25-0.50% research starting risk), seven cheat codes, backtesting-hygiene standards. Treat as the agent's training curriculum, advanced only with evidence.
- `Futures & Options Trading Guide and Predictive Alg....pdf` — "Microstructure Dynamics, Quantitative Architectures, and Systemic Execution in Futures and Options Trading: Systematic Framework and Capital Allocation for Derivatives Traders." — the institutional quantitative layer: fractional Kelly, CVaR, OFI/MLOFI, Stoikov microprice, VPIN, footprint/CVD/absorption, Volume Profile (POC/VA/HVN/LVN), dealer GEX/gamma flip, Vanna/Charm, OU stat-arb + Kalman, DeepLOB (Zhang/Zohren/Roberts, arXiv:1808.03668), Almgren-Chriss, Avellaneda-Stoikov, CPCV, DSR. Liquidity- and capital-hungry relative to the ₹5,000 desk; treat as reference literacy and forward hypotheses, not current capability. Works cited in that PDF include arXiv papers on order-book price impact, multi-level OFI, microprice estimation, VPIN, and the flash-crash microstructure, plus footprint-chart and GEX references.
- `DOC-20250115-WA0020..pdf` — Active Trader magazine compilation (March 2001, December 2004, May 2003) on gap trading: John Carter's opening-gap volume-filter methodology, plus two Wealth-Lab "Gap Closer" backtests (stocks: 80% win, 11.94% net, -24.75% max DD; futures: 69.57% win, 94.66% net, 2.08 recovery factor, -25.27% max DD). The bar-gap chart images in it are teaching examples, not trade templates. Treat as reference literacy for gap dynamics — fade vs follow is a volume/conviction call, position sizing shrinks as conviction rises for fades, reward/risk for high-probability setups should be wider not tighter, "all gaps close" is only 80% true. Primary transferable content: gap-fill momentum entry for futures, exit framework (limit at pre-gap + breakeven after 1% + wide stop), and the caution that uncrossed gaps average -32% loss over 1.5 years.

Treat all sources as reference literacy, not as trade signals or as authoritative on any specific live-market situation.
