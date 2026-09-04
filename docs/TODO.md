# my-job-agent — TODO / Progress Tracker

> Updated with every session. ✅ done · 🔄 in progress · ⬜ pending · 🚫 blocked on user
> Last updated: 2026-09-04 (evening)

## T-04 Option-chain desk + tick archival + envelope model (2026-09-04) — deployed Dhargent
- [x] **User rule**: NIFTY50-INDEX/SENSEX are UNDERLYING/REFERENCE only; positions only on registered option contracts (CE/PE) with expiry/strike/lot; premium-based entry/P&L/sizing; hard safeguard against index positions. Commit `681dd32`.
- [x] **openTrade hard guard**: rejects any `*-INDEX` instrument ("reference only — the desk trades option contracts on the chain, never the index itself") and any symbol not in `fnf_option_contracts`. Quantity = LOTS × lotSize (NIFTY 65/BANKNIFTY 30/FINNIFTY 60/SENSEX 20); entry = premium/unit; premium outlay (units × premium) must fit ceiling; decisionParams stores contract meta (strike/expiry/CE-PE/lot/units).
- [x] **closeTrade**: premium P&L `(exit−entry)×units`; round-trip cost = entry leg + exit leg at FYERS segment rates (options flat ₹20/order, STT 0.05% sell premium, NSE txn 0.03553%, stamp 0.003% buy, SEBI ₹10/cr, GST 18% on broker+txn+sebi); deployed releases entry outlay (not exit value).
- [x] **calculateCost(notional, side, segment)**: true lower-of brokerage (old `Math.max` billed the larger charge — fixed); options vs futures rate sets.
- [x] **generateSignals → option-atm-premium-v1**: tradable universe = registered contracts with live premium quotes; underlying SMA-20 only for direction + ATM strike (bullish→ATM CE, bearish→ATM PE); premium target ×1.5 / stop ×0.75; decay-adjusted.
- [x] **Envelope as capital filter, not instrument selector (user directive 2026-09-04)**: ₹5,000 is the per-position capital constraint (the account starts at ₹5,000 and the ceiling auto-grows/shrinks by profit − charges after each close). It is NOT a rule to prefer one chain over another. The signal engine builds candidates across the whole registered option universe (underlying × expiry × strike × CE/PE), each scored on premium, lot size, contract value, liquidity/OI/volume, bid/ask spread, Greeks (where available) and ATM-ness/distance from spot; any candidate whose `premium × lotSize × lots > headroom` is rejected as unaffordable, and the best-scoring affordable candidate wins. Same-underlying OTM is a legitimate candidate (score preference, not a hard fallback); SENSEX/BANKNIFTY/FINNIFTY are simply other candidates. If no candidate clears strategy + liquidity + risk + affordability, the result is NO TRADE — never the next-cheapest forced pick. (Scope note: initial 26SEP registration was NIFTY-only; universe widening to other chains/expiries is the T-04 follow-on.)
- [x] **Session driver**: exits position-driven via `latestReferencePrice` (option quote for contracts / snapshot for legacy index positions) against stored target/stop — the 2 legacy index opens from T-03 remain managed; opens only from option signals.
- [x] **Feed routing**: option-contract ticks → `ingestQuote` only (never `fnf_market_snapshots`); option symbols in `FNO_MARKET_DATA_SYMBOLS` auto-register at `onModuleInit` (constructor raced the DB); FNO_OPTION_CONTRACTS also upserted at boot. Live: 13 symbols subscribed (3 index + 10 NIFTY 26SEP contracts), 10 contracts in DB, real premiums landing.
- [x] **Tick archival (user 2026-09-04)**: new `fnf_market_snapshots_history` / `fnf_option_quotes_history` (schema mirror + archivedAt, auto-created). `archiveTicksBefore(boundaryIst)` = INSERT…SELECT→history then DELETE from live (idempotent). Driver `maybeArchiveSessions` on every 10s tick: weekday ≥15:30 → archive ts < today 15:30 once; day rollover → archive ts < today 00:00. Verified live: 22,694 snapshots + 3 quotes archived at 18:23 boot; live tables today-only. Commit `4ffce1e`.
- [x] **FYERS token refresh (2026-09-04)**: access token expired overnight (-15 at every reconnect); fresh auth-code exchange (user click) → new access+refresh persisted masked to local + Dhargent `.env`; agent restarted, FYERS primary restored 12:03 IST.
- [x] **T-03 session outcome (Fri 2026-09-04, observe-only)**: driver opened 2 index-level paper BUYs at 09:15:02 (NIFTY50-INDEX @ 23910.90 target 24389/stop 23672; BANKNIFTY-INDEX @ 57492.65 target 58642/stop 56918) — these were pre-T-04 scope-drift (index, not option) per the user's correction; left to resolve naturally per user choice; neither hit target/stop; both still OPEN at 15:30 close; netPnl 0, no costs. Archived in agent_todo_log.

## UI acceptance pass round 2 (2026-09-03 night) — failed-page 500 + date-click + pre-apply failed cards
- [x] **User report**: failed application page → `{"statusCode":500,"message":"Internal server error"}`; Applications & Tracking calendar date-clicks do nothing on first load; pre-apply page still dominated by FAILED cards with no job-listing link, no destination email shown, and hold/resume/approve buttons feeling dead.
- [x] **500 root cause**: `failed-applications-page.controller.ts:29` did `.innerJoin('app.jobLead', 'lead')` but `application.entity.ts` has only a bare `leadId` FK — no `jobLead` relation → TypeORMError on every page load (err log confirmed at 22:41/22:42). Join was unused (page renders app fields only; detail endpoint fetches the lead separately) → removed. `/applications-page/failed` now 200.
- [x] **Date-click dead on first load**: click listeners were only attached inside `renderCalendar()` (fires on month/year change); the server-rendered initial `#calGrid` never got listeners. Fixed: `wireDayCells()` helper + an initial call after the grid exists; `renderCalendar()` reuses it after innerHTML swaps.
- [x] **Day pagination ISO mangling**: paginate anchors called `loadDay(iso + '?page=' + page)` → day value became `2026-09-03?page=2` (server saw a bogus day). Anchors now carry `data-day` + `data-page`; `loadDay(iso, page = 1)` builds `URLSearchParams({day:iso, page})` cleanly.
- [x] **Detail-view buttons dead (unquoted UUIDs)**: `onclick="applyNow('+id+')"` emitted `applyNow(9a8eb1ac-…)` — bare UUID parsed as JS identifiers → syntax error on click. Now `applyNow(\''+id+'\')` (double-escaped through the template literal; verified in compiled output + served HTML). Same for `followUp`.
- [x] **Pre-apply failed cards**: 22 dead `failed` naukri rows (channelJson NULL — no email/portal ever resolved, errorDetail set) dominated the queue with only a Hold button. Card now shows: 🔗 job-listing link (`lead.url`) when present, explicit "Send to email" line for email channels, the failure reason (`errorDetail`) in red, "no channel resolved — cannot send until a channel exists" when channel is NULL. Failed items with a resolvable channel get an honest `🔄 Retry — approve & send` button (service `approve()` permits failed→approved, clears errorDetail, sweep retries). All failed items moved into a collapsed `❌ Previously failed (N)` details section below the actionable queue so ready/hold/approved items surface first.
- [x] **Verified live**: `/pre-apply-page` 200 (failed section, retry button, links, email lines present), `/applications-page` 200 (wireDayCells ×2 calls, data-day pagination, quoted applyNow/followUp in served JS), `/applications-page/failed` 200 (was 500). Build clean; pm2 restarted.

## Status-routing fix cluster (2026-09-03 evening) — sent items leave the review queue & land in Application Tracking
- [x] **User report**: ZEBRA (status `sent`) still listed in the Pre-Apply Review Queue; expected rule "sent ⇒ appears in Application Tracking depending on its status"; **Application Tracking returned `500 {"message":"Internal server error"}`**; approve/hold buttons "not working at all".
- [x] **Root causes (four, all fixed)**:
  1. **Tracking 500 — dead column**: `application.repository.ts` calendar queries selected `app.appliedAt`, a property that no longer exists on the entity (renamed to `sentAt` → `sent_at` long ago; TypeORM synchronize dropped the old column). Every calendar/count query threw `Unknown column 'app.appliedAt'` → whole page 500. Page was broken since the rename.
  2. **Nothing ever stamped `sent_at`**: engine success paths saved status `submitted` but never set `sentAt` → even with (1) fixed, sent apps would never appear on the calendar (sent_at NULL on every row). Both send paths (`applyToLead`, `submitPrepared`) now stamp `application.sentAt = new Date()` on `submitted`.
  3. **Queue never hid sent items**: `listAll()` returned everything incl. 11 `sent` → ZEBRA lingered. Review page now uses `findReviewQueue()` (`status != sent`) + header shows "N sent → moved to Applications & Tracking"; `hold()` refuses sent items.
  4. **Buttons looked dead**: `act()` had no error path — a failed/expired-session POST left the button disabled forever with no alert; approve/hold also only ever rendered sensibly once sent items leave. Now: try/catch + clear alert + button re-enable.
- [x] **Sent-set semantics**: "sent" = status `submitted|sent|applied` OR `sent_at` set; bucket date = `COALESCE(sent_at, created_at)` (UTC-safe `DATE_FORMAT`, no tz drift). `counts()` buckets: sent/failed/pending via CASE. Calendar & day-list now show REAL sends (36 legacy `queued` rows correctly stay out — they never went out).
- [x] **History backfill**: 10 app rows stuck `queued` for items sent Aug 27–28 → `submitted` with real `sent_at`; ZEBRA's `submitted` row stamped `sent_at = created_at` (2026-09-03 14:57). Applications now: 11 submitted (all dated) + 26 queued.
- [x] **Verified live (2026-09-03)**: `/applications-page` 200 (was 500) with Sent/Pending/Failed buckets; day lists 2026-08-27→6, 2026-08-28→4, 2026-09-03→1 (ZEBRA); `/pre-apply-page` 0 ZEBRA, 0 sent badges, 31 actionable cards, "11 sent → moved to Applications & Tracking". Commit `f90dc6f`, pushed.

## USER-APPROVED APPLY — ZEBRA prepared, AWAITING user approval to send (2026-09-03)
- [x] **"OK SN APPLY TO THIS JOB https://zebratechiessolution.com/public/career/job-opportunities/9#apply"** — explicit user approval on record (2026-09-02 evening, FR-17.6 satisfied).
- [x] **Page verified live 2026-09-03** (HTTP 200): "WALK-IN INTERVIEW: Laravel Developer (3–5 yrs) with AI Knowledge | Immediate Joiner", Full Time, Sector V Kolkata. Evidence: `hr@zebratechies.com` printed in the JD (contact Sharmila Saha, +91-8334922887) + own apply form on the page. ⚠️ CAVEAT: printed walk-in dates are 22 Oct–7 Nov **2025** (past) though the posting is titled as an ongoing/immediate-joiner walk-in — surfaced to user before send.
- [x] **Lead created** `zebra`/`job-opportunities-9` (7226f149-…, full JD text; only hr@ appears in description so channel detection is unambiguous).
- [x] **Two engine defects fixed (2026-09-03)** — without them the prepared channel would have been the Chrome-blocked browser path, not SMTP:
  1. `apply-engine.service.ts` `prepareApplication`: the careers-page form fallback (`findApplyFormUrl`) ran even when a real evidence-email channel existed and OVERRODE it with the company's own apply page (kind `ats` → browser automation, which is blocked for this user). Now the fallback only runs when NO channel was found (`if (!channel)`), matching the user-mandated channel priority: stated process / real ATS → HR email → portal/form last. (The 09-02 prepare of this same job hit this bug: item 4594e02e sat ready with `ats` → job-page channel.)
  2. `process-learning.service.ts` `detectProcess`: the `Email: x@y` pattern puts the optional ':' in capture 1 and the address in capture 2, but the code read `m[1]` first → target `":"`. Now takes the last capture group, which is the address in every email pattern (defect also silently broke any other JD phrased "Email: hr@…").
- [x] **Prepared → queue item `9a8eb1ac-…` status `ready`** — channel `email → hr@zebratechies.com` (jd-email), astro 80/100, tailored ATS CV built (generated/cv/03092026/Swarna_Sekhar_Dhar_Zebra_Techies_Solution_Laravel_Developer…pdf), subject "Laravel Developer (3-5 yrs) with AI Knowledge — Walk-in Interview, Immediate Joiner — Swarna Dhar". Stale duplicate from 09-02 (lead 8a2c9df9 externalId `9` + ats-channel item 4594e02e) deleted — no application rows referenced it.
- [ ] 🚫 **SEND: user approves on /pre-apply-page (or explicit go) → 10-min muhurta sweep emails hr@zebratechies.com with the tailored CV attached.** Do NOT send blind.

## Auth + pre-apply page session (2026-09-02 evening) — pre-apply page "not showing JD/email" ROOT-CAUSED + FIXED
- [x] **User report**: "/pre-apply-page is not showing job description email to be send and other details".
- [x] **Root cause (two stacked bugs)**: (1) sessions live in express-session default in-memory MemoryStore → every pm2 restart silently logs the user out; a logged-out browser got raw 401 JSON (`{"message":"Operator password required."}`) instead of any page. Two restarts happened that day (SMTP wiring + APP_SECRET restore) → user's session died. (2) Independently, the pre-apply card template (`src/applications/pre-apply-page.controller.ts`) never rendered `job_leads.description` even when logged in (34/37 leads have the field).
- [x] **Fix**: new `src/auth/unauthorized-html-redirect.filter.ts` (`UnauthorizedHtmlRedirectFilter`, global) — HTML-Accept browser requests that hit a 401 now redirect to the login shell; API/XHR clients still get clean 401 JSON (security matrix unchanged). Registered in `src/main.ts`. Card now renders a collapsible "📋 Job description" block (`details.jd` + CSS) in every pre-apply card.
- [x] **Verified live on berhampore.in**: logged-out browser GET /pre-apply-page → 302 to login shell (was raw JSON); logged-out API POST → 401 JSON unchanged; logged-in GET → HTTP 200, 37 cards, 37 "Email draft" blocks, 37 JD blocks (first JD 2,636 chars). Commit `24bb879`, pushed.
- [x] **Caveat for user**: in-memory sessions mean EVERY pm2 restart logs everyone out. Offer: switch to a MySQL-backed session store so logins survive restarts (user hasn't decided — ask next session).

## Auth requirement CHANGED (2026-09-02) — login now required on LOCAL too; remote showed raw 401 instead of login page
- [x] **User directive**: "IN LOCAL IT IS SHOWING PASSWORD CHANGING PAGE NOT THE DASHBOARD … MAKE LOGIN REQUIRE TO LOCAL ALSO. AFTER LOGIN IT SHOULD GO TO DASHBOARD." Plus report: berhampore.in showed `{"message":"Operator password required for remote access.",…401}` with no login page at all.
- [x] **Root cause (both symptoms)**: (1) the SPA shell (`AppFallbackController`, serves dashboard.html at `/`) sat INSIDE the Nest router behind the global guard → remote visitors got raw 401 JSON before any HTML could load; (2) the guard still had the HOST-based localhost exemption + dashboard.js had an `IS_LOCAL` branch → localhost showed the "Local mode / change-password" card instead of login or dashboard.
- [x] **Fix**: removed the localhost exemption from `ConditionalAuthGuard` (login required everywhere — loopback bypass is gone and must never return, Cloudflare tunnel arrives as 127.0.0.1). `AppFallbackController` marked `@BypassAuth` (shell has no data; login form must load pre-auth). Session cookie `secure: 'auto'` so plain-http localhost login works while the https tunnel still gets Secure cookies. dashboard.html/js rebuilt: no session → sign-in form (any host); session → dashboard hub (pre-apply queue, applications, interview practice, market data, F&O, option trading, visa guide, side income) with change-password under Account + sign-out.
- [x] **Verified live**: localhost GET / → 200 (login page); local login over plain http sets cookie → `/auth/me` returns operator; `/leads` 401 without session, 200 with; https://berhampore.in/ → 200 serving the login HTML (was 401 JSON); remote login sets Secure cookie; `/pre-apply-page` 401 without session, 200 with; `x-operator-password` header path (server-to-server) still 200.
- [ ] Next: replace placeholder `SESSION_SECRET` in `.env` with a random secret (security-report follow-up, still open).

## Agent-not-applying investigation (2026-09-02) — NO engine fault, blocked on approvals
- [x] **Diagnosis**: pipeline is gated by design — lead → pre-apply queue (`ready`) → **user approval** → muhurta sweep (10-min tick) sends only `status='approved'` items inside shubh windows (score ≥ 65).
- [x] Evidence: last real submission **2026-08-31 10:34**; queue = **18 `ready`, 0 `approved`**, 10 sent, 3 failed (approved-then-failed), 6 hold. Sweep early-returns on 0 approved → nothing sends. Shubh windows (score 70) were open today but nothing was approved.
- [ ] 🚫 **Decision: approve queue items (user)** — NO approval given (2026-09-02, question timed out; FR-17.6: silence is never approval → nothing sent). 18 items remain `ready`, 0 `approved`. Approve on `/pre-apply-page` or tell the agent explicitly; the sweep then sends at the next open shubh window. Top matches: Virvon Node/NestJS 100/90, Zoftsolutions 100/67, Vistateq AWS Backend 100/85, Resolvent 80/85, Astroidea 80/85.
- [ ] **Continental Industry (LinkedIn, 5a1f9e3c, 88/100) = HOLD** — known needs_info browser-fill blocker since 08-27 (5 fields: skills palette, facebook/twitter/website, hiring-manager msg); requires manual logged-in browser fill before it can send.
- [ ] Sweep auto-submits approved items at next tick while a shubh window is open (today ~13:12–19:12+); failures go to retry-backoff / `failed`.
- [ ] Optional: lower-friction future — auto-approve policy env (`PRE_APPLY_AUTO_APPROVE=true`) only if user wants to remove the human gate.

## Recently completed (2026-09-02 session — operator-password auth model; Google login REMOVED)
- [x] **Google login removed** — no passport, no Google strategy, no consent-screen work needed. `.env` Google vars deleted.
- [x] **Auth per user spec**: localhost access = NO authentication; public IP/domain access = single operator password (`SESSION_PASSWORD` in `.env`). `POST /auth/change-password` (old + new required) persists to `.env`; `POST /auth/forgot-password` emails the password to `RECOVERY_EMAIL` (bapay.9@gmail.com) via SMTP env creds.
- [x] **Root cause fixed**: the middleware catch-all in main.ts swallowed the ENTIRE Nest router — every path (APIs included) returned dashboard.html. Catch-all removed; `AppFallbackController` (`@All('*')`, registered last) serves the SPA shell. All controllers reachable again.
- [x] **Real server-side wall**: `ConditionalAuthGuard` now a global `APP_GUARD` (previously dead code → API fully open publicly). Localhost bypass is HOST-based (`localhost`/`127.0.0.1`), never IP-based (Cloudflare tunnel arrives as loopback). `@BypassAuth` + `@AllowIps` for 3rd-party callbacks / webhooks / server-to-server callers. Strict rate limiters on auth routes; `trust proxy` set.
- [x] Auth endpoints: `POST /auth/login`, `GET /auth/me`, `POST /auth/logout`, `POST /auth/forgot-password`, `POST /auth/change-password`. Server is PM2-supervised (`pm2 list`).
- [x] Security-report follow-ups: `/auth/me` and the old `/auth/allowed-emails` protection now handled by the global guard (`allowed-emails` route deleted with the Google stack). `SESSION_SECRET` is still the placeholder — replace with a random secret in `.env`.
- [x] **Cloudflare tunnel restored (2026-09-01)** — cloudflared had died; restarted `cloudflared tunnel run ce9458f2-...`. Root `/` now serves the dashboard (previously 404). Not reboot-surviving yet.

## Recently completed (2026-09-01 session — CeeVi document packet)
- [x] **Printable CeeVi document packet prepared** — combined locally available identity, education, birth-proof, joining, and employment documents into `/home/swarna-sekhar-dhar/Downloads/Swarna_Sekhar_Dhar_CeeVi_Actual_Document_Packet.pdf` (41 pages). Missing requirements are identified in the packet; no submission was made.

## Recently completed (2026-09-01 session — market-data inspection)
- [x] **Market-data inspector page** at `/market-data` with instrument, time, price, volume, OHLC-availability, latest-only, row-limit, and auto-refresh filters. It reads `GET /trading/market/snapshots`, shows current feed status, and clearly separates real/near-real-time input from paper-only execution. Filter smoke tests live in `scripts/market-data-filter.test.js`.

## Recently completed (2026-08-27 session — LinkedIn apply + evidence-only rule)
- [x] **LinkedIn leads unblocked** (bug fixed): `applyToLead` and `prepareApplication` hard-failed every `source='linkedin'` lead with "no adapter for source linkedin" (line 127 adapter gate ran before the sandbox branch; the LinkedIn easy-apply branch at line 201 was unreachable dead code). Fixed: LinkedIn leads pass the adapter gate (easy-apply automation still off — ban risk), sandbox branch runs, and detected direct channels (company ATS / evidence email) are used with the last-uploaded-CV rule. Also fixed `channelKind` crash (`adapter.source` on undefined) + optional-chaining on adapter probeQuestions.
- [x] **Build break fixed**: `profile.service.ts` `getResponse` omitted `lastUploadedCvPath` that the DTO requires — tsc failed; added to response.
- [x] **EVIDENCE-ONLY HR contact (user rule 2026-08-27 — supersedes 2026-08-25 pattern-guess)**: pattern-guessing role mailboxes (hr@/careers@…) is FORBIDDEN. Investigator now returns only real addresses found on the JD/job page/company pages (domain-guarded). No evidence → engine falls through to portal easy-apply with last uploaded CV (no tailoring) or company ATS link (external link → company portal). Code, REQUIREMENTS.md FR-13, and skill all updated. VERIFIED: Josys (no evidence) → null; BiCSoM email still found via DirectChannelDetector (real evidence).
- [x] **SANDBOX apply demo VERIFIED (BiCSoM Sr.Node JS developer, LinkedIn 4439041961)**: lead created (source=linkedin), SANDBOX=true, `POST /applications/apply/:leadId` → status `sandboxed`, is_sandbox=1, channel email → pg@bicsom.co (evidence from posting), tailored CV generated, no submission made. ✓
- [x] **REAL apply executed (Josys Senior Backend Engineer, LinkedIn 4450092684)**: lead created (source=linkedin), prepared → approved → muhurta sweep (shubh window open, tithi 15 shukla/Dhanishta, score 100) → sent 21:51:13 via bapay.9@gmail.com, status `submitted`, is_sandbox=0, sentToday 4→5. NOTE: channel was pattern-guessed hr@josys.com (pre-rule-correction send) — engine now forbids that; Josys posting has no email evidence, correct future path = Ashby ATS (jobs.ashbyhq.com/josys, verified live) or LinkedIn portal apply.
- [x] Duplicate-apply guard verified: re-apply/prepare on already-applied leads returns needs_info/"already in pre-apply queue (sent)".

## Recently completed (2026-08-27 session — user defect fixes)
- [x] **Defect 1 — repeated sent mails (root cause fixed)**: duplicate emails for the same job came from the retry loop INSERTing a fresh `applications` row per attempt while the SMTP relay was down (ECONNREFUSED ::1:587 — two dead `portal:*` mail accounts active in DB). Fixed: failed application rows are retried IN PLACE (never new rows); RetryBackoffService skips queue-governed leads (FR-19: user approves resends) and permanent failures; bogus portal mail accounts deactivated; gmail account's 15/day cap now rolls over with the calendar (stale `sentToday` was permanently blocking the only healthy mailbox).
- [x] **Defect 2 — CV experience mangling (root cause fixed)**: ProfileOptimizer hid stints <5 months with NO last-job exception (Indus Net Apr–Aug 2026 dropped!) and AtsCvBuilder sorted experience by JD-keyword relevance. Fixed per user rule (FR-23): descending join/leave order; only <4-month non-last stints hidden; last job NEVER removed. Verified: Indus Net kept + first, only Veritos (2 mo) hidden.
- [x] **Defect 3 — unapproved sends at ~14:55 (process + code fixed)**: assistant auto-approved 4 queue items after a timed-out approval question (Quantumloop/Gramian/Anatta sent, Iqra failed). User rule now in REQUIREMENTS FR-17.6: **silence is never approval; nothing sends without explicit user `approve`** — own judgment only when the system is "near to perfection". Code hardening: retry service cannot auto-resend queue-governed leads; portal caps no longer block the email channel (FR-17.8); stored w3.org channels nulled → manual-apply.
- [x] learning_weights `metric_key` → `metricKey` column-name fix (was spamming errors on every record attempt).
- [x] **Education history — same rules as experience** (user rule "same to education history"): education was hardcoded in the CV builder (never read the profile). Added `educationJson` column (entity + DB + DTO + response), seeded MCA 2005–2008 + BCA 2002–2005; optimizer returns education sorted descending by start/end; builder renders all entries from data (no drops, no relevance ordering), HK-dir line kept. Verified: shuffled input → MCA first, BCA second in the PDF.
- [x] **Major projects section** (user rule: "in profile also have major project worked section — fetch project details from my CV or linkedin or indeed, so you can add remove them as per the job skill requirement"): added `projectsJson` (entity + DB + DTO + GET /profile); seeded the 9 real projects from `Downloads/Swarna_Sekhar_Dhar_Final_ATS_CV (1).docx`. Optimizer keeps all; CV builder selects/orders by JD skill overlap (matched×2, all×1), top-2 always shown, cap 5 — verified: Node/NestJS JD surfaces modernization+tracking module first, PHP/CodeIgniter JD surfaces govt apps+insurance first, non-matching projects dropped. Also fixed latent PDF race: builder now awaits the write stream's `finish` so generated PDFs are complete when returned (was awaiting doc 'end' — half-written files under back-to-back generation).

## Recently completed (2026-08-27 session — astro + pre-apply phase)
- [x] **HR-channel hardening** (bug discovered during pre-apply review): w3.org accessibility-badge address was being picked as HR channel from naukri page footers (3 staged + 1 already-sent app affected). Fixed: noise list expanded, page-scan domain guard (foreign-domain emails dropped), domain resolution rewritten (DoH A-record checks + DDG result-link-only parsing + portal/badge domain blacklist). Held items with unresolvable channels now fall to manual-apply.
- [x] **A1 Group careers adapter** (`a1group` source, jobs.a1.com): data API reverse-engineered from job-listing block bundle — `GET /wp-json/a1-group/v1/filter-jobs?country=<slug>` (6 countries, 193 jobs live; per_page capped at 6 → page param); German-language veto (w/m/d, :in, ä/ö/ü/ß, German role words) + IT-role filter like Norway adapter; Workday apply URL resolved per lead and embedded for channel detection; Workday added to DirectChannelDetector; registered in Scout + ApplyEngine. Apply = Workday ATS → staged in pre-apply queue (FR-19 company-site rule).
- [x] finn.no adapter committed (SSR job scrape + Vend OTP login flow)
- [x] FR-16 Astro module: MuhurtaService (panchanga via astronomy-engine, dynamic Lahiri aligned with MyLife shared ephemeris), shubh-window API — multiple windows/day, rahu kala/yamaganda/amavasya/ganda-mula vetoes verified
- [x] FR-16 Job astro-match scoring (lead astro score + reasons)
- [x] FR-17 Pre-apply queue entity/service (prepare → review → approve/hold/upload-cv → muhurta send)
- [x] FR-17 MuhurtaSendService: sweep approved items at shubh windows — E2E verified (prepare→approve→sweep→sent, sandboxed)
- [x] FR-18 Per-portal cap 27 (apply_settings.maxPerPortal) + hourly scout (SCOUT_INTERVAL_MINUTES=60)
- [x] Pre-apply dashboard page `/pre-apply-page` (review CV + email + channel + astro plan; hold/pause/upload/approve)
- [x] Auto-apply loop switched to prepare-only mode
- [x] Astro scoring tables documented in REQUIREMENTS.md FR-16 (tithi/nakshatra/weekday lists, segments) — user may tune via env
- [x] Panchanga engine INDEPENDENTLY VERIFIED vs published panchang for 2026-08-27:
      Shukla Chaturdashi (tithi 14) + Dhanishta + Thursday + Rahu kaal ~13:59–15:36
      (HT, bhaktiras.net, samvat.in, kundligpt all agree with engine output)

## Completed
- [x] Repo scaffold: NestJS + TypeORM + MySQL, MVCR, shared config (MyLife standards)
- [x] Git: dev branch, remote github.com/methakon/my-job-agent, conventional commits
- [x] DB `myjob_agent` created; dedicated MySQL user
- [x] Entities (8): candidate_profile, job_leads, applications, question_answers,
      apply_settings, status_updates, interview_questions, mail_accounts
- [x] Profile module: upsert, completeness score, missing-field surfacing
- [x] Profile optimizer: short-stint hiding (<5mo), same-company merge, CV-ready variant
- [x] Scout adapters: Remotive, RemoteOK, Norway (englishjobs.no) — verified live
- [x] Lead scoring vs profile skills; cron + manual trigger
- [x] Apply engine: priority chain ATS → HR email → easy-apply; kill switch;
      per-source toggles/caps
- [x] Direct-channel detector: Greenhouse/Lever/Workable/Ashby + HR emails
      (Greenhouse offers verified via public API)
- [x] Mail accounts in DB (Gmail primary / Outlook backup), AES-256 encrypted
      app-passwords, failover, 15/day cap
- [x] Human email composer (varied openers/closers, no boilerplate)
- [x] Answer bank with profile-derived seeds; needs_info flow for unknown questions
- [x] Interview prep bank + per-lead practice sets
- [x] Email tracker (IMAP poll → status_updates with HTML content)
- [x] Dashboard UI at `/` (score, leads inbox, applications, settings)
- [x] Swagger at `/docs`
- [x] Docs: REQUIREMENTS.md + PROJECT_DETAILS.md (living docs, updated per prompt)

## Recently completed (2026-08-26 / 2026-08-27 session)
- [x] Monster / foundit India adapter (`MonsterAdapter`) live in Scout + ApplyEngine
- [x] Interactive Interview Practice Prep bank & page live at `/interview-practice-page`
- [x] Dashboard: Mail accounts management panel live (`GET/POST /mail/accounts`)
- [x] Dashboard: Interview practice card with link to `/interview-practice-page`

## Recently completed (2026-08-25 night session)
- [x] Scorer fix: title veto (designer/QA/sales etc. never match), URL/HTML
      boilerplate stripped, title-hit or 3+ skill rule — bad leads purged
- [x] RetryBackoffService: failed applications auto-retried at 5→10→20→30min,
      max 4 attempts; applications.retryCount column
- [x] **SIDE-INCOME MODULE**: researched opportunities matched to user's
      constraints (min involvement, zero-min investment, 11 Pound Road
      Berhampore space): CSC VLE (92%), Amazon IHS (88%), Valmo/Meesho (85%),
      Delhivery counter (75%), Amazon Easy (70%) — each with cost breakdown,
      requirements, documents, apply steps, scam warnings; API + dark-theme
      dashboard page at /side-income-dashboard/dashboard with status buttons

## Recently completed (2026-08-25 evening session)
- [x] node-rsa import fix (exports {NodeRSA, default})
- [x] Naukri adapter registered in ApplyEngine (was scout-only) — apply works
- [x] **NAUKRI APPLY END-TO-END VERIFIED**: real application submitted
      (77% match SDE @ Bankbazaar, Remote); cloudgateway apply-workflow payload
      per NopeRi reference; applicationHistory() method added for tracking
- [x] FR-13 Deep HR-email investigation: job page curl → domain resolve →
      career pages → pattern-guess + MX verify; pattern-guesses usable per
      user rule (posters often use official mailboxes)
- [x] **AUTO-APPLY LOOP LIVE**: nightly 6h cron + POST /auto-apply/run;
      applies leads ≥40% match, max 8/run, 90s human-like pacing,
      kill-switch + completeness gates. FIRST RUN: multiple real Naukri
      applications auto-submitted

## Earlier completed (2026-08-25 day session)
- [x] AtsCvBuilder: JD-tailored ATS PDF CV — verified valid 1-page PDF
- [x] FR-10 ProcessLearningService: JD-stated application-process detection
- [x] FR-11 Self-improvement engine scaffold (outcome recording + stats)
- [x] FR-12 Gmail SMTP live; IMAP OTP auto-read + recruiter reply polling

## Pending — engineering
- [x] **Yahoo Finance interim market-data fallback** — implemented and verified 2026-09-01: configurable chart polling with symbol-to-instrument mapping, timeout/error status, throttled snapshot persistence, and no order-placement dependency. It is limited to Yahoo-supported underlying/index proxies until FYERS credentials and a validated option-chain source are available.
- [x] **Yahoo interim duplicate-candle guard + five-session paper plan** — repeated Yahoo polls for the same 1-minute candle are deduplicated per instrument before persistence/status counting; regression coverage is in `scripts/market-feed-guard.test.js`; paper-only risk and execution rules are documented in `docs/FNO_PAPER_PLAN.md`.
- [x] **F&O option contract/quote persistence slice** — explicit contract metadata (symbol, underlying, expiry, strike, CE/PE, lot size, tick size) and provider quotes (LTP, bid/ask, volume, open interest, optional Greeks, timestamps) are implemented in `fnf_option_contracts`/`fnf_option_quotes`; REST registration/inspection/ingestion routes are live; schema creation and production PM2 restart were verified 2026-09-01. No option symbol guessing and no broker order-placement path.
- [x] **Yahoo historical underlying import** — added `scripts/fetch-yahoo-history.js` for retry-safe Yahoo daily OHLCV imports (`5y`/`1d` default) into `fnf_market_snapshots`; verified 3,702 rows fetched and inserted, then a complete rerun inserted 0 duplicates. Underlying/index history only; CE/PE historical quotes remain blocked pending a validated broker derivatives source.
- [ ] **F&O options — complete live paper-trading slice**: use FYERS live market-data WebSocket as primary, with the opt-in Yahoo Finance chart polling fallback for underlying/index proxies until FYERS credentials are available; add Greeks-derived validation, bid/ask spread and liquidity freshness checks, margin/max-loss validation, option-specific paper fills/costs/P&L, and tests. Never call live order placement from sandbox/paper mode.
- [x] **Indus folder — documents checked & sectionised; profile update with verified facts** — DONE 2026-08-27 (commit 5f85e8d + profile PUT): folder sectionised (education/, identity/, offerletters/, release_experiance/, payslip/, ageproof/); all docs OCR'd; profile now 11 verified stints + 4 education entries (added Supercon Jun 2012–18-08-2013, MGTathya/MGTS 19-08-2013–18-08-2014, Sharad Jul–Oct 2020, Espirit Oct–30-11-2020; fixed Experis to 21-07-2020; added 10th WBBSE 1999 + 12th WBCHSE 2002 with %/division); exact dates from letters stored & rendered ("19 Aug 2013" style); golden-CV job descriptions added for the 4 new stints; HK-dir junk line removed from AtsCvBuilder; optimizer/builder now parse day-level dates (monthsBetween + fmt). WebTek (Sep–Dec 2015, terminated) deliberately NOT added — user's own golden CV omits it, <4 months.
- [x] **Tag-<4-month + LinkedIn easy-apply policy** (user instruction verbatim 2026-08-27): "keep all of them in profile section document tagged for those who are less than 4 month but ignore them while creating tailored cv for sending or appliying . and for linkedin easy apply use the last uploaded cv only no need to custom tailor them". IMPLEMENTED 2026-08-27: profile.dto.ts + candidate-profile.entity.ts + profile-optimizer.service.ts + ats-cv-builder.service.ts: tagged boolean on WorkStint/CvWorkStint/ProfileResponseDto workHistory entries; profile-optimizer now TAGS stints <4 months (tagged:true) instead of dropping them — Veritos/Espirit/Sharad preserved with flag, last job never tagged; ats-cv-builder filters !s.tagged before rendering experience — tagged stints stay in profile doc but never appear on tailored CVs; apply-engine skips buildCv for LinkedIn (lead.source==='linkedin') and uses profileService.getLastUploadedCvPath() — no per-JD tailoring; candidate-profile entity + profile.service + profile.controller + profile.dto: lastUploadedCvPath column + GET/PUT /profile/linkedin/cv endpoints; DOB confirmed: official=1982 (PAN+10th cert), astro=1981 — both stored, profile/CV uses 1982, astrology uses 1981.
- [x] **DOB discrepancy — CONFIRMED** (2026-08-27): PAN card ALMPD4210G + 10th certificate both read 09/12/1982; memory/astrology chart says 09-12-1981. User confirmed: official mention = 1982, astrology = 1981. Both stored; profile/CV uses 1982, astrology calculations use 1981.
- [x] **Company-redirect application handling — DETECTION SLICE DONE 2026-09-03** (FR-19, **always-company rule**: no quick apply → ALWAYS apply via company website, never skip/email-only): `direct-channel.detector.ts` now resolves the apply channel in this order — (1) ATS board links (Greenhouse/Lever/Workable/Ashby/Workday, Greenhouse verified live via boards-api), (2) company apply-page links found in the description (any non-portal host whose path points at a SPECIFIC posting, e.g. `company.com/jobs/<role>`), (3) the posting URL itself: non-portal/non-board hosts get an HTTP redirect-chain probe (max 5 hops, 8s) and the final URL is classified — board → canonicalized ATS target; specific posting → ats target (`company-redirect`/`company-apply-page`); careers INDEX (`/careers`, `/careers/jobs`) → intentionally NOT drivable, left to email/portal/manual paths, never silently skipped. Company apply pages are driven by the existing FR-15 browser form-filler which stops before submit unless `AUTO_SUBMIT_BROWSER` is set — so the always-company target is staged, never auto-sent. Portal hosts (naukri/linkedin/indeed/remoteok/…) are never treated as direct channels (unchanged). Verified: 15-case classifier test (`scripts/company-channel.test.js`) + live probes — Stripe `/jobs/listing/…` redirected to `/careers/listing/…` (canonicalized), BiharTechno caught via description link, Coinbase `/careers/jobs` index correctly null, Naukri portal null. Committed on dev 2026-09-03. Remaining FR-19 work: [ ] login/register walls on company forms (automate where legitimate or flag manual with staged URL + prefilled data — largely covered by the filler's needs_info staging) and [ ] careers-INDEX leads (resolve index → specific posting where the company publishes one). Added 2026-08-27 (user request).
- [ ] **CV format by geo-location + employer preference** (FR-4 geo-format rule, 2026-08-27): CV format chosen depending on the job's geographic location and the format type preferred there (US-style resume vs EU/Europass-compatible vs India-style), ALWAYS in ATS format, language ALWAYS English; regional template picked from lead.geo/posting location. Not yet encoded in AtsCvBuilder.
- [ ] **Quick-question section enhancement**: `/quick-question` (or equivalent) should take free-text input from the user — user asks a question (e.g. about a lead, scoring, muhurta, next steps) and gets an answer; not just canned/static. Added 2026-08-27 (user request).
- [ ] **Live list update while applying through portal**: leads/applications list should refresh in real time as the apply run progresses through the portal (per-item status: preparing → submitting → submitted → failed + error), so the same list can be reused/monitored without manual refresh. Added 2026-08-27 (user request).
- [x] **New sending email + reply tracking on both mailboxes** (2026-08-28): job-application emails send from `swarna.s.jobs@gmail.com` ONLY (primary sender, no fallback; Naukri/LinkedIn keep old email via portal creds); `EmailTrackerService` polls ALL active `mail_accounts` via IMAP (encrypted app passwords) — no longer env-var IMAP creds (they were empty, tracking never ran). Noise-filtered (newsletters/orders/spam), links to applications via lead company, stores contentHtml + created_at date-wise. DONE + verified 2026-08-28 (Marriott/Albertsons rejections + Continental in_review linked to app d70f4276).
- [ ] finn.no adapter (scrape English-jobs filter + OTP login flow with bapay.9@gmail.com) — scrape LIVE (English/IT filter + Norwegian-char drop in place); login blocked on captcha verdict (NO bypass → one-time manual session-cookie capture, user hasn't chosen)
- [x] A1 Group careers adapter (jobs.a1.com) — DONE 2026-08-27: data API found (`/wp-json/a1-group/v1/filter-jobs?country=<slug>`, 6 countries/193 jobs, page-paginated, per_page capped at 6); German-language + non-IT veto; Workday apply URL resolved per lead; Workday in DirectChannelDetector; registered Scout + ApplyEngine. Apply via Workday ATS staged in pre-apply queue.
- [ ] LinkedIn easy-apply adapter (session cookie; toggle OFF by default)
- [ ] Production hardening: synchronize:false + migrations, helmet, rate limit

## Blocked on user
- [🚫] **DOB: PAN + 10th cert say 09/12/1982, chart/memory says 09/12/1981 — confirm which** (flag 2026-08-27; affects astrology chart)
- [🚫] Outlook app-password → backup sender (optional; Gmail primary live)
- [🚫] LinkedIn li_at session cookie (if easy-apply wanted)
- [🚫] GitHub/portfolio URL → profile completeness 100%
- [🚫] HK-dir statement PDF path (attach to Norway applications)

## Verification checklist (per release)
- [ ] tsc clean + nest build passes
- [ ] Service boots; GET /profile, /leads, /settings return data
- [ ] Scout pulls leads from all enabled sources
- [ ] One test application generates tailored PDF + human email draft
