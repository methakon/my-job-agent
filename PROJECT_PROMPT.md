# My-Job Agent — Project Prompt & Resume File

**Purpose:** Autonomous job-search agent for Swarna Sekhar Dhar — scouts jobs,
tailors ATS PDF CV per job description, applies directly (JD-stated process →
company ATS → HR email → portal easy-apply last), tracks both-side history,
self-improves from outcomes.

## Resume rule
When the user opens Hermes in this folder (`~/projects/my-job-agent`) and says
**"continue"**, read this file's TODO and the docs below, then resume work.
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

## TODO next session (in order)
1. **Pre-apply queue is FULL (10 ready items, astro 35–95)** — user reviews at
   `/pre-apply-page` and approves; MuhurtaSendService sweep (10 min) batch-sends
   all approved inside the next shubh window (today: 06:56–13:16 IST, then
   14:56–05:16 IST next day). Sandbox currently OFF (real sends once approved).
2. **Verify astro scoring tables with user** — tithi/nakshatra/weekday lists
   + rahu/yamaganda/gulika segments are documented in REQUIREMENTS.md FR-16
   and service header; user may tune (env: SHUBH_MIN_SCORE, MUHURTA_SWEEP_MINUTES).
   Engine cross-checked vs published panchang 2026-08-27 ✓ (Shukla Chaturdashi,
   Dhanishta, Thursday, rahu kaal ~13:59–15:36 — HT/bhaktiras/samvat/kundligpt agree).
3. **A1 Group careers adapter (jobs.a1.com)**: WordPress; REST live; real
   vacancy list renders client-side via block `./job-listing/assets/index.js`
   — next step: read that block's JS for the data source/fetch params.
4. **Activate LinkedIn snapshot** (user action): save profile HTML into
   data/linkedin/profile.html → POST /linkedin/refresh. Then CV tuning is live.
5. **finn.no login**: captcha verdict NO bypass — legitimate path = one-time
   manual session-cookie capture (user hasn't chosen). Scrape side live.
6. LinkedIn easy-apply via li_at cookie (toggle OFF by default).
7. Outlook app-password (optional backup sender) — pending from user.
8. GitHub/portfolio URL for profile → completeness 100% — pending from user.
9. **Company-redirect apply handling** (FR-19): jobs whose apply link redirects
   to the company's own page — detect, drive form (FR-15 rules), and if the page
   needs login/register, handle that too (legit automation or flag manual-apply
   with staged data in pre-apply queue).
10. **Quick-question user input** (FR-20): `/quick-question` takes free text
    from user; answer from live state (leads, astro, muhurta, applications).
11. **Live list updates while applying** (FR-21): per-item status transitions
    (preparing → submitting → submitted → failed → sent) visible live on the
    dashboard during /auto-apply/run; list stays consistent after run.

## Gotchas / lessons
- pdfkit must be required (not ES-imported): `const PDFDocument: any = require('pdfkit')`
- TypeORM can't infer types from `string | null` unions — always set explicit column type
- Naukri search needs BOTH nkparam header AND login cookies (appid 109/systemid Naukri)
- pkill kills our own shell sometimes — use targeted patterns or ss -tln to check port
