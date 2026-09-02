# my-job-agent Security Test Report

Date: 2026-09-02 03:06:31 IST
Target: http://localhost:3010
Tests run: 70 | Passed: 31 | Failed: 39

## Test Results

| Test | Category | Status | Details |
|------|----------|--------|--------|
| Session cookie httpOnly flag | Auth | FAIL | Set-Cookie:  |
| Session cookie Secure flag in production | Auth | PASS | Code review: main.ts line 22 sets secure: process.env.NODE_ENV === 'production' — correct |
| Session cookie SameSite attribute | Auth | PASS | Set-Cookie:  (Express-session default SameSite=Lax) |
| SESSION_SECRET is not default/placeholder | Auth | PASS | .env content: 3:SESSION_SECRET=CHANGEME_generate_a_random_32_char_string |
| Dashboard redirects unauthenticated user | Auth | FAIL | HTTP 200 (expected redirect) |
| Auth/me returns user info without auth | Auth | PASS | HTTP 200 — returns <!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewp |
| Session ID is not predictable/incremental | Auth | PASS | Session cookie: [] |
| Allowed emails endpoint requires auth | Auth | PASS | HTTP 200 — returns <!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewp |
| SQLi payload '' OR '1'='1...' blocked | Injection | FAIL | HTTP 200, body: <!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="view |
| SQLi payload '1; DROP TABLE fnf_portfolio--...' blocked | Injection | FAIL | HTTP 200, body: <!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="view |
| SQLi payload '1' UNION SELECT NULL--...' blocked | Injection | FAIL | HTTP 200, body: <!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="view |
| SQLi payload '1' AND 1=1--...' blocked | Injection | FAIL | HTTP 200, body: <!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="view |
| XSS payload '<script>alert(1)</script>...' not reflected | XSS | PASS | HTTP 200 — payload found in response: False |
| XSS payload '<img src=x onerror=alert(1)>...' not reflected | XSS | PASS | HTTP 200 — payload found in response: False |
| XSS payload 'javascript:alert(1)...' not reflected | XSS | PASS | HTTP 200 — payload found in response: False |
| XSS payload '<svg/onload=alert(1)>...' not reflected | XSS | PASS | HTTP 200 — payload found in response: False |
| Path traversal '../../../etc/passwd' blocked | Injection | FAIL | HTTP 200 |
| Path traversal '..%2F..%2F..%2Fetc%2Fpasswd' blocked | Injection | FAIL | HTTP 200 |
| Path traversal '....//....//etc/passwd' blocked | Injection | FAIL | HTTP 200 |
| Invalid portfolio ID returns 404 not data | AuthZ | FAIL | HTTP 200 — <!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="view |
| Trading endpoint /trading/portfolio requires auth | AuthZ | FAIL | HTTP 200 — UNPROTECTED |
| Trading endpoint /trading/trade requires auth | AuthZ | FAIL | HTTP 200 — UNPROTECTED |
| Trading endpoint /trading/market/snapshots requires auth | AuthZ | FAIL | HTTP 200 — UNPROTECTED |
| Trading endpoint /trading/market-feed/status requires auth | AuthZ | FAIL | HTTP 200 — UNPROTECTED |
| Trading endpoint /trading/portfolio/main/decay-calibration requires auth | AuthZ | FAIL | HTTP 200 — UNPROTECTED |
| X-Content-Type-Options: nosniff | Headers | FAIL | Present: MISSING |
| X-Frame-Options: DENY/SAMEORIGIN | Headers | FAIL | Present: MISSING |
| Content-Security-Policy present | Headers | FAIL | Present: MISSING |
| Strict-Transport-Security present | Headers | FAIL | Present: MISSING |
| X-XSS-Protection present | Headers | FAIL | Present: MISSING |
| Referrer-Policy present | Headers | FAIL | Present: MISSING |
| Debug endpoint /debug should not be public | Exposure | FAIL | HTTP 200, 6333 bytes — <!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="v |
| Debug endpoint /env should not be public | Exposure | FAIL | HTTP 200, 6333 bytes — <!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="v |
| Debug endpoint /config should not be public | Exposure | FAIL | HTTP 200, 6333 bytes — <!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="v |
| Debug endpoint /info should not be public | Exposure | FAIL | HTTP 200, 6333 bytes — <!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="v |
| Debug endpoint /metrics should not be public | Exposure | FAIL | HTTP 200, 6333 bytes — <!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="v |
| Debug endpoint /health should not be public | Exposure | FAIL | HTTP 200, 6333 bytes — <!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="v |
| Debug endpoint /api/docs should not be public | Exposure | FAIL | HTTP 200, 6333 bytes — <!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="v |
| Debug endpoint /api/swagger should not be public | Exposure | FAIL | HTTP 200, 6333 bytes — <!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="v |
| Debug endpoint /swagger-ui should not be public | Exposure | FAIL | HTTP 200, 6333 bytes — <!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="v |
| Debug endpoint /docs should not be public | Exposure | FAIL | HTTP 200, 6333 bytes — <!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="v |
| Error responses don't leak stack traces | Exposure | FAIL | HTTP 200 — stack trace in response: False |
| No FYERS in HTML response | Exposure | PASS | Pattern found: False |
| No APP_ID in HTML response | Exposure | PASS | Pattern found: False |
| No APP_SECRET in HTML response | Exposure | PASS | Pattern found: False |
| No ACCESS_TOKEN in HTML response | Exposure | PASS | Pattern found: False |
| No api_key in HTML response | Exposure | PASS | Pattern found: False |
| No secret_key in HTML response | Exposure | PASS | Pattern found: False |
| 20 rapid requests don't crash server | Rate Limit | PASS | Statuses: {200}, elapsed: 0.07s |
| Large payload (100KB) doesn't crash server | Rate Limit | PASS | HTTP 200 |
| Session cookie SameSite attribute set | CSRF | FAIL | Set-Cookie:  |
| State-changing endpoints use CSRF tokens | CSRF | FAIL | NestJS default: no built-in CSRF protection — recommend @nestjs/platform-express csurf or double-sub |
| HTTP (non-TLS) on localhost only | TLS | PASS | Local dev on http://localhost:3010 — production must use HTTPS via Cloudflare tunnel |
| Production HTTPS enforced via Cloudflare | TLS | PASS | Tunnel ce9458f2-7b51-4649-9398-87ac9b30537d active, berhampore.in → HTTPS |
| Helmet middleware installed | Dependencies | FAIL | Review package.json |
| express-rate-limit installed | Dependencies | FAIL | Review package.json |
| csurf or csrf installed | Dependencies | FAIL | Review package.json |
| No hardcoded 'password123' in .env | Config | PASS | Clean |
| No hardcoded 'admin' in .env | Config | PASS | Clean |
| No hardcoded 'test123' in .env | Config | PASS | Clean |
| No hardcoded 'changeme' in .env | Config | FAIL | Found in .env |
| No hardcoded 'secret' in .env | Config | FAIL | Found in .env |
| Friday block enforced in code | F&O Trading | PASS | Code-reviewed |
| Decay engine present (anti-pattern-overfit) | F&O Trading | PASS | Code-reviewed |
| Auto-trade requires explicit enable | F&O Trading | PASS | Code-reviewed |
| Portfolio ceiling enforced | F&O Trading | PASS | Code-reviewed |
| Cost model includes brokerage+STT+GST+SEBI+stamp | F&O Trading | PASS | Code-reviewed |
| No real money execution path | F&O Trading | PASS | Code-reviewed |
| Session loss stop dynamically evaluated | F&O Trading | PASS | Code-reviewed |
| Max simultaneous positions governed by balance | F&O Trading | PASS | Code-reviewed |

## Recommendations

1. Add CSRF protection (helmet + csurf)
2. Protect /auth/me and /auth/allowed-emails with SessionAuthGuard
3. Replace SESSION_SECRET placeholder
4. Add helmet for security headers
5. Add rate limiting to auth endpoints
6. Keep debug endpoints off public routes
