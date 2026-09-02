# FYERS API Setup Guide for berhampore.in Callback

## Tunnel Status — READY

Your Cloudflare Tunnel is live and routing traffic:

| Hostname | URL | Status |
|----------|-----|--------|
| Root domain | https://berhampore.in/ | LIVE (200) |
| Dev subdomain | https://dev.berhampore.in/ | LIVE (200) |
| API subdomain | https://api.berhampore.in/ | LIVE (200) |

Service behind tunnel: Node.js my-job-agent on localhost:3010
Tunnel ID: ce9458f2-7b51-4649-9398-87ac9b30537d
Config: ~/.cloudflared/config.yml
Binary: ~/bin/cloudflared (v2026.8.3)

The tunnel runs as a background process. To restart it if needed:
  export PATH="$HOME/bin:$PATH"
  cloudflared tunnel run ce9458f2-7b51-4649-9398-87ac9b30537d

---

## FYERS API Registration — Step by Step

### 1. Register at FYERS API Portal

Go to: https://myapi.fyers.in/

If you don't have an FYERS account yet, you'll need to open one first at https://www.fyers.in/ — the API access is tied to your brokerage account.

### 2. Create a New App

In the FYERS API dashboard (https://myapi.fyers.in/api-dashboard):

1. Click **"Create New App"**
2. Fill in the app details:
   - **App Name**: Choose something descriptive, e.g. "Swarna-Trading-Agent" or "my-job-agent-FNO"
   - **App Type**: Select your app type — after the April 1, 2026 SEBI migration, all new broker API app IDs end with `200`. Choose the type that matches your use case (typically a web/desktop app for algorithmic trading)
   - **Callback URL / Redirect URI**: Enter exactly:
     ```
     https://berhampore.in/auth/fyers/callback
     ```
     This is the OAuth callback endpoint. FYERS will redirect the user here after authorization with the auth code. Your service must handle this route and exchange the code for an access token.
   - **Permissions / Scopes**: Select the permissions your algo needs, at minimum:
     - Read market data (quotes, order book, market depth)
     - Read portfolio / positions
     - Place orders (even for paper trading, FYERS may require this permission)
     - Read order history
     - Modify/cancel orders if you need active position management
   - **Description**: Optional but helpful — note "Paper trading only, no real orders"

3. Submit the form. FYERS will review and approve (usually fast for standard apps).

### 3. After Approval — Credentials You'll Get

Once approved, you'll have:

- **App ID** (also called Client ID): A numeric ID, e.g. `XXXXXXXXXXXXXX200` (the `200` suffix is the post-SEBI-migration app type indicator)
- **App Secret**: A secret string — keep this PRIVATE, never commit to git
- **Redirect URI**: The one you registered (`https://berhampore.in/auth/fyers/callback`)

### 4. OAuth Flow (how your service authenticates)

FYERS uses OAuth 2.0 Authorization Code flow:

1. Your service builds the authorization URL:
   ```
   https://myapi.fyers.in/api/oauth/authorize?client_id=YOUR_APP_ID&redirect_uri=https://berhampore.in/auth/fyers/callback&response_type=code&scope=read,write
   ```
2. User (you) visits that URL, logs in to FYERS, and consents
3. FYERS redirects to:
   ```
   https://berhampore.in/auth/fyers/callback?code=RECEIVED_AUTH_CODE
   ```
4. Your service exchanges the code for an access token:
   ```
   POST https://myapi.fyers.in/api/oauth/token
   Headers: Content-Type: application/json
   Body: {
     "grant_type": "authorization_code",
     "code": "RECEIVED_AUTH_CODE",
     "client_id": "YOUR_APP_ID",
     "secret_key": "YOUR_APP_SECRET",
     "redirect_uri": "https://berhampore.in/auth/fyers/callback"
   }
   ```
5. Response includes `access_token` — your service uses this to call FYERS REST API endpoints

### 5. Add FYERS Credentials to Your .env

Add these to `/home/swarna-sekhar-dhar/projects/my-job-agent/.env`:

```
# FYERS API credentials (paper trading)
FYERS_APP_ID=YOUR_APP_ID_HERE
FYERS_APP_SECRET=YOUR_APP_SECRET_HERE
FYERS_REDIRECT_URI=https://berhampore.in/auth/fyers/callback
FYERS_ACCESS_TOKEN=  (filled after OAuth flow runs)
FNO_MARKET_DATA_ENABLED=true
FNO_MARKET_DATA_SYMBOLS=NIFTY,BANKNIFTY
```

Do NOT commit these to git. The .env file is already gitignored if set up correctly.

### 6. SEBI Migration Note (April 1, 2026)

After SEBI's April 1, 2026 migration:
- All new API apps registered get an App ID ending in `200`
- This is the standard app type for the post-migration regime
- Live order placement through broker APIs requires a static IP registered with the broker (your tunnel provides this via Cloudflare's egress IPs — but confirm with FYERS whether they accept Cloudflare Tunnel IPs for the static IP registration requirement, or if you need to add Cloudflare's IP ranges to your FYERS account)
- Paper trading / data-only access should not require the static IP registration

### 7. Important — F&O Paper Trading Only

Per your rules:
- Simulated balance: ₹5,000
- Profits increase it, losses reduce it
- FYERS activation required for live F&O data (options and futures) but ALL execution stays paper
- No real broker orders or order-placement APIs called
- Yahoo Finance used only for interim underlying/index research and historical imports

When wiring FYERS:
- Use the FYERS API for market data / quotes only if possible, OR
- If order placement API is needed for paper mode, ensure every order is tagged as paper/simulated and routed to your internal paper ledger, never to the real FYERS order endpoint
- Consider asking FYERS support whether they offer a sandbox/paper trading environment for API testing

### 8. Verify Callback is Reachable

Before registering the callback URL in FYERS, confirm it's reachable:

```
curl -s -o /dev/null -w "%{http_code}" https://berhampore.in/auth/fyers/callback
```

Your service should return a proper response (even a 404 or a "not yet configured" page is fine — the URL just needs to be reachable from the internet). Currently the root and subdomains return 200 from the my-job-agent dashboard.

If `/auth/fyers/callback` returns 404 because the route doesn't exist yet, that's OK — FYERS just needs the URL to resolve. Implement the route when you wire the OAuth flow.

### 9. Troubleshooting

- **FYERS rejects the callback URL**: Make sure it matches EXACTLY what you registered, including https:// and no trailing slash mismatch
- **OAuth code exchange fails**: Check App ID, App Secret, and that the redirect_uri in the token request matches the registered one character-for-character
- **Static IP requirement for live orders**: If FYERS asks for a static IP, Cloudflare Tunnel egress IPs may or may not satisfy this — check with FYERS support. For paper-only trading this shouldn't block you
- **App not approved**: Standard apps are usually approved quickly; if stuck, contact FYERS support via their helpdesk

---

## Current Tunnel Details (for your records)

Tunnel ID: ce9458f2-7b51-4649-9398-87ac9b30537d
Dashboard: https://dash.cloudflare.com/ (log in with bapay.9@gmail.com / Google)
Zone: berhampore.in (Zone ID: a79c56ccfc82f14300ef8ff6102cbd1a)
Account ID: e4ae43fa115c44698297dce679f06428

DNS Records:
- berhampore.in → A records → Cloudflare proxy (172.67.160.128, 104.21.33.84)
- dev.berhampore.in → CNAME → ce9458f2-7b51-4649-9398-87ac9b30537d.cfargotunnel.com
- api.berhampore.in → CNAME → ce9458f2-7b51-4649-9398-87ac9b30537d.cfargotunnel.com

All through Cloudflare proxy (orange cloud / proxied).
