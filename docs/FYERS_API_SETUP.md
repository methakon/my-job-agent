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
   Body: { "grant_type": "authorization_code", "appIdHash": "<base64(APP_ID:SECRET)>", "code": "<auth_code>" }
   where appIdHash = `printf '%s:%s' "$FYERS_APP_ID" "$FYERS_APP_SECRET" | base64` (no newline).

   Response: { "s": "ok", "access_token": "..." } → store in `FYERS_ACCESS_TOKEN`.

## 2. Credentials in .env (both hosts)

```
FYERS_APP_ID=TQHWHBA2SZ-200
FYERS_APP_SECRET=<from console — full value, base64-ish, ~24+ chars>
FYERS_REDIRECT_URI=https://berhampore.in/auth/fyers/callback
FYERS_ACCESS_TOKEN=<empty until exchange runs>
FNO_MARKET_DATA_PROVIDER=fyers        # fyers primary; yahoo only fallback
```

`.env` is git-tracked in this repo by explicit user convention — but the FYERS
secret is a runtime credential that must never be pasted into chat or commit
messages; write it via masked python/ssh only.

## 3. Data endpoints (v3)

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

## 4. Troubleshooting

- `invalid app id hash` on validate-authcode → the secret is wrong/truncated.
  FYERS v3 secrets are ~24+ chars (base64-style, may end `=`). A 16-char value
  is almost certainly a truncated copy: re-copy the FULL secret from
  myapi.fyers.in → My Apps → reveal. Do not trust chat history.
- Auth code errors → codes are single-use and short-lived; regenerate the
  login URL before every exchange attempt.
- Callback mismatch → redirect_uri must match the console registration
  character-for-character (https, no trailing slash).
- Static IP → required only for real order placement; paper/data access needs
  no static-IP registration.

## 5. Deploy/restart reminder

Any `.env` or code change ⇒ `pm2 restart trading-agent` on Dhargent AND
`pm2 restart my-job-agent` at home. Env vars are read at process start only.
