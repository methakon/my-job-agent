# Trading AI Architecture Audit Verification

Use this reference when performing verification audits of trading AI architecture without introducing changes.

## Triggers

- User specifies "audit-only" with explicit constraints against committing, pushing, or modifying files
- User requests migration type verification before making changes
- User requires test verification of P0 decision flow in trading-ai module
- User asks to verify database configuration and migration compatibility

## Workflow

1. **Type Verification First**
   - Inspect TypeORM version: `npm ls typeorm`
   - Read TypeORM type definitions for TableColumnOptions
   - DO NOT modify migration files based on assumptions — verify against installed version
   - If type matches definition, leave unchanged and report

2. **Build Verification**
   - Run: `npm run build`
   - Exit code 0 = PASS
   - Report exact code and no output

3. **Test Execution**
   - Run ALL available test scripts:
     - `npm run test:trading`
     - `npm run test:ai`
     - `npm run test:trading-ai`
   - Report exit codes and test counts

4. **P0 Flow Verification**
   - Confirm DecisionSnapshot → AI uses same in-memory snapshot
   - Verify `decisionId === snapshot.decisionId` in buildAiTradingInputFromSnapshot
   - Confirm no reconstruction from journal, signal.reasons, database queries
   - Verify SHADOW-MODE prevents AI output from affecting deterministic decisions

5. **Database Safety**
   - Verify mysql2 driver (NOT pg/PostgreSQL)
   - Confirm Oracle Cloud MySQL at 10.0.0.99:3306
   - Verify SSH tunnel: 127.0.0.1:3307 → 10.0.0.99:3306
   - DO NOT execute `npx typeorm migration:run` against shared Oracle Cloud DB
   - Report migration compatibility status

6. **Git Status**
   - Run: `git status`
   - Report all modified and untracked files
   - DO NOT commit or push per user constraints

## Pitfalls

- **Migration length type:** Never assume `length: '64'` is wrong — always verify against TypeORM version's TableColumnOptions definition
- **Test count discrepancy:** Build may pass but tests may exit 0 with no actual test execution — always report exact test counts
- **P0 verification:** If any reconstruction occurs (from journal, signal.reasons, database queries, defaults), mark P0 = NOT VERIFIED
- **Database safety:** Always explicitly confirm NO migration execution against shared Oracle Cloud DB

## Files

- `1788800108047-AddDecisionIdToFnfTrade.ts` — Migration adds `decisionId` column

## Session Reference

This reference captures the audit performed on 2026-09-07 for the Trading AI architecture following a completed work checkpoint.
