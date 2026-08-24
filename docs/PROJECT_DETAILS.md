# my-job-agent — Project Details (architecture & status)

> Companion to docs/REQUIREMENTS.md. Updated together with it.

## 1. Repository

- Local: `~/projects/my-job-agent`
- Remote: https://github.com/methakon/my-job-agent (private), branch `dev`
- Runtime: port **3010**, dashboard `/`, Swagger `/docs`
- DB: MySQL `myjob_agent`, user `myjob_agent` (creds in `.env`, tracked in git
  per user convention; APP_SECRET added for password encryption)

## 2. Module map (MVCR)

```
src/
├── main.ts                  bootstrap: env-check, static /public, swagger, CORS
├── app.module.ts            wiring; TypeORM forFeature list of all entities
├── shared/                  db.config, env-check, swagger.config (copied from MyLife shared)
├── profile/
│   ├── candidate-profile.entity.ts   master profile (one row)
│   ├── profile.repository.ts / service.ts / controller.ts (+DTOs)
│   └── profile-optimizer.service.ts  completeness score, stint hiding (<5mo),
│                                     same-company merge, application-ready variant
├── scout/
│   ├── public-api.adapters.ts        Remotive + RemoteOK adapters
│   ├── norway-jobs.adapter.ts        englishjobs.no markdown feed
│   ├── scout.service.ts              cron (SCOUT_INTERVAL_MINUTES) + skill scoring
│   ├── lead.controller.ts            GET /leads, POST /leads/scout
│   └── job-lead.entity.ts
├── applications/
│   ├── portal-adapter.interface.ts   PortalAdapter contract (add portals via one file)
│   ├── apply-engine.service.ts       priority chain: ATS → HR email → easy-apply
│   │                                 kill switch, daily caps, JD-tailored CV+letter
│   ├── direct-channel.detector.ts    finds ATS links / HR emails in postings
│   ├── mail.service.ts               Gmail primary + Outlook backup failover,
│   │                                 AES-256 encrypted app-passwords from DB
│   ├── mail-account.entity.ts        mail_accounts table
│   ├── mail.controller.ts            POST/GET /mail/accounts
│   ├── human-email-composer.service.ts  varied human-style email bodies
│   ├── ats-cv-builder.service.ts     pdfkit JD-tailored ATS PDF CV
│   ├── answer-bank.service.ts        custom-question answers (seeded + learned)
│   ├── question-answer.entity.ts
│   ├── application.entity/.repository/.controller  submissions + tracking endpoints
│   ├── apply-setting.entity/.repository + settings.controller  per-source toggles/caps
│   ├── email-tracker.service.ts      IMAP poll → StatusUpdate rows w/ HTML body
│   ├── status-update.entity.ts       both-side action log (timestamp + content)
│   └── direct-apply.mailer.ts        legacy simple SMTP sender (superseded by MailService)
├── interview/
│   ├── interview-question.entity.ts  seeded bank
│   └── interview-prep.service/.controller   per-lead practice sets
└── public/dashboard.html             dark UI dashboard
```

## 3. API surface

| Endpoint | Method | Purpose |
|---|---|---|
| /profile | GET/PUT | view/update master profile |
| /profile/optimized | GET | completeness score + CV-ready variant |
| /leads | GET | stored leads (match-sorted) |
| /leads/scout | POST | run scouting now |
| /applications | GET | submission history |
| /applications/apply/:leadId | POST | apply to a lead |
| /applications/poll-email | POST | IMAP sweep now |
| /applications/status-updates/:id | GET | both-side timeline w/ content |
| /applications/answers | GET/POST | answer bank |
| /settings | GET | portal toggles/caps |
| /settings/:source | POST | update toggle/cap |
| /interview-prep | GET | full bank |
| /interview-prep/for-lead/:leadId | GET | tailored practice set |
| /mail/accounts | GET/POST | mailboxes (passwords write-only) |

## 4. Data model

candidate_profile · job_leads · applications · question_answers ·
apply_settings · status_updates · interview_questions · mail_accounts

## 5. Environment (.env)

MYSQL_*, DATABASE_NAME=myjob_agent, AGENT_PORT=3010,
MYJOB_API_URL=http://localhost:3001, SCOUT_INTERVAL_MINUTES=360,
APPLY_KILL_SWITCH=false, AUTO_APPLY_{REMOTIVE|REMOTEOK|LINKEDIN}=…,
LINKEDIN_SESSION_COOKIE= (empty), IMAP_* (pending user creds), SMTP_*
(superseded by DB-stored accounts), APP_SECRET (encryption key)

## 6. Status (2026-08-25)

Done: scaffold, all modules above, Norway adapter live, dashboard, docs.
Verified running: Nest start OK, scout pulled 137 jobs incl. Norway leads,
profile seeded from ATS CV, completeness 90%.

Pending (blocked on user or next iteration):
1. Gmail + Outlook app-passwords → activate direct HR email apply
2. finn.no adapter + account signup flow (Norwegian phone verification?)
3. Naukri/Monster adapters (scraping; login credentials from user)
4. LinkedIn easy-apply via session cookie (toggle OFF by default)
5. IMAP creds for reply tracking
6. GitHub/portfolio URL in profile (→100% completeness)

## 7. Document maintenance rule

REQUIREMENTS.md and this file are updated with every new user requirement,
before code changes, and committed together with the milestone.
