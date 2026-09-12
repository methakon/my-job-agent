# /project-status synchronization — mandatory gate-close procedure

Status page: `GET /project-status` (operator-authenticated, served by pm2
`my-job-agent` on `http://127.0.0.1:3010`, published as `berhampore.in`).
Data: MySQL table `project_checklist_items` (224 rows, v5 edition).

## 1. The incident this fixes (2026-09-10)

Code, tests and git were current (commit `c98a7b4` on `dev`, pushed) while the
control plane still showed the previous day's state. Audit findings, all
verified against git and the live DB:

| Question | Finding (evidence) |
| --- | --- |
| When did the page/table appear? | `6b061cb` 2026-09-04 (v4 page + 224-row seed), `1a983ed` 2026-09-05 (v5 details), `01b20e0`/`4931a84` 2026-09-10 (clarification store). |
| What writes the table automatically? | **Nothing.** Only two writers exist: the boot seed (`ProjectStatusService.ensureSeeded`, insert-missing-only) and the operator/agent HTTP API (`POST /project-status/item/:id/status|note`). No cron, no commit hook, no deploy step, no test touches it. |
| Is there a status-specific scheduler? | No. `src/project-status/` contains no `@Cron`/interval; Hermes cron jobs (2× `myjob_db_backup.sh`, `myjob_trade_reports.sh`) never write the checklist. |
| Did the DB sync clobber writes? | No. `project_checklist_items` is `SHARED_APPEND_ONLY` (oracle→local), and **nothing calls `DatabaseSyncService.runSync()`** — there is no scheduler or controller for it. Unrelated latent issue, not the cause. (Note: this project has exactly ONE database — Oracle Cloud MySQL — so a "local" target is a fiction anyway; see §6.) |
| Did a re-seed overwrite statuses? | No. Seeding skips rows whose `(grp_order,item_order)` already exist; 36 rows whose DB status differs from the committed seed survived, proving seeding does not touch existing rows. |
| Was the page cached? | No. Server-rendered per request; an authenticated GET immediately reflects DB contents. |
| Was the operator waiting on a clarification? | No. 9 clarification rows, all answered. |
| So why did it lag? | The write depended on **an agent session remembering to call the API**. Sessions on 2026-09-08 (2 rows) and 2026-09-09 (28 rows, last write 11:08 IST) did; the 2026-09-10 sessions did not. `updatedAt` histogram: 2026-09-04 → 190 (seed), 09-08 → 2, 09-09 → 28, 09-10 → 0 before the manual fix. Only 5 notes carried a commit SHA, i.e. evidence discipline was already partial. |

Conclusion: **not a regression in automation — there was never any automation.**
The control plane depended on model memory, which is exactly the reliability bug
to remove.

## 2. The rule

Every meaningful gate/task progression updates the row whose `item` text and
`doneWhen` actually describe it — never a conversational gate number, never a
new row.

- work underway → `in_progress`
- row's own `doneWhen` genuinely satisfied → `done`
- code committed / build green / PR merged → **not** completion
- partial → stay `in_progress`, record the gap
- notes are **appended**, never overwritten
- evidence = test/verification result + commit SHA + endpoint or runtime check (+ gap)
- writes go through the authenticated API, never raw SQL
- after every write, the page must be GET/render-verified

Worked example: a session's "GATE 20" (evidence-labelling integrity) is NOT the
page's `GATE 20` ("SHADOW → MICRO-LIVE"). It belongs to *GATE 12 #5 "Use strict
future-only labels with frozen feature cutoffs"* because that row's `doneWhen` —
"a timestamp/leakage test proves no post-decision feature information entered
the label inputs" — is precisely what the change proved. Rows were chosen by
reading `doneWhen`, not by the number.

## 3. Tools (all additive; no trading/FNF/execution code touched)

| File | Role |
| --- | --- |
| `scripts/gate-status.js` | The only sanctioned writer. Resolves the row by identity (`--find`, prints `doneWhen`, refuses ambiguity, can only UPDATE — never INSERT), refuses `done` without a SHA + verification marker, appends the evidence block, posts to the API, then GETs the page and asserts the row renders with the new status + note. Non-zero exit if any check fails. `--dry-run` to preview. |
| `scripts/gate-close-check.js` | Drift guard. For each recent code commit (`src/`, `scripts/`, `package.json`; default last 15) it asks: is this SHA recorded on a checklist row, and does that row still render? Each commit is classified `synced` / `DRIFT` / `cp-plan` (touches only the control plane itself — this guard, `AGENTS.md`, `docs/`, `package.json` — so it cannot belong to a roadmap row) / `legacy` (documented pre-guard baseline in `docs/gate-close-legacy-baseline.json`, NOT evidence) / `allow`. Only `DRIFT` fails (exit 1); it fails open with a loud warning only when the DB/app is unreachable. |
| `scripts/hooks/pre-push` | Enforcement. Installed via `npm run gate:hooks:install` (`git config core.hooksPath=scripts/hooks`) so a stale control plane blocks a push on any model/session. |
| `scripts/lib/gate-auth.js` | Shared operator auth for both tools: decrypts `portal_users.passwordEnc` (AES-256-CBC under `ENCRYPTION_KEY`) and presents it as `x-operator-password` — the header `ConditionalAuthGuard` accepts on any protected route — so the tools authenticate like a server-to-server caller and never touch `POST /auth/login` (rate limited to 10 attempts / 15 min in `src/main.ts`; a per-run login locks the tooling out of its own control plane). The password is never logged. A `401`/`403`/`429` page read is reported as an auth problem and treated as **fail-open with a loud WARN**, never as evidence drift; a `200` page missing a recorded SHA is real drift. |
| `AGENTS.md` | Model-independent instructions (read by Hermes project-context injection, Claude Code, Codex, OpenCode). |
| `package.json` | `gate:status`, `gate:check`, `gate:hooks:install`. |

## 4. Gate-close checklist (run before reporting anything as complete)

1. `npm run gate:check` — see which recent commits lack recorded evidence.
2. For each, `npm run gate:status -- --find "<item text>" ...` with `in_progress`
   while underway, or `done` only when `doneWhen` is genuinely met.
3. Re-run `npm run gate:check` — must print `IN SYNC`.
4. Confirm the writer's own render verification passed (`SYNCED — row [n] …`).
5. Commit, push (the pre-push hook re-checks), and report the row id + status to
   the operator alongside the commit SHA.

## 5. Escapes, and the honesty requirement

- `--allow <sha>` / `GATE_CLOSE_ALLOW` — deliberate exemption for a docs-only or
  no-gate commit.
- `GATE_CLOSE_SKIP=1` — emergency bypass of the hook; the hook prints that it was
  bypassed, and the bypass must be reported to the operator. Never silent.
- If the app or tunnel is down, the guard fails open (a dead network must not
  block a push) but states that sync is UNVERIFIED. `--strict` makes it fail closed.

## 6. Known open gaps (recorded, not hidden)

- **Single-database rule (operator directive 2026-09-10):** this project always
  uses Oracle Cloud MySQL and there is NO local database. All tooling here
  connects via `MYSQL_*` (`127.0.0.1:3307` = SSH tunnel to Oracle Cloud MySQL).
  Two leftovers still assume a local store and should be cleaned up if ever
  touched: `.env` carries unused `LOCAL_DB_*` keys, and `DatabaseSyncService`
  models an `oracle` vs `local` pair whose `ORACLE_DB_*` vars are unset (so it
  would default to the same MySQL as the app). It is inert — nothing calls
  `runSync()` — and `SHARED_APPEND_ONLY` would only ever insert missing rows, so
  it could never propagate a status/note change. Removed from the critical path;
  not fixed here to avoid touching unrelated code.
- `src/project-status/checklist-v4.seed.json` is not mirrored from the DB, so a
  fresh environment seeds with stale statuses (8 `done` in seed vs 42 in the DB).
  Mirroring was deliberately left out of this change to keep one writer and one
  source of truth; if a rebuild happens, sync the seed then.
- `.hermes/project.json` carries a `current_checkpoint` (sha `ebdaa96`,
  UNFINALISED) that is a second, stale, model-facing state surface. Refreshed in
  this change and included as a gate-close step.

## 2026-09-12 — "/project-status disagrees with the work" audit + control-plane hardening

**Outcome of the audit:** no discrepancy existed. Rows 21, 27, 38, 39 and 159 were `done` in
`project_checklist_items`, and both the origin page (127.0.0.1:3010) and the public route
(cloudflared `berhampore.in` → localhost:3010) rendered the `done` button as the row's ACTIVE
status with the newest `gate-sync` markers. The one app, one database, one page route
(`ProjectStatusPageController` → `ProjectStatusService.grouped()`, no cache, no snapshot, no seed
rendering) all agreed. The false reading came from the *audit* itself using a substring test.

**Three hardenings applied (operator-directed):**

1. `ProjectStatusPageController` now sends `Cache-Control: no-store`. Previously the page had only
   a weak ETag and no cache directive, so a browser could reuse a pre-write copy (bfcache /
   heuristic freshness) and display statuses the database had already superseded.
2. The gate writer's render check asserts the row's **active status button**
   (`scripts/lib/gate-render-verify.js`, `scripts/gate-verify.test.js`, 40 checks). The old check
   was satisfiable without the row being in that status at all: every row renders a button labelled
   `done`, and the writer's own evidence text contains "done by agent", so
   `chunk.includes('>done<')`/`rendered.includes('done')` were true for EVERY row. The verification
   could not fail; now it fails on a pending row whose note says "done", on markup drift, on two
   active buttons, and on an active-but-not-disabled button.
3. `scripts/lib/gate-auth.js` refuses to run when `MYSQL_HOST`/`MYSQL_PORT` are unset instead of
   letting mysql2 default to `localhost:3306`. A MySQL listener DOES exist on this host's
   `127.0.0.1:3306` (it is never a store for this project), so the old fallback could silently
   point a tool at a phantom database — and did, masking itself as `connect ETIMEDOUT` during the
   audit.

**DOCUMENTED RECOMMENDATION — NOT IMPLEMENTED (needs operator approval; no DDL was run):**
`project_checklist_items` has **no unique key on `(grp_order, item_order)`** — only
`PRIMARY(id)` — although `ProjectStatusService.ensureSeeded()`'s own comment claims
`uq_grp_item`. Today the seeder's `exist()` check is the only guard, and the app has been
restart-looped (320+ restarts on 2026-09-12), so two overlapping boots can pass `exist()`
simultaneously and insert duplicate rows for the same `(grp_order, item_order)`. A duplicate
`pending` twin of a `done` row would then render alongside it and make the page look stale — the
exact symptom this audit chased. Verified today: **zero duplicate `(grp_order, item_order)` pairs**
and zero duplicate item texts, so the index can be added without a data repair. Recommended
change (to be scheduled separately, with a backup first):

```sql
-- prerequisite check (read-only)
SELECT grp_order, item_order, COUNT(*) FROM project_checklist_items
 GROUP BY grp_order, item_order HAVING COUNT(*) > 1;
-- then, after operator approval and a verified backup
ALTER TABLE project_checklist_items
  ADD UNIQUE KEY uq_grp_item (grp_order, item_order);
```

Also left as-is deliberately: the `:3306` listener itself, `src/project-status/checklist-v4.seed.json`
still carrying `pending` for every item (it is a seeding template, not a status source), and the
`database-sync` service. None of them were touched by this change.

