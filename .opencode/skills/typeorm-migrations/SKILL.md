---
name: typeorm-migrations
description: Use to establish, verify, or operate TypeORM v0.3.x migrations for a NestJS+TypeORM+MySQL/PostgreSQL project — ormconfig.js (not .ts), compiled dist/ DataSource, migration:run and migration:generate workflow, pitfalls, and verification steps. Trigger on typeorm_migrations table, missing columns, or migration files.
---

# TypeORM Migrations v0.3

Use when you need to establish, verify, or operate TypeORM migrations for a NestJS+TypeORM+MySQL/PostgreSQL project using TypeORM v0.3.x.

TypeORM v0.3 has specific constraints that differ from v0.2:
- `DataSourceOptions` type is exported as a type, not a class
- CLI commands require a JavaScript `DataSource` instance export (not TypeScript)
- Migration files must be compiled to `dist/` before CLI can discover them
- `synchronize: true` auto-creates tables but does NOT run migration files

## Trigger Conditions

1. Migration history table (`typeorm_migrations`) does not exist or is incomplete
2. Entity classes define fields that are missing in the database schema
3. New migration files exist in `src/migration/` but are not reflected in DB
4. You need to establish a working migration workflow for the first time
5. You need to inspect current migration status without modifying database

## Workflow

### Phase 1: Setup Configuration

Create `ormconfig.js` (NOT `.ts` — CLI requires JS):

```javascript
const path = require('path');

module.exports = {
  type: 'mysql', // or 'postgres', 'sqlite', etc.
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: Number(process.env.MYSQL_PORT || 3307),
  username: process.env.MYSQL_USER || 'user',
  password: process.env.MYSQL_PASSWORD || 'password',
  database: process.env.DATABASE_NAME || 'mydb',
  synchronize: false, // Critical: never auto-sync with migrations
  logging: false,
  entities: [path.join(__dirname, 'dist', '**', '*.entity.js')],
  subscribers: [path.join(__dirname, 'dist', '**', '*.subscriber.js')],
  migrations: [path.join(__dirname, 'dist', 'migration', '*.js')],
  migrationsTableName: 'typeorm_migrations',
};
```

**Never hard-code credentials** — always use `process.env.*` with safe defaults.

### Phase 2: Create Runtime DataSource

Create `src/datasource.ts` (compiled to `dist/datasource.js`):

```typescript
import { DataSource, DataSourceOptions } from 'typeorm';
import * as path from 'path';

const config: DataSourceOptions = {
  type: 'mysql',
  host: process.env.MYSQL_HOST,
  port: Number(process.env.MYSQL_PORT),
  username: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.DATABASE_NAME,
  synchronize: false,
  logging: false,
  entities: [path.join(__dirname, '..', '**', '*.entity.ts')],
  migrations: [path.join(__dirname, '..', 'migration', '*.ts')],
};

const dataSource = new DataSource(config);

export default dataSource;
```

**Do not export only the config** — CLI requires a `DataSource` instance.

### Phase 3: Compile TypeScript

```bash
npm run build
# or manually:
npx tsc
```

Verify compiled files exist:
```bash
ls -la dist/datasource.js dist/migration/
```

### Phase 4: Run Migrations

```bash
export $(grep -v '^#' .env | xargs)
npx typeorm --dataSource dist/datasource.js migration:run
```

**Never run migrations directly on `.ts` files** — CLI cannot import TypeScript types.

### Phase 5: Generate New Migrations

1. Modify entity files in `src/**/*.entity.ts`
2. Compile: `npm run build`
3. Generate: `npx typeorm --dataSource dist/datasource.js migration:generate -n MigrationName`
4. Review generated SQL in `src/migration/*.ts`
5. Compile and run: `npm run build && npx typeorm --dataSource dist/datasource.js migration:run`

## Pitfalls

### ❌ Forgetting to compile before migration run

**Symptom:** `Error: Unable to open file: "ormconfig.ts"` or `Cannot find module`

**Fix:** Always compile TypeScript before running CLI commands:
```bash
npm run build
# THEN
npx typeorm --dataSource dist/datasource.js migration:run
```

### ❌ Running `migration:generate` without `synchronize: false`

**Symptom:** `synchronize: true` auto-creates columns, then `migration:generate` sees no changes

**Fix:** Set `synchronize: false` in both runtime config and `ormconfig.js`

### ❌ Hard-coding credentials in config files

**Symptom:** Credentials committed to git, exposed in logs

**Fix:** Always use `process.env.*`:
```javascript
password: process.env.MYSQL_PASSWORD || 'fallback' // Fallback for dev only
```
In production, omit the fallback to force explicit environment configuration.

### ❌ Using TypeScript `.ts` config with CLI

**Symptom:** `The requested module 'typeorm' does not provide an export named 'DataSourceOptions'`

**Fix:** Use `ormconfig.js` (compiled paths) for CLI, not `ormconfig.ts`

### ❌ Migration file naming convention

**Symptom:** TypeORM does not detect migration files

**Fix:** Use timestamp prefix pattern:
```bash
# Correct
1788800108047-AddDecisionIdToFnfTrade.ts
1788800108048-CreateTradeBookTables.ts

# Incorrect (no prefix)
AddDecisionIdToFnfTrade.ts
```

## Verification Steps

After running migrations, verify:

```bash
# Check migration table exists
mysql -u root -p -e "SHOW TABLES LIKE 'typeorm_migrations'" mydb

# Check migration history
mysql -u root -p -e "SELECT name, timestamp FROM typeorm_migrations ORDER BY timestamp" mydb

# Verify table schema
mysql -u root -p -e "DESCRIBE fnf_trades" mydb
```

## Expected Outcomes

✅ `typeorm_migrations` table created  
✅ All migration files in `dist/migration/` executed  
✅ Database schema matches entity definitions  
✅ No unapplied migration files reported by CLI  

## Project context (my-job-agent)

- Read the repo-root `TODO.md` ("Project Architecture Memorandum") BEFORE touching DB config: the deployed app reaches Oracle Cloud MySQL through an SSH tunnel on `127.0.0.1:3307`; `MYSQL_PORT` 3307 = Oracle Cloud via tunnel, 3306 = local MySQL. Never flip it without checking which host you are on (2026-09-09 incident).
- `src/database-sync/database-sync.service.ts` "ORACLE_*" labels are a sync-role concept between two LOCAL MySQL instances — NOT Oracle Cloud. Do not conflate.
- In production the app runs with `synchronize: false`; schema changes go through compiled `dist/` migration runs on the deployed VM.

## References

- TypeORM v0.3 migration documentation: https://typeorm.io/migrations
- NestJS TypeORM module: https://docs.nestjs.com/techniques/database