# SINGLE PAPER PORTFOLIO — ARCHITECTURE ANALYSIS

**Date**: 2026-09-17 (POST-MARKET)
**Branch**: `ja-015-publish` (18 commits ahead of origin/dev)
**Status**: ANALYSIS ONLY — NO CODE CHANGES YET

---

## CURRENT ARCHITECTURE

### Data Flow Diagram

```
FYERS WebSocket ──────────────┐
                              ├→ TickInterpreter → UnifiedMarketDataService
Upstox REST + V3 WS ─────────┘         ↓
                              unified_option_quotes (canonical)
                              fnf_option_quotes (FNF desk)
                                        ↓
                              FNF Trading Service
                                        ↓
                              fnf_portfolios / fnf_trades (THE SINGLE PORTFOLIO)

Upstox Live Paper ──────────────────────┐
                              ↓
                  upstox_live_paper_option_quotes (desk store)
                                        ↓
                  UpstoxLivePaperAutoEntryService
                                        ↓
                  upstox_live_paper_portfolios / trades / orders / positions
                  (SEPARATE PAPER PORTFOLIO — TO BE DEPRECATED)
```

### Component Inventory

#### MARKET DATA (KEEP)

| Component | File | Purpose |
|-----------|------|---------|
| FYERS WebSocket | `fno-market-data.service.ts` | FYERS live feed → unified store |
| Upstox REST Poll | `upstox-live-paper-market.service.ts` | Upstox V2 REST → unified + desk store |
| Upstox V3 WebSocket | `upstox-live-paper-market.service.ts` | Upstox V3 binary → unified + desk store |
| Canonical Interpreter | `canonical/tick-interpreter.service.ts` | Provider-agnostic tick normalization |
| Unified Market Data | `unified-market-data.service.ts` | Canonical store + freshness validation |
| Feed Arbitration | `feed-arbitration.service.ts` | Lease/heartbeat for active feed selection |
| Feed Health | `feed-health.service.ts` | Provider liveness monitoring |
| Upstox Token Service | `upstox-live-paper-auth.service.ts` | OAuth token management |
| Upstox Market Stability | `upstox-live-paper-market-stability.service.ts` | Market hours/session tracking |

#### PAPER EXECUTION (DEPRECATE)

| Component | File | Purpose |
|-----------|------|---------|
| Upstox Paper Service | `upstox-live-paper.service.ts` | Portfolio/trade/order/position/P&L CRUD |
| Upstox AutoEntry | `upstox-live-paper-autoentry.service.ts` | Entry/exit signal evaluation + execution |
| Upstox Risk Service | `upstox-live-paper-risk.service.ts` | Per-trade risk checks |
| Upstox Capital Continuity | `upstox-live-paper-capital-continuity.service.ts` | Capital balance persistence |
| Upstox Weekly Report | `upstox-live-paper-weekly-report.service.ts` | Weekly P&L summaries |
| Upstox Learning Service | `upstox-live-paper-learning.service.ts` | Trade reflection/learning |
| Upstox Scheduled Service | `upstox-live-paper-scheduled.service.ts` | Cron-based maintenance |
| Upstox Paper Controller | `upstox-live-paper.controller.ts` | REST API for paper portfolio |
| Upstox Token Controller | `upstox-live-paper-token.controller.ts` | OAuth flow endpoints |

#### FNF (THE SINGLE PORTFOLIO)

| Component | File | Purpose |
|-----------|------|---------|
| FNF Trading Service | `fnf-trading.service.ts` | Portfolio/trade/decision CRUD |
| FNF Option Chain | `fnf-option-chain.service.ts` | Quote ingestion + chain queries |
| FNF Trading Controller | `fnf-trading.controller.ts` | REST API |
| FNF Page Controller | `fnf-trading-page.controller.ts` | HTML dashboard |

---

## DATABASE TABLES

### KEEP (Market Data)

| Table | Rows | Purpose |
|-------|------|---------|
| `unified_option_quotes` | 2.47M | Canonical store (FYERS_LIVE + UPSTOX + UPSTOX_LIVE) |
| `unified_market_snapshots` | ? | Underlying price snapshots |
| `upstox_live_paper_option_quotes` | 468K | Upstox desk store (dataSource: UPSTOX) |
| `upstox_live_paper_market_snapshots` | ? | Upstox market snapshots |
| `market_data_feed_leases` | ? | Feed arbitration leases |
| `fnf_option_quotes` | 34K | FNF desk store (provider: fyers) |
| `fnf_option_quotes_history` | ? | Archived FNF quotes |
| `fnf_option_contracts` | ? | Registered option contracts |

### DEPRECATE (Paper Execution)

| Table | Rows | Action |
|-------|------|--------|
| `upstox_live_paper_portfolios` | 1 | Archive, do not delete |
| `upstox_live_paper_trades` | 0 | Archive, do not delete |
| `upstox_live_paper_orders` | 0 | Archive, do not delete |
| `upstox_live_paper_positions` | 0 | Archive, do not delete |
| `upstox_live_paper_pnl_events` | 14 | Archive, do not delete |
| `upstox_live_paper_weekly_reports` | 0 | Archive, do not delete |
| `upstox_live_paper_sessions` | 10 | Archive, do not delete |
| `upstox_live_paper_candidates` | 136 | Archive, do not delete |
| `upstox_live_paper_instructions` | 0 | Archive, do not delete |

### PRESERVE (FNF Portfolio)

| Table | Rows | Purpose |
|-------|------|--------|
| `fnf_portfolios` | 1 | THE SINGLE PORTFOLIO |
| `fnf_trades` | 14 | Trade history |
| `fnf_decision_journal` | ? | Decision audit trail |
| `fnf_trade_reflections` | ? | Post-trade analysis |
| `fnf_trade_reports` | ? | Performance reports |
| `fnf_market_snapshots` | ? | Market state snapshots |
| `fnf_decay_calibrations` | ? | IV decay model params |

---

## COMPONENTS TO RETIRE

### 1. Upstox Paper Execution Path

**What it does**: Reads from `upstox_live_paper_option_quotes` (desk store), evaluates entry/exit signals, executes paper trades in a SEPARATE portfolio.

**Why retire**: No actual trades were taken (0 trades, 0 orders, 0 positions). The FNF portfolio is the single paper execution path.

**Components**:
- `UpstoxLivePaperService` — portfolio/trade/order/position CRUD
- `UpstoxLivePaperAutoEntryService` — entry/exit signal evaluation
- `UpstoxLivePaperRiskService` — per-trade risk checks
- `UpstoxLivePaperCapitalContinuityService` — capital balance
- `UpstoxLivePaperWeeklyReportService` — weekly P&L
- `UpstoxLivePaperLearningService` — trade reflection
- `UpstoxLivePaperScheduledService` — cron maintenance
- `UpstoxLivePaperController` — REST API
- `UpstoxLivePaperTokenController` — OAuth flow

**Tables to archive** (not delete):
- `upstox_live_paper_portfolios`
- `upstox_live_paper_trades`
- `upstox_live_paper_orders`
- `upstox_live_paper_positions`
- `upstox_live_paper_pnl_events`
- `upstox_live_paper_weekly_reports`
- `upstox_live_paper_sessions`
- `upstox_live_paper_candidates`
- `upstox_live_paper_instructions`

### 2. Upstox Paper Portfolio State

**What it does**: Tracks capital, deployed, netPnl, unrealisedPnl in `upstox_live_paper_portfolios`.

**Why retire**: No actual trades were taken. The FNF portfolio is the single paper portfolio.

**State**: 1 portfolio (`sensex-live-2026-09-10`), ₹5,000 capital, ₹0 deployed, ₹0 P&L.

---

## COMPONENTS TO KEEP

### 1. Upstox Market Data Path

**What it does**: Fetches live market data from Upstox REST API + V3 WebSocket, writes to:
- `unified_option_quotes` (canonical store, source: `UPSTOX_LIVE`)
- `upstox_live_paper_option_quotes` (desk store, dataSource: `UPSTOX`)

**Why keep**: Upstox remains a redundant live-data provider for the FNF portfolio.

**Components**:
- `UpstoxLivePaperMarketService` — data fetching + persistence
- `UpstoxLivePaperMarketStabilityService` — market hours/session tracking
- `UpstoxLivePaperTokenService` — OAuth token management
- `UpstoxLivePaperConfig` — configuration

### 2. Unified Market Data Pipeline

**What it does**: Canonical tick normalization, freshness validation, feed arbitration.

**Why keep**: This is the shared infrastructure that both FYERS and Upstox feed into.

**Components**:
- `TickInterpreterService` — provider-agnostic tick normalization
- `UnifiedMarketDataService` — canonical store + freshness validation
- `FeedArbitrationService` — lease/heartbeat for active feed selection
- `FeedHealthService` — provider liveness monitoring

### 3. FNF Trading System

**What it does**: The single paper portfolio for all paper trading.

**Why keep**: This IS the target architecture.

**Components**:
- `FnfTradingService` — portfolio/trade/decision CRUD
- `FnfOptionChainService` — quote ingestion + chain queries
- `FnfTradingController` — REST API
- `FnfTradingPageController` — HTML dashboard

---

## DATA TO PRESERVE

### Historical Market Data (DO NOT DELETE)

1. **FYERS ticks** in `unified_option_quotes` (1.89M rows, source: `FYERS_LIVE`)
2. **Upstox REST ticks** in `upstox_live_paper_option_quotes` (468K rows, dataSource: `UPSTOX`)
3. **Upstox V3 WS ticks** in `unified_option_quotes` (221K rows, source: `UPSTOX_LIVE`)
4. **Canonical/unified records** in `unified_option_quotes` (2.47M total)
5. **Provider/source provenance** — `source` column in `unified_option_quotes`
6. **Timestamps** — `sourceTimestamp`, `receivedTimestamp`, `ts`
7. **OI/IV/Greeks** where available

### Historical Paper Execution State (ARCHIVE, DO NOT DELETE)

1. **Upstox paper portfolio** — 1 portfolio, ₹5,000 capital, ₹0 deployed
2. **Upstox paper P&L events** — 14 events (likely balance snapshots)
3. **Upstox paper sessions** — 10 sessions
4. **Upstox paper candidates** — 136 candidates (entry signal evaluations)

### FNF Portfolio State (PRESERVE AS-IS)

1. **FNF portfolio** — 1 portfolio (`sandbox-live`), ₹10,000 capital, ₹1,659.58 netP&L
2. **FNF trades** — 14 trades
3. **FNF decision journal** — decision audit trail
4. **FNF trade reflections** — post-trade analysis

---

## MINIMAL CHANGES

### Phase 1: Disable Upstox Paper Execution (Safe, No Data Loss)

1. **Comment out autoentry cron** in `UpstoxLivePaperModule`:
   - Remove `UpstoxLivePaperAutoEntryService` from providers
   - Remove `UpstoxLivePaperScheduledService` from providers
   - Remove `UpstoxLivePaperController` from controllers

2. **Keep market data services active**:
   - `UpstoxLivePaperMarketService` — continues writing to unified store
   - `UpstoxLivePaperMarketStabilityService` — continues tracking market hours
   - `UpstoxLivePaperTokenService` — continues managing OAuth tokens

3. **Archive execution tables** (rename, not delete):
   - `upstox_live_paper_portfolios` → `upstox_live_paper_portfolios_archived`
   - `upstox_live_paper_trades` → `upstox_live_paper_trades_archived`
   - `upstox_live_paper_orders` → `upstox_live_paper_orders_archived`
   - `upstox_live_paper_positions` → `upstox_live_paper_positions_archived`
   - `upstox_live_paper_pnl_events` → `upstox_live_paper_pnl_events_archived`

### Phase 2: Normalize Historical Data (Optional, Research Value)

1. **Merge UPSTOX_LIVE ticks into unified format**:
   - Already in `unified_option_quotes` with `source: UPSTOX_LIVE`
   - No action needed — already normalized

2. **Preserve desk store for research**:
   - Keep `upstox_live_paper_option_quotes` as-is
   - Contains raw Upstox payloads with full fidelity

### Phase 3: Verify Single Portfolio (Post-Implementation)

1. **Verify FNF is the ONLY execution path**:
   - `fnf_portfolios` — 1 portfolio
   - `fnf_trades` — all paper trades
   - No other portfolio tables active

2. **Verify both providers feed FNF**:
   - `fnf_option_quotes` — provider: `fyers`
   - `unified_option_quotes` — sources: `FYERS_LIVE`, `UPSTOX_LIVE`
   - FNF reads from both via `sharedQuoteToChainRow()`

3. **Verify no duplicate execution**:
   - Only one autoentry service active (`FnfTradingService`)
   - No Upstox autoentry running

4. **Verify historical data intact**:
   - `unified_option_quotes` — 2.47M rows preserved
   - `upstox_live_paper_option_quotes` — 468K rows preserved
   - `fnf_option_quotes` — 34K rows preserved

5. **Verify REAL TRADING locked**:
   - `executionMode: PAPER` in all paper portfolios
   - No real broker connections active
   - No real order placement code paths

---

## MIGRATION/COMPATIBILITY RISKS

### Low Risk

1. **Upstox market data continues uninterrupted**:
   - `UpstoxLivePaperMarketService` stays active
   - Writes to `unified_option_quotes` (canonical) continue
   - FNF reads from canonical store — no data gap

2. **No data loss**:
   - All tables archived, not deleted
   - Historical market data preserved
   - FNF portfolio state preserved

3. **No breaking changes to FNF**:
   - FNF reads from `fnf_option_quotes` + `unified_option_quotes`
   - No dependency on Upstox paper execution components

### Medium Risk

1. **Upstox desk store becomes orphaned**:
   - `upstox_live_paper_option_quotes` continues to be written by market service
   - No consumer reads from it after autoentry is disabled
   - Mitigation: Keep writing for research value; archive later

2. **Upstox paper portfolio state becomes stale**:
   - 1 portfolio with ₹5,000 capital sits unused
   - Mitigation: Archive table, document as historical artifact

### High Risk (If Not Managed)

1. **Accidental re-enable of Upstox paper execution**:
   - Code still exists in codebase
   - Mitigation: Add `@Deprecated()` decorators, document in ARCHITECTURE.md

2. **FNF autoentry doesn't read from Upstox V3 WS ticks**:
   - FNF reads from `fnf_option_quotes` (provider: `fyers`) with fallback to `unified_option_quotes`
   - Upstox V3 ticks land in `unified_option_quotes` with `source: UPSTOX_LIVE`
   - Mitigation: Verify `sharedQuoteToChainRow()` maps UPSTOX_LIVE ticks correctly

---

## VERIFICATION CHECKLIST

- [ ] Upstox paper execution components disabled (autoentry, risk, scheduled)
- [ ] Upstox market data components active (market service, token service, stability)
- [ ] FNF is the ONLY active paper portfolio
- [ ] Both FYERS and Upstox feed into unified store
- [ ] FNF reads from unified store via `sharedQuoteToChainRow()`
- [ ] No duplicate execution paths
- [ ] Historical data preserved (unified_option_quotes, desk store, fnf_option_quotes)
- [ ] REAL TRADING remains completely locked
- [ ] TSC + build passes
- [ ] Tests pass
