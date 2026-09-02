# my-job-agent — TODO / Progress Tracker

> Updated with every session. ✅ done · 🔄 in progress · ⬜ pending · 🚫 blocked on user
> Last updated: 2026-09-01

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
- [ ] **Company-redirect application handling** (FR-19, **always-company rule**: no quick apply → ALWAYS apply via company website, never skip/email-only): when a job's apply link redirects to the company's own application page, handle it — detect redirect URLs, visit the page, and submit via the company form when feasible; if the page requires login/register, handle that scenario too (either automate registration/login where legitimate, or flag for manual apply with the URL + prefilled data staged). Added 2026-08-27 (user request).
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
