# GATE 5 input-capture scope — what Monday must capture for rows 50–52 / 55–59 (READ/DESIGN-FIRST, 2026-09-13)

**Purpose:** make the next live session **mechanically ready** to capture the microstructure inputs that
GATE 5's remaining rows need. This document is design/scope only: **no production behaviour is changed**, no
risk/execution/capital/REAL-trading control is touched, no GATE 5 row is marked done, and nothing is
manufactured. An offline-testable pure mapping prototype is included (see §7) but is **not wired** to any feed.

---

## 1. What each provider currently exposes (from the code, not assumed)

| Path | Code | What is requested | What arrives | Persisted |
|---|---|---|---|---|
| FYERS WS (primary) | `fno-market-data.service.ts:634` | `socket.subscribe(symbols, isDepth=false, channel 1)` then `mode(FullMode)` — **SymbolUpdate, depth NOT requested** | ltp, volume, oi, **scalar** bid/ask, exch_feed_time | `unified_option_quotes` FYERS_LIVE: bid/ask present, **bidQty/askQty NULL**, `depth` NULL |
| Upstox REST (paper/live desk) | `upstox-live-paper-market.service.ts` | `/v2/option/chain`, `/v2/option/contract`, `/v2/market-quote/quotes|ltp`, `/v2/market/status` — **periodic polling (~10–20 s)** | chain legs with `bid_price`/`ask_price`/`bid_qty`/`ask_qty`, ltp, volume, oi, iv | `unified_option_quotes` UPSTOX: **L1 sizes + IV + OI at 100 % coverage** |
| Upstox WS | constant `UPSTOX_LIVE_WS_BASE = 'wss://api.upstox.com/live/'` | declared, **not used by the desk** | — | — |
| Raw payload archive | — | — | — | **None** — only a `payloadHash` plus `{providerDepth, providerInstrumentId}` in the `depth` JSON; the raw body is not stored |

## 2. Why FYERS `bidQty`/`askQty` are NULL — three compounding causes (from the code)

1. **Depth is never requested.** `subscribe(symbols, false, 1)` passes `isDepth=false`; FYERS only publishes
   the 5-level book on the depth channel. The quote channel carries no size.
2. **The size field names do not match a depth payload.** The mapper reads
   `bid_size|bidQty|bid_qty` (`provider-mappers.ts:168`) and `ask_size|…`; a depth payload instead delivers
   `bid`/`ask` as **arrays of `[price, size, orders]`**, which the mapper never parses. (`fromDepth()` only
   understands `{buy:[…],sell:[…]}` objects — FYERS uses `bid`/`ask`.) An array reaching `num()` becomes
   `NaN` → `null`, so nothing is stored even if it is present.
3. **`zeroIsAbsent` turns a 0 size into NULL** (`provider-mappers.ts:85`). A quote-channel `bid_size` of 0 is
   indistinguishable from absent and is dropped by design.

**Conclusion:** sizes are absent because **depth was not subscribed and the array form is not mapped** — not
because the provider lacks sizes. Confirming the exact FYERS depth shape needs **one live capture**; no raw
payload exists offline, so the prototype in §7 covers both observed FYERS shapes (array-of-arrays and
array-of-objects) and refuses anything else rather than guessing.

## 3. Proposed canonical depth representation (design)

Add nothing to the canonical *schema* that invents levels; reuse the existing `depth: unknown` carrier with one
pinned, versioned shape:

```
depth = {
  depthVersion: 'depth-v1',
  providerInstrumentId,          // provider's own id — provenance
  providerPayloadHash,           // unchanged from the canonical tick
  levels: 5,                     // levels actually received (never padded)
  bids: [ { level, price, qty, orders } … ],   // best-first, ≤5
  asks: [ { level, price, qty, orders } … ],
  sourceTimestampSemantics: 'QUOTE',
}
```

Rules: a missing level stays absent (no zero-fill, no carried-forward level); `bids`/`asks` are sorted
best-first deterministically; a malformed level invalidates the whole depth block (reason recorded) rather than
producing a partial book; `providerPayloadHash` + provider instrument id always travel. `bid`/`ask`/`bidQty`/
`askQty` on the tick keep their meaning as the **best** level, derived from `bids[0]`/`asks[0]` only when the
provider sent it.

## 4. Trade-print capture — feasibility

| Provider | Usable trade/print stream today? | Evidence |
|---|---|---|
| FYERS | **No** — the subscribed socket is quote/depth (SymbolUpdate); there is no per-trade tape with an aggressor side | `fno-market-data.service.ts` subscriptions |
| Upstox | **No** — the desk uses v2 market-quote/option-chain/contract (quotes, not prints); historical/intraday endpoints yield candles (OHLCV), not price+side prints | `upstox-live-paper-market.service.ts` endpoints |

**Required fields for rows 56–59** (if a tape is ever sourced): instrument identity, price, **quantity**, an
**aggressor side** (buyer-initiated / seller-initiated) or an exchange trade id enabling deterministic side
inference, provider trade timestamp + semantics, sequence/exchange trade id, payload hash.

**Minimal canonical print shape (design only):** `{ instrumentKey, source, providerInstrumentId, price, qty,
aggressor: 'BUY'|'SELL'|null, tradeId, sourceTimestamp, sourceTimestampSemantics: 'LAST_TRADE', payloadHash }`.
A print with no aggressor and no trade id must stay **UNKNOWN** rather than being signed from the quote —
**never synthesise trades from quote snapshots.**

## 5. Event / queue-change capture — what is genuinely available

- **FYERS depth channel (`isDepth=true`) is a true EVENT stream** of book updates (5 levels with sizes). This
  is the only genuinely event-based, size-carrying source. **Nothing is captured today** because the
  subscription is quote-only.
- **Upstox REST is periodic SNAPSHOTS (10–20 s).** Differencing them is a snapshot delta, **not** event-based
  order flow; it must not be labelled OFI-grade evidence.
- **Cancellation vs fill is not separable from L1 snapshots or even from depth events alone** — a size
  decrease can be either. Cancellation-rate (row 55) needs a **trade tape to cross-reference** (or
  order-level events), so it stays blocked even after depth capture; quote-event intensity becomes derivable
  once depth events exist.

**Evidence required before row 51 (OFI) can be implemented:** a persisted, timestamped sequence of depth
events per instrument with (a) best bid/ask price **and** size on both sides, (b) a provider/sequence ordering,
(c) proof that consecutive records are distinct events (not repeated polls). Row 55 additionally needs the
trade tape for the cancellation leg.

## 6. Classification of each capture change

| Capture change | Class | Precise missing input | Provider / source responsible |
|---|---|---|---|
| Subscribe FYERS depth channel + map array depth → best bid/ask + sizes | **LIVE-DATA-BLOCKED** (code prepared offline, §7) | The live depth payload + a session to prove it | FYERS (`fyers-api-v3` socket, `isDepth=true`) |
| Persist all 5 levels + provenance/hash as `depth-v1` | **LIVE-DATA-BLOCKED** (schema/code designed) | Same as above; storage decision | FYERS (and Upstox if depth endpoint added) |
| Map FYERS array depth in the canonical mapper | **OFFLINE-ACTIONABLE** (prototype + tests now) | — | — |
| Upstox depth via `/v2/market-quote/quotes` (depth field) or a v3 depth endpoint | **LIVE-DATA-BLOCKED** | Confirm the endpoint returns depth for the contracts; one call | Upstox API |
| Trade-print capture | **DATA-BLOCKED** | No print/aggressor stream exists in the current subscriptions or APIs | FYERS + Upstox (provider capability) |
| Event/queue-change capture for OFI | **LIVE-DATA-BLOCKED** | FYERS depth channel must be captured first | FYERS |
| Cancellation-rate capture | **DATA-BLOCKED** | Trade tape to cross-reference; depth events alone cannot separate cancel from fill | FYERS/Upstox (prints) |
| Replenishment-after-consumption | **DATA-BLOCKED** | Prints (consumption) + depth (replenishment) | FYERS/Upstox |
| Whether to add a depth column / raw-payload archival | **OPERATOR-BLOCKED** | Storage + retention decision (payload archival was previously deferred) | Operator |

## 7. Offline-testable artefact produced now

`src/trading/microstructure/capture/fyers-depth-mapping.ts` — a pure, versioned (`fyersdepth-v1`) mapping from
the two FYERS depth shapes (`bid`/`ask` as `[[price, size, orders]…]` or `[{price, qty, orders}…]`) to a
canonical best-level + `depth-v1` block. It **never pads, never invents a level, and refuses an unknown shape
with a reason**; tests use fixture payloads (`scripts/fyers-depth-mapping.test.js`). It is **not imported by
production** (asserted by test), so it changes no feed behaviour; wiring it is a Monday one-liner once a real
payload confirms the shape.

## 8. Monday capture plan

**Goal:** capture the FYERS depth channel (and optionally Upstox depth) for the subscribed universe, persist
it, and produce the evidence rows 50–52/55–59 need.

1. **Pre-flight (before 09:15, machine up):** refresh the FYERS token (expires 06:00 IST) and the Upstox token
   (03:30 IST); confirm the tunnel (`127.0.0.1:3307`); confirm `FNO_MARKET_DATA_SYMBOLS`.
2. **Subscribe depth:** in `fno-market-data.service.ts` `onConnect()`, call
   `socket.subscribe(symbols, /*isDepth*/ true, 1)` (or add a second depth subscription) — **behind an env
   flag** (e.g. `FNO_DEPTH_CAPTURE=true`) so it can be enabled for the session and reverted without a code
   change. Confirm the socket's depth mode is the one that emits `bid`/`ask` arrays.
3. **Map + persist:** route depth payloads through the prototype mapper (`fyersdepth-v1`), then persist via the
   existing canonical writer into `unified_option_quotes.depth` (JSON `depth-v1`) — **no schema change**
   required to start; a dedicated column/retention policy is an operator decision (which payloads to keep, for
   how long). Best bid/ask **and** sizes land in the existing `bid`/`ask`/`bidQty`/`askQty`.
4. **Validation rules (before anything is trusted):**
   - a malformed/unknown depth shape → refuse with a reason, never a partial book;
   - `bids[0].price <= asks[0].price` (no crossed book) else reject;
   - sizes finite and `>= 0`; a 0 size is a real value here (do **not** re-apply `zeroIsAbsent` to levels);
   - timestamps keep `QUOTE` semantics; `payloadHash` and provider instrument id preserved;
   - consecutive depth records must be distinct events (prove it is not a repeated poll) before OFI.
5. **Measure the capture:** per instrument — depth records/min, distinct-event ratio, malformed count, level
   count received, size coverage. This is the evidence rows 51/55 need.
6. **Rows each captured field unblocks:**
   - depth levels + sizes → **50** (OBI), **52** (MLOFI), and the depth half of **56**/**59**;
   - depth **events** with sizes → **51** (OFI) and quote-event intensity (**55**) once the event-vs-poll
     proof exists;
   - trade prints (not available today) → **56/57/58** and the cancellation leg of **55**; an **operator/
     provider decision** is required to source them.
7. **Do not** mark any GATE 5 row done off a capture alone: rows 51/55 also require the event-vs-poll proof,
   and 56–59 remain blocked until a tape exists.

## 9. Non-actions

No production adapter wiring, no subscription change committed to run by default, no schema/retention change,
no Redis, no risk/execution/capital/REAL-trading change, no GATE 5 row marked done, and no synthetic trades or
levels. The prototype is research-only and unwired.

## 10. Addendum — GATE 7 term-structure capture note (found while scoping rows 67/69)

GATE 7's surface/skew rows were built offline (rows 66/67/69), but the **term dimension is empty in-session**:
the Upstox chain poll requests only the NEAREST expiry, so on a sampled session each underlying yields exactly
one expiry (`termAvailable=false`; a second expiry appears only in after-hours/stale rows and is not usable as
session evidence). Row 67's strike dimension is real (24–27 strikes), and row 69's skew is real, but the term
slope/curvature correctly refuses `INSUFFICIENT_EXPIRIES`.

**Small Monday change that would unblock the term dimension:** request the chain for the **next expiry as well**
(the desk's existing `/v2/option/contract` call already returns the contract master, which lists the available
expiries — use the nearest TWO), and persist them with the expiry field as today. That needs no schema change and
no new endpoint; it is one additional key per poll. Until then, rows 67's term dimension and 69's term
slope/curvature remain data-limited and are reported honestly rather than interpolated.

