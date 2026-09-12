# GATE 5 (MICROSTRUCTURE P0) — offline scoping against the authoritative roadmap (2026-09-13)

**Scope:** classify every GATE 5 row by what can genuinely be implemented and proven **offline, before the
next market session**. Read-only investigation; no live-data claims, no synthetic evidence, no changes to
trading/risk/execution/capital. The goal of GATE 5 is *"Use order-flow information to distinguish acceptance
from temporary movement."*

**Verdict:** 2 of 10 rows are offline-actionable, 7 are data-blocked, 1 is dependency-blocked.
**Row 53 (microprice + queue imbalance) was implemented** (highest-priority offline-actionable, item_order 4).

---

## 1. What microstructure data actually exists (measured)

| Store | Columns | Reality |
|---|---|---|
| `unified_option_quotes` (canonical) | bid, ask, bidQty, askQty, volume, oi, `depth` json, sourceTs, provenance | **FYERS_LIVE (1,665,009 rows): bid/ask present, `bidQty`/`askQty` NULL, `depth` NULL.** UPSTOX (361,058) and UPSTOX_LIVE (40,341): **L1 sizes present** |
| `depth` json | `{payloadHash, providerDepth, providerInstrumentId}` | **`providerDepth: null`** — no order-book LEVELS are persisted, only provenance |
| `fnf_option_quotes_history` | bid, ask, volume, oi, IV, greeks | bid/ask only — **no sizes, no depth** |
| `upstox_live_paper_option_quotes` | bid, ask, bidQty, askQty, bidDepth, askDepth, volume, OI | L1 sizes present (real Upstox market data, paper execution) |
| trade tape | — | **None.** `fnf_trades`/`upstox_trades`/`upstox_live_paper_*_orders|trades` are position/order level, not prints; there is no price+side trade stream |
| quote cadence | — | Upstox = **REST snapshots (~10–20 s intraday)**, not an event stream; FYERS is a WS but persists no sizes |

**Measured coverage (canonical store, market hours 09:15–15:30):** source `UPSTOX` → **80,907 rows on
2026-09-11 and 37,686 on 2026-09-10, 100% carrying bidQty/askQty**. So a real, dense L1-size archive exists
for the quotations-based features; nothing exists for depth- or trade-based features.

## 2. Classification (authoritative gate order)

| Row | item_order | Capability | Class | Why (evidence) |
|---|---|---|---|---|
| 50 | 1 | OBI where depth exists | **DATA-BLOCKED** | No order-book levels persisted (`providerDepth: null`). A degenerate L1-only OBI would duplicate row 53's queue imbalance |
| 51 | 2 | OFI from event-based queue changes | **DATA-BLOCKED** | The FYERS WS persists NULL sizes; Upstox is a ~10–20 s REST *snapshot* series. There is no size-carrying event stream to difference |
| 52 | 3 | MLOFI (multi-level depth) | **DATA-BLOCKED** | No multi-level depth exists anywhere |
| **53** | **4** | **microprice + queue imbalance** | **OFFLINE-ACTIONABLE ✅ (implemented)** | Canonical L1 sizes exist (source UPSTOX, 118k market-hours rows). Per-snapshot state — needs no events |
| 54 | 5 | spread + spread shock | **OFFLINE-ACTIONABLE** (next) | bid/ask present broadly (FYERS + Upstox); doneWhen = reproduce from archived data + sample size |
| 55 | 6 | cancellation rate + quote-event intensity | **DATA-BLOCKED** | Cancellation needs order-level events; an L1 snapshot cannot separate a cancel from a fill. Quote-event intensity alone would be a redefinition |
| 56 | 7 | replenishment after consumption | **DATA-BLOCKED** | Needs trade prints (consumption) **and** depth (replenishment); neither exists |
| 57 | 8 | trade intensity / activity regime | **DATA-BLOCKED** | No trade tape; FYERS volume is absent/0, Upstox volume is cumulative, not per-interval |
| 58 | 9 | CVD slope / aggressive-trade imbalance | **DATA-BLOCKED** | Needs prints with aggressor side; none exists ("where supported" → would be permanently UNKNOWN) |
| 59 | 10 | absorption / stacked imbalance as hypotheses | **DEPENDENCY-BLOCKED** | Depends on rows 50–58 (all blocked/partial) plus depth/trades; nothing to form the hypotheses from |

## 3. What was implemented (row 53)

`src/trading/microstructure/micro-imbalance.ts` (`microimb-v1`) — pure, deterministic:
- `mid = (bid+ask)/2`; `spread = ask−bid` and relative; **`queueImbalance = (bidQty−askQty)/(bidQty+askQty)`**;
  **`microprice = (bid×askQty + ask×bidQty)/(bidQty+askQty)`** plus its offset from mid.
- **Window = ONE observation** — no lookback, no smoothing ⇒ **no look-ahead by construction** (asserted:
  a quote evaluates identically alone, in a batch, and when later quotes are appended).
- **Safe explicit refusals, never 0/NaN/Infinity:** `NO_QUOTES`, `INVALID_QUOTE` (0/negative price),
  `CROSSED_BOOK`, **`NO_SIZES` (the FYERS case)**, `NEGATIVE_SIZE`, `ZERO_SIZE`, `NOT_A_NUMBER`.
- **Provenance preserved:** source, source/received timestamps, sequence number, payload hash, data quality and
  the **EVENT/SNAPSHOT basis** are echoed unchanged (the Upstox fit is recorded as `SNAPSHOT`, not mislabelled
  as event-based).
- Multi-level depth and event-based OFI are explicitly documented as **not inputs**; the module writes no
  state and nothing in production imports it (asserted).

**Evidence:** `npm run test:micro-imbalance` **58/58**; archive replay over the canonical store (2026-09-11,
market hours) — **SAMPLE SIZE 20,000** L1 quotes valued, `NO_SIZES` 50 (the FYERS contrasts), queue-imbalance
distribution reported, digest `75a0bdb632d18983`. All GATE 4/6 suites + market-data/canonical suites remain
green.

## 4. Precise blockers for the rest of GATE 5

1. **Order-book depth is never persisted** — `depth` holds `{payloadHash, providerDepth: null, ...}`. Rows
   50/52 and half of 55/56/59 need the real levels. Unblocks: capture `providerDepth` (adapter mapping + a
   depth column/serialisation decision, then a live session to prove it).
2. **No trade tape** — no price+side prints exist, so rows 56/57/58 and 59 have no aggressor/consumption
   input. Unblocks: a trades/prints stream from the provider plus a durable store.
3. **No size-carrying event stream** — FYERS persists NULL sizes; Upstox is REST snapshots. Row 51 needs the
   event stream. Unblocks: fix the FYERS depth/size mapping and prove it live; row 51 stays blocked until then.
4. All four are **LIVE-DATA-BLOCKED to prove** even after the code exists — they cannot be closed offline.

## 5. Non-actions

No synthetic/replayed-as-if-live evidence was created. No Redis/roadmap row created. No change to the feed
protocols, adapters, risk, execution, capital or REAL-trading controls. Rows 876–878 untouched. GATE 5 rows
other than 53 remain `pending`.
