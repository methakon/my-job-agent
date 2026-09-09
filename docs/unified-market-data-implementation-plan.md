# UNIFY LIVE MARKET DATA + FNF/UPSTOX PAPER IN PARALLEL — Implementation Plan

Status: DRAFT for execution · Audit: docs/market-data-unification-audit.md (committed ddee199)
Brief: user HERMES TASK (21 sections) · Estimated completion today: ~25% (audit + boot + isolation-by-construction)
Target: implement brief sections 1-21 with minimum disruption; FnF account NEVER reset.

> For Hermes: execute phase-by-phase with the test-driven-development skill; each phase ends
> with `npm run build` + its test script green + a commit. Do NOT start coding without
> re-reading the audit doc and the files named in each phase.

## Baseline facts (verified 2026-09-10)

- Deploy topology: live web app = THIS host (pm2 my-job-agent, port 3010, public via
  cloudflared tunnel); Oracle MySQL via ssh tunnel 127.0.0.1:3307. Dhargent VM
  (168.110.60.10) runs ONLY the headless trading-agent worker (module graph = FnF/FYERS
  stack; does NOT import UpstoxLivePaperModule) — unaffected by this epic.
- SOURCE A = FYERS v3 WebSocket (`src/trading/fno-market-data.service.ts`): REAL WS,
  heartbeat, autoreconnect(6), DB-token watcher; writes fnf_option_quotes (options) +
  fnf_market_snapshots (indices). Env: FNO_MARKET_DATA_ENABLED/PROVIDER/SYMBOLS.
- SOURCE B = Upstox REST (`src/trading/upstox-live-paper/upstox-live-paper-market.service.ts`):
  v2 quote/option-chain/market-status polling (UPSTOX_LIVE_POLL_MS default 30s, min 10s);
  `connectWebSocket()` is a STUB (line 197: "using REST polling fallback"); writes its own
  upstox_live_paper_option_quotes / _market_snapshots. Env: UPSTOX_LIVE_* .
- Yahoo = only in fno-market-data.service.ts: auto-fallback when FYERS down + explicit
  FNO_MARKET_DATA_PROVIDER=yahoo mode. NOT allowed to remain on the trading path.
- No real order path exists. ExecutionProvider interface: only UpstoxSandboxProvider
  (DB-only). FnF openTrade = internal paper fill (executionMode label REAL).
- Engines read ONLY their own tables → brief s12 (same ticks both engines) is FALSE today.
- Toggles: .env feature flags; UPSTOX_SANDBOX_ENABLED=true master lock (never change).

## PRIMARY/SECONDARY decision (brief s2/s6)

PRIMARY = FYERS v3 WebSocket. Why: only real WS implementation, full tick fields
(ltp/bid/ask/oi/iv/greeks), autoreconnect + token-change rebuild, proven in production
(Dhargent worker). SECONDARY = Upstox REST polling. Why: working live source (the other
audited mechanism), no WS yet, lower tick frequency — acceptable fallback. Yahoo: DISABLED
forever (s3). Upstox WS: future enhancement, NOT a blocker (brief accepts the two working
sources; REST is the working Upstox mechanism).

---

## PHASE 1 — Yahoo hard-disable (brief s3) [~1h]

**Objective:** live trading/data path can never invoke Yahoo; startup log says
"Yahoo market-data feed: DISABLED"; code retained only for historical/non-trading use.

**Files:**
- Modify: `src/trading/fno-market-data.service.ts` (constructor provider selection +
  onModuleInit + startYahooFallback/startYahooPoller entry points)
- Create: `scripts/yahoo-disable.test.js` (asserts behavior below against dist)

**Steps:**
1. Add `const yahooEnabled = /^(1|true|yes)$/i.test(process.env.YAHOO_FEED_ENABLED ?? 'false');`
   Read in constructor next to `provider`.
2. Provider selection: `provider === 'yahoo' && !yahooEnabled` → treat as
   `provider = 'fyers'`? NO — brief: Yahoo never on path. If provider env says yahoo OR
   yahooEnabled false → force provider 'fyers' when creds exist; if FYERS creds missing →
   feed stays DISABLED (do NOT startYahooFallback). Remove every call site of
   startYahooFallback/startYahooPoller from onError/onClose/tryFyersReconnect paths.
   Keep the private methods (unused → compiler error risk with noUnusedLocals? check
   tsconfig; if strict, keep a `void` reference or guard with `yahooEnabled` branch that
   can never run when disabled, or delete methods and keep parser files only).
3. Startup log: in onModuleInit when `!yahooEnabled` →
   `this.logger.log('Yahoo market-data feed: DISABLED')`.
4. Test `scripts/yahoo-disable.test.js`: build dist, require service? — services are hard
   to unit-test; instead test via source-level assertions on dist JS (regex: no
   `query1.finance.yahoo.com` reachable when YAHOO_FEED_ENABLED unset/false; module-level
   guard exists). Follow existing scripts/*.test.js style (they assert on dist or pure fns).
5. Verify: `npm run build && node scripts/yahoo-disable.test.js` PASS.
6. Manual: start app with YAHOO_FEED_ENABLED unset → log line present, status endpoint
   provider never 'yahoo'.
7. Commit: `feat(trading): hard-disable Yahoo on the live market-data path (brief s3)`.

## PHASE 2 — Normalized tick model + common storage (brief s4/s5/s7) [~3-4h]

**Objective:** broker-independent normalized observation stored ONCE, fields per brief s5,
source preserved (UPSTOX_LIVE / FYERS_LIVE), configurable strikes around ATM, expiries
never hard-coded.

**Files:**
- Create: `src/trading/unified-market-data/unified-option-quote.entity.ts`,
  `unified-market-snapshot.entity.ts`, `unified-market-data.module.ts`,
  `unified-market-data.service.ts` (pure normalize + persist + broadcast; NO broker code)
- Modify: `src/app.module.ts` (TypeOrm entities list + imports),
  `src/trading/fno-market-data.service.ts` (publish normalized tick to unified service)

**Steps:**
1. Entities (typeorm, synchronize:true creates tables; explicit `type: 'varchar'` on every
   `string | null` column — TS emits Object otherwise; `type:'decimal'` w/ precision+scale;
   index on (contractSymbol, ts), (underlying, expiry, strike)).
   Fields (s5): instrument_key, underlying, exchange, segment, instrument_type, expiry,
   strike, option_type, ltp, bid, ask, bid_qty, ask_qty, volume, oi, previous_oi,
   change_oi, iv, delta, gamma, theta, vega, depth, source, source_timestamp,
   received_timestamp, sequence_number, data_quality, timestamp.
2. `UnifiedMarketDataService.ingestOptionTick(tick)` — normalizes + stamps
   received_timestamp + data_quality (GOOD/STALE/INVALID via market-feed-guard +
   staleness) + sequence_number (incrementing per source) + persists + keeps
   in-memory latest-by-contract map (single source of truth for engines in Phase 4).
3. FnoMarketDataService.recordTicks option branch: after ingestQuote, ALSO
   `void this.unified.ingestOptionTick(...)` with source='FYERS_LIVE'. (Transitional
   dual-write — allowed ONLY while Phase 4 read-migration is pending; flag
   `UNIFIED_DUAL_WRITE=true` default on, remove in Phase 4 step 5.)
4. Build + existing tests green (`npm run test:trading`). Commit:
   `feat(trading): normalized unified option-quote store (s4/s5/s7)`.

## PHASE 3 — Feed health state machine + PAUSE NEW TRADING (brief s6/s8) [~3-4h]

**Objective:** automatic source health mgmt; PRIMARY FYERS / SECONDARY Upstox-REST /
states PRIMARY|SECONDARY|ACTIVE|FAILED|RECOVERING; heartbeat + stale-tick threshold +
reconnect backoff + recovery grace; when BOTH unhealthy → new trades hard-rejected.

**Files:**
- Create: `src/trading/unified-market-data/feed-health-state.ts` (pure state machine,
  unit-testable), `feed-health.ts` types
- Modify: `unified-market-data.service.ts` (owns the machine + timers),
  `upstox-live-paper-market.service.ts` (expose fetchOptionChain as a SECONDARY provider
  hook into unified: on FYERS FAILED → unified drives upstox REST fetches → same
  ingestOptionTick with source='UPSTOX_LIVE'),
  `src/trading/fnf-trading.service.ts` openTrade (health gate),
  `src/trading/upstox-live-paper/upstox-live-paper.service.ts` openPosition (health gate)

**Steps:**
1. Pure machine: transitions PRIMARY↔SECONDARY on heartbeat miss / stale-threshold
   breach; FAILED after N misses; RECOVERING grace (e.g. 60s) before restore; hysteresis
   (no rapid flap: require grace + 2 consecutive good ticks). Unit tests
   `scripts/feed-health.test.js`.
2. Unified service timers: FYERS heartbeat = last tick ts; if > staleMs (config
   MARKET_DATA_STALE_MS default 5s for WS, REST 60s) → mark source stale → switch.
   Backoff: 15s→60s doubling cap 300s.
3. Engine gates: fnf openTrade + upstox openPosition call
   `unified.feedHealthy()` → if neither source healthy → reject with
   'market data unhealthy — new trading paused' (brief s8.4). Existing stale-quote
   per-desk checks remain as second layer.
4. Status endpoint: `GET /unified-market-data/status` (state, active source, last tick
   age, health) — used by Phase 6 UI.
5. Tests (s19 #2,#3,#4,#5,#6) in scripts (state machine pure tests; engine gate via
   stubbed health). Build + test green. Commit:
   `feat(trading): unified feed health machine with pause-new-trading (s6/s8)`.

## PHASE 4 — Same ticks for both engines; remove duplication (brief s1/s12/s15) [~4-5h]

**Objective:** both engines consume the SAME normalized ticks; per-engine market tables
retired; FnF account semantics untouched (s9).

**Files:**
- Modify: `src/trading/fnf-option-chain.service.ts` (findChain/latest reads →
  unified latest map/table; KEEP contract metadata reads on fnf_option_contract),
  `src/trading/fno-market-data.service.ts` (drop fnf_option_quotes writes; keep
  ingestSnapshots for indices ONLY if fnf pages need history — else unified),
  `src/trading/upstox-live-paper/upstox-live-paper-market.service.ts` (remove own
  persistence + polling timer when acting as secondary-through-unified; keep token/creds),
  engines' quote reads (fnf engine decision path + upstox decision path),
  `src/app.module.ts` entity list if tables retired (mark deprecated, do NOT drop tables
  with data — FnF history must survive)

**Steps (read-migration last, keep every page working after each step):**
1. FnfOptionChainService gains read methods backed by unified latest-by-contract cache
   (same shape as FnfOptionQuote rows: contractSymbol/underlying/expiry/strike/optionType/
   ltp/bid/ask/oi/iv/ts + source) — pages keep working.
2. fnf-trading.service.ts decision reads switch to unified cache (contract metadata
   unchanged). Run `node scripts/gate0-regression.test.js` + pages manually.
3. Upstox engine decision reads switch to unified cache (its portfolio/position/order/
   pnl tables untouched — isolation intact).
4. fno feed: stop dual-write to fnf_option_quotes (fnf_* market tables become history
   archives only; UNIFIED_DUAL_WRITE removed).
5. upstox market service: secondary mode — polling runs ONLY when unified machine says
   FYERS FAILED; persistence to upstox_live_paper_* quote tables stops (tables kept as
   archives).
6. Tests (s19 #8,#15): two engines consume same normalized tick (feed one tick through
   unified → both latest-quote caches equal); storage single-write assertion.
7. Commit: `feat(trading): both desks consume the unified normalized feed (s1/s12/s15)`.

## PHASE 5 — Isolation & paper-execution hardening (brief s9-s11/s13/s14/s20) [~3h]

**Objective:** prove + lock isolation; paper fills strictly bid/ask; real orders triple-
locked; restart does NOT reset ₹5,000 accounts.

**Files:**
- Read-first: upstox-live-paper.service.ts fill path (requested→fill, spread/slippage
  capture), fnf-trading.service.ts openTrade, all trading entities (account namespace
  columns)
- Modify: entities missing `broker`/`account_namespace` (add with defaults
  broker='FYERS'/account_namespace='FNF_TRADING' etc.), fill validation hardening,
  triple-lock assertions (UPSTOX_SANDBOX_ENABLED=true ⇒ hard fail; EXECUTION_MODE=PAPER
  ⇒ hard fail) if any path could reach real order API
- Tests (s19 #7,#9,#10,#11,#12,#13,#14): scripts/upstox-isolation.test.js already exists —
  EXTEND it (missing bid/ask → fill rejected; FnF account untouched by upstox trade; upstox
  ₹5,000 account independent; restart reconstructs from DB not reset; sandbox lock blocks).
- Build + full test set green. Commit:
  `test(trading): isolation + paper-fill + real-order-lock proofs (s9-s14)`.

## PHASE 6 — UI + reporting (brief s16/s17) [~3-4h]

**Objective:** dashboard shows feed panel (Active/Backup Source, Connection, Last Tick ms,
Feed Health GOOD/BAD, Yahoo DISABLED) + clearly labelled FNF ACCOUNT and UPSTOX PAPER
ACCOUNT blocks; per-namespace reports incl. comparison.

**Files:**
- Modify: `public/upstox-live-paper.html` (feed panel + account block),
  fnf trading page controller HTML (feed panel header), new
  `src/trading/unified-market-data/unified-market-data.controller.ts` (status + health
  JSON), weekly-report service (add comparison section vs FnF same-period where data
  exists), fnf trade report service (namespace label)

**Steps:**
1. Unified status endpoint → page panels fetch and render (label FNF ACCOUNT / UPSTOX
   PAPER ACCOUNT, never combined balance).
2. Reporting: verify both report services exist (fnf-trade-report, upstox weekly) and
   emit required metrics (s17 list); add comparison block when both exist for window.
3. Manual QA pages. Commit: `feat(ui): unified feed panel + labelled accounts (s16/s17)`.

## PHASE 7 — Restart recovery (brief s18) [~2h]

**Objective:** restart → reconnect live data, restore health machine, resync chain via
REST if needed, FnF/Upstox accounts reconstructed from DB (never reset to ₹5,000).

**Steps:**
1. Unified service onModuleInit: restore machine state; if FYERS token present connect;
   else secondary REST resync; else FAILED w/ pause (no fake data).
2. Verify upstox account reconstruction path (already DB-persisted entities; assert no
   `capital=5000` reset logic exists — grep for it; if found, remove).
3. Test s19 #11 (restart simulation: boot app twice against dev DB, upstox portfolio
   balance persists). Commit: `feat(trading): restart recovery + no-reset guarantee (s18)`.

## PHASE 8 — Full test suite + regression (brief s19) [~2h]

**Files:** package.json (`test:unify` script chaining all new scripts), run ALL:
`npm run test:trading && npm run test:upstox-live-paper && npm run test:unify` (+
test:trading-ai, gate0-regression). Fix regressions. Commit: `test: s19 acceptance suite`.

## PHASE 9 — Final deliverable (brief s21) + deploy [~1h]

1. Write the s21 report: the two sources found, PRIMARY/SECONDARY + why, exact Yahoo
   components disabled, exact pipeline/tables created, FnF-not-reset confirmation,
   upstox ₹5,000 fresh-start + restart persistence, same-ticks confirmation, isolation
   confirmation, real-order-blocked confirmation, test results, TODOs/risks.
2. Update PROJECT_PROMPT.md + TODO.md; commit; push dev.
3. Deploy: `npm run build` on live host → `pm2 restart my-job-agent --update-env` →
   verify root/upstox/status 200 + logs. Dhargent worker NOT affected (module graph
   excludes upstox) — verify remote still online after.

---

## Risks / tradeoffs / open questions

- FnF read-path migration (Phase 4) is the only FnF-touching work — mitigated by
  read-cache-first + regression scripts + keeping fnf_* tables as archives (never drop
  with data).
- FYERS WS may be down outside market hours — health machine must treat no-ticks as
  STALE only inside market hours (add market-hours clock to machine) or it will flap
  overnight; REST secondary covers.
- DB growth: unified tick tables need retention policy (history pruning) — decide in
  Phase 4 (s7 says store; retention TBD).
- Open Q: does the brief want upstox desk to receive FYERS-sourced ticks for instruments
  Upstox REST cannot see (SENSEX)? Unification universe = FNO_MARKET_DATA_SYMBOLS +
  configured contracts; SENSEX via FYERS only → secondary REST cannot cover SENSEX when
  FYERS fails → document in s21 report.
- Keep UPSTOX_SANDBOX_ENABLED=true untouched; real-mode triple-lock code exists only as
  future-proofing, never active.
