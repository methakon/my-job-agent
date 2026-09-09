# FYERS OAuth2 v3 — Auth Code → DB Single-Row Token (current, settled)

> Authoritative operational details: `docs/FYERS_API_SETUP.md` and `docs/FNO_PAPER_PLAN.md` (repo root `docs/`).
> This reference supersedes any older ".env + pm2 restart" flow.

## Endpoints (FYERS API v3)

- Auth-code URL: `https://api-t1.fyers.in/api/v3/generate-authcode?client_id=<APP_ID>&redirect_uri=<REDIRECT_URI>&response_type=code&state=<STATE>`
- Exchange: `POST https://api-t1.fyers.in/api/v3/validate-authcode` with body `{ "grant_type": "authorization_code", "appIdHash": "<sha256-hex>", "code": "<auth_code>" }`
- `appIdHash = sha256(APP_ID + ":" + APP_SECRET)` computed with the **FULL app id** (e.g. `TQHWHBA2SZ-200`) — not the short client id.
- Response carries `access_token`, `refresh_token` (≈15-day), `fy_id`, `expiry` (next trading day ~05:30 IST).

## Token storage — single-row DB model (not .env)

- Callback (`/auth/fyers/...`) is the **only intake path** for auth codes. It exchanges the code and upserts **one active row** in `fyers_tokens` (FyersToken entity): access token AES-256-CBC encrypted under `ENCRYPTION_KEY`, plus `fy_id`, `appId`, `authCodeHash`, status (`ACTIVE`/`EXPIRED`/`REVOKED`), expiry audit, `updatedAt`.
- **Runtime (market-data sockets, scripts) reads the token from the DB row.** No `.env` edits, no `pm2 restart`, no token in commit.
- `.env` keeps only `FYERS_APP_ID`, `FYERS_APP_SECRET`, `FYERS_REDIRECT_URI` (+ optional seed). `FYERS_ACCESS_TOKEN`/`FYERS_REFRESH_TOKEN` are legacy; the DB row wins.
- Deployments (home my-job-agent + Dhargent trading-agent) each hold their own row; both use the same FYERS app. FYERS grants one live session per login, so re-authing one host invalidates the other — re-run GET THE TOKEN on the other host when its socket drops (auto-reconnect watcher detects and surfaces this).

## GET THE TOKEN flow (UI)

- Paper desk and F&O Options desk render a **GET THE TOKEN** card/banner when no ACTIVE row exists (or row is EXPIRED/REVOKED).
- Flow: card → FYERS login/consent (`/generate-authcode`) → callback → row upserted → desk status flips to connected; watcher auto-(re)connects the socket. No manual token pasting.

## Refresh / PIN

- Refresh happens at runtime via FYERS OAuth; the **PIN is typed by the user at refresh time only** and is never stored or logged. If a refresh fails (PIN required), the row is marked `EXPIRED` and the UI asks the user to GET THE TOKEN again.

## Pitfalls

- Full app id in `appIdHash` (above) — using the short id yields `Invalid appIdHash` from validate-authcode.
- Never write the access token into `.env` or logs; encrypted DB row is the single source of truth.
- Both hosts sharing one FYERS app session: a fresh login on host A kicks host B — expected, not a bug.
