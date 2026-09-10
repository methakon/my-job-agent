# AGENTS.md — binding rules for ANY agent/model working in my-job-agent

These rules are not advice. They apply to every model, session and runtime
(Hermes, Claude Code, Codex, OpenCode, cron jobs, humans). If you cannot follow
one, stop and say so explicitly.

## 1. The /project-status control plane must never lag the work

`/project-status` reads MySQL table `project_checklist_items` (page route
`GET /project-status`, writes via `POST /project-status/item/:id/status` and
`/item/:id/note`). **Nothing in the commit, test, build or deploy path writes
that table.** On 2026-09-10 implementation, tests and git were current while the
table sat a day behind — a process failure, not a bug. Do not let it recur.

MANDATORY, on every meaningful task or gate progression:

1. **Resolve the row from its real identity.** Match the row's `item` text and
   read its `doneWhen`. Conversational gate numbers are meaningless here: the
   page's `GATE 20` is "SHADOW → MICRO-LIVE" while a session's "GATE 20" may be
   the evidence-labeling change that actually belongs to *GATE 12 #5 "Use strict
   future-only labels with frozen feature cutoffs."* Never write a session gate
   number into a row, never invent a gate, never insert a row.
2. **While work is underway → `in_progress`.**
3. **Only when the row's own `doneWhen` is actually satisfied → `done`.** A
   commit, a green build or a merged PR is NOT completion. If the row's
   `doneWhen` is only partly met, leave it `in_progress` and record the gap.
4. **Append evidence, never overwrite.** Use the writer below — it appends a
   timestamped block to the existing note and preserves the newest content when
   the 500-char column overflows.
5. **Evidence must be concrete:** test/verification result, commit SHA, the
   endpoint or runtime check performed, and the remaining gap where applicable.
   The writer REFUSES `done` without a SHA plus a verification marker.
6. **Write through the authenticated API, never raw SQL.**
7. **Verify by rendering.** After the write, `GET /project-status` must show the
   row with the new status and note. The writer does this for you and exits
   non-zero if the page does not reflect the write.
8. **Report nothing as complete to the operator until the row is synced and
   independently render-verified.** Say the row id and status when you report.

## 2. Commands

```bash
# move a row (the ONLY sanctioned writer; appends evidence, then render-verifies)
npm run gate:status -- --find "strict future-only labels" --status in_progress \
    --evidence "test: pattern-engine.test.js 10b pass; commit: c98a7b4; runtime: after-hours label verified 22:18 IST" \
    --gap "frozen FEATURE cutoffs on the general ML dataset still open"

npm run gate:status -- --find "<item text>" --status done \
    --evidence "test: <suite> pass; commit: <sha>; verified: <endpoint or render check>"

npm run gate:check          # drift guard: recent code commits vs recorded evidence (+ live render)
npm run gate:hooks:install  # install the pre-push guard so a stale control plane blocks a push
```

Read the full checklist and the incident evidence in
`docs/GATE_CLOSE_STATUS_SYNC.md`. Never bypass with `GATE_CLOSE_SKIP=1` silently.

`npm run gate:check` classifies each recent code commit as `synced`, `DRIFT`,
`cp-plan` (touches **only** the control plane itself: this guard, `AGENTS.md`,
`docs/`, `package.json` — work that cannot belong to a roadmap row), `legacy`
(documented pre-guard baseline, NOT evidence) or `allow` (deliberate exemption).
Only `DRIFT` blocks. Appending new entries to
`docs/gate-close-legacy-baseline.json` to silence real drift is forbidden; sync
the row instead.

Both tools share one cached operator cookie (`scripts/lib/gate-auth.js`) because
`/auth/login` allows only 10 attempts / 15 min. If a page read reports a `401` /
`403` / `429`, that is an auth/limiter problem, not evidence drift: the tools say
so loudly and fail open. Wait out the window; do not loop logins.

## 3. Standing constraints (unchanged)

- **One database, always Oracle Cloud.** Oracle Cloud MySQL is the only store
  for this project; there is no local/development database at all. Every
  connection goes to Oracle Cloud MySQL through the SSH tunnel published as
  `127.0.0.1:3307` (`MYSQL_*` env). Never introduce a second database, never
  treat `LOCAL_DB_*` or a `:3306` target as a real store, and never point code,
  scripts or sync jobs at anything else.
- Historical TradeBook and Hermes Trade History stay separate with provenance.
- No live trading, no order widening, no threshold loosening without explicit
  operator approval; FNF data and funds are never touched.
- No secrets in commits, notes or memory.
