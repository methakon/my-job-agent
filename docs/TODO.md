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
