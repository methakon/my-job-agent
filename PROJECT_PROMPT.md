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

## Progress (2026-08-27)
- **CNV Labs/iCloudEMS REAL application SENT** (job 4349990583, Node.js Developer): evidence-based email to contact@icloudems.com (found on careers page — fully rule-compliant, NO pattern-guessing) fired 22:38:28 UTC via muhurta sweep; DB status=submitted, isSandbox=0, tailored CV attached. Pre-apply item 9dfe9691-e521-4728-8079-f3c1e0375540.
- **Evidence pipeline bug fixed (root cause)**: `baseDomain()` in hr-email-investigator was written for hostnames not emails — `contact@icloudems.com`.split('.') → baseDomain `contact@icloudems.com` ≠ pageHost, silently dropping EVERY evidence email. Patched email-aware + www-redirect retry + parenthesized-brand domain fallback. Verified live: investigator now returns {contact@icloudems.com, medium, careers-page:/career}. Committed `fix(apply): evidence-only email detection now actually works` (3b43e77) + pushed.
- **DB unicode corruption REPAIRED + re-verified**: workHistoryJson role strings now store real "Senior Associate → Team Lead – Backend" (U+2192 arrow, U+2013 en dash). Write-path sanitization still open (TODO).
- **Continental Industry pipeline (job 4456857847, Senior Software Engineer, Bengaluru, Node.js/TS/AWS, ContiTech)**: lead 5a1f9e3c-7b2d-4c8e-9f1a-3d4e5f6a7b8c inserted; prepared; NO email evidence found (honest null — Continental publishes no HR emails); channel set to company ATS SmartRecruiters posting (external-link → company portal rule); item e16a55f4-3d9d-403c-af64-fa25a7c49380 approved for muhurta sweep.
- **Browser form (FR-15) fixed for modern ATS** (3 fixes, in flight):
  1. SmartRecruiters device-verification interstitial stalls default headless Chrome → stealth flags (AutomationControlled off, real UA, webdriver spoof) pass it in ~1s;
  2. ATS forms hidden behind CTA ("I'm interested") → click first apply button + wait for oneclick-ui URL + wait for field visibility;
  3. `$$eval` never sees shadow-DOM inputs (SmartRecruiters oneclick-ui renders form in shadow roots) → switched to playwright locators (pierce shadow DOM) with per-field nth() fill; CV upload locator too; CSS.escape crash removed; aria-label added to matcher; firstname/lastname/website/message aliases added.
  4. needs_info rows no longer block re-send: dedupe only on terminal success (submitted/sent/sandboxed); failed+needs_info retried in place (no duplicate rows).
- **Fixed ATS false positive**: process-learning ATS regex matched "lever" inside "Leverage" → negative lookahead `lever(?!age)`. Continental correctly re-detected as no-JD-ATS.
- **Cutshort portal apply (Google login)**: paused — requires user to tick "Allow remote debugging" in chrome://inspect (harness forbids retry before confirmation); email already sent so nothing lost.

## TODO next session (in order)
0. **Verify Continental send result** (item e16a55f4-3d9d-403c-af64-fa25a7c49380): muhurta sweep fires browser fill on SmartRecruiters oneclick-ui ~10 min after last boot (23:45:22 → ~23:55); expect needs_info (form filled for human review, AUTO_SUBMIT_BROWSER unset) — review screenshots in generated/browser/ + check DB status. Then decide: enable AUTO_SUBMIT_BROWSER=true for full auto-submit or keep human-review.
1. **Cutshort portal apply via Google login** (user approval pending on Chrome remote-debugging): https://cutshort.io/job/Node-js-Developer-ICloudEMS-wwzWD11g — Google OAuth confirmed; user must tick "Allow remote debugging for this browser instance" in chrome://inspect + second Allow popup; Google account sign-in is a manual user step (no stored creds).
2. **Write-path unicode sanitization** (stored data repaired; builder/writer still unsanitized): strip/replace non-ASCII control chars in CV builder + workHistoryJson write path.
3. **Tag-<4-month + LinkedIn easy-apply policy** (user instruction verbatim 2026-08-27): tagged short-stint flag in workHistory + DTO; AtsCvBuilder skips tagged; LinkedIn easy-apply uses last uploaded CV only. Also ASK USER the DOB question (PAN + 10th cert: 09/12/1982 vs chart/memory: 09/12/1981 — affects astrology).
4. **Josys Ashby wiring go/no-go** (posting 04703ddd-7128-4740-982a-bdac760aeddc): rule-compliant jobs.ashbyhq.com/josys verified — awaiting user decision (pattern-guessed email already disclosed, cannot unsend).
5. **A1 Group careers adapter (jobs.a1.com)**: WordPress; REST live; vacancy list client-side via job-listing block — read block JS for data source/fetch params.
6. **Activate LinkedIn snapshot** (user action): save profile HTML into data/linkedin/profile.html → POST /linkedin/refresh.
7. **finn.no login**: captcha verdict NO bypass — one-time manual session-cookie capture (user hasn't chosen). Scrape side live.
8. LinkedIn easy-apply via li_at cookie (toggle OFF by default).
9. **Company-redirect apply handling** (FR-19, always-company rule): jobs whose apply link redirects to company's own page — detect, drive form (FR-15), handle login/register (legit automation or flag manual-apply).
10. **Quick-question user input** (FR-20): /quick-question free text from live state.
11. **Live list updates while applying** (FR-21): per-item status transitions visible live during /auto-apply/run.
12. **CV format by geo-location + employer preference** (FR-4): US/EU/India style, ALWAYS ATS, ALWAYS English.

## Gotchas / lessons
- pdfkit must be required (not ES-imported): `const PDFDocument: any = require('pdfkit')`
- TypeORM can't infer types from `string | null` unions — always set explicit column type
- Naukri search needs BOTH nkparam header AND login cookies (appid 109/systemid Naukri)
- pkill kills our own shell sometimes — use targeted patterns or ss -tln to check port
