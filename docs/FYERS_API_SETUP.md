# FYERS API Setup Guide (v3) — for the trading agent

Status: 2026-09-03 — v3 flow (this doc was rewritten from the obsolete v2 flow;
the old `myapi.fyers.in/api/oauth/*` endpoints no longer apply).

## Stack context

- **App**: `TQHWHBA2SZ-200` (post-SEBI-migration app type, `-200` suffix) at
  https://myapi.fyers.in → My Apps.
- **Redirect URI**: `https://berhampore.in/auth/fyers/callback` (Cloudflare
  Tunnel → home my-job-agent :3010; tunnel id `ce9458f2-7b51-4649-9398-87ac9b30537d`).
- **Consumers**:
  - Dhargent VM `trading-agent` (pm2) — live feed + session driver, talks to
    MDS directly over VCN.
  - Home job agent + `scripts/fetch-fyers-history.ts` — history import into
    `fnf_market_snapshots` (`source='fyers-history'`) via tunnel 127.0.0.1:3307.
- **Feed policy**: Fyers = primary (live socket + history). Yahoo = fallback
  ONLY while Fyers is unavailable; every feed row carries a `source` tag
  (`fyers | yahoo | fyers-history | import`).

## 1. OAuth flow (v3, Authorization Code)

1. Build the login URL (state = any random string; single-use auth code):

   https://api-t1.fyers.in/api/v3/generate-authcode?client_id=TQHWHBA2SZ-200&redirect_uri=https%3A%2F%2Fberhampore.in%2Fauth%2Fyers%2Fcallback&response_type=code&state=<random>

2. User opens it, logs in with the Fyers account, approves. Browser lands on
   the redirect URI with `?auth_code=...` (single-use, short-lived).

3. Exchange the code — POST https://api-t1.fyers.in/api/v3/validate-authcode
   Content-Type: application/json
   Body: { "grant_type": "authorization_code", "appIdHash": "<sha256_hex(APP_ID:SECRET)>", "code": "<auth_code>" }
   where appIdHash = `printf '%s:%s' "$FYERS_APP_ID" "$FYERS_APP_SECRET" | sha256sum | cut -d' ' -f1`
   — SHA-256 HEX digest (NOT base64 — base64 is the old v2 scheme and returns
   `invalid app id hash` code -5 on v3). APP_ID must be the FULL id WITH suffix
   (TQHWHBA2SZ-200); the suffix-less form fails. Verified 2026-09-03.

   Response: { "s": "ok", "access_token": "...", "refresh_token": "...", "fy_id": "..." }

   In this repo you never handle the response manually: the app does the whole
   exchange for you.

## 2. Token storage — DATABASE, not .env (single-row model)

**User rule (2026-09-08): no new token is stored in the database; the OAuth
callback reads the `auth_code` URL parameter, exchanges it, and stores the
result ONCE; every runtime consumer then reads the token from the database.**

- **Intake**: GET `https://berhampore.in/auth/fyers/login` (or
  `/trading/fyers/auth-url`) → user logs in at FYERS → FYERS redirects to
  `/auth/fyers/callback?auth_code=...&state=...` → the callback validates
  state, exchanges the `auth_code`, and stores access+refresh tokens
  ENCRYPTED (AES-256-CBC under `ENCRYPTION_KEY`) in `fyers_tokens`.
- **Single row**: the row is INSERTED on the first-ever login; every later
  login/refresh UPDATES that same active row in place — the table never
  accumulates new token rows.
- **Consumers**: `FnoMarketDataService` (live feed) and
  `scripts/fetch-fyers-history.ts` read the token from the DB via
  `FyersTokenService.getActiveAccessToken()`; `.env` `FYERS_ACCESS_TOKEN` is
  only a fallback for hosts that have never completed a callback login.
- **Manual exchange**: `GET /trading/fyers/exchange-token?auth_code=...` also
  stores into the same single DB row (no raw tokens in the response).
- **Refresh**: `GET /trading/fyers/refresh-token` refreshes using the DB
  refresh token (requires `FYERS_PIN` in `.env`; PIN is never stored in DB).

## 3. Credentials in .env (both hosts)

```
FYERS_APP_ID=TQHWHBA2SZ-200
FYERS_APP_SECRET=<from console — full value, base64-ish, ~24+ chars>
FYERS_REDIRECT_URI=https://berhampore.in/auth/fyers/callback
# FYERS_ACCESS_TOKEN / FYERS_REFRESH_TOKEN are LEGACY fallbacks only — after
# one /auth/fyers/login the tokens live in fyers_tokens and .env is not read.
FNO_MARKET_DATA_PROVIDER=fyers        # fyers primary; yahoo only fallback
```

`.env` is git-tracked in this repo by explicit user convention — but the FYERS
secret is a runtime credential that must never be pasted into chat or commit
messages; write it via masked python/ssh only.

## 4. Data endpoints (v3)

- History (used by scripts/fetch-fyers-history.ts):
  POST https://api-t1.fyers.in/data/v3/history
  Authorization: `<FYERS_APP_ID>:<FYERS_ACCESS_TOKEN>`
  Body: { "symbol": "NSE:NIFTY50-INDEX", "resolution": "5"|"D",
          "date_format": "1", "range_from": "<epoch s>", "range_to": "<epoch s>",
          "cont_flag": "1" }
  → { s, candles: [[ts,o,h,l,c,v], ...] }
- Quotes/market data + socket: see src/trading/ fyers client code (43+ matches
  of FYERS_* across src/). Symbols: NSE:NIFTY50-INDEX, NSE:NIFTYBANK-INDEX,
  NSE:SENSEX-INDEX.
- Paper-only: data/quotes fine; order APIs never called with real money —
  execution stays in the internal paper ledger (session driver, qty 1,
  ₹10L sandbox portfolio, +2%/−1% bracket, decay self-learning).

## 5. Troubleshooting

- `invalid app id hash` on validate-authcode → appIdHash must be SHA-256 hex of
  `FULL_APP_ID_WITH_SUFFIX:SECRET` (base64 fails with code -5). If still failing
  with the correct hash, the secret itself is wrong/truncated.
  FYERS v3 app secrets can be exactly 16 alphanumeric chars (e.g. `9hLm...tw6`
  for TQHWHBA2SZ-200, verified 2026-09-03) — length alone is not a truncation
  signal; trust a fresh copy from myapi.fyers.in → My Apps → reveal.
- Auth code errors → codes are single-use and short-lived; regenerate the
  login URL before every exchange attempt.
- Callback mismatch → redirect_uri must match the console registration
  character-for-character (https, no trailing slash).
- Static IP → required only for real order placement; paper/data access needs
  no static-IP registration.

## 6. Deploy/restart reminder

Any `.env` or code change ⇒ `pm2 restart trading-agent` on Dhargent AND
`pm2 restart my-job-agent` at home. Env vars are read at process start only.
