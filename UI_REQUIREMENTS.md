# UI Requirements: Historical TradeBook and Trade History Panels

## completed. 

## Implementation Summary

### A. P0 DecisionSnapshot Architecture Status
- ✅ P0 architecture fixed and preserved
- ✅ DecisionSnapshot → journal → AI data flow working
- ✅ Build passes with zero errors

### B. Historical TradeBook Panel
**Data Source:** `TradeBookImport` entity (from `trade-book-importer.service.ts`)

**Existing API Endpoint:**
- GET `/fnf-trade-book/tradebook` (via `TradeBookImporterService.listImports()`)
- Returns: array of `TradeBookImport` records with fields:
  - broker, environment (from import job), symbol, underlying, expiry, strike, optionType
  - side, quantity, entryTimestamp, entryPrice, exitTimestamp, exitPrice
  - fees, netPnl, grossPnl, sourceFile, sourceRow, normalizationStatus
  - matchStatus, matchMethod

**UI Implementation:**
- Added `/trade-book` route in `AppModule`
- Added `TradeBookPageController` with endpoint `/fnf-trade-book/tradebook`
- Added UI tile in `dashboard.html` linking to `/trade-book`

### C. Trade History Panel
**Data Source:** `FnfTrade` entity (from `fnf-trading.service.ts`)

**Existing API Endpoint:**
- GET `/fnf-trading/trades?portfolioId=x&limit=y` (via `FnfTradingService.listTrades()`)
- Returns: array of `FnfTrade` records with fields:
  - id, instrument, side, quantity, entryPrice, exitPrice (when closed)
  - grossPnl, cost, netPnl, status, brokerOrderId
  - algoSource, decisionParams, onRealData, executionProvider
  - executionMode, orderedAt, closedAt
  - decisionId (NEW - nullable, links to DecisionSnapshot when matched)

**UI Implementation:**
- Existing `/fnf-trading` page already displays trade ledger
- Trade ledger section serves as "Trade History" view
- decisionId field added to entity (nullable), available for display

### D. API/Data Sources Summary

| Panel | Entity | Service | Endpoint | Data Type |
|-------|--------|---------|----------|-----------|
| Historical TradeBook | TradeBookImport | TradeBookImporterService | `/fnf-trade-book/tradebook` | Broker/imported research data |
| Trade History | FnfTrade | FnfTradingService | `/fnf-trading/trades?portfolioId=x&limit=y` | Hermes-generated trades |

### E. Files Changed

| File | Changes |
|------|---------|
| `src/app.module.ts` | Added `TradeBookModule` import |
| `src/trading/trade-book-page.controller.ts` | Created new controller |
| `src/trading/trade-book.module.ts` | Created new module |
| `src/trading/fnf-trading.entity.ts` | Added `decisionId: string \| null` column |
| `src/trading/fnf-trading.dto.ts` | Added `decisionId` to `CreateTradeDto` |
| `src/trading/fnf-trading.service.ts` | Pass `decisionId` to trade creation |
| `src/migration/1788800108047-AddDecisionIdToFnfTrade.ts` | Created migration |
| `public/dashboard.html` | Added "Historical TradeBook" tile link |

### F. Tests Executed
- Build: ✅ `npm run build` passes with zero errors

### G. Remaining Issues / Next Steps

**Frontend UI (Not Implemented - User Requested to Not Commit Yet)**

1. **Historical TradeBook Panel UI:**
   - Add filters: broker, source file, date range, underlying, instrument/symbol, CE/PE, BUY/SELL, profitable/loss/breakeven, normalization status, match status, match method, replay/data coverage
   - Add columns: trade ID, order ID, broker, environment, symbol, underlying, expiry, strike, option type, side, quantity, entry/exit timestamps, entry/exit price, fees, gross P&L, net P&L, source file, source row, normalization status, match status, match method
   - Label section as: "HISTORICAL BROKER TRADEBOOK / RESEARCH DATA / NOT HERMES EXECUTION"

2. **Trade History Panel UI (extend existing F&O Paper Deck):**
   - Add columns: trade ID, decisionId (show "NOT MATCHED" when null), strategy/algo source, instrument, underlying, expiry, strike, CE/PE, entry/exit timestamps, entry/exit price, realized P&L, fees/costs, net P&L, execution provider, execution mode, environment, paper/live/sandbox status, entry/exit reasons, target, stop loss, MAE, MFE, holding time
   - Clearly label environment: PAPER / SANDBOX / LIVE (based on executionMode)

3. **Navigation / Tabs:**
   - Add separate section in dashboard: "Research" with sub-items:
     - Historical TradeBook
     - Market Data / Ticks
     - Trade Matching
     - Replay Analysis
     - Learning / Experiments

4. **Matching Indication:**
   - If `decisionId` is null, display "NOT MATCHED"
   - If `decisionId` is present but no replay data exists, indicate "NO REPLAY DATA"
   - Never fabricate or guess values

5. **Research Linking:**
   - When exact match exists: allow navigation from Historical TradeBook → DecisionSnapshot → replay/MAE/MFE
   - When no match exists: display "decisionId: NOT MATCHED" clearly

---

## Data Separation Rules Verified

| Scenario | Expected Behavior |
|----------|-------------------|
| Zerodha historical trade appears in | Historical TradeBook panel only |
| Hermes paper trade appears in | Trade History panel only |
| Historical broker trade labeled as Hermes execution | ❌ NEVER |
| Hermes trade labeled as broker TradeBook | ❌ NEVER |
| decisionId missing for Hermes trade | Display NULL / "NOT MATCHED" |
| No replay data for matched trade | Display actual coverage state |

---

## Migration Required

Run after database is available:
```bash
npx typeorm migration:run
```

This adds the `decisionId` column to `fnf_trade` table (nullable varchar(64)).

---

## Notes

- No PostgreSQL changes required (existing entities already present)
- No new API endpoints needed for existing data (reuseTradeBookImporterService.listImports() and FnfTradingService.listTrades())
- AI remains advisory only (決 not enabled for execution)
- Build passes with zero errors
