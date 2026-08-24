# my-job-agent — Requirements Analysis & Project Details

> **Living document.** Every new user prompt that adds or changes a requirement
> MUST be reflected here (Requirements section) before implementation.
> Last updated: 2026-08-25

## 1. Vision

An autonomous job-search agent for **Swarna Sekhar Dhar** that scouts matching
jobs across portals, tailors application material per job description, and
applies on his behalf — asking him only when information is genuinely missing.

## 2. Candidate profile facts

- Name: Swarna Sekhar Dhar; Kolkata, India; +91 9007291400; bapay.9@gmail.com
- ~16–17 yrs experience; target roles: **Senior Developer / Backend Developer** only
- Education **verified via HK-dir** (Norway recognition) → eligible for
  Norwegian Skilled Worker permit route
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
- Cron every SCOUT_INTERVAL_MINUTES (default 360) + manual trigger endpoint.
- Skill-match scoring vs profile; leads below relevance threshold are not stored.

### FR-3 Application channel priority (user rule)
1. **Company website / ATS** (Greenhouse, Lever, Workable, Ashby) when linked in
   the posting — Greenhouse offers verified live via public API.
2. **HR email** found in posting → send tailored email + PDF CV via SMTP.
3. **Portal easy-apply only as last resort.**
- Global kill switch (`APPLY_KILL_SWITCH`) + per-source toggles + daily caps.

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

### FR-12 Email inbox reading — OTP + replies (added 2026-08-25)
The agent reads the candidate's Gmail (and later Outlook) via IMAP using the
same encrypted app-passwords stored in DB:
1. **OTP auto-read:** when a portal login/signup sends a verification code,
   the agent fetches it from the inbox automatically and completes the
   login (no manual OTP input needed).
2. **Recruiter reply polling:** application-related replies feed the
   tracking table and the self-improvement loop.

### FR-4 Per-job document tailoring (user rule)
- Agent reads each job description and **rewrites the CV to suit it**, then
  renders an **ATS-friendly PDF** (single column, standard headings,
  matched skills first, relevant experience bullets promoted):
  `AtsCvBuilder` (pdfkit). Attached automatically to every application.
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

## 4. Non-functional requirements

- NestJS + TypeORM + MySQL (database-per-service: `myjob_agent`, dedicated user).
- MyLife coding standards: MVCR per module, DTOs for all I/O, one entity file
  per table, thin controllers, repositories own all DB access.
- Swagger docs at `/docs`; shared db.config/env-check/swagger pattern.
- Git: repo `methakor/my-job-agent` → actually `github.com/methakon/my-job-agent`,
  branch `dev`, conventional commits, push after each milestone.
- Best practices: proper indentation, strict TypeScript, fail-fast credential check.
- Dashboard served at `/` (dark UI): profile score+editor, leads inbox,
  applications tracker, portal settings.

## 5. Out of scope (current phase)

- Browser automation of LinkedIn/Naukri/Monster form filling (adapters reserved;
  enable per-source later — ban risk acknowledged by user).
- OTP solving: any portal demanding interactive verification surfaces the
  request to the user instead.

## 6. Document maintenance rule (meta)

Every future user prompt introducing a change/feature must be appended to
section 3/4 here (with date) before code changes. This file is committed with
each milestone so history tracks evolution.
