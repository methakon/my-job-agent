# Database Sync Verification Pattern

**Context**: Oracle Cloud MySQL (PRIMARY) ↔ Local MySQL (STANDBY/RECOVERY)

## Core Constraints

- **Oracle MySQL = PRIMARY** — local MySQL must NEVER become active; only standby/recovery copy
- **NO schema migrations from local to Oracle** — table sync is one-way: Oracle → local
- **synchronize: false** — migrations are authoritative; never `synchronize: true` in production
- **Table ownership MUST be classified** as exactly one of:
  - `ORACLE_AUTHORITATIVE` — Oracle is source of truth; local is replica/read-only copy
  - `LOCAL_AUTHORITATIVE` — local is source; Oracle is replica (rare)
  - `SHARED_APPEND_ONLY` — both sides append; merge conflict handling required
  - `EXCLUDED` — not synchronized (e.g., session tokens, temporary data)

## Verification Workflow

```
1. AUDIT (document existing state)
   ├─ Datasource configuration (Oracle:3307 via SSH tunnel, Local:3306)
   ├─ Table ownership matrix (classify each entity)
   ├─ Migration history comparison (Oracle vs Local)
   └─ Background jobs/workers check

2. IMPLEMENTATION (one-way sync pattern)
   ├─ DatabaseSyncAudit entity (checkpoint, status, audit trail)
   ├─ DatabaseSyncService (incremental, batched, idempotent sync)
   ├─ Trading session safety (defer during 9:15-15:30 IST)
   └─ Exponential backoff with retry limits

3. VERIFICATION
   ├─ Schema match (local mirrors Oracle; no drift)
   ├─ Runtime sync (single controlled sync via service)
   ├─ Idempotency (second run: no duplicates, correct counts)
   ├─ Trading session protection (sync deferred in hours)
   ├─ Checkpoint resilience (interruption/resume)
   └─ Schedule safety (only ENQUEUE work, no overlap)
```

## Pitfalls

| Issue | Prevention |
|-------|------------|
| **Local MySQL different credentials** | Document `LOCAL_DB_HOST`, `LOCAL_DB_PORT`, `LOCAL_DB_USER`, `LOCAL_DB_PASSWORD`, `LOCAL_DB_NAME` in `.env` |
| **Blind `synchronize: true`** | Never use in production; audit migrations first with `typeorm migration:show` |
| **Port confusion (3306 vs 3307)** | Use SSH tunnel (3307) for Oracle, direct (3306) for local; verify with `netstat -tlnp \| grep 330` |
| **Missing `database_sync_audit` table** | Apply migration: `npx typeorm migration:run` before enabling `DB_SYNC_ENABLED=true` |
| **TradeBook merged with FnfTrade** | Keep `trade_book_imports`, `trade_book_import_log` separate from `fnf_trades` |
| **Overlapping sync processes** | Scheduler only ENQUEUES work; single sync worker processes queue |

## Configuration Template

```env
# Database sync configuration
DB_SYNC_ENABLED=false              # Enable only after verification
DB_SYNC_INTERVAL_MINUTES=30
DB_SYNC_OUTSIDE_TRADING_ONLY=true  # True = defer during 9:15-15:30 IST
DB_SYNC_BATCH_SIZE=1000
DB_SYNC_MAX_RETRIES=3
DB_SYNC_BACKOFF_SECONDS=5

# Local MySQL (separate instance)
LOCAL_DB_HOST=127.0.0.1
LOCAL_DB_PORT=3306
LOCAL_DB_USER=local_user
LOCAL_DB_PASSWORD=***
LOCAL_DB_NAME=myjob_agent

# Oracle MySQL (via SSH tunnel)
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3307
MYSQL_USER=mylife
MYSQL_PASSWORD=***
DATABASE_NAME=myjob_agent
```

## Git Safety

- **DO NOT** reset/rebase/squash/amend unrelated commits
- **DO NOT** modify existing migrations unless genuine defect discovered
- **DO NOT** push/deploy without explicit authorization
- Check `git status --short` and `git rev-parse HEAD` before reporting completion

## Verification Status Code

| Status | Meaning |
|--------|---------|
| `AUDITED` | Audit Phase complete; state documented |
| `IMPLEMENTED_UNVERIFIED` | Code implemented; schema verified; runtime pending credentials |
| `VERIFIED` | Runtime sync completed with audit/checkpoint inspected |
| `MIGRATION_CREATED` | Migration file created |
| `MIGRATION_APPLIED` | Migration executed on target database |
| `SCHEMA_VERIFIED` | Local schema matches Oracle (no drift) |
| `SYNC_TEST_VERIFIED` | Single sync run verified: source→destination correct |
| `BLOCKED` | External blocker (credentials, connectivity, permissions) |
| `FAILED` | Runtime error; rollback required |
| `NOT_REQUIRED` | Table not in ownership matrix; sync not needed |
