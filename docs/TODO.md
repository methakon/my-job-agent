# my-job-agent — TODO / Progress Tracker

> Updated with every session. ✅ done · 🔄 in progress · ⬜ pending · 🚫 blocked on user
> Last updated: 2026-08-27

## Recently completed (2026-08-27 session — astro + pre-apply phase)
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
- [ ] **Company-redirect application handling** (FR-19, **always-company rule**: no quick apply → ALWAYS apply via company website, never skip/email-only): when a job's apply link redirects to the company's own application page, handle it — detect redirect URLs, visit the page, and submit via the company form when feasible; if the page requires login/register, handle that scenario too (either automate registration/login where legitimate, or flag for manual apply with the URL + prefilled data staged). Added 2026-08-27 (user request).
- [ ] **CV format by geo-location + employer preference** (FR-4 geo-format rule, 2026-08-27): CV format chosen depending on the job's geographic location and the format type preferred there (US-style resume vs EU/Europass-compatible vs India-style), ALWAYS in ATS format, language ALWAYS English; regional template picked from lead.geo/posting location. Not yet encoded in AtsCvBuilder.
- [ ] **Quick-question section enhancement**: `/quick-question` (or equivalent) should take free-text input from the user — user asks a question (e.g. about a lead, scoring, muhurta, next steps) and gets an answer; not just canned/static. Added 2026-08-27 (user request).
- [ ] **Live list update while applying through portal**: leads/applications list should refresh in real time as the apply run progresses through the portal (per-item status: preparing → submitting → submitted → failed + error), so the same list can be reused/monitored without manual refresh. Added 2026-08-27 (user request).
- [ ] finn.no adapter (scrape English-jobs filter + OTP login flow with bapay.9@gmail.com) — scrape LIVE (English/IT filter + Norwegian-char drop in place); login blocked on captcha verdict (NO bypass → one-time manual session-cookie capture, user hasn't chosen)
- [x] A1 Group careers adapter (jobs.a1.com) — DONE 2026-08-27: data API found (`/wp-json/a1-group/v1/filter-jobs?country=<slug>`, 6 countries/193 jobs, page-paginated, per_page capped at 6); German-language + non-IT veto; Workday apply URL resolved per lead; Workday in DirectChannelDetector; registered Scout + ApplyEngine. Apply via Workday ATS staged in pre-apply queue.
- [ ] LinkedIn easy-apply adapter (session cookie; toggle OFF by default)
- [ ] Production hardening: synchronize:false + migrations, helmet, rate limit

## Blocked on user
- [🚫] Outlook app-password → backup sender (optional; Gmail primary live)
- [🚫] LinkedIn li_at session cookie (if easy-apply wanted)
- [🚫] GitHub/portfolio URL → profile completeness 100%
- [🚫] HK-dir statement PDF path (attach to Norway applications)

## Verification checklist (per release)
- [ ] tsc clean + nest build passes
- [ ] Service boots; GET /profile, /leads, /settings return data
- [ ] Scout pulls leads from all enabled sources
- [ ] One test application generates tailored PDF + human email draft
