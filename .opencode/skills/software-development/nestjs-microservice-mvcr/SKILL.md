---
name: nestjs-microservice-mvcr
description: Use for NestJS + TypeORM microservice work — MVCR pattern.
---

# NestJS microservices with the MVCR pattern

Standing coding standard in the MyLife repo (user-mandated) and a good default for
NestJS + TypeORM microservices generally.

## The pattern (per service)

```
services/<name>/src/
  main.ts              # credential pre-flight BEFORE NestFactory.create
  app.module.ts        # ConfigModule.forRoot(envFilePath ['../../.env', '.env']) + TypeOrmModule.forRoot(mysqlConfig(DB_NAME))
  <entity>.entity.ts   # ONE entity file per DB table — Models
  <x>.dto.ts           # request AND response DTOs — Views (controllers accept/return DTOs only)
  <x>.repository.ts    # ALL DB access — Repositories (no queries in services/controllers)
  <x>.service.ts       # business logic only, calls repository
  <x>.controller.ts    # thin: routing + validation only
```

## Steps

1. Read the repo's existing service first (e.g. `services/mylife-auth/src/`) and
   copy its shape — module wiring, env-check call, shared `db.config.ts` import.
2. Entity: dedicated file per table, snake_case `@Column({ name: ... })` for
   multi-word columns; `decimal` columns come back as strings — convert with
   `Number()` in the DTO mapper.
3. DTOs: class-validator decorators on input classes; a separate
   `<X>ResponseDto` class for output (never return the raw entity). Include a
   computed convenience flag where useful (e.g. `hasCompleteBirthData`).
4. Repository class wrapping `@InjectRepository` — findAll/find/save/create/remove
   plus any queryBuilder work. Keep ordering/filtering here.
5. Controller: `@Controller('prefix')`, `ParseUUIDPipe` on path ids, bodies typed
   as DTOs, one-line delegations to the service.
6. Wire module: `TypeOrmModule.forFeature([Entity])`, register repository +
   service as providers. Shared config via
   `mysqlConfig(process.env.X_DB_NAME || 'fallback')`.
7. Idempotent seeds: an `OnModuleInit` service using
   `repo.upsert(data, ['slug'])` so restarts don't duplicate rows.
8. Verify with `npx tsc --noEmit` in the service dir before committing.

## Pitfalls

|- **Passport strategy options need non-optional types**: `clientID`/`clientSecret`
|  must be `process.env.X!` (non-null assertion) or tsc rejects the `super({...})`
|  call against `StrategyOptions`.
|- **Forgetting the import when adding providers** to app.module.ts is the classic
|  "Cannot find name 'X'" error — add both the provider entry AND the import line.
|- **Prefer the terminal tool's `workdir` parameter over `cd`** — session cwd
|  persists between calls and a stale `cd services/x` fails after dir changes.
|- **Relative imports across service packages break tsc rootDir** — shared code is
|  duplicated into each service's `src/` (see env-check.ts convention) or lives in
|  a sibling `shared/` folder imported only at config level.
|- **`synchronize: true` is dev-only** — gate it on `NODE_ENV !== 'production'`;
|  migrations come later.

## P0 Verification (DecisionId Pipeline)

When implementing P0 decisionId pipeline with `DecisionSnapshot → AiTradingInput → FnfTrade`:

1. **Build the project**: `npm run build`
2. **Run P0 regression tests**: `node scripts/p0-regression-tests.js`
3. **Run full test suite**: `npm run test:trading && npm run test:ai && npm run test:trading-ai`
4. **Stage only required files**: entity, DTO, service, test script (exclude migrations, .hermes/, docs)
5. **Verify no trailing whitespace**: `git diff --check` before staging

All tests must pass before checkpoint is considered P0-verified.
See `references/p0-decisionId-pipeline-verification.md` for full requirements.

## Type Contract Troubleshooting (TypeORM Services)

When TypeScript build fails with entity-related errors, follow this checklist:

1. **Enum/string values must match entity exactly**
   - Inspect entity: `grep -E "@Column|type.*=(string|number)" src/trading/<entity>.entity.ts`
   - Never guess values — use `@Column({ type: 'varchar', default: 'x' })` as source of truth
   - common traps: `'MATCHED_EXACT'` vs `'MATCHED'`, `'OPEN'` vs `'active'`

2. **Nullable fields require null check or `null`**
   - If entity has `nullable: true`, use `null` not `0` or `''`
   - For string fields, add early return: `if (!field) return null;`

3. **Remove fields that don't exist**
   - CSV parsing may suggest fields that aren't in entity — delete, don't guess
   - TypeScript won't catch unused fields — rely on entity types

4. **CSV parse return type is `unknown`**
   - Cast explicitly: `const row = records[i] as Record<string, string>;`

See `references/trading-service-type-contract-fixes.md` for an annotated case study.

## Verification

Run `npx tsc --noEmit` per service in a loop over `services/*/`. A source-only
`shared/` folder without its own tsconfig may print "This is not the tsc
command" — that is expected, not a failure.

## Related session references
- `references/my-job-agent-session.md` — Naukri login/apply, lead scoring, retry
  backoff, HR-email investigation ladder, playwright form-filling, route shadowing,
  MySQL column sizing.
- `references/fnf-decay-engine.md` — FNF trading module: day-wise self-rectifying
  decay engine, per-weekday calibration, signal decay formula, rectification
  triggers, cost model, pitfalls.
- `references/trading-ai-orchestration-types.md` — NestJS/TypeORM AI trading orchestrator
  type fixes: routing metadata, DecisionSnapshot field mappings, quote field names (`oi` not `oI`), assessment result structure.
- `references/trade-book-ingestion-pattern.md` — CSV trade-book ingestion: SHA256 file deduplication, normalization status tracking, raw data preservation, matching strategy against tick/snapshot DB.
- `references/trading-service-type-contract-fixes.md` — Type contract troubleshooting: entity inspection, null handling, CSV parse type assertions, build verification workflow.
- `references/p0-decisionId-pipeline-verification.md` — P0 decisionId pipeline: Architecture requirements, verification points, P0 regression test suite (7 tests), testing workflow, commit conventions.
