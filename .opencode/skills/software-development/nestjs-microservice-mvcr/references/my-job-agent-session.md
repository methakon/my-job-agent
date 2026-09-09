# my-job-agent session learnings (2026-08-25/26)

Verified patterns from the autonomous job-agent service (`~/projects/my-job-agent`,
NestJS+TypeORM+MySQL, port 3010). All verified live unless noted.

## Naukri automation
- **Login**: `central-login-services/v1/login` API; RSA-encrypted password token.
  `node-rsa` package exports `{ NodeRSA, default }` — handle all shapes:
  `const NodeRSA = _n.NodeRSA ?? _n.default ?? _n;`
- **Apply**: cloudgateway apply-workflow POST (reference impl: github Traverser25/NopeRi).
  Register portal adapters in EVERY consumer (scout AND apply engine) — a module-level
  registration missed in one service yields "no adapter for source X" at runtime.
- Credentials stored AES-256 encrypted in DB (`portal_credential` pattern).

## Job-lead scoring (title-aware)
- NEVER score on raw description blob: marketplace ads embed "for-developers"
  boilerplate links that match skills. Strip `<a>...</a>`, bare URLs, HTML tags first.
- Title veto regex for non-dev roles (graphic|visual designer, ux/ui, qa, tester,
  data entry, recruiter, sales, marketing, accountant, content writer...).
- Require a skill hit IN THE TITLE or ≥3 distinct skills overall, else skip storage.
- Weight title hits double.

## Retry with increasing backoff (user rule)
Failed applications auto-retry at escalating delays 5→10→20→30 min, max attempts,
then permanent fail. Persist `retryCount` on the row BEFORE retrying so a crash
can't loop; recheck `updatedAt` vs backoff window every minute tick.

## Auto-apply loop gates
Kill switch env → profile completeness check → per-source caps → single-run lock →
human-like pacing (~90s between submissions). Threshold + max-per-run from env vars.

## Deep HR-email investigation ladder
JD scan → curl actual job URL → resolve company domain (direct TLD variants, then
DuckDuckGo filtering job-board noise) → sweep /careers /jobs /about /contact →
pattern-guess hr@/careers@/jobs@/talent@/recruiting@/hiring@<domain>.
Verify via Cloudflare DNS-over-HTTPS MX lookup before use. User rule: pattern-guess
addresses ARE usable for sending (posters often use official mailboxes) — log
confidence on the application record. Cache per company.

## Playwright browser-form filling (playwright-core + system Chrome)
- Use `playwright-core` + `executablePath: '/usr/bin/google-chrome'`, headless,
  args `--no-sandbox --disable-dev-shm-usage` (Linux root/container).
- Field matching: collect visible inputs/textarea/select via `$$eval` filtering
  computed display/visibility/offsetParent; match against values by normalized
  label/name/id/placeholder substring either direction.
- Required-field gaps → needs_info result, never guess.
- SAFETY: stop before final submit unless explicit autoSubmit flag; screenshot
  loaded/filled/submitted to an audit dir.
- VERIFIED end-to-end against httpbin.org/forms/post.

## Side-income opportunity research (India, tier-3 town)
Verified facts (as of Aug 2026): Valmo/Meesho partner applies free at valmo.in,
NEVER charges fees (fraud report investigations@meesho.com); Delhivery franchise at
delhivery.com/partner/courier-sales-franchise (200 sqft min for delivery center);
Amazon I Have Space = lowest-involvement local parcel point; Amazon Easy needs
200 sqft + computer literacy; CSC VLE free registration register.csc.gov.in.
Amazon DSP needs ₹6-8L liquid — doesn't fit zero/minimal-investment profiles.

## NestJS route shadowing pitfall
A `GET /prefix/:id` route registered in an earlier controller SWALLOWS
`GET /prefix/dashboard` — returns null/empty 200 with no error logged. Fix:
give static-path controllers their own distinct prefix. Symptom: 200 with
Content-Length: 0, no exception anywhere.

## MySQL column sizing for seeded content
Free-text-ish display fields (income ranges etc.) written by seed code: size
varchar(160-200), NOT 60 — "Data too long for column" only appears in logs as
QueryFailedError after boot and silently breaks seeding. Also: TypeORM names
columns camelCase by default unless `name:` given — ALTER TABLE must use the
entity property name, not snake_case guess.
