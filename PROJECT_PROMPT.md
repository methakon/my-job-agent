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

## Progress (2026-09-01)
- **FNF decay engine: LIVE (user instruction "always predict considering decay, always rectify decay value + timings day-wise")** — new `FnfDecayCalibration` entity + `fnf_decay_calibrations` table (7 global weekday rows, portfolio override rows optional, UNIQUE portfolioId+weekday). Every signal is now decay-adjusted: `decayedConfidence = confidence × e^(−rate × data-age-hours) × timingFactor` (1.0 inside the weekday's best-entry window, 0.85 outside); below floor 35 → HOLD. Day-wise self-rectification: after every closed trade the weekday's rate + window are rectified from the outcome (winners ease rate ×(1−0.15), losers tighten ×(1+0.15); window edges drift 0.25h toward winning entry hours, clamped 9.00–15.50); runs automatically after each close + when calibration is stale, and on demand `POST /trading/decay/rectify`. REST: `GET /trading/decay?portfolioId=`, `PATCH /trading/decay` (manual override per weekday), `POST /trading/decay/rectify`. Dashboard: new decay-calibration card (per-weekday rate/window/samples/last-rectified, today highlighted) + signals table shows raw→decayed confidence + decay badge. E2E verified: signal 61%→52% at 0.08h age; win rectified Tue rate 0.0400→0.0340 + window 9.50→9.25; loss →0.0391; samples=2; PATCH wd5 persisted.
- **FNF trading module v1: LIVE** — `src/trading/` now has module wiring in AppModule: `FnfTradingService` (portfolio CRUD, trade ledger with Indian discount-broker cost model, market snapshot ingestion + value-change %, SMA mean-reversion signal stubs with scenario tree + astro match + Friday block, self-learning summary per algoSource), `FnfTradingController` (REST: `/trading/portfolios|trades|market|signals|cost|astro|summary`), `FnfTradingPageController` (`/fnf-trading` dashboard: portfolio card, Nifty 50/Sensex market table, algo panel, trade ledger, cost breakdown, Friday toggle, broker config slots for Zerodha Kite/Angel One, auto-trade on/off, astro muhurta panel). `fnf_portfolios`/`fnf_trades`/`fnf_market_snapshots` tables created in MySQL (prod has synchronize off). Dashboard card added. E2E verified: open→close trade (gross 299.40, cost 32.72, net 266.68), learning summary, market change%, signals with astro match. Entities extended with `fridayTradingEnabled` + `brokerConfig` (text JSON) columns.
- **F&O options page + live-data adapter slice (2026-09-01)** — `/option-trading` is wired as a dedicated paper-only desk. It reuses the guarded FNF/F&O portfolio envelope, Friday gate, astro/muhurta gate, decay-adjusted signals, learning summary, market snapshots, trade ledger, and P&L. A FYERS API v3 data WebSocket adapter (`FnoMarketDataService`) subscribes to configured underlying/option symbols and throttles real ticks into `fnf_market_snapshots`; status is exposed at `GET /trading/market-feed/status`. It never imports or calls broker order placement. Credentials/symbols are environment-only (`FYERS_APP_ID`, `FYERS_ACCESS_TOKEN`, `FNO_MARKET_DATA_ENABLED`, `FNO_MARKET_DATA_SYMBOLS`). Yahoo Finance chart polling is now the opt-in interim alternate (`YAHOO_FINANCE_SYMBOLS`, 15s default poll, 1m chart data); defaults are underlying/index proxies, not an option-chain feed. Remaining option TODO: contract metadata/chain, Greeks, margin, option-specific paper fills/costs, and tests.
- **`/visa-guide` in-app page: live** — `GET /visa-guide` renders the full guide as styled HTML from `VISA_SPONSORED_JOBS_GUIDE.md` via a minimal built-in markdown renderer; live masthead stats from MySQL (31 submitted / 4 failed / 1 needs_info / 0 sandboxed / 115 leads); badge row; 61 table rows; footer links back to dashboard/applications/swagger — committed `66cc07d`, pushed to origin/dev
- **BiCSoM Senior Node.js Developer (lead `346e6524-...`) REAL APPLICATION SENT** via Fluent Forms adapter — application `788df9cf` submitted successfully; engine patched (CV set, AUTO_SUBMIT_BROWSER=true, regex fixed, stale rows cleared). API-driven — no browser popup needed
- **Browser automation still blocked** — Chrome profile has no `remote-debugging-port` flag; `cua_browser_prepare` timed out waiting for user approval; `focus_app(Chrome)` same timeout; `list_windows(Chrome)` returned 0 windows. Remotive job page Cloudflare-blocked via curl. Chrome-drive gated behind user approval — no retry without explicit go-ahead. "immurshiv ui" thread closed by user ("OK IGNORE THEM")
- **Applications**: 36 total — 31 submitted, 4 failed (all Remotive/Lemon.io), 1 needs_info (LinkedIn Continental, Bengaluru — NOT visa-sponsored)
- **Job leads**: 115 live in DB (Naukri, RemoteOK, Remotive, LinkedIn, Norway, A1Group, BiCSoM) + 8 H1B US leads (Stripe, Anthropic, Klaviyo, Lyft, Coinbase, Adyen, Databricks, Airbnb)
- **FNF trading schema v1: committed** — 3 entities in `src/trading/`: `FnfPortfolio` (capital/ceiling/deployed/netPnl/totalCost/autoTradeEnabled), `FnfTrade` (full record incl. decisionParams JSON with all prediction params + astro match + Friday flag + algoSource, entry/exit, gross/net P&L, cost, brokerOrderId, status), `FnfMarketSnapshot` (price/volume/OHLC per instrument, indexed on instrument+ts). No module/service/controller/page yet — next slice
- **Apply engine**: pm2-managed (ecosystem.config.js), systemd wrapper `pm2-swarna-sekhar-dhar.service` active+enabled, port 3010, sandbox OFF, AUTO_SUBMIT_BROWSER=true
- **CV**: Swarna_Sekhar_Dhar_Mywhy_Senior_Backend_Engineer.pdf set as default
- **Chrome browser automation**: blocked — remote debugging not enabled on user profile; no isolated-browser approval granted; no retry without user

## TODO next session (in order)
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
