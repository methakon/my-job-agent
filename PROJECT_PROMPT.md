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

## Progress (2026-08-31)
- **Visa-sponsored-jobs guide written (235 lines, 2026-08-31)** to `VISA_SPONSORED_JOBS_GUIDE.md`: Part A step-by-step walkthrough (UK Skilled Worker lead, Germany EU Blue Card, USA H-1B strategy), Part B latest opportunity list (97 engine leads + live external sponsored openings + 8 H1B US leads), Part C tracked progress map (Phase 1–4), Part D engine live status. Guide NOT yet rendered as an in-app page — that is the next item.
- **BiCSoM Senior Node.js Developer (lead `346e6524-...`) REAL APPLICATION SENT** via Fluent Forms adapter — application `788df9cf` submitted successfully; engine patched (CV set, AUTO_SUBMIT_BROWSER=true, regex fixed, stale rows cleared). No browser popup needed — engine is API-driven.
- **Browser automation blocked on Chrome remote-debugging** — user profile has no `remote-debugging-port` flag; isolated-browser `cua_browser_prepare` timed out waiting for user approval; `focus_app(Chrome)` same timeout; `list_windows(Chrome)` returned 0 windows. Remotive job page Cloudflare-blocked via curl. Chrome-drive attempts gated behind user approval — no retry without explicit go-ahead. "immurshiv ui" thread closed by user ("OK IGNORE THEM").
- **Applications**: 36 total — 31 submitted, 4 failed (all Remotive/Lemon.io), 1 needs_info (LinkedIn Continental Industry, Bengaluru — NOT visa-sponsored)
- **Job leads**: 97 total (Naukri 67, RemoteOK 14, Remotive 5, LinkedIn 4, Norway 4, A1Group 2, BiCSoM 1) + 8 H1B US leads (Stripe, Anthropic, Klaviyo, Lyft, Coinbase, Adyen, Databricks, Airbnb)
- **Scout**: Remotive + RemoteOK + Norway + Naukri + a1group + norway + workable + micro1 + foundever + finn + BiCSoM (11 adapters)
- **Apply engine**: pm2-managed (ecosystem.config.js), systemd wrapper `pm2-swarna-sekhar-dhar.service` active+enabled, port 3010, sandbox OFF, AUTO_SUBMIT_BROWSER=true
- **CV**: Swarna_Sekhar_Dhar_Mywhy_Senior_Backend_Engineer.pdf set as default
- **Visa guide**: written to disk (235 lines) but NOT yet rendered as app page — pending (this session's top task)
- **Chrome browser automation**: blocked — remote debugging not enabled on user profile; no isolated-browser approval granted; no retry without user
- **Gotchas added**: Chrome remote-debugging not enabled on user profile → browser automation blocked; cua_browser_prepare requires user approval (timeout); Remotive Cloudflare-blocked via curl.

## TODO next session (in order)
0. **Create `/visa-guide` in-app page + render the visa guide + progress map** (top priority — user asked): build a controller that serves the guide HTML, re-read counts from DB for the todo map (31 submitted / 4 failed / 1 needs_info / 97 leads / 8 H1B US leads), expose on a new route. Then commit + push per goodbye process.
1. **Walk through visa guide with user** (done this session — summary delivered: UK Skilled Worker lead, Germany Blue Card parallel, USA H-1B lottery+cap-exempt strategy, 97 engine leads, 8 H1B US leads, 31 submitted, 4 failed).
2. **Lemon.io / Remotive Senior React Full-stack (lead `06524d9b-…`)** — apply FAILED x3 (Cloudflare + ATS endpoint). Fix: browser to real Remotive job page (Cloudflare challenge needs real browser), find real apply link, submit. Gate: Chrome remote-debugging + cua_browser_prepare user approval.
3. **H1B US leads (8 total: Stripe, Anthropic, Klaviyo, Lyft, Coinbase, Adyen, Databricks, Airbnb)** — browser-apply to each company career page. Gate: same Chrome approval.
4. **LinkedIn needs_info (Continental Industry, Bengaluru — NOT visa-sponsored)** — 5 unanswered fields; fill via browser. Blocked on Chrome. Lower priority — not visa-sponsored.
5. Activate LinkedIn snapshot (user action): save profile HTML to `data/linkedin/profile.html` → POST /linkedin/refresh.
6. Write-path unicode sanitization (stored data repaired; builder/writer still unsanitized): strip/replace non-ASCII control chars in CV builder + workHistoryJson write path.
7. Tag-<4-month stint + LinkedIn easy-apply policy: tagged short-stint flag in workHistory + DTO; AtsCvBuilder skips tagged; LinkedIn easy-apply uses last uploaded CV. ASK USER DOB question (PAN + 10th cert: 09/12/1982 vs chart/memory: 09/12/1981 — affects astrology; unresolved).
8. A1 Group careers adapter (jobs.a1.com): WordPress; REST live; vacancy list client-side via job-listing block — read block JS for data source/fetch params.
9. finn.no login: captcha verdict NO bypass — one-time manual session-cookie capture (user hasn't chosen). Scrape side live.
10. Company-redirect apply handling (FR-19, always-company rule): jobs whose apply link redirects to company's own page — detect, drive form (FR-15), handle login/register (legit automation or flag manual-apply).
11. Interview practice + conversation history features (2026-08-31 user session): continue conversation from prior context; walk user through knowledge summaries; surface relevant prior-session facts inline. Track conversation as first-class artifact.
12. CV format by geo-location + employer preference (FR-4): US/EU/India style, ALWAYS ATS, ALWAYS English.

## Goodbye process (user-mandated)
Update Progress + TODO here (PROJECT_PROMPT.md) → commit on `dev` → `pull --rebase` → `push origin/dev`. Never skip even on interrupt. Working directory: `/home/swarna-sekhar-dhar/projects/my-job-agent`; branch: `dev`.

## Gotchas / lessons
- pdfkit must be required (not ES-imported): `const PDFDocument: any = require('pdfkit')`
- TypeORM can't infer types from `string | null` unions — always set explicit column type
- Naukri search needs BOTH nkparam header AND login cookies (appid 109/systemid Naukri)
- pkill kills our own shell sometimes — use targeted patterns or ss -tln to check port
- Chrome remote-debugging not enabled on user profile → browser automation blocked; cua_browser_prepare requires user approval (timeout); Remotive Cloudflare-blocked via curl
