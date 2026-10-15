# Option-chain subscription — specification

**Status:** specification only. No subscription code was modified.
**Item:** 38 (option-chain feed). **Author:** prepared under operator directive, 2026-10-15.
**Retrieval date for all cited repository evidence:** 2026-10-15.
**Live broker-documentation citations:** retrieved 2026-10-15 for the subscription caps and key
formats (see §10). Remaining `[NEEDS LIVE DOC]` markers are listed explicitly and have NOT been
replaced with guesses. Nothing in this document invents a subscription cap or assumes a key format
the broker has not been checked to support.

---

## 1. Verified facts (evidence in this repository / database)

| # | Fact | Evidence |
|---|---|---|
| V1 | The live index feed is delivered by **Upstox WebSocket**. | `fnf_market_snapshots.source = 'UPSTOX_WS'` for all 57,608 of 2026-10-15's ticks. |
| V2 | **Zero non-index option ticks** reached the live feed on 2026-10-15. | `option-shaped = 0` over 54,344 rows; both option tables 0 rows after 09:15 IST. |
| V3 | The option-feed tables exist with full contract columns. | `upstox_live_paper_option_quotes` carries `contractSymbol`, `expiry`, `strike`, `optionType`, `ltp`, `bid`, `ask`, OI, Greeks, `dataSource`, `executionMode`, `providerTs`, `payloadHash`. |
| V4 | The option universe is **mirrored from Oracle**, not discovered locally. | `database-sync/database-sync.service.ts:14`: `fnf_option_contracts: 'ORACLE_AUTHORITATIVE'`. |
| V5 | **No C++ code writes the contract master.** | `grep -rn cpp_option_contract_master src/` → no matches. Contract registration is not engine work. |
| V6 | Of 1,482 registered contracts, **22 expire today or later, all SENSEX**. | `fnf_option_contracts`: NIFTY50-INDEX 859 / 0 unexpired; NIFTYBANK-INDEX 511 / 0; SENSEX 112 / 22. |
| V7 | NIFTY/BANKNIFTY registration **stops at 2026-10-08**. | expiry range per underlying: NIFTY 2026-09-26→2026-10-08; BANKNIFTY same; SENSEX 2026-09-26→2027-09-26. |
| V8 | The subscription list is a **hand-maintained env var**. | `fno-market-data.service.ts:137` reads `FNO_MARKET_DATA_SYMBOLS`; its built-in default is **indices only** (`NSE:NIFTY50-INDEX,NSE:NIFTYBANK-INDEX,NSE:SENSEX-INDEX`). Lines 341/400 auto-register option symbols from that same variable. |
| V9 | **Every option symbol in both env files is past expiry.** | TS `.env` symbols are `BSE:SENSEX26SEP74000CE`-style — **September 2026**, expired. C++ `.env` symbols are `NSE:NIFTY26O0622450CE`-style — **26-O-06 = 6 October 2026**, expired. |
| V10 | **`ts` conventions are NOT uniform across tables.** | `fnf_market_snapshots.ts` is **UTC** (max 2026-10-15 08:41:47 vs 14:11 IST wall clock). `fnf_option_quotes_history.ts` is **IST** (all rows fall in hours 10–15, with max 15:30:14 = the IST session close; UTC would make that 21:00 IST). Both are `datetime`, so no server conversion applies. |
| V11 | `upstox_live_paper_*` hourly shape does **not** match the IST session under either convention. | 2026-10-06 option rows occupy h00 and h12–h19 with a gap at h04–h09; hourly counts repeat exactly (h00 45,360 / h01 45,360 on 10-01). Identical counts in different hours are a generator signature, not a tick stream. |
| V12 | The whole Upstox line stopped within 52 s on 2026-10-06. | `upstox_live_paper_market_snapshots` max 19:29:02; `upstox_live_paper_option_quotes` max 19:29:54. |
| V13 | The TS `.env` was modified **13 minutes after** that stop. | mtime `2026-10-06 19:42:27` vs last row `19:29:54`. Correlation only — see A4. |

## 2. Assumptions (explicitly not verified — do not build on these)

| # | Assumption | How to verify |
|---|---|---|
| A1 | Upstox WS can carry option-contract ticks and the client decodes them. | **Partly resolved.** The API side is confirmed: Upstox offers a dedicated `option_chain` subscription mode (LTPC + BID/ASK D0 + option greeks) and its V3 docs show option greeks as a first-class subscription category (§10, D1/D2). What is still **unproven is the CLIENT**: no in-session option row has ever been recorded, and whether the C++/TS decoder handles the option payloads (v3 = Protobuf, `MarketDataFeed.proto`) has not been demonstrated. Remaining: a controlled one-contract subscribe-and-observe test, or a decoder review. |
| A2 | Per-provider subscription caps and the exact instrument-key format. | **RESOLVED for the documented providers/dates — see §10.** Caps are version-dependent: Upstox V3 differs from the legacy 100-key figure, and FYERS v3 (5,000) differs from the legacy 200-symbol figure. The client's API version must be read from the code before any cap is used in sizing. |
| A3 | Bandwidth / CPU / memory / DB-write cost per subscribed contract. | Derivable only after A1 (a measured single-contract baseline, then linear extrapolation). Estimates in this document would be invented. |
| A4 | The 19:42 `.env` edit caused the stop. | Correlation only. Requires the PM2 restart history and log lines around 2026-10-06 19:29 UTC. **Do not assert.** |
| A5 | `upstox_live_paper_*` is sandbox/replay data rather than a live feed. | Strongly indicated by V11 (repeating counts, no session coverage) and by the `dataSource` / `executionMode` columns. Confirm by reading `dataSource` for that table. |

## 3. Prerequisite work — contract discovery and refresh

**Why it is prerequisite, not optional:** V6/V7/V9 mean there is currently no subscribable NIFTY or
BANKNIFTY contract at all, and the env lists name only expired symbols. No subscription design can
be implemented before a trustworthy, current contract universe exists.

Requirements:

1. **Source of truth.** Contracts come from the Oracle-authoritative store via the existing
   `database-sync` path (V4). The refresh must write through that path, not create a second source.
2. **Idempotent.** Re-running must not duplicate rows. Uniqueness is already declared
   (`uq_fnf_option_contracts_symbol`), so the writer must upsert on `symbol`.
3. **Validated.** Reject a refresh that would *reduce* the set of unexpired contracts for an index,
   or that yields zero unexpired contracts for an index that had some. A refresh must not be able to
   empty the universe silently — that is the failure mode already observed (V7).
4. **Runs outside sessions**, per Rule 27: after post-market analysis, not during the trading window.
5. **Observable.** Record, per run: source, retrieval timestamp, contracts added/updated/expired-out,
   and the resulting unexpired count per index. A refresh with a zero count for an index is an alert,
   not a success.
6. **Cited source.** `[NEEDS LIVE DOC]` — the broker/venue contract-master endpoint and its URL.

## 4. Expiry resolution

- **Primary: instrument-master lookup.** The contract master already carries `expiry` as a real
  `date` column. A symbol's expiry is read from the master, not inferred.
- **Fallback: symbol parsing** (only when the master has no row). The two observed formats:
  - `NSE:NIFTY26O0622450CE` — `26` `O` `06` = year, **month code**, day.
  - `BSE:SENSEX26SEP74000CE` — `26` `SEP` = year, **month name**.
  Note the formats differ *within the same environment set*, and the month is a code in one and a
  name in the other. A parser must handle both and must return **UNKNOWN** when neither matches.
- **UNKNOWN stays fail-closed.** An unverifiable expiry must not be treated as unexpired. No parsing
  may be loosened to increase acceptance rates.

## 5. Starting scope (what is actually available today)

**22 SENSEX contracts** are the only unexpired registered contracts (V6). The starting scope is
therefore **SENSEX only**:

- Index: SENSEX (BSE).
- Expiry: nearest valid expiry **from the contract master** — not from the env list, whose symbols
  are expired (V9).
- Strikes: ATM ± N, both CE and PE, where N is set from the actual subscription budget once A2 is
  known. Do not fix N before the cap is verified.
- Contract count: 2 × (2N+1).

**NIFTY 50 and BANKNIFTY are not deliverable today.** Their registrations stop at 2026-10-08 (V7),
so "nearest valid expiry" does not exist for them. They become scoped only after §3 delivers a
current universe. Reporting a NIFTY/BANKNIFTY subscription as designed without §3 would be a fiction.

## 6. Transport and provider responsibilities

- **Proven transport: Upstox WebSocket** (V1). The specification targets Upstox WS for option
  contracts, matching the transport already carrying today's index ticks.
- **Upstox:** option-contract subscription and decoding. `[NEEDS LIVE DOC]` for key format, rate
  limits and caps (A1, A2).
- **FYERS:** unchanged responsibility for its own feed. It is **not** the proven option transport in
  this system today and must not be assumed to be.
- **Single owner recommendation:** market-data subscription should have **one** owner — the process
  that already holds the Upstox WS session — because two processes subscribing to overlapping
  contract sets multiplies cap consumption and makes stale-data detection ambiguous. Ownership
  should be explicit and recorded, not implicit in which service happens to run.

## 7. Failure behaviour (to be implemented, not yet)

- **Reconnect:** bounded exponential backoff, observable (attempt count, last failure reason), and
  never treated as success merely because a retry returned.
- **Resubscription:** after reconnect, the full contract set is re-subscribed and the gap is recorded;
  a partial resubscription must not present itself as complete.
- **Token expiry:** fail-closed. No stale token may authorize trading; a feed that cannot prove
  freshness must report UNKNOWN and block entries.
- **Stale data:** must be representable as missing. The week-long masked outage (item 38) is the
  worked example of why: a fallback that fills a gap with an older value converts an outage into
  silence.

## 8. Open items requiring operator decision

1. Confirm §3 (contract discovery/refresh) is authorized as prerequisite work, and by whom.
2. Provide or authorize retrieval of the broker documentation for A1/A2 (URLs + retrieval date).
3. Confirm the starting scope is SENSEX-only until §3 delivers NIFTY/BANKNIFTY.
4. Decide the subscription owner (§6).

## 9. Related open item

**netPnl provenance (item 39 / ceiling audit):** outstanding, with one added question from the
operator — **how were the `ARCHIVED` trades priced, from real or from synthetic quotes?** Given V11
(the `upstox_live_paper_*` tables carry a generator signature) this is a live question, not a
formality. Not resolved in this document.

---

## 10. Broker documentation retrieved (2026-10-15)

Retrieval date for every row below: **2026-10-15**. Where a page is the broker's own, it is marked
**official**; mirrors are marked as such. A cap is only quoted with the API version it belongs to,
because the two versions disagree — and the client's version is a code question, not a docs question.

### 10.1 Upstox

| # | Fact | Source |
|---|---|---|
| D1 | **Market Data Feed V3 limits** (official): **2 connections per user** (Upstox Plus: 5). Subscriptions — LTPC **5000** individual / **2000** combined; Option Greeks **3000** / **2000**; Full **2000** / **1500**. Individual = when that is the only category subscribed; Combined = when several categories are subscribed at once. | upstox.com/developer/api-documentation/v3/get-market-data-feed |
| D2 | **Subscription modes** (official): `ltpc`, `option_greeks`, `full`, `full_d30`; the request envelope is JSON — `{"guid":…, "method":"sub\|change_mode\|unsub", "data":{"mode":"…","instrumentKeys":[…]}}` — while **responses are Protobuf** and must be decoded with `MarketDataFeed.proto`. | upstox.com/developer/api-documentation/v3/get-market-data-feed |
| D3 | **Instrument-key format** (official): `EXCHANGE|SYMBOL` with a **pipe** — the docs' own examples are `NSE_INDEX\|Nifty Bank`, `NSE_INDEX\|Nifty 50`. Index keys and F&O contract keys share the same shape, so the *key* does not tell you whether it is an index or an option. | upstox.com/developer/api-documentation/v3/get-market-data-feed |
| D4 | Legacy/v2 documentation states **100 instrument keys per socket**, and a `option_chain` mode (LTPC + BID/ASK D0 + greeks). This is the **older** figure; do not use it for a V3 client. | upstox.com/developer/api-documentation/get-market-data-feed (v2 page) |
| D5 | Community-reported caveat: 80 option keys subscribed, "response for very few — sometimes 10, sometimes 5, sometimes 60". Option subscriptions can stream **partially**. | community.upstox.com/t/…/5923 (community, not official) |

### 10.2 FYERS

| # | Fact | Source |
|---|---|---|
| D6 | **Data WebSocket API v3: 5,000 unique symbols per connection** (official support article), counted per API key, across equities/indices/derivatives. Over the cap the socket **rejects** the excess; **FYERS does not return the active symbol list**, so the client must track its own subscriptions. | support.fyers.in/portal/en/kb/articles/is-there-a-limit-to-the-number-of-symbols-i-can-track-using-the-data-websocket-in-api-v3 |
| D7 | The earlier article states **200 symbols**, applies to `lite` and `symbolUpdate`, and says excess is "ignored or rejected". This is the **v2-era** figure. | support.fyers.in/portal/en/kb/articles/what-is-the-maximum-number-of-symbols-i-can-subscribe-to-in-the-data-websocket-20-11-2023 |
| D8 | **Symbol format**: `EXCHANGE:SYMBOL` with a **colon** — `NSE:SBIN-EQ`, `NSE:NIFTY50-INDEX`. Note this is a *different separator* from Upstox's pipe; a single parser must not be reused blindly across providers. | github.com/FyersDev/fyers-skills → skills/fyers-trading/references/websocket.md |
| D9 | Chat modes: `SymbolUpdate` (LTP/quote) and `DepthUpdate` (5-level); `litemode` for LTP-only (lower bandwidth). Message types `cn`/`sub`/`if`/`dp`/`sf`. | same as D8 |
| D10 | **Separate TBT socket**: 3 connections per user, **5 symbols per connection** — do not confuse it with the data socket cap. | github.com/FyersDev/fyers-skills → references/rate-limits.md |
| D11 | REST rate limits: 10/s, 200/min, 100,000/day; **breaching the per-minute cap more than 3 times in a day blocks the user for the rest of the day**; 429 carries `Retry-After` / `X-Retry-After-Ms`. | same as D10 |
| D12 | (Third-party blog, **not** official) REST quotes ≤50 symbols/call; an option-chain REST endpoint returning per-strike OI. Treat as indicative until confirmed officially. | oidata.in/blog/fyers-api-market-data |

### 10.3 What these facts change in this document

1. **The cap cannot be stated once for all.** Upstox V3 (D1) vs the legacy 100-key claim (D4), and
   FYERS v3 (D6) vs 200 (D7), differ by 25×. §5's "do not fix N before the cap is verified" now has a
   concrete next step: read the client's API version in the repository, then use that row.
2. **Key formats differ per provider** (D3 pipe vs D8 colon). Contract registration and subscription
   must build keys per provider; a shared key builder is a defect waiting to happen.
3. **Partial option streaming is an observed platform behaviour** (D5), so "subscribed" must never be
   rendered as "receiving". Any freshness check must be per-contract, not per-subscription.
4. **Still open:** whether *this repository's* Upstox client can subscribe to and **decode** option
   contracts (A1). D2 says responses are Protobuf; the decoder's coverage of the option payload fields
   in §1 V3 (`Greek` columns, `bid`/`ask`, OI) is a code-review question.
5. **Still open:** the client's API/SDK version on both providers — the single input that selects which
   cap row applies.

## 11. Rule 27 compliance note for this specification

This document is docs-only. It was produced by reading the repository, reading broker documentation and
issuing a small number of **read-only point SELECTs** over the existing tunnel; no test suite, no
concurrency stress, no deploy, no service restart and no write of any kind was performed. Per Rule 27
(`docs/ORCHESTRATION.md`), docs-only work is exempt from the trading-window timing rule, and the one
class of work that is explicitly *not* free — repeated contention testing against the shared local
instance — was not attempted.
