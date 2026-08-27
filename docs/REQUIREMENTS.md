# my-job-agent — Requirements Analysis & Project Details

> **Living document.** Every new user prompt that adds or changes a requirement
> MUST be reflected here (Requirements section) before implementation.
> Last updated: 2026-08-27

## 1. Vision

An autonomous job-search agent for **Swarna Sekhar Dhar** that scouts matching
jobs across portals, tailors application material per job description, and
applies on his behalf — asking him only when information is genuinely missing.
Applications are timed to **shubh muhurta** (auspicious windows per Vedic
panchanga) and gated by a **pre-apply review queue** the user controls.

## 2. Candidate profile facts

- Name: Swarna Sekhar Dhar; Kolkata, India; +91 9007291400; bapay.9@gmail.com
- ~16–17 yrs experience; target roles: **Senior Developer / Backend Developer** only
- Education **verified via HK-dir** (Norway recognition) → eligible for
  Norwegian Skilled Worker permit route
- Birth data (astro): b. 9 Dec 1981, 01:00 IST, Berhampore (24.1N 88.25E);
  Lahiri: Virgo lagna (Saturn+Mars), Moon Aries Bharani; Rahu MD → 2037
- Salary policy:
  - International remote: **$35k+/yr (~30+ LPA equivalent)**
  - India remote/onsite: **15–18 LPA** (last CTC 8 LPA; Kolkata; no house rent)
- Notice period: 30 days
- Source CV: `~/Downloads/Swarna_Sekhar_Dhar_Final_ATS_CV (1).docx`

## 3. Functional requirements

### FR-1 Profile management
- Master candidate profile stored in DB; completeness score (target ≥ 90%).
- Sources: public career data, uploaded ATS CV, dashboard edits.
- Missing fields surface in dashboard; applications pause (`needs_info`) until filled.

### FR-2 Lead scouting
- Public-API adapters: Remotive, RemoteOK.
- Norway adapter (englishjobs.no markdown feed) — English-speaking software jobs;
  leverages HK-dir eligibility for Skilled Worker route.
- Planned portals (user may add anytime): finn.no, Naukri, Monster, LinkedIn,
  A1 Group careers. Adapter registry pattern — one file per portal, no core changes.
- Cron every SCOUT_INTERVAL_MINUTES (default **60** = hourly, user rule 2026-08-27)
  + manual trigger endpoint.
- Skill-match scoring vs profile; leads below relevance threshold are not stored.

### FR-3 Application channel priority (user rule)
1. **Company website / ATS** (Greenhouse, Lever, Workable, Ashby) when linked in
   the posting — Greenhouse offers verified live via public API.
2. **HR email** found in posting → send tailored email + PDF CV via SMTP.
3. **Portal easy-apply only as last resort.**
- **Always-company rule (added 2026-08-27, user rule): whenever quick apply is
  NOT available, ALWAYS apply through the company website** — do not skip the
  lead and do not fall back to email-only; drive the company's own application
  page per FR-19 (redirect detection + form automation per FR-15, incl. the
  login/register scenario). Quick apply (portal easy-apply) is used only when
  the company-website route is genuinely not available (no apply link, no
  discoverable ATS, company site down/geo-blocked).
- Global kill switch (`APPLY_KILL_SWITCH`) + per-source toggles + daily caps.

### FR-16 Astro-enabled application timing — shubh muhurta (added 2026-08-27, user rule)
The agent is **enabled with the astro skill** and applies only in auspicious
moments computed from the user's Vedic chart and live panchanga:
1. `AstroMuhurtaService` computes real panchanga (tithi, nakshatra, weekday,
   rahu-kala, yamaganda, gulika) for the user's timezone (IST, UTC+5:30) using
   `astronomy-engine` (pure-JS ephemeris, Lahiri ayanamsa = 24° sidereal).
2. **Shubh-window rules** (Parashari panchanga defaults, configurable):
   - Auspicious tithis: 2,3,5,7,10,11,13 (shukla preferred; 1,4,6,8,9,12,14,15 avoided)
   - Auspicious nakshatras: Rohini, Mrigashira, Punarvasu, Pushya, Uttara Phalguni,
     Hasta, Swati, Anuradha, Uttara Ashadha, Uttara Bhadrapada, Revati
   - Favorable weekdays: Mon (Moon), Wed (Mercury), Thu (Jupiter), Fri (Venus);
     Sat/Sun/Tue only if tithi+nakshatra both auspicious
   - **Rahu kala always avoided** (weekday-specific ~90-min window after sunrise)
   - Moon-sign check vs lagna: Moon in 1/3/6/10/11 from Virgo lagna preferred
   - Score ≥ SHUBH_MIN_SCORE (default 60) = shubh muhurta
3. Every application records its `muhurtaWindow` (JSON: window start/end,
   tithi/nakshatra/score/reasons) so timing is auditable.
4. A send is deferred to the next shubh window when the current moment is
   inauspicious (auto-apply path); manual approvals may override with
   `force=true` (user takes responsibility).

### FR-17 Pre-apply review queue (added 2026-08-27, user rule)
No application is sent unseen. Every candidate application is first
**prepared** (tailored ATS PDF CV + human email draft + detected channel +
astro muhurta plan) and parked in a `pre_apply_items` queue:
1. **Prepare** (`POST /pre-apply/prepare/:leadId`): builds CV + email draft +
   channel + astro plan; status `ready`. **Nothing is sent.**
2. **Review** in dashboard `/pre-apply-page`: user sees exactly what will be
   sent (CV download, email preview, channel target, match + astro scores,
   planned muhurta window) before anything goes out.
3. User actions per item:
   - `approve` → scheduled to send at next shubh muhurta (`force=true` sends now)
   - `hold` → paused indefinitely (user wants to correct the CV first)
   - `upload-cv` → replace the tailored CV with a manually corrected PDF
     (user rule: "uploading manually in pre-apply list") — the corrected CV
     is what gets sent after approval
   - `resume` → back to ready after editing
4. Auto-apply loop **prepares only** (never sends directly); a separate
   `MuhurtaSendService` sweeps approved items at the top of each shubh window
   and submits them through the normal channel chain.
5. Portal **cap 27 applications** (user rule): `apply_settings.maxPerPortal`
   defaults to 27 per portal; engine refuses when a portal's submitted
   application count reaches the cap.
6. **Explicit approval only — silence is NEVER approval** (user rule, added
   2026-08-27 after an incident where a timed-out approval question was
   auto-approved and 3 jobs were emailed without the user's consent):
   approval questions must never auto-approve on timeout; nothing sends
   without the user's explicit `approve`. Own-judgment/auto-approval may be
   enabled only when the system is "near to perfection" (user rule) — not at
   this early stage.
7. **Retries never duplicate** (user defect report 2026-08-27: repeated sent
   mails for the same job): a failed application row is retried IN PLACE
   (same row updated, backoff 5/10/20/30 min, max 4 attempts); retries never
   INSERT new application rows. RetryBackoffService additionally skips any
   lead that has a pre-apply queue item (queue governs resends) and skips
   permanent failures (kill switch, caps, already-applied).
8. **Portal caps never block the HR-email channel** (user defect report
   2026-08-27): `maxPerPortal` and per-source daily caps apply to
   portal/ATS submissions only; email sends are governed solely by the
   MailService mailbox cap (15/day/account, calendar-day rollover).

### FR-18 Hourly fetch + cap (added 2026-08-27, user rule)
- Scout interval default changed **6h → 1h** (SCOUT_INTERVAL_MINUTES=60):
  newly listed jobs are fetched every hour.
- Per-portal application cap **27** (`maxPerPortal` on apply_settings,
  default 27; enforced in ApplyEngine before any submission attempt).

### FR-22 A1 Group careers source (added 2026-08-27)
- Source: `a1group` (jobs.a1.com — A1 Telekom Austria Group, 6 countries:
  Austria, Bulgaria, Croatia, North Macedonia, Serbia, Slovenia).
- Data API (reverse-engineered from the job-listing block bundle):
  `GET https://jobs.a1.com/wp-json/a1-group/v1/filter-jobs?country=<slug>`
  — JSON items {id, title, url, company, location, type{category,timeType,
  remoteType}}; `per_page` capped at 6 server-side, paginate via `page=`.
- Language filter (user rule, mirrors Norway adapter): German-language
  postings dropped — veto on (w/m/d), (m/w/d), `:in`, ä/ö/ü/ß and German
  role words (Mitarbeiter, Praktikum, Verkauf, Berater); non-IT roles
  (sales/shop/retail) dropped too. English + IT keyword roles kept.

### FR-23 CV professional-experience rules (added 2026-08-27, user rule)
The ATS CV builder renders PROFESSIONAL EXPERIENCE strictly per user rule
(verbatim: "it can remove only the company which i have worke duration of
less than 3-4 month but last job should not be removed"):
1. **Order**: descending by start (join) date, then end (leave) date —
   newest role first. NEVER reorder by JD-keyword relevance (that was the
   "random arrangement" defect).
2. **Drop rule**: a stint may be hidden ONLY when its duration is under
   4 months AND it is not the most recent role. The **last job is NEVER
   removed**, whatever its duration. Stints ≥ 12 months are never removed.
3. Same-company adjacent stints merge (earliest join → latest leave);
   `present` sorts as latest.
4. **Education history gets the same treatment** (user rule, added 2026-08-27):
   all education entries from the profile (`educationJson` — school, degree,
   from, to, note) are rendered, strictly descending by start then end date,
   never dropped, never relevance-ordered. Profile API (GET /profile) and
   the upsert DTO expose `education`; seeded with MCA (T. John College,
   2005–2008) + BCA (Dumkal Institute, 2002–2005); the HK-dir Norway
   recognition statement line stays after the list.
5. **Major projects section — profile + JD-driven selection** (user rule,
   added 2026-08-27): profile stores `projectsJson` (name, client?, tech[],
   from?, to?, summary?) via the upsert DTO and GET /profile response;
   seeded with the 9 projects from the user's Final ATS CV. The CV builder
   selects/orders projects by overlap with the job's skills (matchedSkills
   ×2, allSkills ×1), tie-broken by recency; the top 2 are always shown,
   further projects only when they overlap the JD; capped at 5. Only real
   profile projects are ever rendered — never fabricated.
6. **CV PDF flush guarantee**: AtsCvBuilder awaits the write stream's
   `finish` (not the document's `end`), so callers never read a
   half-written PDF.
- Apply chain: A1 uses **Workday** ATS (a1group.wd3.myworkdayjobs.com).
  Adapter resolves the Workday apply URL from each kept lead's detail page
  at scrape time and embeds it in the lead so the direct-channel detector
  labels it `workday` (company ATS) and the pre-apply queue stages it
  (FR-19: no quick apply, company site only; Workday needs an account →
  staged as manual-apply until browser automation covers it).
- Workday pattern added to DirectChannelDetector ATS_PATTERNS.

### FR-10 JD application-process detection (added 2026-08-25)
Before applying anywhere, the agent READS the job description for an explicit
application process ("send CV to x@y.com", "apply via Greenhouse", "apply
online at our portal") and follows THAT stated process first — before
detector-found channels and long before portal easy-apply.

### FR-11 Self-improvement engine (added 2026-08-25)
The agent is self-improving: every outcome (submitted / replied / rejected /
needs_info reason) feeds learning weights — channel success rates, which CV
keywords get responses, best send hours, per-portal success. Future behaviour
(cover-letter emphasis, channel choice, send timing) adapts from these stats.
Scaffold live in ProcessLearningService; weights persistence next iteration.

### FR-13 Deep HR-email investigation (added 2026-08-25; AMENDED 2026-08-27 — evidence-only)
When a job description itself contains no HR email, the agent investigates
before giving up, in escalating steps:
1. Curl the actual job posting URL → scan page for emails.
2. Find the company's website (from lead data / search) → curl careers/jobs
   page → scan for HR/careers email.
3. Try common career-page paths: /careers, /jobs, /about, /contact,
   /careers/join-us etc.
**EVIDENCE ONLY (user rule 2026-08-27 — supersedes 2026-08-25)**: pattern-guessing
role mailboxes (hr@, careers@, jobs@, talent@, recruiting@, hiring@) is FORBIDDEN.
A guessed address is never a channel. Only addresses actually found on the JD,
job page, or company pages (domain-guarded against noise/footers) may be used.
If no evidence-based contact exists, the engine falls through per channel
priority: portal easy-apply with the LAST UPLOADED CV (no tailoring) or the
company ATS link (external apply link → company portal).
Every discovered address is cached in the DB with its source and confidence
so future applications to the same company reuse it. Confidence is logged on
every application record.
### FR-12 Email inbox reading — OTP + replies (added 2026-08-25)
1. **OTP auto-read:** when a portal login/signup sends a verification code,
   the agent fetches it from the inbox automatically and completes the
   login (no manual OTP input needed).
2. **Recruiter reply polling:** application-related replies feed the
   tracking table and the self-improvement loop.

### FR-15 Browser automation for portal forms (added 2026-08-26)
For portals without a usable HTTP API (Workday, Taleo, some Lever forms),
the agent drives a real headless Chromium via Playwright:
1. Load the application URL; detect form fields by label/placeholder/name.
2. Fill from profile data + answer bank; unknown questions → needs_info.
3. Upload the tailored ATS PDF CV when a file input exists.
4. STOP BEFORE FINAL SUBMIT unless AUTO_SUBMIT_BROWSER=true — user reviews
   in dashboard first (safety default). Screenshot saved at every step to
   `generated/browser/` for audit.
5. Kill-switch + per-source caps apply as everywhere else.

### FR-14 Nightly auto-apply loop (added 2026-08-25, user approved;
**modified 2026-08-27: prepares-only, muhurta-gated send**)
Every hour (aligned with scout) the agent **prepares** applications for all
stored leads with match score ≥ 40% (AUTO_APPLY_MIN_MATCH), up to 8 per run
(AUTO_APPLY_MAX_PER_RUN), with ~90s human-like pacing between preparations.
**No submission happens in the loop** — items land in the pre-apply queue
(FR-17) for user review; sending is performed by MuhurtaSendService at the
next shubh window after approval. Gates: global kill switch, profile
completeness, per-source daily caps, single-run lock. Manual trigger:
POST /auto-apply/run.

### FR-4 Per-job document tailoring (user rule)
- Agent reads each job description and **rewrites the CV to suit it**, then
  renders an **ATS-friendly PDF** (single column, standard headings,
  matched skills first, relevant experience bullets promoted):
  `AtsCvBuilder` (pdfkit). Attached automatically to every application.
- **Geo-format rule (added 2026-08-27, user rule): always choose the CV format
  depending on the geographic location of the job and the format type
  preferred there** — e.g. US-style resume (no photo, no DOB, summary line),
  EU-style CV (Europass-compatible, often with photo/DOB optional per country:
  Germany/Austria prefer photo, UK/IE lean US-style), India-style (photo +
  DOB + marital status common). The generator picks the regional template
  matching the employer's country/region (lead.geo or posting language/location).
- **ATS format always**: whatever the regional style, output must stay
  ATS-parseable — single column, standard section headings, no tables/images/
  text boxes, machine-readable PDF text layer.
- **Language always English** (user rule) — regional formats are about layout/
  fields, never language; English text throughout.
- Cover letters/email bodies written in **human style** — varied openers/
  closers, references actual job + matched skills, no corporate boilerplate
  (`HumanEmailComposer`).

### FR-5 Profile optimization rules (user rules)
- Short stints (< 5 months) hidden from generated CVs (e.g. Veritos 2 mo).
- Same-company designation changes merged into one entry with combined period
  and joined role titles (Han River Feb 2021–Feb 2025 as one block).
- Skill list trimmed per job: only backend-relevant skills highlighted for
  Senior/Backend Developer targeting; legacy stack stays in history only.

### FR-6 Answer bank (custom questions)
- Common questions auto-seeded from profile (notice period, salary, location).
- Unknown questions → application paused as `needs_info`; answer saved once
  and reused forever.

### FR-7 Interview preparation
- Seeded question bank (NestJS/TS/MySQL/system-design/HR) with answer guides.
- Practice set generated per lead from the skills that lead mentions.

### FR-8 Application tracking (user rule: both sides, with content)
- Every submission logged with status timeline.
- IMAP polling of replies (Gmail/Outlook); matched replies stored as
  StatusUpdate rows with timestamp + original HTML body preserved.
- Portal-side events recorded alongside email-side events.

### FR-9 Email accounts (user decision)
- Gmail = primary sender, Outlook = backup (failover).
- App-passwords created by user after 2FA; stored **encrypted (AES-256,
  APP_SECRET key) in DB table `mail_accounts`**, never in code/env.
- Daily cap 15 emails/account.

### FR-19 Company-redirect application handling (added 2026-08-27, user request)
**MANDATORY channel per FR-3 always-company rule (2026-08-27):** when quick
apply is not available, the agent ALWAYS applies through the company website.
When a job's apply link redirects to the company's own application page
(not a portal adapter the agent can drive directly), handle it:
1. Detect redirect apply URLs (http redirect chain, meta refresh, or apply-link
   pointing to the company domain rather than a known portal).
2. Visit the page and attempt submission via the company form when feasible
   (FR-15 browser automation rules apply: fill from profile + answer bank,
   upload tailored ATS PDF, STOP BEFORE FINAL SUBMIT unless
   AUTO_SUBMIT_BROWSER=true, screenshot audit).
3. If the page requires login/register: handle that scenario too — where
   legitimate (public registration without banned automation), automate
   registration/login once and reuse the session; otherwise flag the lead as
   manual-apply with the URL, prefilled data staged, and surface it in the
   pre-apply queue for the user's one-click follow-through.
4. Track outcome in applications table (channel = company_redirect, note =
   submitted_auto | needs_manual | needs_registration).

### FR-20 Quick-question section with user input (added 2026-08-27, user request)
The quick-question area must take free-text input from the user, not just
show canned questions:
1. `/quick-question` accepts a user-typed question (query param or POST body).
2. The agent answers from live service state: lead details, astro score,
   muhurta windows, application status, settings — plus the answer bank /
   profile when the question is about the user's own data.
3. Keeps a small history of recent Q&A (question_answers table reuse) so
   repeated questions can be answered instantly from the last known answer.

### FR-21 Live list update while applying (added 2026-08-27, user request)
While an apply run is in progress through the portal, the leads/applications
list must refresh in real time so it can be reused/monitored without manual
reload:
1. Per-item status transitions visible live: preparing → submitting →
   submitted → failed (+ errorDetail) → sent (muhurta sweep).
2. Dashboard/list polls or streams the run progress (SSE or short-poll of
   /pre-apply or /applications during an active /auto-apply/run).
3. After the run, the list stays consistent with the applications table
   (no stale "ready" rows for items already submitted).

## 4. Non-functional requirements

- NestJS + TypeORM + MySQL (database-per-service: `myjob_agent`, dedicated user).
- MyLife coding standards: MVCR per module, DTOs for all I/O, one entity file
  per table, thin controllers, repositories own all DB access.
- Swagger docs at `/docs`; shared db.config/env-check/swagger pattern.
- Git: repo `methakor/my-job-agent` → actually `github.com/methakon/my-job-agent`,
  branch `dev`, conventional commits, push after each milestone.
- Best practices: proper indentation, strict TypeScript, fail-fast credential check.
- Dashboard served at `/` (dark UI): profile score+editor, leads inbox,
  applications tracker, portal settings, **pre-apply review queue**.
- Astro engine is pure-JS (`astronomy-engine`, MIT) — no native builds;
  Lahiri ayanamsa constant 24° for sidereal positions.

## 5. Out of scope (current phase)

- Browser automation of LinkedIn/Naukri/Monster form filling (adapters reserved;
  enable per-source later — ban risk acknowledged by user).
- OTP solving: any portal demanding interactive verification surfaces the
  request to the user instead. reCAPTCHA is never bypassed — a genuine
  browser fingerprint renders the intended flow (invisible reCAPTCHA auto-
  passes; checkbox challenges are left for the user's one-time manual login,
  cookie capture pattern like LinkedIn li_at).

## 6. Document maintenance rule (meta)

Every future user prompt introducing a change/feature must be appended to
section 3/4 here (with date) before code changes. This file is committed with
each milestone so history tracks evolution.
