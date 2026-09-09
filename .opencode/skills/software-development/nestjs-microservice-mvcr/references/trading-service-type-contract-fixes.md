# Trading Service Type Contract Fixes

This reference documents the type-fixing pattern used for NestJS + TypeORM trading services (my-job-agent repository), specifically for `trade-matcher.service.ts`.

## Session: 2026-09-07 — trade matcher type errors

### Problem

Build failure with 11 TypeScript errors in `src/trading/trade-matcher.service.ts`:
- `timeDifferenceMs` type mismatch (was `number | 0` but should be nullable)
- `dataCoverage` enum values didn't exist (`partial`, `full`, `none` invented by error)
- `matchStatus` string literals didn't match entity constraints
- `symbol` nullability issue

### Root Cause Analysis

| Field | Entity Definition | Error in Service | Fix |
|-------|-------------------|------------------|-----|
| `matchStatus` | `@Column({ type: 'varchar', length: 20, default: 'unmatched' })` | `'MATCHED_EXACT'`, `'MATCHED_CONTRACT_TIME'` | Changed to `'MATCHED'` |
| `timeDifferenceMs` | `@Column('int', { nullable: true })` | Assigned `0` when no match | Changed to `null` |
| `dataCoverage` | FIELD DOES NOT EXIST | Used `partial`, `full`, `none` | Removed entirely |
| `symbol` | `@Column({ type: 'varchar', length: 100, nullable: true })` | Used `trade.symbol || trade.instrumentKey` without null guard | Added early return: `if (!symbol) return matchResult;` |

### Fix Pattern

**Step 1: Inspect entity definitions first**
```bash
grep -E "@Column|type.*=(string|number)" src/trading/trade-book.entity.ts
```

**Step 2: Match type contracts exactly**
```typescript
// BEFORE (WRONG)
matchStatus: 'MATCHED_EXACT' | 'MATCHED_CONTRACT_TIME';

// AFTER (CORRECT)
matchStatus: 'MATCHED' | 'UNMATCHED'; // Entity's actual constraint
```

**Step 3: Handle nullability explicitly**
```typescript
// BEFORE (WRONG)
const symbol = trade.symbol || trade.instrumentKey;
await this.findTickBySymbol(symbol, ...);

// AFTER (CORRECT)
const symbol = trade.symbol || trade.instrumentKey;
if (!symbol) return matchResult; // Early return with null match
await this.findTickBySymbol(symbol, ...);
```

**Step 4: Remove fields that don't exist**
```typescript
// dataCoverage was used but NO field exists in TradeBookImport entity
// Fix: Remove dataCoverage from matchResult object entirely
```

### CSV Parse Type Assertion Pattern

For `trade-book-importer.service.ts`, `csv-parse` returns `unknown`:

```typescript
// BEFORE (WRONG)
const row = records[i];

# AFTER (CORRECT)
const row = records[i] as Record<string, string>;
```

### Build Verification

```bash
# Dependencies first
npm install csv-parse --legacy-peer-deps

# Type check
npm run build
# Should show: exit 0, 1 lines output
```

### Key Principles

1. **Never guess enum/string values** — query the entity definition directly
2. **Null is a valid type** — use `null`, not artificial defaults like `0`
3. **Remove unused fields** — don't invent fields that don't exist
4. **Type guards for nullable source data** — add check before use

### Related Skills

- `nestjs-microservice-mvcr` — General NestJS + TypeORM development patterns
- `systematic-debugging` — Root cause debugging methodology
