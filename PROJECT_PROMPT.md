# My-Job Agent — Project Prompt & Resume File

**Purpose:** Autonomous job-search agent for Swarna Sekhar Dhar — scouts jobs,
tailors ATS PDF CV per job description, applies directly (JD-stated process →
company ATS → HR email → portal easy-apply last), tracks both-side history,
self-improves from outcomes.

## Resume rule
When the user opens Hermes in this folder (`~/projects/my-job-agent`) and says
**"continue"**, resume in this order (no confirmation loop, no re-asking):
1. **DB to-do log** (`agent_todo_log` table in MySQL `myjob_agent`) — THE operative
   task queue. Columns: `id`, `todo_id` (e.g. T-04, J-09, D-02, I-02), `title`,
   `status`, `detail`, `updated_at`. Statuses: `pending` < `in_progress` <
   `done`; also `pending_user` (blocked awaiting the user) and `blocked`.
   Start the first unfinished row in id order (`in_progress` first, then
   `pending`); `pending_user`/`blocked` are skipped (surface them to the user,
   don't work them). Query it read-only via:
   `cd ~/projects/my-job-agent && set -a && . ./.env && set +a && MYSQL_PWD="$MYSQL_PASSWORD" mysql -h "$MYSQL_HOST" -P "$MYSQL_PORT" -u "$MYSQL_USER" myjob_agent -e "SELECT id,todo_id,status,LEFT(title,80) FROM agent_todo_log ORDER BY id;"`
2. **Project checklist** (`project_checklist_items` table — the Hermes F&O
   v4/v5 validated gates, visible at `/project-status`). As work progresses,
   ALWAYS update each item's `status` (pending/in_progress/done) AND write a
   `note` (what was done, issues hit, how solved) — never leave an item done
   without a note.
3. Then this file's Progress + `docs/TODO.md` for context; start the first
   unfinished item.
On goodbye: update Progress + TODO here, commit on `dev`, `pull --rebase`,
push `origin/dev` — never skip even on interrupt.

## Key docs (source of truth — update BEFORE code when requirements change)
- `docs/REQUIREMENTS.md` — requirements analysis (FR-1…FR-12)
- `docs/PROJECT_DETAILS.md` — architecture, API surface, data model, status
- `docs/TODO.md` — progress tracker with blocked-on-user list

## Quick facts
- Stack: NestJS + TypeORM + MySQL `myjob_agent` (user `myjob_agent`),
  port **3010**, dashboard `/`, Swagger `/docs`
- Repo: github.com/methakon/my-job-agent, branch `dev`
- Run: `npm run build && node dist/main.js`
- Standards: MyLife MVCR, DTOs everywhere, one entity per table,
  conventional commits. Git sync after EVERY completed TODO item.

## Verified working (2026-08-25/26)
- Login/auth-free local service; profile 90% complete from ATS CV import
- Scout: Remotive + RemoteOK + Norway (englishjobs.no) live
- Naukri: login + search + APPLY END-TO-END VERIFIED — 12+ real applications
  auto-submitted via cloudgateway apply-workflow
- Auto-apply loop LIVE (every 6h): leads ≥40% match, max 8/run, 90s pacing,
  kill-switch gates; RetryBackoffService retries failures at 5→10→20→30min
- DEDUPE: never re-applies to same lead or same portal external job id
- Scorer hardened: title veto (designer/QA/sales never match), boilerplate
  stripped, title-hit-or-3-skills rule
- FR-13 HR-email deep investigation (job page → domain → career pages →
  pattern-guess+MX; pattern-guesses usable per user rule)
- Gmail SMTP send verified; IMAP OTP auto-read + recruiter reply polling
- ATS PDF CV builder: tailored per-JD PDF, NO watermark line, Indus Net
  stint corrected (Apr–Aug 2026); cvPath stored per application in MySQL
- LinkedIn-informed keyword tuning built (needs profile snapshot in
  data/linkedin/ — user action)
- FR-15 Browser automation VERIFIED: playwright-core + system Chrome fills
  ATS forms, CV upload, stops before submit unless autoSubmit=true,
  screenshots to generated/browser/
- FR-11 Learning weights LIVE in MySQL: channel/portal/hour stats feed
  GET /learning/stats + bestChannel recommendation
- Daily digest email at DIGEST_HOUR to bapay.9@gmail.com
- Applications history page /applications-page: JD + CV download +
  tracking per application; dashboard Apply button removed from leads
- Side-income module: 5 researched opportunities + page at
  /side-income-dashboard/dashboard
- Monster / foundit India adapter (`MonsterAdapter`) live in Scout and ApplyEngine
- Interview practice bank & page live at `/interview-practice-page` + Dashboard card
- Mail accounts management panel live in dashboard (`/mail/accounts` endpoint integration)
- Dashboard at `/`, Swagger at `/docs`, launcher `./start-agent.sh`
- **Astro muhurta engine LIVE** (`/astro/muhurta?hours=N`): Vedic panchanga
  (astronomy-engine, Lahiri ayanamsa dynamic, aligned with MyLife shared
  ephemeris) — tithi/nakshatra/weekday/moon-house scoring, base 45, threshold
  65, hard vetoes (rahu kala, yamaganda, amavasya, ganda-mula). Multiple shubh
  windows per day; batch-send all approved applications inside windows.
- **Pre-apply review queue LIVE** (`/pre-apply-page`): nothing sends without
  user approval. Pipeline: hourly scout → prepare-only loop builds tailored
  CV + cover letter + email draft → user reviews (approve/hold/pause/upload
  corrected CV) → MuhurtaSendService sweep (10 min) sends ALL approved items
  together inside a shubh window. Verified E2E (prepare→approve→sweep→sent,
  sandboxed).
- **Portal cap 27** (`apply_settings.maxPerPortal`) + **hourly fetch**
  (`SCOUT_INTERVAL_MINUTES=60`) enforced.
- Job astro-match scoring (`/astro/score`): lead↔chart match (Rahu MD
  foreign/tech, Mercury dev/comm, Saturn+Mars backend/senior) with reasons.
- Panchanga engine cross-checked vs published panchang (2026-08-27: Shukla
  Chaturdashi + Dhanishta + Thursday + rahu kaal ~13:59–15:36 — matches
  Hindustan Times, bhaktiras.net, samvat.in, kundligpt).
- A1 Group (jobs.a1.com) investigated: WordPress, REST API live; vacancy list
  client-side via job-listing block — adapter TODO (docs/TODO.md).

## Credentials stored (encrypted AES-256 in mail_accounts table)
- Gmail app-password (bapay.9@gmail.com) — primary sender + OTP reader
- Naukri password (portal:naukri:bapay.9@gmail.com)

## Progress (2026-09-13 00:20) — row 41 DONE (GapRangePos over the prior-day range, GATE 4 #4)

- **Row 41 → done, commit `81a8bea`** (control plane synced + render-verified; pushed, `dev` =
  `81a8bea`, unpushed 0). doneWhen: "The same inputs produce the same result in replay, and edge
  cases return a safe explicit state rather than a fabricated value."
- **Feature** (`src/trading/gap-engine/gap-range-pos.ts`, `gaprangepos-v1`, pure: no clock, no I/O,
  no randomness, no AI), reusing the existing `gap-session-series` adapter — no new adapter. Pinned
  definition, stated in the module header and a spec object: `GapRangePos = (open − prior.low) /
  (prior.high − prior.low)`, a dimensionless ratio in prior-range widths (0 = prior low, 1 = prior
  high, >1 opened ABOVE the prior range, <0 opened below it). Window = the immediately preceding
  session; no lookback, no averaging, no smoothing. It reads only the session open and the prior
  session's high/low, so nothing after the open can move it — proven by mutating every post-open
  field (session close/high/low, next quoted close, prior close).
- **No threshold exists at all**: the single config object is just `{ enabled }`, so the item cannot
  be tuned. Nothing classifies, ranks or optimises (asserted by a code-not-prose scan).
- **Edge cases are safe explicit states, never fabricated values**: closed vocabulary
  `NO_PRIOR_SESSION` / `NO_PRIOR_RANGE` / `ZERO_PRIOR_RANGE` / `IMPOSSIBLE_PRIOR_RANGE` /
  `NO_SESSION_OPEN`, each `status: UNAVAILABLE` with a **null** value, a human detail and a counted
  token. The disabled path computes nothing and reports `DISABLED` per input.
- **Evidence**: `test:gap-range-pos` **94/94** — reversed input ⇒ identical digest AND identical
  observation order; shuffled input ⇒ identical counts/refusals; repeated runs byte-identical; a
  changed open moves the digest; every refusal reachable and counted; no non-OK row ever carries a
  number or NaN. Regressions rows 38/39/40 green (`gap-taxonomy` 80/80, `gap-hypotheses` 78/78,
  `gap-candidates` 63/63). `verify:gap-range-pos` over the real archive: **1,242 sessions,
  OK=1241 / UNAVAILABLE=1** (the first session — `NO_PRIOR_SESSION` by construction), digest
  `f9c234411d770925`.
- **Descriptive finding (reported, NOT tuned):** min −3.353 / median 0.625 / max 4.627; the open sat
  below the prior range in 193 sessions, inside [0..1] in 706, and above it in 342.
- **Build isolation**: build + tests ran in a detached worktree at HEAD with only the new files
  overlaid, so the shared `dist/` and the running PM2 app were untouched.
- **Untouched**: rows 877/878, 20, 22, 23–26, 427, 438, 876; the Job Agent workstream and its
  control plane were not read or written.

## Progress (2026-09-12 12:05) — Redis offload: design corrected + isolation PROVEN + deterministic row id implemented

- **Operator clarification applied (design was wrong)**: `docs/REDIS_HOT_PATH_OFFLOAD.md` §3 previously
  let the desks read prices from a Redis-backed cache — withdrawn. The hot path is now documented as
  purely in-process: `provider → canonical interpreter → validation → engine → signal → risk →
  execution`, with persistence strictly a *side channel* reached by a non-blocking enqueue. Redis read
  models are allowed for observability only, never as an input to signal/risk/execution.
- **Isolation boundary implemented** (research/shadow; nothing in production imports it):
  `src/trading/unified-market-data/tick-fanout.ts` — `ingest(tick, decide)` decides first,
  synchronously, then appends to a bounded in-process ring. No await/promise/timer/clock/IO/AI;
  decisions are never dropped; overflow drops the newest tick for persistence with a counted reason;
  the sink is called only from `drain()` (single-flight) and a batch leaves the queue only after the
  sink resolves, so a failed write stays retryable in order; `drainBounded` reports the remainder.
- **Failure simulation proving separation** (`scripts/tick-fanout.test.js`, 44/44): hung-forever
  writer (10,000 ticks: 10,000 decisions, p99 < 1 ms, ingest < 100 ms, queue pinned at capacity, sink
  never called on the hot path); writer slow at the **measured** MySQL p50 287 ms; writer throwing
  every time (300/300 decisions, no unhandled rejection, batch retained); **EXIT/stop-loss with a hung
  writer AND a full queue fired in < 1 ms** and closed the position on the breaching tick.
  **Separated latency accounting (one run): decision→execution p50 0.0006 ms / p99 0.0048 ms vs
  persistence p50 287.7 ms per 100-row batch ≈ 517,000× separation.**
- **Approved prerequisite #1 — deterministic canonical row id (NO DDL)**:
  `src/trading/unified-market-data/canonical-row-id.ts` (`rowid-v1`) = uuidv5 over
  `source | instrumentKey | sourceTimestamp(ISO) | providerPayloadHash | economic-content hash`,
  written into the EXISTING uuid PK and wired into `ingestQuote` + `ingestSnapshot`. The per-process
  `sequenceNumber` is deliberately excluded (it resets on restart and would defeat replay safety).
  A weak identity returns null → the writer falls back to the generator instead of minting a
  guessable key. Motivation measured: hot tables have a random-uuid PK and non-unique natural keys
  (65% duplicate `(contractSymbol, ts)` in a peak FNF window, 35% unified), so replay would duplicate
  rows today. Tests 37/37 (`npm run test:canonical-row-id`).
- **Regressions**: feed-arbitration + pattern-engine suites pass with the canonical writer change.
  Nothing was rebuilt/redeployed: the running app is unchanged; the id change lands at the next deploy.
- **Control plane**: commit `33a1d07` recorded as evidence on row **878** (canonical interpreter) —
  **in_progress only**; 878's live doneWhen (both desks consuming canonical rows on live payloads)
  remains open. `gate:check` IN SYNC, pushed (`dev` = `33a1d07`).
- **Remaining order (approved)**: Redis implementation → Monday shadow calibration → evidence → only
  then a controlled read-path migration. Redis is NOT installed yet. Staleness contract stays the
  existing `staleQuoteMaxAgeMs`; no execution/risk/capital/threshold/safety-gate change.
- **Roadmap coverage missing (flagged, awaiting operator)**: the Redis market-data-persistence
  workstream has no dedicated row (rows 109/356/388 are latency *modelling*). Rows are operator-created.

## Progress (2026-09-12 11:27) — row 40 DONE (GAP-FADE + FAILED-ORB candidates, GATE 4 #3)

- **Row 40 → done, commit `aebf6e8`** (control plane synced + render-verified; pushed, `dev` =
  `aebf6e8`, unpushed 0). doneWhen: "The component can be enabled/disabled independently and its
  output can be inspected in a historical replay." Row instruction satisfied: a separate, versioned
  module with declared inputs, output schema and missing-data/failure behaviour.
- **Two candidates, never one blended score** (`src/trading/gap-engine/gap-candidates.ts`, `gap-cand-v1`,
  pure: no clock, no I/O, no randomness, no AI): each has its own switch, input contract and refusal
  list.
  - **GAP_FADE** consumes the taxonomy's assessments (gap geometry is never re-derived) and reads
    ONLY pre-open fields, with an explicit look-ahead barrier: target = gap origin (previous close),
    invalidation = session open. The test mutates every post-open field (session close/high/low, fill
    state, and the outcome-derived class) and proves the verdict cannot move.
  - **FAILED_ORB** builds the 15-minute opening range from real intraday observations, then finds the
    first breakout and the first re-entry inside the range. A path that does not cover the 09:15 open
    is REFUSED with its measured lag (`LATE_START`) instead of becoming a mislabelled proxy. (The
    traded price is the `price` column — the row's `close` is the broker's previous close; the
    session's own close never enters.)
- **Thresholds**: structural defaults in ONE documented config (maxGapRatio 1.0, rangeMinutes 15,
  maxStartLagMinutes 5), never tuned against outcomes; the module reports counts and never selects,
  ranks or optimises (asserted, including a code-not-prose scan). Every emittable reason is published
  in `CANDIDATE_REFUSAL_TOKENS` and documented in the candidate spec.
- **Two real defects the tests caught**: ordering by session date alone left same-date inputs in
  caller order, so the report digest depended on input order (canonical order now breaks ties on the
  row's own pre-open identity content); and a propagated taxonomy reason was emitted outside the
  published vocabulary.
- **Evidence**: `test:gap-candidates` 63/63; `verify:gap-candidates` replay — GAP_FADE **767
  candidates over 1,242 sessions** (473 not applicable, 211 too large for a fade, 2 unavailable);
  FAILED_ORB **7 of 9** archived intraday paths (the 2 sessions whose tape begins at 10:55/11:17 IST
  are refused `LATE_START`); digest `e9a54d30e75cbfac`. Regressions: gap-taxonomy 80/80,
  gap-hypotheses 78/78. `scripts/lib/gap-archive.js` gained the shared intraday loader (one SQL).
- **Descriptive finding (reported, NOT tuned):** with ~15 s intraday sampling every evaluated session
  showed a breakout that later re-entered, so FAILED_ORB is 7/7 of evaluated — the definition is
  deliberately permissive and the natural place to sharpen it is GATE 4 items 41–43 (geometry, value
  area, early acceptance/rejection state), not a threshold chosen to flatter results.
- **Untouched**: live-dependent rows (20/22/23–26, 427, 438, 876, 877, 878), all trading/risk/execution
  code, `.env`, capital, and the Job Agent workstream. The gap engine remains research/shadow-only —
  a test asserts no production module imports it.

## Progress (2026-09-12 11:00) — control-plane hardening (audit accepted; NO roadmap status changed)

- **Audit outcome (accepted by the operator):** the reported "/project-status does not reflect rows
  21/27/38/39/159" was **not reproducible**. DB said `done`; the origin page (127.0.0.1:3010) and the
  public route (cloudflared `berhampore.in` → localhost:3010) both rendered the `done` button as the
  row's ACTIVE status with the newest `gate-sync` markers. One app, one DB, one page route
  (`ProjectStatusPageController` → `ProjectStatusService.grouped()`, no cache/snapshot/seed render);
  nginx :80 serves static files only and does not proxy the app; the VM runs only `trading-agent`.
  The false reading came from the audit's own substring test. **No roadmap status was modified.**
- **Three hardenings implemented, tested and verified live:**
  1. `/project-status` now sends `Cache-Control: no-store` (it had only a weak ETag, so a browser
     could display a superseded status from cache/bfcache). Commit `3afe11c`.
  2. The gate writer's render check asserts the row's **ACTIVE status button**
     (`scripts/lib/gate-render-verify.js` + `scripts/gate-verify.test.js`, 40 checks). The old check
     could not fail — every row renders a button labelled `done`, and the evidence text contains
     "done by agent", so `>done<`/`rendered.includes('done')` were true for EVERY row. Commit `d63a6f5`.
  3. `scripts/lib/gate-auth.js` fails immediately when `MYSQL_HOST`/`MYSQL_PORT` are unset instead of
     letting mysql2 default to `localhost:3306` — a MySQL listener DOES exist on this host's
     `127.0.0.1:3306` (never a store here) and the silent fallback masked itself as `ETIMEDOUT`
     during the audit. Commit `d63a6f5`.
- **Guard scope (commit `2fa51c4`):** the exemption mechanism is job-application-only by design (its
  own test enforces that), so the page's no-store change is classified instead by adding ONE src/
  path to `CONTROL_PLANE_PATTERN` — by exact filename (`src/project-status/project-status-page.controller.ts`,
  the control plane's own UI) — deliberately not a wildcard over the module or src/. A new test pins
  that boundary. The out-of-scope exemption entry was reverted (allow-list back to its 7 designed
  job-application SHAs).
- **DEPLOYED:** built HEAD in a detached worktree with the controller overlaid, backed up the old
  `dist` (`/tmp/dist.bak.20260912_105357`), swapped, restarted pm2 `my-job-agent` (online, listening,
  2 nest assets intact). The build also includes the parallel JA session's committed `b185d85`
  (which fixed the earlier crash-loop); it boots and serves.
- **Verification (live, both routes):** origin HTTP 200 `cache-control: no-store`; public
  `cache-control: no-store` + `cf-cache-status: DYNAMIC`. Active-button verifier vs DB on BOTH
  surfaces: rows 21/27/38/39/159 `done`, 22 `in_progress`, 877 `in_progress` — all VERIFIED.
  Negative controls: row 38 asked as `pending` → refused with the exact reason; a non-existent row →
  refused; marker scoping confirmed (row 22 does not carry row 38's marker). Suites: `test:gate-verify`
  40/40, `test:gate-exemptions` 23/23, `gate:check` IN SYNC, writer dry-run OK (nothing written).
  Pushed: `dev` = `9338a52`, unpushed 0.
- **DOCUMENTED RECOMMENDATION — NOT IMPLEMENTED (no DDL):** `project_checklist_items` has no unique
  key on `(grp_order, item_order)` although the seeder's comment claims `uq_grp_item`; overlapping
  boots can duplicate rows and a duplicate `pending` twin beside a `done` row is exactly the
  stale-looking symptom this audit chased. Zero duplicates exist today. The ALTER TABLE is written up
  in `docs/GATE_CLOSE_STATUS_SYNC.md` for a separate, approved change with a backup first.
- Untouched: all roadmap statuses, rows 877/878, trading/risk/execution/feed code, `.env`, capital,
  Job Agent files.

## Progress (2026-09-12 11:35) — row 39 DONE (GAP-FILL + GAP-AND-GO as separate hypotheses, GATE 4 #2)

- **Row 39 → done, commit `5984e64`** (control plane synced + render-verified; pushed, later head
  `602f032`). `src/trading/gap-engine/gap-hypotheses.ts` — pure (no clock, no I/O, no randomness,
  no AI, and NO threshold constant at all, asserted):
  * **GAP_FILL** asserts "a material gap is filled during the session it opened"; realized iff the
    session range reaches the gap ORIGIN (up: low <= prevClose, down: high >= prevClose).
  * **GAP_AND_GO** asserts "a material gap holds and the session continues in the gap direction";
    realized iff the gap is UNFILLED AND the session closes beyond its open in the gap direction.
    It also reports a fixed-geometry excursion measure (entry = session open, risk = the gap,
    reward = the session extreme) labelled DESCRIPTIVE ONLY.
  * The two have INDEPENDENT switches (disabling one leaves the other's outcomes identical —
    asserted); immaterial sessions are NOT_APPLICABLE; anything the taxonomy could not determine is
    UNAVAILABLE with the taxonomy's own reason propagated verbatim. No outcome is ever fabricated.
  * REUSE, NOT DUPLICATION: it consumes the taxonomy's `SessionGapAssessment` rows (direction,
    zone, fillState, measures) and never re-derives gap geometry or touches session bars.
  * `npm run test:gap-hypotheses` **78/78**; row 38's suite still **80/80** (regression).
    `npm run verify:gap-hypotheses` replay over **1,242 archived sessions**: GAP_FILL 975/978
    (99.7%; UP 496/497, DOWN 479/481), GAP_AND_GO 2/978 (0.2%; UP 0/497, DOWN 2/481), overlap
    both 0 / only-FILL 975 / only-GO 2 / neither 1. The disabled path evaluates nothing.
  * Writing the test caught a REAL defect: the report digest depended on the input order of the
    supplied assessments; observations are now emitted date-ordered so the digest is a function of
    the data only.
  * `scripts/lib/gap-archive.js` — the archived-session loader extracted so both replays load
    sessions ONE way (no duplicated SQL). After the extraction, row 38's replay reproduces a
    **byte-identical digest (`aa90d4e2e42217f8`)**, proving the refactor changed nothing.
  * Descriptive finding (reported, NOT acted on): on index daily bars the session range almost
    always revisits the previous close (fill rate 99.7%), which is what starves the unfilled-gap
    classes (BREAKAWAY 1, RUNAWAY 0 in row 38). No threshold was tuned to change that; a
    fade/continue study may later need a deliberate, documented threshold decision.
  * Research/shadow only: no production module imports the gap engine (asserted), no schema,
    service, risk, execution or decision-path change.
- **Parallel JA session:** their commit `b185d85` (JA-010 qualification engine wired into
  `app.module.ts` + apply-engine entry points) resolved the unresolved `QualificationService`
  dependency that had been crash-looping the shared `dist` earlier in the day. It was allow-listed
  as the separate workstream (exemption count tripwire grown to 7 in
  `scripts/gate-exemptions.test.js`, still 22/22). Their code was NOT rebuilt or deployed from this
  session; the running app keeps the earlier clean HEAD build plus the IMAP guard.

## Progress (2026-09-12 11:05) — row 38 DONE (gap taxonomy over a real 1,242-session series, GATE 4 #1)

- **Selection (roadmap re-read first):** GATE 2 has 4 pending rows (23–26) and GATE 3 is complete,
  so GATE 4 (grp_order 5) is next in dependency order. All four GATE 2 rows are DATA-blocked, not
  code-blocked: their doneWhens need pre-open evidence, and the archive holds **zero rows in the
  09:00–09:15 IST window on every recorded day** plus only 3 off-hours `pre_open_observations`
  rows with NULL symbol (the first archived tape row of any session is ~10:55 IST). Nothing was
  marked done on partial/synthetic evidence.
- **Row 38 (GATE 4 #1, "Build taxonomy: common, breakaway, runaway/continuation, exhaustion,
  island and older-gap interaction") → done, commit `e7b8851`.** Two pure modules (no clock, no
  I/O, no AI, no randomness) + a replay:
  * `src/trading/gap-engine/gap-session-series.ts` — adapter. Two MEASURED input facts, both
    verified against independent data: the feed's `close` column is the broker's PREVIOUS close,
    not the session's own (the 2026-09-11 row quotes 23477.80 = the index tape's 2026-09-10
    close exactly; NIFTYBANK 56471.90 vs tape 56471.95), so `close(S)` comes from the NEXT
    session's quote and the newest session is marked INCOMPLETE instead of guessed; and sessions
    are labelled by the broker `ts` (IST) inside the market window, never by `createdAt`, which
    carries over past midnight. The complete bar = widest high-low span (ties: earliest ts, then
    source id) so selection is order-free. Unusable rows are excluded with named reasons.
  * `src/trading/gap-engine/gap-taxonomy.ts` — the component. Pinned precedence ISLAND →
    BREAKAWAY → RUNAWAY_CONTINUATION → EXHAUSTION → COMMON, materiality requiring BOTH the
    percent and the prior-range ratio, ONE definition of fill used everywhere (up: low <=
    prevClose), thresholds in a single config, an explicit enabled/disabled switch whose disabled
    path computes nothing, older-open-gap interaction scanning, a prevClose-vs-prior-row integrity
    measure, and UNAVAILABLE-with-reason for every missing input. Fill TIMING is reported
    UNAVAILABLE because OHLC cannot time a fill — never invented.
  * `npm run test:gap-taxonomy` **80/80**; `npm run verify:gap-taxonomy` replays the ARCHIVE:
    **1,242 real sessions for NSE:NIFTY50-INDEX (2021-09-01 → 2026-09-11)**, 1,240 assessed,
    978 material gaps, prevClose integrity **1240 agree / 0 mismatch**, order-free digest.
    Distribution as found (not tuned): NONE 262, COMMON 428, EXHAUSTION 113, ISLAND 103,
    BREAKAWAY 1, RUNAWAY_CONTINUATION 0, UNCLASSIFIED 333.
  * Writing the test caught a REAL defect: openness and `fillState` briefly used different
    definitions of fill (zone entry vs origin touch); both now use the origin.
  * Not wired into any production module (asserted by a static test) — no service, schema or
    decision-path change; research/shadow only.
- **Findings worth an operator decision (reported, not acted on):** (a) with these thresholds on
  index data, gaps are almost always filled intraday (1,236 of 1,240) so the unfilled-gap classes
  are rare (BREAKAWAY 1, RUNAWAY 0) — the classes are reachable (proven by fixtures) but the
  thresholds may need tuning for a fade/continue study; (b) the daily series is index-level only;
  options/underlyings would need their own series source.

## Progress (2026-09-12 10:20) — row 27 DONE (time-align before inference) + desk app crash-loop repaired + DB backups working again

- **Row 27 (GATE 2 #6, "Time-align all pre-open and cross-market information before
  inference") → done, commit `5949caa`.** New pure module
  `src/trading/pre-open/pre-open-alignment.ts` (`align-v1`): every row declares the basis of
  its OWN time column (IST market wall vs UTC server wall), an undeclared basis is refused
  (BASIS_UNKNOWN) and never assumed, the declared wall becomes ONE absolute instant, session
  window + exchange-calendar gates apply (REFERENCE rows must precede the window AND come from
  a real trading window), nothing at/after the `asOf` cutoff can enter the frame (LOOK_AHEAD
  counted), a row carrying two differently-based columns is cross-checked (gap > 30 min =
  BASIS_MISMATCH — catches an IST value stored in a UTC column), each symbol resolves
  newest-known-at-asOf else UNAVAILABLE with a reason (no interpolation), and count maps are
  canonical so the frame digest depends on the DATA only. `npm run test:alignment` **75/75**
  (basis, refusals, window/calendar, look-ahead, determinism, per-symbol, cross-validation vs
  `scripts/lib/market-session.js`, full replay). `npm run verify:alignment` replays ARCHIVED
  rows: on 2026-09-11 it aligns **412 real rows / 4 index symbols** (400 cross-market + 12
  previous-session references) and refuses the 3 off-hours pre-open rows as CALENDAR_CLOSED.
  The determinism section caught a REAL defect (insertion-ordered count maps made the digest
  order-dependent) — fixed, not worked around. Control plane: row 27 done, render-verified.
- **Honest coverage finding (belongs to rows 20/23-26, not to row 27):** the cross-market tape
  holds **ZERO rows in the 09:00–09:15 IST window on every archived day** — 2026-09-11 market
  window 35,246 rows but pre-open 0 (the VM was off 04:23–10:40 IST), 2026-09-10 market 37,361
  / pre-open 0, and the only `pre_open_observations` rows (3) are the 00:45 IST off-hours
  capture with NULL symbol. The pre-open side of the frame is therefore EMPTY and says so; no
  frame is manufactured. GATE 2's measurement items cannot close without Monday's window.
- **INCIDENT on resume — desk app crash-looping (271→320 restarts, port 3010 dead).** Cause:
  the parallel job-application session's still-unbuilt WIP had been partially built into `dist`
  (its `apply-engine.service.js` emitted at 03:52 while `app.module.js` stayed from my clean
  03:30 build), so the 09:31 restart hit
  `Nest can't resolve dependencies of the ApplyEngineService (... QualificationService at index [18])`
  and looped. **Repair:** clean HEAD build in a detached worktree → swap `dist` → restart;
  app is up, listening, `/project-status` 401 (alive), running HEAD. The JA session's source
  files were NOT touched. (The ImapFlow lines in the old log were pre-existing noise, not this
  cause.)
- **DB backup pipeline diagnosed and repaired (no backup existed since 2026-09-05).** Root
  cause was NOT size: the cron had failed on every run since **2026-09-07** with
  `Permission denied (publickey)` because `myjob_db_backup.sh` used `~/.ssh/id_ed25519`, which
  is NOT in the VM's `authorized_keys` (only `oci-vm-id_ed25519` is); interactive runs worked
  purely because the desktop ssh-agent held the right key, and cron had no agent. Fixed:
  correct key + `IdentitiesOnly=yes`, slot-stable remote names, resumable
  `rsync --partial --append-verify` so a cron timeout resumes instead of re-dumping, verify
  (`gzip -t` + size match) before promoting and deleting the remote copy, single-flight lock.
  A real dump was pulled and verified: **395,238,417 B, gzip OK, 57 tables** (DB is 3.7 GB —
  `fnf_option_quotes_history` 2.2 GB, `unified_option_quotes` 1.05 GB).
- **IMAP crash class fixed (agent queue item 76, separate workstream):** an `ImapFlow` client
  with no `'error'` listener turned the async socket timeout into an unhandled event that
  exited the whole process **62 times between 2026-09-07 and 2026-09-12** (each death took the
  desk routes and the control plane down); `mail_accounts.imapFailureCount` was still 0 because
  the process died before any handler ran. `src/applications/imap-safety.ts` now guards every
  client before `connect()` and holds the ONE backoff/auto-disable rule both services use;
  `npm run test:imap` **57/57** incl. the crash reproduced on a real ImapFlow instance. Commit
  `4ce0ab8` (allow-listed as the separate job-application workstream); the exemption tripwire
  test now lists all five audited SHAs (it had been red since the parallel session grew the
  list without growing the assertion).
- **Desk state:** both feeds STANDBY (market closed) — FYERS_WS note "socket down — awaiting
  credentials/reconnect", UPSTOX_REST `credentialsOk=0`; FYERS token expired 06:00 IST and
  Upstox 03:30 IST, so both need re-issue before Monday. `trading-agent` untouched (holds the
  FYERS socket, 0 restarts). No new ticks since 2026-09-11T14:23Z.
- **Roadmap coverage missing (asking, not inventing):** the IMAP/mail reliability workstream has
  no `project_checklist_items` row (0 matches for IMAP|mail|inbox|reply|credential); it is
  tracked in the agent-side `agent_todo_log` (item 76). Operator decision needed.

## Progress (2026-09-12 03:50) — rows 21 + 22 (GATE 2 OAI) implemented; desk app crash-loop repaired; clean stop

- **Row 21 (GATE 2 #2 — OAI formula) → done, commit `0c33c4d`.** `oai` = (BuyQty − SellQty) /
  (BuyQty + SellQty) is now explicit in `pre-open-features.ts`: formula, units
  (dimensionless, [−1,+1]), window (auction phases only), and edge behaviour (zero total /
  missing side / out-of-phase / stale → UNAVAILABLE with reason + null value, never a
  fabricated number). It is the **SAME `DerivedValue` object as `auctionImbalancePct`** — one
  computation, two names (the test asserts object identity). `PRE_OPEN_FEATURES_VERSION` → `po-v2`;
  the capture service and the ORM column default no longer hard-code a version literal.
  `scripts/pre-open-capture.test.js` gained the `[O]` replay/formula/edges and `[V]`
  single-source-of-truth sections → **100/100** (run in an isolated worktree, see the build note).
- **Row 22 (GATE 2 #3 — store OAI level/slope/acceleration/persistence) → `in_progress`,
  commit `9cb178d`.** New pure module `src/trading/pre-open/pre-open-oai-series.ts`:
  `buildOaiSeries()` writes the block **at capture time** (values as used at decision time, not
  recomputed later) with pinned definitions — level = newest OAI in the auction window; slope =
  (last−first)/elapsedMinutes; acceleration = change of slope across the last two legs ÷ mean leg
  length; persistence = share of non-zero samples agreeing with the newest direction (a neutral 0
  neither agrees nor enters the denominator). Post-cutoff/out-of-window samples are excluded AND
  counted; duplicate timestamps collapse to the last value; input order is irrelevant (replay is
  byte-identical); short series refuse with a reason and a null value — never 0/NaN/Infinity. The
  block carries version `oais-v1`, cutoff, phase, sample counts and reasons. Storage: a new
  additive nullable `derived` json column on `pre_open_observations` (live in the DB; TypeORM
  `synchronize:true`), written via `attachOaiSeries()` in BOTH capture paths before
  `insertIgnore()` (and never blocking the observation on failure); `pre-open.repository.ts`
  gained `seriesAsOf()`; `pre-open.controller.ts` exposes the stored block for audit.
  `scripts/pre-open-oai-series.test.js` (**60/60**, wired into `test:pre-open` = 100/100 + 60/60).
  **Gap (why not done): the row's doneWhen needs a historical record CONTAINING the value — the
  first real block can only be written in the next 09:00–09:15 IST capture window. Code, column
  and storage path are live; the artefact lands Monday.** Deliberately not marked done.
- **INCIDENT + REPAIR (desk app down ~03:21–03:30 IST, 104 restarts).** My earlier `npm run build`
  in the SHARED tree failed on the parallel job-application session's uncommitted
  `src/app.module.ts` (undefined `PreApplyService`/`QualificationService`) yet still EMITTED
  `dist/app.module.js` from that broken source and skipped nest's asset copy → `dist` lost
  `project-status/*.json`. The running process kept serving from memory, so it looked healthy
  until its next restart, then crash-looped: `ReferenceError: PreApplyService is not defined` +
  `MODULE_NOT_FOUND './checklist-v4.seed.json'`. (The `src/*.ts` stack frames were a red herring:
  pm2 runs node with `--enable-source-maps`.) **Repair:** built HEAD cleanly out-of-tree in a
  detached git worktree and swapped that `dist/` in (previous build kept at
  `/tmp/dist.partial.033027`), restarted → app up, listening 3010, stable, running `9cb178d`
  (which also made row 22's code live and materialised the `derived` column). `trading-agent`
  (FYERS socket owner) was NOT restarted. **The JA session's files were not touched, stashed or
  reverted** — they remain modified/uncommitted as they left them. Hazard recorded: while that
  WIP is uncommitted and non-compiling, ANY `npm run build` in the shared tree re-poisons `dist`;
  build from a clean revision (worktree recipe now in the `nestjs-boot-blocker-checklist` skill).
- **Control plane:** rows 21 (done) and 22 (in_progress, render-verified with its gap) synced via
  the sanctioned writer; `gate:check` exit 0 **IN SYNC**; pushed `origin/dev` = `9cb178d`.
- **Clean stop on instruction:** after row 22 no offline-completable roadmap item remains in
  dependency order — the rest of GATE 2 (20, 23, 24, 25, 26, 27) needs live/archived tape, and
  GATE 4+ is downstream new feature work. Rows 20/427/438/876/877/878 were not touched.

## Progress (2026-09-12 01:45) — row 159 DONE (strict future-only labels, frozen feature cutoffs) + Dhargent Option A executed

- **Dhargent Option A (operator-approved, executed read-only everywhere else):**
  `/home/ubuntu/trading-agent/.env` gained `UNIFIED_DUAL_WRITE=false`; then
  `pm2 restart trading-agent --update-env` + `pm2 save` (backup:
  `.env.bak-dualwrite-20260912-012535`). The foreign pre-canonical writer stopped dead:
  **0** `FYERS_LIVE` rows in `unified_option_quotes` / `unified_market_snapshots` after
  19:55:35Z vs 3,136 in the 30 min before. FNF desk writes kept flowing
  (`fnf_option_quotes` fyers: 128 rows / 5 min, newest 19:58Z), the canonical producer and
  both leases were unaffected (NIFTY/BANKNIFTY = FYERS_WS, hb 8-12 s). Revert = delete the
  line + restart. FNF writes, FYERS ownership, tokens, capital, risk and arbitration were
  not touched.
- **Row 159 (GATE 12 #5) → done** — `src/trading/pattern-engine/label-integrity.ts` (new,
  pure): `withFeatureCutoff()` records the newest input the feature vector was allowed to
  read (`features.cutoff.featureCutoffMs`), `validateLabelWrite()` refuses any patch naming
  a feature field or an unknown field (fail closed) and any horizon without coverage
  provenance, `splitFeatureInputs()`/`leakedFeatureInputs()` name post-cutoff ticks,
  `headlineLabel()` only ever promotes a COVERED horizon. The engine's label writer is now
  a single choke point (`writeLabel()`), and the stored label envelope echoes the row's
  frozen cutoff. `scripts/label-integrity.test.js` (**60/60**, `npm run test:labels`) is the
  timestamp/leakage proof, including a static scan that no `signals.update()` inline patch
  names a frozen field. Runtime check: 508 rows all keep their features, all 54 labelled
  rows still carry the original vector.
- Existing suites green (`test:pattern`, `test:desks`, `test:labels`); app rebuilt +
  restarted (listening 3010, no new errors, arbitration unchanged).

## Progress (2026-09-11 21:30) — canonical interpreter is the MANDATORY production pipeline (mode removed) + roadmap row 878 + live Upstox proof

**Operator decisions (2026-09-11)**
- Create exactly ONE new roadmap row for the canonical tick-interpreter workstream — done: **GATE 0 #11, id 878, `in_progress`, render-verified**. No separate rows for Zerodha, provider mappings, validation, persistence, latency or individual adapters; **row 877 untouched**.
- **Correction: `TICK_INTERPRETER_MODE` is not required — the canonical interpreter is permanently ON and mandatory. Remove the mode-switch concept from the design.** The pipeline must always be `provider raw payload → provider adapter → deterministic canonical interpreter → validation → canonical persistence → desk/engine consumption`. Shadow observation may remain only as an internal diagnostic/measurement facility with zero production effect; it must not be a prerequisite or an alternate operating mode. Invalid canonical ticks must be rejected rather than passed through to broker-specific desk logic.
- Raw-payload archival: **DEFER** — no raw-payload column, no extra storage/write volume; the existing hash/source/broker provenance is kept.
- Next session: run the live real-payload verification first — inspect canonical identity, timestamp semantics, rejection codes/rates, provenance and latency for FYERS and Upstox — then prove canonical persistence and canonical desk reads are actually active. There is no mode to flip any more, and the row's `doneWhen` no longer mentions one.
- Keep all existing trading, risk, capital, provider arbitration, paper accounting and instrument configuration unchanged; do not mark either roadmap item done from offline tests alone.

**Implementation (`018f424`)**
- `TickInterpreterService` has **no mode**: `InterpreterMode`, `currentMode` and `TICK_INTERPRETER_MODE` are deleted, and the transitional `UNIFIED_DUAL_WRITE` / `UPSTOX_LIVE_DUAL_WRITE` mirror switches are gone with them (both defaulted ON, so production behaviour is unchanged by their removal). `interpret()` stays pure; `interpretAndPersist()` and the envelope-aware `ingestMessage()` (bounded, never throws) persist EVERY validated tick. The producer's own gate (`allowPublish`) withholds without persisting — arbitration ownership plus the existing per-instrument snapshot throttle — and is counted as `withheld`, not as a rejection. Provider control/ack records ("socket is disconnected", subscribe acks) are `ignored`: not tick data, not persisted, not counted as invalid.
- Both live adapters now write the common store ONLY through the interpreter: FYERS `onMessage()`, the Upstox chain leg and the Upstox index row. The broker-specific `unified.ingestQuote`/`ingestSnapshot` calls are deleted, so store write volume is unchanged (one write per tick, same throttle) and there is no broker-specific fallback to route rejects into.
- Provider mappers may use an adapter-supplied **identity hint** for fields the record is silent about (the contract key a chain row was requested for, the envelope's expiry/strike/right — all from the same provider response). A value present in the payload always wins; a record with no identity anywhere is refused, never invented.
- `UnifiedMarketDataService.sharedQuote()` resolves a canonical row from a caller's own broker key form (`NSE_FO|…`) as well as the canonical key, so a standby desk still consumes a canonically written row.
- Coverage: `npm run test:canonical-ticks` **11/11** — the mandatory-pipeline checks are new (no mode flag anywhere in `src`, no shadow-only call sites, no common-store writes outside the interpreter, no dual-write switch, withheld ≠ rejection, control records ignored, malformed tick still rejected, identity-hint rules, canonical index row, canonical desk reads, numeric-token resolution, cross-broker identity convergence, zero-book-side semantics) on top of the schema/identity/timestamp/rejection/determinism/provenance/latency/persistence checks. Regressions green: desks, trading, lease-connection 6/6, db-pool 5/5, feed-beat 6/6, gate-exemptions 22/22, entry-policy 89/0.
- Deployed: both pm2 processes restarted cleanly; the agent re-registered `FYERS_WS priority=0 universes=BANKNIFTY,NIFTY` and reconnected its socket; the app seeded row 878.

**Live verification the same evening (`42df4cc`, market closed but the Upstox desk still polls real chains)**
- Feeding real Upstox chain payloads through the mandatory pipeline immediately exposed three defects the offline suite could not, all fixed and re-verified live:
  1. **Real v2 option-chain legs key by a NUMERIC token** (`BSE_FO|862843`) — identity-less, so the interpreter refused all 126 records (`SCHEMA`). The Upstox adapter now resolves tokens from the broker's OWN contract master (`/v2/option/contract`, `instrument_key → trading_symbol`), the deterministic source the mapper contract already allowed; an unresolved token is still refused, never guessed.
  2. **Brokers spell the same contract differently** (Upstox `SENSEX73900CE17SEP26` vs FYERS `SENSEX17SEP73900CE`), so a key taken from the provider's symbol text was NOT comparable across providers — the whole point of the layer. The canonical option key is now REBUILT from the contract's own fields (`exchange + underlying + DD + MON + strike + CE|PE`, `canonicalOptionSymbol()`), the symbol-parsed underlying wins for options, and the alternate symbol order (strike + right + date) is parsed and detected as an OPTION, so identity does not depend on an adapter hint.
  3. **Upstox publishes 0 for a book side with no quote** (27 live `IMPOSSIBLE_VALUE` rejections). A zero bid/ask/qty is now carried as ABSENT (provider semantics); a zero last price is still rejected.
  - Also fixed: the `/market-data/*` JSON APIs were **unreachable** — the SPA fallback (`AppFallbackController`) answered them with the login shell at HTTP 200, so no scripted check could ever see them. `/market-data/` is now delegated, and the diagnostic read-outs exist: `GET /market-data/canonical` (app process) and a periodic `[CANONICAL]` log line in the socket owner (which runs no HTTP server) — read with `npm run market-data:canonical`.
  - `sharedQuote()` also matches a contract by fields (underlying/expiry/strike/right), so a desk finds a canonical row whose symbol its own broker spells differently.
- **Live result after deploy (app process, real Upstox payloads): accepted 590, persisted 546, rejected 0** (was 126 SCHEMA + 27 IMPOSSIBLE), last sample `UPSTOX_LIVE:BSE:SENSEX17SEP75800PE`; store holds 4,133 canonical quote rows and 161 snapshots in a 15-minute window with CONVERGED keys (`BSE:SENSEX17SEP74900CE`) and the desk universe label on `underlying` — **canonical persistence and canonical identity are now proven on live Upstox data**; the FYERS side and both desks CONSUMING canonical rows still need the market session.
- FYERS keeps replaying its last session ticks after hours; the pipeline rejects them `STALE` ("QUOTE tick is 18403s old (> 60s budget)") and so writes nothing post-close — correct behaviour (no stale pre-session contamination), and the reason the store stays quiet on the FYERS side until the next session.
- **Measurement trap confirmed again**: the Oracle Cloud MySQL server clock runs ~5 h 30 m behind real UTC (`NOW()`/`UTC_TIMESTAMP()`), while `createdAt` is written by the client in real UTC. A `createdAt > NOW() - INTERVAL 15 MINUTE` window therefore spans ~5.5 h and overstates counts by ~20× (198,720 vs the true 4,133). Always window client-written timestamps on a CLIENT-computed cutoff.
- **Watch items for the next session**: (a) a quiet option contract's `exch_feed_time` may in practice be that contract's LAST TRADE time — if the FYERS-side rejection rate is dominated by `STALE`, inspect the QUOTE vs LAST_TRADE classification and the 60 s QUOTE budget (`TICK_MAX_QUOTE_LAG_MS`) with the operator, never by silently loosening a gate; (b) prove both desks consume the canonical rows (a standby desk's shared-store read); (c) confirm the FYERS canonical path yields the same converged identities as Upstox for a shared contract.

## Progress (2026-09-11 19:00) — arbitration lease isolated onto its own connection + deterministic canonical tick interpreter

**Authorised option (b) — lease/heartbeat on a dedicated MySQL connection (`c2d369a`)**
- Operator scope honoured exactly: one dedicated connection for the arbitration control path only; application pool size untouched (10 / 4); market-data writes untouched; no MySQL `PROCESS` grant; the 8 s `FEED_DB_TIMEOUT_MS` bound kept; heartbeat-before-lease-read kept; TTL rules unchanged (a lease that cannot be renewed ages out — no stale ownership, no invented candidate); ownership/priority/failover/failback policy untouched; roadmap row unchanged.
- `src/trading/unified-market-data/lease-connection.store.ts` (new): `DedicatedLeaseStore` opens ONE lazily-created mysql2 connection (same `.env`/DB, keepalive from `mysqlKeepAliveOptions()`, bounded `FEED_LEASE_CONNECT_TIMEOUT_MS` default 15 s), serving only `find()`/`upsert()` with parameterised SQL (`feedName` PK ⇒ ON DUPLICATE KEY UPDATE renews the feed's own row; JS Dates bound exactly as before). `recycle()` destroys that connection after ANY failed/timed-out lease op so a wedged socket is never reused and the retry reconnects. `FeedArbitrationService` now injects `LEASE_STORE` and keeps every rule identical.
- Verified: `npm run test:lease-connection` **6/6** (one reused dedicated connection; hung write bounded + NOT delivered + cannot renew a lease; failed read bounded + fails OPEN + no invented candidate; recovery after a dead socket AND after a failed connect; stale lease loses its universe by TTL and a fresh one takes it back — exactly one owner; bounded connect against a black-hole peer). Regressions green: feed-beat 6/6, db-pool 5/5, desks, trading, entry-policy 89/0, gate-exemptions 22/22.
- **Live proof (the defect this fixes)**: after deploy, `FYERS_WS` heartbeat renews every 15 s (sampled 26 s → 21 s → 17 s ago) where it had been frozen for 647 s; the agent now holds 3 sockets to :3307 (pool reaped to 2 idle + 1 dedicated) and the app 8. `UPDATE`ed row host/pid = current agent pid.
- Baseline gate: the "fresh FYERS heartbeat/lease" element is now PROVEN; "FYERS owns NIFTY / is actually publishing NIFTY / Upstox standby" could NOT be shown because the market had already closed (15:30 IST) before the deploy, so the bounded 100 s outage → failover → recovery → controlled failback demo stays deferred to the next session, exactly as instructed.

**Canonical LIVE tick interpreter (`9bfcbd3`, new operator instruction, implemented + deployed in shadow mode)**
- `src/trading/unified-market-data/canonical/`: `canonical-tick.ts` (one canonical schema + pure interpretation/validation: one identity per provider symbol form, timestamp semantics preserved, rejection codes for missing identity / incomplete option contracts / non-positive prices / negative qty-OI / crossed books / unparseable-or-future timestamps / past-the-lag-budget, and NOTHING defaulted — absent stays null), `provider-mappers.ts` (the only place broker field names, symbol forms, envelopes and timestamp units live: FYERS SymbolUpdate with `d`/`data` wrappers, lite `v` nesting, epoch-second `exch_feed_time`; Upstox v3 quotes + option-chain legs with nested `market_data`; Kite ticks whose numeric token must resolve from the instrument master or be rejected), `tick-interpreter.service.ts` (pure `interpret()`, shadow `observe()`, `interpretAndPersist()`; latency p50/p95/max + budget flag; rejection metrics by code/source; `canonicalToTickInput` / `canonicalFromStoredQuote` so desks read ONE canonical shape with no broker-specific logic).
- Deterministic and AI-free by construction; provenance preserved (source, broker's own id/token, payload hash, raw payload) and persisted through the existing common store.
- Coverage: `npm run test:canonical-ticks` **9/9** — identical canonical schema/identity across FYERS/Upstox/Zerodha; symbol, timestamp and envelope normalization; every rejection code; no fabrication; determinism + provenance; latency measured/flagged/aggregated; persistence + canonical read-back; real SDK wrapper and nested chain-leg payloads. Offline (fake repositories, no DB).
- SUPERSEDED by the operator's correction the same evening: the interpreter was first deployed behind `TICK_INTERPRETER_MODE=shadow`, and the operator then removed the mode concept entirely — the interpreter is permanently ON and mandatory (see the 21:15 entry above and `018f424`). `observe()` no longer exists; both adapters call the canonical ingest path.

**Outstanding / decisions needed**
- Next session (market hours): prove the clean baseline, run the bounded outage → failover → recover → controlled-failback demo (row 877's `doneWhen`), and separately verify the canonical pipeline on real payloads — identity, timestamp semantics, rejection codes/rates, provenance, latency, canonical persistence active and BOTH desks consuming canonical (row 878's `doneWhen`).
- **Roadmap coverage**: resolved by the operator — ONE new row created for the canonical-interpreter workstream (**GATE 0 #11, id 878**), no rows for its parts. Row **877** unchanged.
- Raw-payload archival: **deferred by the operator** — no new column, no extra write volume; the raw payload stays in the interpreter result and its hash/id travel in the stored `depth` payload.
- Row **877** and row **878** both stay `in_progress` (evidence + gap synced, render-verified); FYERS token still expires 06:00 IST daily.

## Progress (2026-09-11 13:40) — authorised MySQL pool reliability fix (implemented, verified, deployed) + lease-liveness baseline still failing

- **Authorised scope (operator, verbatim intent)**: keepalive/idle-reaping so stale or black-holed pooled sockets are detected and replaced, using the existing client/pool mechanism; keep the 8 s lease bound; do NOT raise `FEED_DB_TIMEOUT_MS`; do NOT increase pool size; no trading/risk/capital/arbitration/instrument changes; no manual session kills; add focused regression coverage; keep it under row 877 and do not mark the row done from tests alone; run the outage demo **only after a healthy baseline**.
- **Implementation (`658cbef`)** — one shared helper `mysqlPoolTuning()` in `src/shared/db.config.ts` with mysql2's OWN options (nothing invented, verified in `node_modules/mysql2`): `enableKeepAlive: true`, `keepAliveInitialDelay: 10_000` (applied by `lib/base/connection.js` → `stream.setKeepAlive`), `maxIdle: 2` + `idleTimeout: 30_000` (arm `lib/base/pool.js` → `_removeIdleTimeoutConnections`, which only runs when `maxIdle < connectionLimit`). Wired through TypeORM `extra` for the runtime config (both processes) and the CLI `DataSource`, and spread into the session-store pool via a new exported `sessionStorePoolOptions()`. `connectionLimit` (10 / 4) untouched; query semantics, risk gates, capital, sizing, arbiter ownership and instruments untouched; `FEED_DB_TIMEOUT_MS` stayed at 8 s.
- **Coverage + verification**: `scripts/db-pool-reliability.test.js` (**5/5**, `npm run test:db-pool`) proves the tuning reaches mysql2's real pool config and arms the reaper, the reaper is OFF without it, a black-holed pooled connection is discarded and replaced (never reused; keepalive observed on the socket with `(true, 10000)`), and provider liveness cannot freeze behind a dead connection (heartbeat keeps advancing across poll cycles; the lease write still lands). Live check against Oracle Cloud MySQL: `SELECT 1` 787 ms, config as intended, idle socket **reaped after 30 s** (`all=0 free=0`) and the next query opened a fresh connection in 523 ms. Existing suites re-run green: `test:desks` (feed-arbitration, fnf-shared-quote-fallback 11/11, pattern-engine, upstox desks), `test:feed-beat` 6/6, `test:trading` (all 7 suites), `test:entry-policy` 89/0, `test:gate-exemptions` 22/22. Both pm2 processes restarted with the fix at 13:31 IST.
- **Baseline gate NOT met → outage demo NOT run.** After a clean restart the agent's `FYERS_WS` lease wrote once (13:32:42) and then froze; its lease read times out at the 8 s bound every poll (13:32:07, 13:37:07 … one line per 5-min throttle window), while `UPSTOX_REST` (app) advances every 6-28 s. The app's arbiter also shows occasional 8 s lease-write timeouts (13:19:16, 13:24:17, 13:29:17).
- **Cause narrowed by evidence (read-only)**: DB healthy (independent `SELECT 1` 167-280 ms; `Threads_running` 5; `Innodb_row_lock_current_waits` 0; `Table_locks_waited` 0), so NOT the DB or a lock; the exact compiled code path is fast in a fresh process (`FeedArbitrationService` + real DataSource: `find()` 200-283 ms, `decisions()` 202 ms, `beat()` 391-562 ms, probe row `DIAG_PROBE` created and deleted, real rows untouched), so NOT the code/config/table; the agent's own quote inserts keep landing (~47 rows/s, `createdAt` fresh, 32 contracts), so NOT a dead or fully saturated pool. Note for future measurement: `ts` columns hold **IST wall-clock** while `createdAt` holds UTC — a `ts > NOW() - INTERVAL n` filter over-counts wildly (looked like 3 800 rows/s; the true insert rate is ~48/s), so always measure market-data write rate by `createdAt`.
- **Second, separate defect class evidenced (same incident, needs its own decision)**: during the tunnel outage the agent's mysql2 pool ended up **closed and never recovered in-process** — `Pool is closed.` (thrown at `mysql2/lib/base/pool.js`) killed option-quote, snapshot AND lease writes at 12:58:52 while the process stayed up and kept holding the FYERS socket: a live process with zero persistence. Only a pm2 restart recovered it.
- No route is a self-service fix under the current authorisation: the remaining candidates are (a) MySQL `PROCESS` privilege to inspect live sessions/transactions, (b) a reserved/dedicated connection for arbiter lease ops, (c) in-process pool recovery on closed/fatal state, (d) reducing/batching the agent's write load. Awaiting operator decision; the demo is ready to run the moment the baseline gate passes. Row **877 stays `in_progress`** (evidence + gap appended, render-verified 6/6).

## Progress (2026-09-11 late) — one common live feed for both desks + FYERS lease-liveness incident

**Shipped (pushed to `dev`)**
- `9a7056c` — one common live feed for both paper desks. The FYERS producer now
  participates in the single-active-feed arbiter (`FYERS_WS`, priority 0, OPTION
  coverage only, DB lease every 15 s, publishes only the universes it is awarded), and
  the FNF chain read falls back to the common normalized store when its own broker
  store has nothing fresh (`FNO_SHARED_QUOTE_FALLBACK`; provenance preserved, fresher
  row wins, history reads untouched, kill switch honoured). 11/11 checks in
  `scripts/fnf-shared-quote-fallback.test.js`.
- `a81fae3` — NIFTY becomes a two-producer universe. `UPSTOX_LIVE_UNIVERSE_MAP` (opt-in
  alias) maps the broker key `NSE_INDEX|Nifty 50` to the universe `NIFTY`, because the
  derived label is `NIFTY50` while option contract symbols derive `NIFTY` — without the
  alias the two feeds never overlapped and failover could not be exercised at all.
  `UPSTOX_LIVE_INSTRUMENTS` gained NIFTY as the SECOND key, so the desk's tradable
  universe (`underlyings[0]`) stays SENSEX: feed coverage only, no new entry surface.
- `cb17e41` — the single roadmap row for this workstream: GATE 0 item 10 (row **877**),
  `in_progress`, deliberately NOT marked done while its doneWhen is unmet.
- `30e6c50` — provider-liveness fix (operator-authorised): heartbeat published FIRST
  from local truth, award refresh after; `withTimeout` (`FEED_DB_TIMEOUT_MS`, 8 s)
  bounds one lease read/write; a timed-out operation is never counted as delivered and
  cannot create or preserve ownership; `scripts/feed-beat-liveness.test.js` 6/6
  including the hung-read regression. `npm run test:feed-beat`.

**Bounded outage demo (100 s, market hours) — failover PROVEN, failback OPEN**
- With FYERS stopped: the arbiter handed NIFTY to `UPSTOX_REST` (lease
  `ACTIVE [NIFTY,SENSEX]`, `FYERS_WS` stale/`[]`), and the standby really served it —
  `unified_option_quotes [UPSTOX] underlying=NIFTY50`, 42 instruments, ~4 s old, and the
  app logged `option chain: 84 quotes persisted from 2 underlying(s)` (was 42 / 1).
- On restore the agent reconnected (`connected; subscribing to 35 symbol(s)`), FYERS
  NIFTY ticks were fresh within seconds, and the agent's own decision state reclaimed
  NIFTY — but the cross-process lease heartbeat froze, so the app never observed the
  reclaim and UPSTOX still holds NIFTY. **Controlled failback NOT demonstrated**, and
  producer-level single-owner for NIFTY is currently violated (two producers, distinct
  instrument keys). Engine-level integrity holds: each desk reads its own store and the
  common-store fallback never engaged (its own store stayed fresh).

**Open (recorded as row 877's gap)** — the agent's lease read/write times out (the bound
fires in production: `lease read failed (timed out after 8000ms (lease read))`) while its
quote writes succeed and the DB itself is healthy (`SELECT 1` 558 ms; 32 sessions, 31
idle, no long-running query, no metadata-lock wait; `innodb_trx`/`data_locks` unreadable
— no PROCESS grant). Pool saturation from un-cancelled `Promise.race` timeouts was
investigated and REFUTED. Root cause unidentified; no further code/config changes made.

**Infrastructure** — the OCI SSH path failed ~11:44 IST (TCP/22 accepted, no SSH banner:
`TCP_REACHABLE_BANNER_UNAVAILABLE`), which killed the DB tunnel and crash-looped the app
(54 restarts) and starved the agent. Recovery is outside the application; when the banner
returned the tunnel was rebuilt with the identical configuration, `SELECT 1` was proven
BEFORE restarting anything, both processes were restarted, port 3010 is back and the
app's restart counter is frozen (no crash-loop). The FYERS socket owner is unchanged:
the headless `trading-agent`, with the app making zero connect attempts.

## Progress (2026-09-11) — Upstox LIVE token self-service (FYERS parity) + committed drift-guard exemption source

- **Upstox token acquisition is now self-service** (`f4b1de9`): `/api/upstox/token/init` builds the documented dialog `https://api.upstox.com/v2/login/authorization/dialog` (the old `apps.upstox.com/...` host does not resolve; probed live → 302 to `login.upstox.com`); `/api/upstox/callback` is no longer a stub — it validates a single-use 5-minute state and performs the real server-side exchange (`POST /v2/login/authorization/token`, form-encoded: client_id + client_secret + redirect_uri + grant_type=authorization_code), takes the expiry from the token's own `exp` claim and REFUSES to store a token of unknown lifetime. The callback is public by design and guarded by the state instead (Upstox cannot send `x-operator-password` — that is exactly why token delivery never reached us before); the sanctioned notifier intake stays as the scripted fallback. `/upstox-live-paper.html` gained a status/expiry/remaining-time card with a GET THE TOKEN button and a result banner; the raw token is never returned or logged. Tests: `scripts/upstox-token-oauth.test.js` 16/0 (`npm run test:upstox-token`), `pre-open-capture.test.js` 71/0, live verification 15/15 against the running app (pm2 `my-job-agent`, 3010).
- **New roadmap row (operator-approved, standalone)**: group `UPSTOX AUTO TRADING` item 1 = "Portal-native Upstox LIVE access-token acquisition", appended to `src/project-status/checklist-v4.seed.json` (seed row #225, the other 224 rows byte-identical) → runtime row id **876**, status **in_progress**, evidence + gap recorded through `npm run gate:status` and render-verified on `/project-status`. Outstanding doneWhen: the first real operator authorize click (not self-verifiable). Token expires 03:30 IST daily; user supplies a fresh one in the console (2026-09-11).
- **Drift-guard governance — a committed exemption source** (`3d5010f`, `5e7e047`): `--allow` / `GATE_CLOSE_ALLOW` only ever applied to the one invocation that passed it, so a push could never honour an exemption (the guard runs from `scripts/hooks/pre-push`; the repo sets `core.hooksPath=scripts/hooks`). Added `docs/gate-close-allow.json` — exact full SHAs, each REQUIRING reason + workstream + authority, unauditable entries ignored — loaded into the SAME allow set by `scripts/lib/gate-exemptions.js`; the guard classifies via `classifyCommit()` and prints the exemption's reason. Narrow by construction: exact SHAs only, no globs/paths/ranges, a recorded row still wins over an exemption, and an end-to-end probe (planted, unlisted `src/` commit) still returns DRIFT. The control-plane pattern now covers the `gate-*` family including their `.test` variants only. Tests `scripts/gate-exemptions.test.js` 22/0 (`npm run test:gate-exemptions`); `gate:check` → IN SYNC.
- **Exemption recorded for `d80e0ba`** ("add separate JA control-plane page"): legitimate, separate Job Application workstream, tracked in its own `job_application_roadmap_items` table (40 rows) — NOT trading roadmap coverage. Cleared with that single narrow allow-list entry; no trading row invented, no trading roadmap row altered, the 40 JA rows left untouched, JA control plane stays authoritative for that workstream.
- **Operational state**: `gate2-preopen-window-capture` (792771ea078c) is armed for 2026-09-11 08:57 IST (window 09:00–09:15, read-only, no fabrication, no look-ahead); it needs a live token by then or it reports the token gap honestly. `var/pre-open-window/` holds only `-SELFTEST` artefacts so far. Pushed to origin/dev; HEAD `5e7e047`.
- **Fresh token supplied + verified (2026-09-11 04:04 IST)**: the operator pasted a LIVE Upstox token in the console; it was ingested through the sanctioned notifier route (`scripts/upstox-token-intake.js`, stdin — never raw SQL, never written to disk, never logged) and the row went `TOKEN_VALID` with `expiresAt` 2026-09-12 03:30 IST. Independently verified read-only: Upstox `/v2/user/profile` HTTP 200 (token accepted), `/v3/market-quote/quotes` HTTP 200 (Nifty 50 last_price 23477.8, prev_close present; the four `indicative_*` auction fields `null` outside the window — recorded as such, never fabricated), and the app's own `/upstox-live-paper/status` → `auth.status=TOKEN_VALID`, `expiryWithinMinutes` 1406, feed `UPSTOX_LIVE` paperOnly. Row 876 stays `in_progress`: the self-service OAuth click is still unproven. The 09:00–09:15 IST capture window is now unblocked.
- **GATE 2 slice-1 capture readiness verified + armed (2026-09-11 04:12 IST)**: the auction window (08:59–09:21 IST default) had not opened yet, so the harness was NOT run early — it refuses to run late/outside by design, and a capture taken now would be exactly the look-ahead the slice forbids. Instead the readiness was proven: `--plumbing-check` ok (node v26.7.0, buildDir present, DB target 127.0.0.1:3307/myjob_agent) and a `--dry-run` of the shipped path (fetches, persists NOTHING) authenticated with the fresh token and showed the broker payload DOES carry the auction keys (`indicative_equilibrium_price`, `indicative_equilibrium_quantity`, `indicative_imbalance_quantity_total`, `indicative_imbalance_quantity_market`, `total_buy_quantity`, `total_sell_quantity`, `reference_price`, `prev_close_price`) with every value NULL/ABSENT outside the window; safety asserts held (no desk module loaded, no @nestjs/schedule, no HTTP listener, prevCloseFromStore=false). The store already holds 3 rows for 2026-09-11 from the in-process test suite (outside the window) — treated as noise, not window evidence.
- **Armed for the real window**: `gate2-preopen-window-capture` (792771ea078c, 08:57 IST, `--wait --from=08:59 --to=09:21`) now runs with a live token (exp 2026-09-12 03:30 IST); NEW `gate2-preopen-evidence-review` (023aa89a1b18, 09:30 IST) reads the evidence, quotes the real publication matrix, updates ONLY the Gate 2 rows whose own doneWhen is genuinely satisfied through `npm run gate:status`, requires `gate:check` IN SYNC, commits/pushes only if a tracked file actually changed, and reports. Honest expectation recorded: GATE 2 item 1 (capture pre-open buy/sell quantity) is the only one slice 1 can plausibly close; item 5 (indicative equilibrium + relationship to the eventual open) is partial at best; items 2/3/4/6/7/8 are later slices. No Gate 2 row was touched and nothing was fabricated.
- **GATE 2 slice-1 window MISSED on 2026-09-11 (host was down, harness correctly refused a late run)**: systemd stopped `hermes-gateway.service` at 04:23:54 IST (the previous gateway life exited uncleanly — lifecycle ledger, last heartbeat 04:23 IST) and started it again at 10:40:33 IST, so the 08:57 capture job fired only as a catch-up at 10:42:38 and the harness refused it (`window already over (08:59–09:21 IST); refusing to run late`) exactly as designed — no fabricated window, no look-ahead. Result: ZERO window observations for the day (`pre_open_observations` holds only the 3 test artefacts — BSE_INDEX|SENSEX, phase CLOSED, quality UNAVAILABLE, ~00:45 IST). No Gate 2 row was touched, because no row's doneWhen was satisfied. No Hermes defect to fix: the unit is `enabled`, `Restart=always`, `Linger=yes` — the machine simply has to be powered on at 08:57 IST on a trading day.
- **Next window re-armed — Tue 2026-09-15** (Sat/Sun closed; Mon 2026-09-14 is Ganesh Chaturthi): one-shot `gate2-preopen-capture-20260915` (fb2b3340dcc2, 08:57 IST, same read-only harness) plus `gate2-preopen-review-20260915` (a20aa715de88, 09:30 IST, updates only genuinely-satisfied Gate 2 rows, requires `gate:check` IN SYNC). Preconditions for Tuesday: the machine powered on before 08:55 IST and a fresh Upstox token after 03:30 IST (tokens die daily — console paste via `scripts/upstox-token-intake.js`, or the desk's GET THE TOKEN click).

- **upstox-live-paper module** (src/trading/upstox-live-paper/, from the 2026-09-09 session; ~26 files, self-contained: auth/token OAuth intake, market service, paper execution, scheduled weekly report, entities, UI at /upstox-live-paper) is now REGISTERED and BOOTING on the production dist. App green: "Nest application successfully started", port 3010, dashboard 200, /project-status 401 gate intact. TinyFish removal (prior) stays: no TinyFishAdapter anywhere.
- **Boot-fix arc (2026-09-10)**: seed json asset config added (nest-cli.json; nest build never copied checklist-v4.seed.json → crash loop), EncryptionService + WeeklyReportService providers registered, explicit column types on 13 `X | null` columns (TS design:type Object) + 3 bare precision/scale columns, duplicate upstox controllers removed from AppModule controllers (root cause of "available in AppModule context" DI failures), weekly-report @Cron fixed to 6-field `0 30 18 * * 1-5`, accessTokenEncrypted made nullable (TOKEN_MISSING seed rows carry none).
- **Master lock honored**: module runs paper regardless of UPSTOX_SANDBOX_ENABLED (per its config); flag=true in .env; token row seeded for client 8CA31472-…; DB tables auto-created via synchronize (dev).
- **NEXT (user epic brief 2026-09-10, pasted)**: AUDIT existing market-data/trading paths first (brief section 2), then unify live market data (single common feed + normalized tick for BOTH FnF and Upstox engines), disable Yahoo on the trading data path, hard account isolation, common tick storage, restart recovery, tests. Upstox paper module is the vehicle for the Upstox side of the parallel run.
- **Epic progress 2026-09-10 (committed ddee199)**: (1) section-2 AUDIT done → docs/market-data-unification-audit.md (two parallel pipelines, Upstox WS is a stub/REST-only, Yahoo only in FYERS feed, duplicated tick tables, no real order path, isolation by table). (2) IMPLEMENTATION PLAN drafted → docs/unified-market-data-implementation-plan.md (9 phases; PRIMARY=FYERS WS, SECONDARY=Upstox REST, Yahoo disabled; each phase maps to brief sections, ends with build+test+commit). (3) DEPLOYED: web app w/ module live on port 3010 (public via cloudflared tunnel); Dhargent worker untouched (module graph excludes upstox). Epic % complete: ~25% (audit+boot+isolation-by-construction); execution starts with plan Phase 1 (Yahoo hard-disable).
- **NOT yet committed**: docs/TODO.md, docs/FNO_PAPER_PLAN.md, public/dashboard.html, upstox-trading legacy sandbox controller/entity/module/service, emergency-trading.controller, inbox/mail-account/side-income/auth/db.config modifications (all included in this commit).

## Progress (2026-09-05) — decision engine, Reflexion/Greeks, v5 checklist, auth hardening
- **Candidate-ranking DECISION ENGINE live** (`option-candidate-rank-v1`, f7bce35): universe-wide
  candidates → ₹5k capital filter (NOT instrument rule) → gates (stale/spread/volume/decay) →
  weighted score (strategy fit/liquidity/spread/expiry/Greeks/same-underlying nudge/cost) →
  best affordable or NO TRADE. Universe widened to 32 contracts NIFTY+BANKNIFTY 26SEP (eb9cca0).
- **2 legacy index positions closed** (scope-drift cleanup): phantom ₹81k deployed released;
  net −₹200.74 absorbed; ceiling auto-shrunk to ₹4,799.26; deployed ₹0 — desk starts clean.
- **/project-status DB-driven page** (6b061cb): project_checklist_items table, 22 gates + priority
  order seeded; status toggles + per-item notes; **upgraded to v5 detailed edition** (1a983ed):
  224 rows incl FINAL EXECUTION PROTOCOL group, per-item Implementation + Done-when, notes inline.
- **T-08 Reflexion episodic memory** (1a983ed): fnf_trade_reflections written on every close —
  deterministic outcome class (WIN_TARGET/LOSS_STOP/TIME_EXIT/LOSS_MANUAL) + critique + heuristic;
  exitTrigger flows from driver; recent lessons injected into next signal reasons.
- **T-09 local Greeks/IV** (1a983ed): bsm-greeks.ts (BSM IV solver + delta/gamma/theta/vega,
  validated vs textbook); candidates scored on local delta when provider omits it; |delta|
  0.10–0.40 band gate; provider-vs-local desync flagged.
- **Guidebook (Google Doc) reviewed + mapped to v4/v5 gates** — only 2 additive items existed
  (T-08, D-02); recorded in docs/TODO.md. **D-01 DECIDED (user)**: XGBoost first, Reflexion =
  post-trade critique. **D-02 spec written**: docs/D02_MULTI_LEG_DEFINED_RISK_SPEC.md (IC/credit
  spread family; blocked on margin + broker).
- **Auth hardening (8265919)**: portal password REMOVED from .env — now AES-256-CBC encrypted in
  portal_users DB row (bapay.9@gmail.com / Swarna Sekhar Dhar + birth/astro profile) under
  ENCRYPTION_KEY; login/change-password/forgot-password DB-first with env legacy fallback;
  change-password strips .env. **Git history purged** of the old plaintext password
  (filter-repo rewrite; full backup at /tmp/myjob-agent-backup-20260905-0110.bundle).
- Status PDF reports in docs/ (OPTION_DESK_STATUS + MY_JOB_AGENT_PROJECT_STATUS, 2026-09-04).

## Progress (2026-09-04)
- **T-04 Option-chain desk — index is underlying/reference ONLY; positions are CE/PE contracts (deployed Dhargent, commits `681dd32` + `4ffce1e`)** — user rule: NIFTY50-INDEX/SENSEX determine which option-chain contracts to trade; the desk never opens a position on the index itself. `openTrade` hard guard rejects any `*-INDEX` instrument and any symbol not registered in `fnf_option_contracts`; quantity = LOTS × lotSize (NIFTY 65/BANKNIFTY 30/FINNIFTY 60/SENSEX 20); entry = premium/unit; premium outlay (units × premium) must fit the envelope; contract meta (strike/expiry/CE-PE/lot/units) persisted in decisionParams. `closeTrade` computes premium P&L `(exit−entry)×units` and round-trip FYERS segment costs (options flat ₹20/order per leg, STT 0.05% sell premium, NSE txn 0.03553%, stamp 0.003% buy, SEBI ₹10/cr, GST 18% on broker+txn+sebi) — the old `Math.max` brokerage bug (billed the larger of pct/flat) fixed to a true lower-of. `generateSignals` now runs `option-atm-premium-v1` over registered contracts with live premium quotes: underlying SMA-20 decides direction → ATM CE (bullish) / ATM PE (bearish), premium target ×1.5 / stop ×0.75, decay-adjusted; the underlying index is never the signal instrument. Feed routes option-contract ticks to `fnf_option_quotes` only (never `fnf_market_snapshots`) and auto-registers option symbols from `FNO_MARKET_DATA_SYMBOLS` at `onModuleInit`. Session driver exits are position-driven via `latestReferencePrice` (quote for contracts, snapshot for legacy index positions) against stored target/stop, so the 2 legacy T-03 index opens remain managed. Live NIFTY 26SEP chain (10 contracts, strikes 23,850–24,050 CE/PE) registered; FYERS subscribed to 13 symbols; real premiums verified landing.
- **Envelope model (2026-09-04, user directive — corrected wording)** — ₹5,000 is the per-position CAPITAL CONSTRAINT, not an instrument-selection rule. Account starts at ₹5,000 (stored in the DB); after every close the stored ceiling auto-grows/shrinks by net P&L (`ceiling = max(0, capital + netPnl)` = profit − charges). The signal engine builds candidates across the entire registered option universe (underlying × expiry × strike × CE/PE × premium × lot size × contract value × liquidity/OI/volume × bid/ask × Greeks × ATM-ness), rejects every candidate whose `premium × lotSize × lots > available headroom` (capital + netPnl − deployed), then ranks the affordable survivors by strategy suitability and risk (strike/expiry quality, liquidity, spread, Greeks). Same-underlying OTM is a legitimate candidate scored on merit — not a hard fallback; SENSEX/BANKNIFTY/FINNIFTY are other candidates allowed to win on score. If nothing clears strategy + liquidity + risk + affordability → NO TRADE (never force the next-cheapest). NIFTY ATM 26SEP is ₹13–26k/lot today so it is typically filtered out; the desk trades whichever affordable candidate scores best, and holds (no trade) when none exists.
- **Session tick archival (2026-09-04, user directive)** — new `fnf_market_snapshots_history` + `fnf_option_quotes_history` tables (schema mirror + archivedAt; auto-created via synchronize). `archiveTicksBefore(boundaryIst)` moves (INSERT…SELECT → history, then DELETE) idempotently. Session driver `maybeArchiveSessions` runs every 10s tick: weekday ≥15:30 archives `ts < today 15:30` once per date; day rollover archives `ts < today 00:00` (stragglers). Verified live on Dhargent boot 18:23: 22,694 snapshots + 3 quotes archived; live tables now today-only; history accumulating (35,965 snapshots).
- **FYERS token refresh (2026-09-04)** — access token (single-day) expired overnight → `-15 Please provide valid token` on every WS reconnect; Yahoo fallback active per policy. Fresh auth-code exchange via user login click (appIdHash sha-256, browser-grade headers for Cloudflare 1010); new access+refresh tokens written masked to local + Dhargent `.env`; trading-agent restarted; FYERS primary restored (log: "FYERS socket available again — Yahoo fallback stopped"). Playbook saved in market-data-paper-trading skill.
- **T-03 observe-only session (Fri 2026-09-04 09:15–15:30 IST) — completed, outcome archived** — first autonomous paper session: driver armed, opened 2 index-level BUYs at 09:15:02 (NIFTY50-INDEX @ 23910.90 target 24389.12/stop 23671.79; BANKNIFTY-INDEX @ 57492.65 target 58642.50/stop 56917.72, conf 47 decayed, astro shubh 80) — these were pre-T-04 scope-drift (raw index, not option contracts) flagged by the user mid-session and left open to resolve naturally per user choice. Neither hit target/stop; both still OPEN at close; netPnl 0. Ceiling corrected 100,000 → 5,000 (the 100k was wrongly applied on 09-03). ₹5k-envelope/redeposit rules held (driver refused SENSEX open at 12:03: ₹76.8k notional > headroom under the corrected ceiling).

## Progress (2026-09-03)
- **UI acceptance pass round 2 — three reports fixed & deployed (2026-09-03 night)** — (1) `/applications-page/failed` returned 500: `failed-applications-page.controller.ts` did `.innerJoin('app.jobLead', 'lead')` but the application entity has only a bare `leadId` FK, no `jobLead` relation — join removed (was unused), page now 200. (2) Applications & Tracking calendar: date-clicks did nothing on first load (server-rendered grid never got click listeners — only cells re-rendered by `renderCalendar()` did); pagination called `loadDay(iso + '?page=' + page)` corrupting the day param into `2026-09-03?page=2`; detail-view Apply/Follow-up buttons emitted unquoted UUIDs (`applyNow(9a8eb1ac-…)` → JS syntax error on click). Fixed: `wireDayCells()` runs on initial render + after every grid swap; paginate anchors carry `data-day`/`data-page` and `loadDay(iso, page)` builds clean `URLSearchParams`; UUIDs now single-quoted through proper double-escape (verified in compiled + served HTML). (3) Pre-apply page: 22 dead `failed` naukri rows (channelJson NULL, errorDetail set) dominated the queue with only a Hold button. Cards now show 🔗 job-listing link (`lead.url`), explicit "Send to email" line for email channels, red failure-reason text, and "no channel resolved — cannot send until a channel exists" for NULL-channel items; failed items with a resolvable channel get `🔄 Retry — approve & send` (service `approve()` allows failed→approved; errorDetail cleared; sweep retries). All failed cards moved into a collapsed `❌ Previously failed (N)` section below the actionable queue. Verified live: all three pages 200, content checks pass, build clean, pm2 restarted. Commit `HEAD` (pending push).
- **ZEBRA Techies apply — prepared, awaiting user approval (2026-09-03)** — user-approved job (09-02, "OK SN APPLY TO THIS JOB") lead `zebra`/`job-opportunities-9` created + prepared → pre-apply queue item `9a8eb1ac` status `ready`, channel email → `hr@zebratechies.com` (JD evidence, jd-email), astro 80/100, tailored CV built. Two engine defects fixed along the way: (1) `prepareApplication`'s company-form fallback no longer overrides an existing evidence-email channel with the company's own apply page (was routing approved sends into the Chrome-blocked browser path); (2) `detectProcess` now takes the last capture group for `Email: x@y` patterns (was returning target `:`). Page caveat: printed walk-in dates 22 Oct–7 Nov 2025 (past) though posting is titled ongoing — flagged to user. Send gated on user approval on /pre-apply-page → muhurta sweep. Committed + pushed to origin/dev.
- **Cloudflare credential audit + role correction (2026-09-03)** — both Cloudflare credentials had been stored with swapped labels in `.env` from an earlier session. Verified each credential against the live Cloudflare API to confirm its real auth method — the one stored under `CLOUDFLARE_API_KEY` authenticates only as a Bearer `Authorization` token → it is the API Token, and the one stored under `CLOUDFLARE_API_TOKEN` authenticates with `X-Auth-Key` + email → it is the Global API Key. Relabeled `.env` so the API Token lives under `CLOUDFLARE_API_TOKEN` and the Global API Key lives under `CLOUDFLARE_API_KEY`, verified the zone `berhampore.in` against the corrected creds (zone ID `a79c56ccfc82f14300ef8ff6102cbd1a`, active, full Cloudflare plan, Cloudflare nameservers active, no existing A/AAAA records yet), and cleaned the `.gitignore` (removed a couple of stale `*.env*` exclusions that had been added under confusion; `generated/` and `node_modules/` still ignored, `dist/` + `__pycache__/` already untracked). Committed, pulled `--rebase`, pushed to `origin/dev`.
- **FNF decay engine: LIVE (user instruction "always predict considering decay, always rectify decay value + timings day-wise")** — new `FnfDecayCalibration` entity + `fnf_decay_calibrations` table (7 global weekday rows, portfolio override rows optional, UNIQUE portfolioId+weekday). Every signal is now decay-adjusted: `decayedConfidence = confidence × e^(−rate × data-age-hours) × timingFactor` (1.0 inside the weekday's best-entry window, 0.85 outside); below floor 35 → HOLD. Day-wise self-rectification: after every closed trade the weekday's rate + window are rectified from the outcome (winners ease rate ×(1−0.15), losers tighten ×(1+0.15); window edges drift 0.25h toward winning entry hours, clamped 9.00–15.50); runs automatically after each close + when calibration is stale, and on demand `POST /trading/decay/rectify`. REST: `GET /trading/decay?portfolioId=`, `PATCH /trading/decay` (manual override per weekday), `POST /trading/decay/rectify`. Dashboard: new decay-calibration card (per-weekday rate/window/samples/last-rectified, today highlighted) + signals table shows raw→decayed confidence + decay badge. E2E verified: signal 61%→52% at 0.08h age; win rectified Tue rate 0.0400→0.0340 + window 9.50→9.25; loss →0.0391; samples=2; PATCH wd5 persisted.
- **FNF trading module v1: LIVE** — `src/trading/` now has module wiring in AppModule: `FnfTradingService` (portfolio CRUD, trade ledger with Indian discount-broker cost model, market snapshot ingestion + value-change %, SMA mean-reversion signal stubs with scenario tree + astro match + Friday block, self-learning summary per algoSource), `FnfTradingController` (REST: `/trading/portfolios|trades|market|signals|cost|astro|summary`), `FnfTradingPageController` (`/fnf-trading` dashboard: portfolio card, Nifty 50/Sensex market table, algo panel, trade ledger, cost breakdown, Friday toggle, broker config slots for Zerodha Kite/Angel One, auto-trade on/off, astro muhurta panel). `fnf_portfolios`/`fnf_trades`/`fnf_market_snapshots` tables created in MySQL (prod has synchronize off). Dashboard card added. E2E verified: open→close trade (gross 299.40, cost 32.72, net 266.68), learning summary, market change%, signals with astro match. Entities extended with `fridayTradingEnabled` + `brokerConfig` (text JSON) columns.
- **F&O options page + live-data adapter slice (2026-09-01)** — `/option-trading` is wired as a dedicated paper-only desk. It reuses the guarded FNF/F&O portfolio envelope, Friday gate, astro/muhurta gate, decay-adjusted signals, learning summary, market snapshots, trade ledger, and P&L. A FYERS API v3 data WebSocket adapter (`FnoMarketDataService`) subscribes to configured underlying/option symbols and throttles real ticks into `fnf_market_snapshots`; status is exposed at `GET /trading/market-feed/status`. It never imports or calls broker order placement. Credentials/symbols are environment-only (`FYERS_APP_ID`, `FYERS_ACCESS_TOKEN`, `FNO_MARKET_DATA_ENABLED`, `FNO_MARKET_DATA_SYMBOLS`). Yahoo Finance chart polling is now the opt-in interim alternate (`YAHOO_FINANCE_SYMBOLS`, 15s default poll, 1m chart data); defaults are underlying/index proxies, not an option-chain feed. Explicit option contract metadata and quote storage are now implemented through `fnf_option_contracts` and `fnf_option_quotes`, with REST inspection/ingestion at `/trading/options/contracts`, `/trading/options/chain`, and `/trading/options/quotes`; schema creation and live endpoint verification passed after the production PM2 restart. Remaining option TODO: Greeks-derived validation, margin/max-loss validation, liquidity/freshness checks, and option-specific paper fills/costs/P&L.
- **Market-data inspector page (2026-09-01)** — `/market-data` and `GET /trading/market/snapshots` expose persisted feed snapshots with instrument search, time range, price range, volume range, OHLC availability, latest-only, row limit, auto-refresh, feed status, and explicit paper-only safety messaging. Pure filter behavior is covered by `scripts/market-data-filter.test.js`; no trading or broker execution path is added.
- **Yahoo interim feed safeguard (2026-09-01)** — Yahoo remains enabled for experimental underlying/index analysis while the broker account is under document review. Repeated polls of the same 1-minute candle are now rejected per instrument before snapshot persistence and feed tick counting; FYERS ticks are unaffected. Five-session ₹5,000 paper-options rules are documented in `docs/FNO_PAPER_PLAN.md`. No option trade is permitted without an explicit contract and fresh option quote.
- **CeeVi document packet prepared (2026-09-01)** — created the printable 41-page combined PDF at `/home/swarna-sekhar-dhar/Downloads/Swarna_Sekhar_Dhar_CeeVi_Actual_Document_Packet.pdf` from locally available identity, education, birth-proof, joining, and employment documents. Missing requirements are listed in the packet; nothing was submitted to CeeVi.
- **`/visa-guide` in-app page: live** — `GET /visa-guide` renders the full guide as styled HTML from `VISA_SPONSORED_JOBS_GUIDE.md` via a minimal built-in markdown renderer; live masthead stats from MySQL (31 submitted / 4 failed / 1 needs_info / 0 sandboxed / 115 leads); badge row; 61 table rows; footer links back to dashboard/applications/swagger — committed `66cc07d`, pushed to origin/dev
- **BiCSoM Senior Node.js Developer (lead `346e6524-...`) REAL APPLICATION SENT** via Fluent Forms adapter — application `788df9cf` submitted successfully; engine patched (CV set, AUTO_SUBMIT_BROWSER=true, regex fixed, stale rows cleared). API-driven — no browser popup needed
- **Browser automation still blocked** — Chrome profile has no `remote-debugging-port` flag; `cua_browser_prepare` timed out waiting for user approval; `focus_app(Chrome)` same timeout; `list_windows(Chrome)` returned 0 windows. Remotive job page Cloudflare-blocked via curl. Chrome-drive gated behind user approval — no retry without explicit go-ahead. "immurshiv ui" thread closed by user ("OK IGNORE THEM")
- **Applications**: 36 total — 31 submitted, 4 failed (all Remotive/Lemon.io), 1 needs_info (LinkedIn Continental, Bengaluru — NOT visa-sponsored)
- **Job leads**: 115 live in DB (Naukri, RemoteOK, Remotive, LinkedIn, Norway, A1Group, BiCSoM) + 8 H1B US leads (Stripe, Anthropic, Klaviyo, Lyft, Coinbase, Adyen, Databricks, Airbnb)
- **FNF trading schema v1: committed** — 3 entities in `src/trading/`: `FnfPortfolio` (capital/ceiling/deployed/netPnl/totalCost/autoTradeEnabled), `FnfTrade` (full record incl. decisionParams JSON with all prediction params + astro match + Friday flag + algoSource, entry/exit, gross/net P&L, cost, brokerOrderId, status), `FnfMarketSnapshot` (price/volume/OHLC per instrument, indexed on instrument+ts). The module/service/controller/pages are now live as described above.
- **Operator-password auth model (2026-09-02, AMENDED same day)** — Google OAuth removed entirely. **Login required for local AND public access** (amendment: previously localhost = no auth; user directive 2026-09-02 made localhost require login too, and after login the root page shows the dashboard hub). Endpoints: `POST /auth/login`, `GET /auth/me`, `POST /auth/logout`, `POST /auth/change-password` (old+new, persists `.env`), `POST /auth/forgot-password` (mails password to bapay.9@gmail.com via SMTP env creds). Global `ConditionalAuthGuard` — NO localhost/loopback exemption (Cloudflare tunnel arrives as loopback, so any such bypass would open berhampore.in; never reintroduce one); `@BypassAuth`/`@AllowIps` for callbacks/webhooks/server-to-server AND the SPA shell controller (login page must load pre-auth — this fixed the raw-401-no-login-page on berhampore.in). Session cookie `secure: 'auto'` (plain-http local login works; tunnel https still gets Secure). Auth routes rate-limited; `trust proxy` set. Root `/` serves dashboard.html — password form when logged out (any host), dashboard hub when logged in.
- **Cloudflare tunnel restored (2026-09-01)** — cloudflared had died; `https://berhampore.in/` was returning 530 (edge could not reach origin; app itself was healthy on 3010). Restarted `cloudflared tunnel run ce9458f2-...` → berhampore.in + dev.berhampore.in back to app responses (404 on / = normal, no root route). Caveat: not yet reboot-surviving (no systemd unit).
- **Apply engine**: pm2-managed (ecosystem.config.js), systemd wrapper `pm2-swarna-sekhar-dhar.service` active+enabled, port 3010, sandbox OFF, AUTO_SUBMIT_BROWSER=true
- **CV**: Swarna_Sekhar_Dhar_Mywhy_Senior_Backend_Engineer.pdf set as default
- **Chrome browser automation**: blocked — remote debugging not enabled on user profile; no isolated-browser approval granted; no retry without user

- **Paper account model aligned to ₹5,000 envelope + redeposit rule (2026-09-03)** — user directive: paper trading starts with ₹5,000 in balance; losses and service charges reduce it; if money is lost the desk continues with the REMAINING balance (after service-charge deduction) in the next session until the user redeposits. Portfolio `sandbox-live` corrected from ₹10L to capital ₹5,000 / ceiling ₹1L (notional headroom for one qty-1 index position). Session driver gained the depletion guard: `effectiveBalance = capital + netPnl ≤ 0` ⇒ hold new opens + log "awaiting redeposit" (no freeze on drawdown, no imaginary money). T-03 **rescheduled to Fri 2026-09-04 09:15 IST** (backlog said 09-05 = Saturday, NSE closed) — first autonomous paper session on the ₹5,000 envelope; observation only, no code changes during the session.

## Progress (2026-09-05 late) — Upstox Sandbox isolation + decision batch + backups
- **Upstox Sandbox isolation COMPLETE** (task spec v2, docs/UPSTOX_SANDBOX.md): mode columns
  `on_real_data`/`execution_provider`/`execution_mode` on fnf_trades/portfolios/decision_journal/
  reflections/reports (defaults 1/FYERS/REAL preserve FYERS; migrated; indexes); separate
  `sandbox_ticks` table (19 cols) + async non-blocking UpstoxSandboxIngestionService; fail-closed
  UpstoxSandboxProvider (SANDBOX-only host, REAL-mode refused, disabled without creds);
  real-only filters at learningSummary/rectifyDecay/listTrades/listPortfolios + /trades/sandbox +
  /portfolios/sandbox endpoints; UPSTOX_SANDBOX_* env keys unset, UPSTOX_SANDBOX_ENABLED=false;
  tests scripts/upstox-isolation.test.js spec-v2 A–L + FYERS regression ALL PASS (13/13); deployed
  Dhargent (crash-loop fixed: TradingAgentModule forFeature was missing FnfTradeReport/SandboxTick).
  Commits 83d0f3f → c9a1bc7.
- **EPIC queued (EPIC-P1, in_progress)**: Option Chain Market Prediction & Profit Engine
  (spec paste_3, §1–36). PHASE 1 audit DONE: chain = 32 registered contracts / 1 expiry (26SEP) /
  near-ATM band only; FYERS OI always 0 → OI walls/PCR_OI/change-OI DATA-GATED (health-flag, never
  fabricate); Greeks/IV provider-empty → use local BSM (bsm-greeks.ts); underlying snapshots rich
  (VWAP/ATR/ORB/gap live). PHASE 2 next: feature pipeline + OBSERVATION-mode engine.
- **Decision batch**: I-01 pm2 user-systemd unit (enabled, resurrect on boot); J-10 cv_region_formats
  DB (32 researched rows/6 continents + /cv-formats API); J-04 MySQL sessions (survive restart);
  T-07 trade-report outbox → Telegram (poller cron f8e233b96d27 every 2min market hours,
  WhatsApp-ready); daily DB backup script myjob_db_backup.sh + crons (pre-open 08:55 / post-close
  15:45 IST Mon–Fri) → ~/projects/my-job-agent/backups/ then removed from server.
- Gate-3 feature engine live (VWAP/ATR/ORB/gapPct on real ticks, 5/10); Gate-14 4/10 (failure
  families + evidence classes); Gate-19 4/10; T-04/candidate-ranking/I-02/J-14/J-19/J-11/J-12 done.

## TODO next session (in order)
> **AUTHORITATIVE queue = `agent_todo_log` DB table (see Resume rule step 1).**
> The list below is historical context; on "continue" start from the DB log
> (first `in_progress`/`pending` by id), NOT from this numbered list.

0. **MONDAY 2026-09-14 09:00–09:15 IST — the pre-open window is the unblocking event for all of GATE 2.** Row 27 (time-alignment) is DONE (`5949caa`), but the archive proves the tape has **ZERO rows in the 09:00–09:15 IST window on every recorded day** and `pre_open_observations` holds only 3 off-hours rows with NULL symbol. So rows 20 and 23–26 (capture, survival at 1/5/15 min, IEP-vs-open, depth/spread shock, relative pre-open volume) cannot close until that window is captured live: refresh BOTH tokens first (Upstox dies 03:30 IST, FYERS 06:00 IST), confirm the 08:57 capture cron fires, then re-run `npm run verify:alignment` to see a NON-empty pre-open side of the frame.
0. **Two DB backup crons were repaired 2026-09-12** (`myjob_db_backup.sh`: wrong SSH key = `Permission denied (publickey)` since 2026-09-07; now the authorised `oci-vm-id_ed25519` + `IdentitiesOnly=yes`, slot-stable remote dump, resumable `rsync --partial`, verify-then-promote). Verify the next scheduled runs (08:55 / 15:45 IST) actually finish: the dump is ~395 MB (DB 3.7 GB) and downloads at ~1.4 MB/s, so a resumed run is normal; the script exits 0 with `BACKUP_PENDING` when it made progress and non-zero only on hard failure.
0. **GATE 2 rows 21/22 — row 22 still needs its first REAL stored OAI series block.** Row 21 is done (`0c33c4d`); row 22 (`9cb178d`) is complete in code — `pre-open-oai-series.ts` + the `derived` json column + the capture-time write in both paths + 60/60 tests — but its doneWhen requires a historical record CONTAINING the value, which only the next **09:00–09:15 IST capture window** can produce. At that window: confirm `derived.oaiSeries` lands on the session's rows with version `oais-v1`, cutoff and sample counts, then move row 22 to `done`. Rows 20, 23, 24, 25, 26, 27 all need the same live/archived tape, so GATE 2 closes as a block once that data exists.
0. **BUILD HAZARD (learned 2026-09-12): never run `npm run build` in the shared tree while the job-application session has uncommitted WIP.** A failed build can still emit `dist/app.module.js` from broken source AND skip nest's asset copy, silently poisoning `dist` for the next restart (this crashed the desk app with 104 restarts: `ReferenceError: PreApplyService is not defined` then `MODULE_NOT_FOUND './checklist-v4.seed.json'`). Deploy by building HEAD in a detached worktree and swapping `dist/` (recipe in the `nestjs-boot-blocker-checklist` skill). Also note pm2 runs node with `--enable-source-maps`, so crash frames show `src/*.ts` even though `dist/*.js` is what runs.
0. **Common-feed workstream (row 877 = GATE 0 #10) — restore single-owner and demonstrate controlled failback.** The authorised lease-isolation fix (`c2d369a`) is DONE and LIVE: the arbiter's lease read/write runs on its own dedicated MySQL connection, and the agent's `FYERS_WS` heartbeat now renews every 15 s (it had been frozen 647 s) — `test:lease-connection` 6/6, pool size untouched, 8 s bound kept, TTL rules unchanged. Baseline element "fresh FYERS heartbeat/lease" is PROVEN; "FYERS owns NIFTY / is publishing NIFTY / Upstox standby" needs market hours, so at the NEXT SESSION: (1) prove the clean baseline, (2) run the bounded 100 s FYERS outage → UPSTOX_REST NIFTY failover → FYERS recovery → controlled failback demo with lease+publication+common-store evidence at each stage, (3) finish verifying the CANONICAL pipeline for row 878 (GATE 0 #11) — the Upstox side is ALREADY proven live (`42df4cc`: accepted 590 / persisted 546 / rejected 0 on real chains, converged keys `BSE:SENSEX17SEP74900CE`); still open: the FYERS side under live ticks (watch the STALE reject rate) and BOTH desks consuming canonical rows. Row 878's `doneWhen` has no mode flip (the interpreter is permanently ON and mandatory; `TICK_INTERPRETER_MODE` and the dual-write switches are deleted). Raw-payload archival is DEFERRED by the operator (no new column, no extra write volume). Do not mark row 877 or row 878 done until its own doneWhen fully holds.
0. **FYERS token lifetime** — the DB token expires 06:00 IST daily and `FYERS_PIN` is absent, so the re-login at `http://127.0.0.1:3010/auth/fyers/login` is a standing morning dependency (the socket rebuilds itself once a fresh token lands; no restart needed).
0. **Tue 2026-09-15 08:57 IST — the re-armed pre-open window capture** (jobs `gate2-preopen-capture-20260915` fb2b3340dcc2 + review `gate2-preopen-review-20260915` a20aa715de88). Preconditions: machine powered on before 08:55 IST (the gateway unit is enabled+Linger, so it only needs the host up) and a fresh Upstox token after 03:30 IST — tokens die daily. The plan for 2026-09-11 itself WAS executed correctly up to the window and was lost to the host being off (04:23–10:40); the review found nothing to sync, so no Gate 2 row moved. The first real operator OAuth click is STILL the only thing that closes row 876's gap.

0. **Upstox LIVE token — supply a fresh one here in the console, then prove the first real operator OAuth click** (row 876 `UPSTOX AUTO TRADING #1` stays `in_progress`; that click is its only outstanding doneWhen and I cannot self-verify it). Token expires 03:30 IST daily; the sanctioned route is the desk button → `GET /api/upstox/token/init` → `login.upstox.com` → public state-validated callback. With a live token the GATE 2 slice-1 pre-open capture (09:00–09:15 IST, cron `gate2-preopen-window-capture` 792771ea078c, armed 08:57) can finally run and prove the Upstox index auction fields (`indicative_equilibrium_price`, `indicative_imbalance_quantity_total/market`), which stay unproven outside a real window.
0. **Drift-guard governance — every FUTURE job-application code commit needs its own exact-SHA entry** in `docs/gate-close-allow.json` (reason + workstream + authority required; that is the narrow design working as intended). The JA workstream stays in its own `job_application_roadmap_items` table and out of `project_checklist_items`. Making the JA path wholesale-exempt is an OPERATOR decision and is NOT implemented, because it would weaken detection for that path.
0. **Two backup crons report `last_status=error`** — `myjob-db-backup-preopen` (7447716d75e9, 08:55 weekdays) and `myjob-db-backup-postclose` (fa77d6783087, 15:45), both running `myjob_db_backup.sh`, failing since 2026-09-10. Undiagnosed; not touched this session (no scope for it).
0. **Cloudflare credential roles corrected + zone verified + .gitignore cleaned (2026-09-03)** — both creds had been stored with swapped labels from an earlier session: the value now under `CLOUDFLARE_API_KEY` authenticates only as a Bearer token → it's the API Token, and the value now under `CLOUDFLARE_API_TOKEN` authenticates with `X-Auth-Key` + email → it's the Global API Key. Relabeled `.env`, verified zone `berhampore.in` (ID `a79c56ccfc82f14300ef8ff6102cbd1a`) against the corrected creds, cleaned `.gitignore`. Committed + pulled `--rebase` + pushed to `origin/dev`.
0. **SESSION_SECRET placeholder still in .env — replace with random secret** (security-report follow-up, user OK still pending).
0. ~~**Google OAuth login — finish E2E**~~ — **SUPERSEDED 2026-09-02**: Google login removed per user directive; replaced by the operator-password model (see "Operator-password auth model" above). No Google Cloud Console work needed.
0. **FNF trading — real broker API wiring** (module v1 + decay engine live): plug in Zerodha Kite Connect / Angel One API with stored credentials (encrypted in `fnf_portfolios.brokerConfig`), live price feed for Nifty 50/Sensex/equities feeding `fnf_market_snapshots`, order placement within money limit, paper-trade first.
1. **FNF decay — refine model with live outcomes**: decay currently uses fixed floor 35 + learning rate 0.15 + window step 0.25h; consider per-instrument rates, expiry-day (Thursday) special handling, and auto-trade gating on decayed confidence.
1. **FNF decay — refine model with live outcomes**: decay currently uses fixed floor 35 + learning rate 0.15 + window step 0.25h; consider per-instrument rates, expiry-day (Thursday) special handling, and auto-trade gating on decayed confidence.
2. **Lemon.io / Remotive Senior React Full-stack (lead `06524d9b-…`)** — apply FAILED x3 (Cloudflare + ATS endpoint). Fix: browser to real Remotive job page or company Greenhouse/Lever page (Cloudflare challenge needs real browser), find real apply link, submit. Gate: Chrome remote-debugging + cua_browser_prepare user approval.
3. **H1B US leads (8 total: Stripe, Anthropic, Klaviyo, Lyft, Coinbase, Adyen, Databricks, Airbnb)** — browser-apply to each company career page. Gate: same Chrome approval.
4. **LinkedIn needs_info (Continental Industry, Bengaluru — NOT visa-sponsored)** — 5 unanswered fields; fill via browser. Blocked on Chrome. Lower priority.
5. Activate LinkedIn snapshot (user action): save profile HTML to `data/linkedin/profile.html` → POST /linkedin/refresh.
6. Tag-<4-month stint + LinkedIn easy-apply policy: tagged short-stint flag in workHistory + DTO; AtsCvBuilder skips tagged; LinkedIn easy-apply uses last uploaded CV. ASK USER DOB question (PAN + 10th cert: 09/12/1982 vs chart/memory: 09/12/1981 — affects astrology; unresolved).
7. Write-path unicode sanitization (stored data repaired; builder/writer still unsanitized): strip/replace non-ASCII control chars in CV builder + workHistoryJson write path.
8. A1 Group careers adapter (jobs.a1.com): WordPress; REST live; vacancy list client-side via job-listing block — read block JS for data source/fetch params.
9. finn.no login: captcha verdict NO bypass — one-time manual session-cookie capture (user hasn't chosen). Scrape side live.
10. Company-redirect apply handling (FR-19, always-company rule): jobs whose apply link redirects to company's own page — detect, drive form (FR-15), handle login/register (legit automation or flag manual-apply).

## Goodbye process (user-mandated)
Update Progress + TODO here (PROJECT_PROMPT.md) → commit on `dev` → `pull --rebase` → `push origin/dev`. Never skip even on interrupt. Working directory: `/home/swarna-sekhar-dhar/projects/my-job-agent`; branch: `dev`.

## Gotchas / lessons
- pdfkit must be required (not ES-imported): `const PDFDocument: any = require('pdfkit')`
- TypeORM can't infer types from `string | null` unions — always set explicit column type
- Naukri search needs BOTH nkparam header AND login cookies (appid 109/systemid Naukri)
- pkill kills our own shell sometimes — use targeted patterns or ss -tln to check port
- Chrome remote-debugging not enabled on user profile → browser automation blocked; cua_browser_prepare requires user approval (timeout); Remotive Cloudflare-blocked via curl
- FNF trading entities use `decisionParams` as `text` JSON so the page can render the full decision context (price target, stop-loss, confidence, scenario list, astro match, Friday flag) without schema churn per algorithm
- TypeORM `create()` with `nullable` columns: pass `undefined` not `null` (TS strict: `DeepPartial` doesn't accept `null`); `const out = []` infers `never[]` — type the array literal
- Prod runs `synchronize=false` (NODE_ENV=production) — new entity tables must be created via SQL in MySQL before boot
- Visa guide page renders the raw markdown file live — edits to `VISA_SPONSORED_JOBS_GUIDE.md` show up on refresh; no rebuild needed
