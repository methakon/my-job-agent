# Option-Chain Paper Trading — Playbook and Defect Library

Everything below is either (a) a rule that keeps a paper loop honest, or (b) a
defect that **silently produced plausible-looking wrong numbers** in a live NSE
session while the tests were green.

Part 1 is the discipline. Part 2 is the scar tissue — written as
**symptom → cause → fix**, because the symptom is almost never the cause.

---

# PART 1 — THE DISCIPLINE

## Non-negotiable

- **NO_TRADE is a valid, often successful outcome.** Never rescue via averaging
  down, doubling up, or automatic reversal.
- Never average down automatically. A new position must independently requalify.
- Never auto-reverse after a loss.
- No trade on stale, inconsistent or incomplete data.
- Every decision is journaled with its data snapshot and its reasons.
- Real and paper data stay explicitly separated.
- **Live execution is disabled.** Paper mode only. No order path in the code.

## Entry gates, in order

A gate that produces a *reason* is worth more than a gate that just refuses —
the refusals are what make the system learnable.

| # | Gate | Failure |
|---|------|---------|
| 1 | Data validity: fresh, two-sided, traded price present | NO_TRADE |
| 2 | Structural setup exists (compression → breakout → range) | NO_TRADE |
| 3 | Underlying direction agrees with the side taken | NO_TRADE |
| 4 | The option itself is moving that way | NO_TRADE |
| 5 | Not chasing: extension beyond structure | NO_TRADE |
| 6 | Liquidity: spread and depth | NO_TRADE / RESIZE |
| 7 | Loss boundary derivable **before** entry | NO_TRADE |
| 8 | One lot affordable at current capital | NO_TRADE |
| 9 | Inside the exchange session window | NO_TRADE |

Gates 1 and 7–8 are the non-negotiable ones. The rest express a strategy belief
and must be **learnable, not fixed**.

## Sizing

> "Position size is determined AFTER the strategy and stop structure are known.
> Do NOT begin with 'how many lots can I afford?' and then find a signal."

```js
riskLots       = floor(maxRiskPerTrade / (stopPerUnit * lotSize));
affordableLots = floor(availableCapital  / (premium  * lotSize));
lots = max(1, min(riskLots, affordableLots, capLots));
```

When one lot cannot respect the risk limit or the capital, the answer is
**NO_TRADE** — never a tighter stop, never a larger risk budget, never fractional
lots. The **only** hard financial invariant is
`TOTAL_COMMITTED <= AVAILABLE_CAPITAL`.

## Exits must be dynamic

No fixed target %, stop %, ₹ loss, holding time or profit target. The only fixed
boundary is the one decided **before** entry, and it is never widened — widening
after the fact fabricates a better result than the market gave.

Useful dynamic exits, each a *label for learning* rather than a veto:

- **boundary hit** (pre-entry structural stop, or an ATR trail ratcheted up from
  the running high-water mark)
- **expectancy decay** — gave back the run, or gross sits inside round-trip cost
- **regime change** — the premise no longer holds
- **confidence collapse** — evidence fell against the thesis since entry
- **time/expiry effect** — settlement window raises urgency, decides alone never
- **liquidity deterioration** — the exit becomes untradeable

A trail is ratcheted from the **high-water mark**, reconstructed from the path
taken rather than accumulated, so a restart cannot lose it.

## The accounting rule

```
ENTRY → MARK → DECIDE → EXIT → FINAL NET OUTCOME → LEARNING UPDATE
```

**Never update the model with an unrealised outcome.** A mark updates MFE/MAE and
reported P&L; only an actual close updates the posterior. The sequence matters —
training on an open trade is the single easiest way to corrupt a learning loop.

---

# PART 2 — THE DEFECT LIBRARY

Each item cost real debugging time. Tests were green throughout.

## The meta-lesson: green tests are not evidence

Three defects here were invisible to reading code *and* to a passing suite:

- An async harness calling `fn()` without `await`, so failures escaped as
  unhandled rejections **after** the summary printed. A failing test reported as
  passing.
- A `SELECT` aliasing the key column to `symbol` while the row normaliser read
  only the original column names. Every valid row normalised to `symbol: null`
  and was filtered out — **the data was correct throughout.**
- A freshness filter set to 15s against a feed whose p95 tick gap was 30s, so
  ~40% of fresh quotes were rejected and a live chain looked empty.

**Rule:** when a component disagrees with reality, instrument the actual call and
print intermediate values. Do not re-read the code, and do not rewrite the same
query hoping to spot it. Three rewrites failed; one instrumented call found it in
under a minute.

---

## 1. Missing data read as a market signal

**Symptom:** every position closed within minutes with a liquidity reason.

**Cause:** the feed carried `volume=0` and `oi=0` on **every** tick (39,462 of
39,462 rows). The monitor read `0` as "no volume, exit not fillable".

**Fix:** distinguish *absent* from *zero*. Gate on whether the field was reported.

```js
if (ctx.volumeReported && Number.isFinite(ctx.volume) && ctx.volume <= 0) {
  return { action: 'REDUCE', reason: 'LIQUIDITY_DETERIORATION' };
}
```

Absence is unknown, and unknown is never a signal. Same rule for `changeOi`,
`iv`, `bidQty`, `askQty` — null them, never default to 0.

**Test:** a feed reporting `volume: 0, volumeReported: false` HOLDS the position;
`volume: 0, volumeReported: true` exits.

---

## 2. Freshness judged on arrival time

**Symptom:** feed looked healthy — socket open, ticks every few seconds — but
persisted nothing.

**Cause:** the broker reconnected happily while **replaying yesterday's tape**.
Ticks arrived fresh; their exchange timestamp was 19 hours old.

**Fix:** freshness is the **exchange** timestamp. A feed carrying no exchange
timestamp is reported **unjudgeable**, never trusted.

---

## 3. Freshness budget inherited from a different feed

**Symptom:** a live, two-sided ladder returned empty.

**Cause:** a 15s budget against a feed measured at median 8s / p95 30s / max 113s
over 466 samples. ~40% of legitimately fresh quotes were rejected.

**Fix:** **measure** the cadence, then set the budget from it (45s cleared p95
with headroom). A freshness bound decides whether a quote may be acted on. It is
never a target or a stop.

---

## 4. Two canonical stores, one reader

**Symptom:** with feed A dead, the engine saw nothing while feed B streamed
44,000 rows/min of the identical contracts.

**Cause:** both providers already fed one canonical tick pipeline — but persisted
to **different tables**:

```
broker A -> interpreter -> canonical -> feed_option_quotes     (contractSymbol)
broker B -> interpreter -> canonical -> unified_option_quotes  (instrumentKey)
```

Redundancy survived until persistence, then split. A single-table reader cannot
fail over, no matter how healthy the second feed is.

**Fix:** one read surface over both. Normalise to one shape, prefer the freshest
exchange timestamp. Read-side only — do not migrate the write path.

The two schemas differ in **meaning**, not just naming. `feed_option_quotes` has
no `changeOi`, no `bidQty`/`askQty`, no `sourceTimestamp`; selecting them is a hard
SQL error. Verify with `SHOW COLUMNS` before writing the query.

---

## 5. Column-name assumptions across stores

| concept | `feed_option_quotes` | `unified_option_quotes` |
|---|---|---|
| key | `contractSymbol` | `instrumentKey` |
| OI | `openInterest` | `oi` |
| IV | `impliedVolatility` | `iv` |
| underlying | `NIFTY50-INDEX` | `NIFTY` |

**Fix:** alias every column to one name in the SELECT, and match underlying on a
**set** of aliases. A single-key lookup silently returns nothing.

---

## 6. mysql2 returns DATE columns as JS Date objects

**Symptom:** `expiry = 'Tue Oct 06'`, then `Incorrect DATE value: 'Tue Oct 06'` on
the next query. This silently corrupted registry rows through an
`ON DUPLICATE KEY UPDATE`, then failed live queries.

**Fix:** one helper at every DATE boundary. Read the local calendar fields — do
**not** round-trip through `toISOString()`, which shifts the day.

```js
function isoDay(v) {
  if (v == null) return null;
  if (v instanceof Date) {
    return `${v.getFullYear()}-${String(v.getMonth()+1).padStart(2,'0')}-${String(v.getDate()).padStart(2,'0')}`;
  }
  const m = String(v).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}
```

---

## 7. Symbol-form assumptions in expiry codes

**Symptom:** live ticks dropped as `missing expiry/strike/right`; the feed
registered "no option universe"; an entire expiry series silently ignored.

**Cause:** the broker uses **two** expiry-code forms — `DDMMM` (`26SEP`) and
`DDO0MM` (`26O06`, when week and month repeat). A `[A-Z]{3}`-only pattern matched
the first and rejected the second. This appeared in **three** separate places,
each needing its own fix.

**Worse:** the code does **not** contain the day. The broker's own contract master
proves it — `26SEP` is **29** Sep, `26OCT` is **27** Oct, `26DEC` is **29** Dec.
Any code reading `26` as the day produced a wrong expiry on every contract.

**Fix:** never derive a date from a symbol. Take it from authoritative contract
metadata; skip and log any symbol lacking it. To span providers, generate every
spelling from **structured parts** — a regex cannot tell a 2-digit day from a
root ending in digits, and emits garbage.

---

## 8. Account aliasing defeating an exact-key lookup

**Symptom:** a live ladder returned `found: false` for symbols verifiably present.

**Cause:** the SELECT aliased the key to `symbol`; the normaliser read only
`contractSymbol`/`instrumentKey`. Every row normalised to `symbol: null` and was
filtered out.

**Fix:** accept every name the key column can arrive under, and smoke-test the
**normalised row** against live data — not just the raw query.

---

## 9. Accounting that lets a mark breach an invariant

**Symptom:** `COMMITTED 4982 > EQUITY 4884`, `invariantHolds: false`, from a
position that was merely slightly adverse.

**Cause:** sizing equity included unrealised P&L. Capital already committed
cannot be un-committed by a mark.

**Fix:** sizing equity is **realised-only**. Report the mark separately so an
adverse position stays visible without corrupting the accounting.

```js
const realisedEquity = initialCapital + realizedNet;
const markedEquity   = realisedEquity + unrealizedNet;
invariantHolds: committed <= realisedEquity + 1e-9
```

---

## 10. Ratios with no floor

**Symptom:** `gave back 3150% of a 0.20-pt run`, forcing an exit 4 minutes after
entry on tick noise.

**Cause:** give-back = `(MFE − move) / MFE` with no minimum run.

**Fix:** require the excursion to be a *run* — at least 0.5 premium points **and**
a material fraction of the loss boundary.

---

## 11. Deciding on the same tick you entered

**Symptom:** a position closed one second after opening, booking fabricated P&L.

**Cause:** the first mark was the entry print. Zero elapsed time.

**Fix:** a minimum observation window (2 min) for non-structural exits. The
pre-entry loss boundary stays enforceable from the first mark — it is not
time-based.

---

## 12. A verdict resting on a field nobody populates

**Symptom:** a structural stop *always* used the volatility fallback.

**Cause:** the code read `breakout.rangeHigh`, but `detectBreakout` never returns
that field — it lives on `consolidation`. Undefined never matched, so the
structure branch silently never ran. Present upstream, absent in the port.

**Fix:** when reading a nested field across modules, assert it exists. A fallback
that always fires is a silent defect.

---

## 13. Reasoning about an outage from a stale note

**Symptom:** reported "auth expired, awaiting your login" repeatedly, while the
token was active and serving data.

**Cause:** reciting a state captured earlier in the session instead of reading
current state. Cost: a user was told to do something already done.

**Fix:** before stating any external condition, query it. Token status, process
state and row counts are one cheap call. If a claim would change what the user
does, verify it in the same breath.

---

## 14. Vendor policy that cannot be engineered around

Some brokers disable the token **refresh** API under regulator rules. An expired
access token cannot self-heal — the feed waits for a human login. Record it as a
user-blocker once and move on; do not loop, and do not attempt a broker login
autonomously.

---

## VERIFICATION BEFORE CLAIMING A LOOP WORKS

Run the real path against live data, not a fixture:

1. One live contract resolves end to end, bid **and** ask present.
2. Freshness is measured on the exchange timestamp and the reported age is sane.
3. A position survives ≥2 monitor passes without a fabricated exit.
4. Every closed trade reconciles **independently**:
   `gross = (exit − entry) × lotSize × lots`, `net = gross − itemised charges`,
   and the ledger sums match the outcome records.
5. `liveOrders = 0` on every outcome.
6. The capital invariant holds through an adverse mark.
7. The test harness awaits async tests and exits non-zero on failure.

A loop that has never completed a full lifecycle has produced **zero**
observations, no matter how many skip records it wrote. Neither does a losing
trade count as failure, nor a winning trade as validation — both are training
observations. Do not tune from one trade.