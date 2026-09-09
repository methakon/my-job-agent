---
name: nestjs-microservice-mvcr
description: Use for NestJS microservice development following MyLife MVCR (Model-View-Controller-Repository) standards — service business logic, controller routing, repository data access, DTO validation, TypeORM entities. Trigger for any NestJS work in my-job-agent or MyLife services.
---

# NestJS Microservice MVCR

## When to use

Building or modifying a NestJS module/service in the MyLife stack (`~/projects/mylife/services/*` or my-job-agent). Follows the shared patterns copied from `~/projects/mylife/services/shared/` (`db.config.ts`, `env-check.ts`, `swagger.config.ts`).

## Pattern

- **Model** — one TypeORM entity per table (`src/**/*.entity.ts`).
- **View** — template/static pages or API JSON responses.
- **Controller** — HTTP routing only; thin, delegates to services.
- **Repository** — data access; services never run raw queries directly.
- **Service** — business logic, cross-entity orchestration.
- **DTOs** everywhere for input validation. Explicit column types (TypeORM can't infer `string | null` unions).

## Rules

- Add a module = module file + service + controller + entity (if new table) registered in `AppModule`.
- New tables in production (`NODE_ENV=production`, `synchronize=false`) must be created via SQL in MySQL before boot.
- Standard shared config helpers come from the MyLife shared lib; copy, don't reinvent.
- Prods use conventional commits; git sync after each completed TODO item.

## References

- `references/trading-ai-architecture-audit.md` — verification workflow for trading AI architecture (audit-only, no file changes).

## Related skills

- `typeorm-migrations` — schema/migration workflow for this stack.
- `trading-broker-authentication-isolation` — broker provider separation in the same codebase.