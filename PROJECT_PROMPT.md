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

## Verified working (2026-08-25)
- Login/auth-free local service; profile 90% complete from ATS CV import
- Scout: Remotive + RemoteOK + Norway (englishjobs.no) live
- Naukri: LOGIN WORKING (central-login-services/v1/login), nkparam RSA token
  generator working, search returns 20+ jobs; apply endpoint implemented
  (needs end-to-end test)
- Gmail SMTP send verified (app-password AES-256 encrypted in DB)
- IMAP inbox reading verified: OTP auto-read (FR-12) + recruiter reply polling
- ATS PDF CV builder: valid tailored 1-page PDF generated
- Dashboard at `/`, Swagger at `/docs`

## Credentials stored (encrypted AES-256 in mail_accounts table)
- Gmail app-password (bapay.9@gmail.com) — primary sender + OTP reader
- Naukri password (portal:naukri:bapay.9@gmail.com)

## TODO next session (in order)
1. **Restart service & verify naukri end-to-end**: boot → POST /leads/scout →
   confirm naukri leads stored → pick one lead → POST /applications/apply/:id →
   verify submitted status. Then commit+push.
2. **finn.no adapter**: login flow (account exists, bapay.9@gmail.com;
   confirm password vs BankID with user) + scrape English jobs + apply.
3. **Self-improvement persistence**: store learning weights in DB table
   (channel success, keyword replies, best hour); wire outcome recording into
   applyDirect/email tracker.
4. Monster India adapter (same pattern as Naukri).
5. LinkedIn easy-apply via li_at cookie (toggle OFF by default).
6. Dashboard: add Mail accounts panel + interview-practice page.
7. Outlook app-password (optional backup sender) — pending from user.
8. GitHub/portfolio URL for profile → completeness 100% — pending from user.

## Gotchas / lessons
- pdfkit must be required (not ES-imported): `const PDFDocument: any = require('pdfkit')`
- TypeORM can't infer types from `string | null` unions — always set explicit column type
- Naukri search needs BOTH nkparam header AND login cookies (appid 109/systemid Naukri)
- pkill kills our own shell sometimes — use targeted patterns or ss -tln to check port
