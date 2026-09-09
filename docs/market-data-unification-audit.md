# Market-Data & Trading Unification — Audit (brief section 2)

Date: 2026-09-10 · Branch dev @ ddee199 · Against: user brief "UNIFY LIVE MARKET
DATA + RUN FNF AND UPSTOX PAPER TRADING IN PARALLEL" (pasted 2026-09-10, sections
1-21). This doc is the section-2 audit deliverable: what exists, where, and the
gap list the unification must close.

## 0. Executive summary

- TWO independent paper-trading desks exist with TWO parallel market-data
  pipelines and TWO parallel tick-storage schemas: the FYERS/FnF desk
  (`fno-market-data.service.ts` + `fnf_*` tables) and the Upstox paper desk
  (`upstox-live-paper/*` + `upstox_live_paper_*` tables). Neither engine can
  consume the other's ticks today.
- NO real-broker order path exists anywhere. `ExecutionProvider` interface has a
  single implementation (`UpstoxSandboxProvider`, DB-only). FnF "REAL" is a
  label on an internal paper-fill engine. Upstox paper hardcodes
  `executionMode: 'PAPER'`. Safety sections 13-14 of the brief are satisfied by
  construction — the risk is scope creep in the opposite direction (accidental
  real wiring later), which the unified layer must keep impossible.
- The Upstox desk's "live WebSocket" is NOT implemented: `connectWebSocket()`
  is a stub that logs "WS path prepared; using REST polling fallback"
  (`upstox-live-paper-market.service.ts:197`). The desk currently runs REST
  option-chain/market-status polling only (status field `marketDataSource` can
  report DEGRADED; WS never connects).
- Yahoo Finance is referenced in exactly ONE file: `fno-market-data.service.ts`
  (FYERS desk), as (a) auto-fallback when the FYERS socket is down and (b) an
  explicit `FNO_MARKET_DATA_PROVIDER=yahoo` polling mode. The Upstox desk never
  touches Yahoo. Brief s3 (Yahoo never on the trading data path) therefore
  means: remove/disable the fallback + mode in the FYERS feed when unifying.
- FnF decision engine + Upstox engine each read ONLY their own quotes tables →
  brief s12 (same ticks for both engines) is currently false by construction.

## 1. Desk inventory

### 1a. FYERS/FnF desk (options, paper; "real" envelopes)
- Feed: `src/trading/fno-market-data.service.ts` — FYERS v3 WS adapter
  (primary), Yahoo chart polling (fallback + explicit mode). Toggles:
  `FNO_MARKET_DATA_ENABLED`, `FNO_MARKET_DATA_PROVIDER` (fyers|yahoo),
  `FNO_MARKET_DATA_SYMBOLS`, `FNO_MARKET_DATA_PERSIST_MS`, `YAHOO_FINANCE_*`,
  `FYERS_RETRY_MS`. Token read from `fyers_tokens` DB row (FYERS v3, callback
  intake + GET THE TOKEN UI).
- Feed starts: on module init in the headless `trading-agent` app
  (`src/trading-agent/main.ts`) and is injected by several page controllers
  (fnf-trading-page, option-trading-page, market-data, emergency-trading).
- Engine: `fnf-trading.service.ts` `openTrade()` — registered-contract-only,
  index-level rejection, Friday gate, capital/ceiling checks, internal paper
  fill; `executionMode` defaults 'REAL' (envelope label semantics).
  `execution-provider.interface.ts` exists (mode type only has 'REAL' |
  'SANDBOX' — no 'PAPER').
- Decision pipeline: `trading-ai-orchestrator.service.ts` (semaphore-guarded),
  decay engine, `fnf_decision_journal`, `fnf_trade_reflections`.
- Data-quality gates: stale-quote rejections inside services; `semaphore.ts`,
  `market-data-filter.ts`, `market-feed-guard.ts` present but only referenced by
  `trading-ai-orchestrator` / `market-data-inspection` — NOT by the feed paths.

### 1b. Upstox paper desk (options, paper; isolated ₹5,000 accounts)
- Feed: `src/trading/upstox-live-paper/upstox-live-paper-market.service.ts` —
  Upstox REST `/v2/option/chain`, `/v2/quote`, `/v2/market/status` + WS base
  consts. WS = STUB (see §0). REST polling interval timer drives chain+status
  fetches. Toggles: `UPSTOX_LIVE_*` env set incl. `UPSTOX_LIVE_WS_ENABLED`
  (aspirational — no WS code honors it yet), `UPSTOX_SANDBOX_ENABLED` master
  safety lock (module is paper by design regardless; flag blocks real-mode
  permission), `UPSTOX_LIVE_PAPER_REAL_MODE` (never true path today).
- Auth/token: `upstox-live-paper-auth.service.ts` — OAuth v2 intake, AES
  encrypted access token in `upstox_live_paper_tokens` (single active row per
  clientId; TOKEN_MISSING seed rows; nullable token column), runtime reads DB
  row not .env.
- Engine: `upstox-live-paper.service.ts` — paper open/exit, stale-quote
  blocking, per-position ₹5,000 capital filter, `executionMode: 'PAPER'` hard
  coded, weekly report cron (`0 30 18 * * 1-5`) + `market-stability.service.ts`
  (stale-block counters).
- UI: `/upstox-live-paper` (public/upstox-live-paper.html) + token controller.

### 1c. Legacy/adjacent
- `upstox-trading.*` (page controller/entity/module/service) — old Upstox
  sandbox UI scaffolding; no order/http/WS code found. Candidates for removal or
  explicit deprecation during unification.
- `upstox-sandbox.provider.ts` — the only `ExecutionProvider` impl (DB-only
  sandbox orders). `upstox-sandbox-ingestion.service.ts` — queue writing only
  to `sandbox_ticks` (declared ORACLE_AUTHORITATIVE in database-sync map).
- `emergency-trading.controller.ts` — static HTML page (GET), reads FnF service
  + feed status; no execution surface.
- `trade-book*`, `trade-matcher.service.ts` — historical/broker-import ledger
  (UI/data-separation rule: never shown as Hermes executions).

## 2. Tick/quote storage (brief s7, s15 — duplication today)

| Producer | Tables (writer) | Consumer |
|---|---|---|
| FYERS feed (FnoMarketDataService) | `fnf_market_snapshots`(+history), `fnf_option_quotes`(+history) — fnf-option-chain.service.ts:78, fno feed | FnF engine, pages |
| Upstox paper feed | `upstox_live_paper_option_quotes`, `upstox_live_paper_market_snapshots` (market.service.ts:210/215) | Upstox engine only |
| Sandbox ingest queue | `sandbox_ticks` | inspection |

Same feed classes (option chain quotes, underlying snapshots) are stored twice
under two schemas — brief s15 (no duplicated market feed for the same symbols)
is currently false when both desks track the same underlying universe.

## 3. Execution & isolation (brief s9-s11, s13-s14)

- Real broker calls: NONE in src. `ExecutionProvider` interface is the extension
  seam; only sandbox impl exists. FnF `openTrade` = internal paper fill; Upstox
  = internal paper fill. s13/s14 hold by construction today; keep them that way
  in the unified executor (mode enum must include 'PAPER'; real providers, when
  they arrive, must be opt-in + lock-gated).
- Accounts: FnF envelopes in `fnf_portfolios` (on_real_data flag distinguishes
  sandbox; brokerConfig encrypted per row); Upstox paper accounts are separate
  entities/portfolio rows under `upstox_live_paper_*`. Boundary is by TABLE +
  service, not by a shared account abstraction — works, but duplicated.

## 4. Schedules, toggles, recovery (brief s18)

- Crons in trading: ONE — upstox weekly report (`0 30 18 * * 1-5`,
  upstox-live-paper-scheduled.service.ts:26). FnF decision engine is
  on-demand/page-triggered; trading-agent headless process is heartbeat-alive.
- Restart recovery: all state is DB-persisted (portfolios/positions/orders
  entities). Upstox engine re-marks open positions from latest quotes on demand
  (service.ts:593); NO explicit onModuleInit rehydration/reconnect loop beyond
  the REST polling timer (WS stub means nothing to reconnect). FYERS feed has
  reconnect-while-fallback logic when socket drops (fno-market-data.service.ts
  ~293-307).
- Env toggles inventory (feature flags, .env — never in code): listed per desk
  above. No global EXECUTION_MODE env exists; mode lives per portfolio/entity.

## 5. Gap list vs brief (input to the design phase)

1. s4/s5/s6 — ONE common live market-data service with primary/fallback
   providers does not exist. Two feeds, one WS-stubbed. Upstox REST polling is
   the only "live" Upstox path today; a real Upstox WS (or shared FYERS feed)
   must be built for a true primary.
2. s3 — Yahoo must be excised from the FYERS feed (fallback + explicit mode +
   parser + YAHOO_* env) as part of the unified provider set.
3. s7/s15 — unify tick storage: one normalized tick model + one set of
   snapshot/quote tables both engines read; kill the duplicated
   `upstox_live_paper_*` market tables or migrate them into the common store.
4. s12 — both engines must consume the SAME normalized ticks (see §2).
5. s8 — data-quality gates (stale/bid-ask/missing) exist ad hoc per desk; make
   them a property of the normalized tick + feed health state so both desks
   inherit them.
6. s16/s17 — UI/reporting: two desks currently render from two APIs; unify the
   status/feed-health surface (single live-feed status model).
7. s18 — restart recovery should re-arm the SAME feed health state machine
   (primary→fallback→pause) — implement the pause-new-trading state when both
   sources are unhealthy (brief §8 step 4).
8. s19 — no automated tests exist for feed failover, stale rejection, isolation,
   or restart recovery; the unification must ship these.
9. Legacy: `upstox-trading.*` scaffolding + `sandbox_ticks`/sandbox provider
   should be reconciled or explicitly deprecated so the audit surface shrinks.
10. `ExecutionProvider`/mode typing is pre-unification ('REAL'|'SANDBOX', no
    'PAPER'); align with the paper-first reality during the build.

## 6. Recommended shape (for the design phase, not yet approved)

- Single `MarketDataOrchestrator` owning: health state machine (primary live
  WS → secondary live source → PAUSE), normalized `MarketTick` emission to one
  channel, one tick-storage writer.
- Providers implement a `LiveFeedProvider` interface: FYERS (current adapter),
  Upstox (WS to be implemented; REST as its own secondary), Yahoo (removed from
  trading path per brief s3 — retained only if the brief's "disable" means a
  kill-switch, not deletion).
- FnF engine + Upstox engine subscribe to the SAME normalized tick stream;
  account/portfolio isolation stays per desk (brief s9-s11) but data is shared.
