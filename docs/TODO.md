# my-job-agent — TODO / Progress Tracker

> Updated with every session. ✅ done · 🔄 in progress · ⬜ pending · 🚫 blocked on user
> Last updated: 2026-08-25

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

## In progress
- [ ] (none)

## Recently completed (2026-08-25, latest session)
- [x] AtsCvBuilder: JD-tailored ATS PDF CV — VERIFIED (valid 1-page PDF generated)
- [x] FR-10 ProcessLearningService: reads job description for employer's stated
      application process (email/ATS/portal-form) and follows it before any
      other channel
- [x] FR-11 Self-improvement engine scaffold: outcome recording + learning
      stats (channel success, keyword replies, best send hour)
- [x] FR-12 Gmail SMTP live (app-password AES-256 in DB); test email sent OK
- [x] InboxReaderService: IMAP OTP reading (auto portal verification codes)
      + recruiter reply polling — verified against live inbox

## Pending — engineering
- [ ] finn.no adapter (scrape English-jobs filter) + account signup/apply flow
- [ ] A1 Group careers adapter (jobs.a1.com)
- [ ] Naukri adapter (scraping-based; login credentials needed)
- [ ] Monster India adapter (same approach as Naukri)
- [ ] LinkedIn easy-apply adapter (session cookie; toggle OFF by default)
- [ ] Browser automation service for ATS form filling (Playwright)
- [ ] Dashboard: mail-account management panel + interview-practice page
- [ ] Daily digest of new high-match leads (email to self)
- [ ] Production hardening: synchronize:false + migrations, helmet, rate limit

## Blocked on user
- [🚫] Outlook app-password → backup sender (optional; Gmail primary live)
- [🚫] Naukri/Monster: existing credentials or fresh signup approval?
- [🚫] LinkedIn li_at session cookie (if easy-apply wanted)
- [🚫] GitHub/portfolio URL → profile completeness 100%
- [🚫] HK-dir statement PDF path (attach to Norway applications)
- [🚫] finn.no login method: email+password or BankID? (account exists, bapay.9@gmail.com)

## Verification checklist (per release)
- [ ] tsc clean + nest build passes
- [ ] Service boots; GET /profile, /leads, /settings return data
- [ ] Scout pulls leads from all enabled sources
- [ ] One test application generates tailored PDF + human email draft
