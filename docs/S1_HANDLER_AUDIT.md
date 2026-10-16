# S1 — Handler audit: what every route returns to an unauthenticated caller

Scope: `src/roadmap/roadmap_server.cpp` at local HEAD `df7193aaeb28814e111e3cd1f1ff72c80b117b97`
(branch `feat/cpp-trading-agent`). Every claim below was read from disk at that revision, with the
line cited. No claim here is taken from memory or from a previous session.

Method: the dispatcher chain (lines 2372–2705) was read end to end and each branch was classified
by (a) whether it consults `is_auth`, (b) what the handler body reads or writes, and (c) what
appears in the response. `is_auth` is `check_auth(req)` (line 2323); the whole of its logic is:

    static bool check_auth(const std::string& req) {                    // line 1418
        if (req.find("auth_token=operator_valid_session") != npos) return true;   // 1420
        if (req.find("x-operator-password") != npos) return true;                 // 1421
        return false;

Because both tests are substring searches over the **entire raw request**, `is_auth` is true for any
request whose text contains the header *name*, or the cookie literal that ships in the repository.
It is therefore not an access control at all, and "gated by is_auth" below means **gated by
something an unauthenticated attacker can satisfy trivially**. This audit records what each handler
returns; it does not treat the `is_auth` guard as a boundary.

## The four routes named first

| Route | Unauthenticated body | Verdict |
|---|---|---|
| `GET /visitor-info` (2374) | Aggregate analytics dashboard: lifetime page views / visits / unique visitors / retained views / bounce rate (1841–1864), tracker queue counters persisted/enqueued/dropped (1867), top-10 visited **paths** with counts (1894–1899), top-10 countries + ISO codes (1908–1913), browser/OS/device-category counts (1921–1941). No IP, no hostname, no visitor id, no version. | **SAFE as an aggregate.** No identifiers and no operator data. Residual: `fetch_analytics_popular_pages` (db_client.cpp:3224) groups every recorded path, so operator paths (`/admin/visitors`, `/api/roadmap/...`) appear by name in a public table — route-name disclosure only. |
| `GET /api/visitor-info/stats` (2376) | JSON of the same aggregates from `fetch_analytics_summary_stats()` (db_client.cpp:3144): `total_visitors`, `lifetime_page_views/visits`, `retained_page_views/sessions`, `visitors_today`, `page_views_today`, `bot_page_views`, `unique_estimated_visitors`, `bounce_rate_pct`. Counts only. | **SAFE.** Aggregate counts; nothing identifying. |
| `GET /health` (2675) | HTML telemetry page (`render_health_page`, 1625): DB connected/disconnected (1673), **today / all-time stored tick counts** from `fetch_stored_tick_counts()` (1681–1682), **build revision** `HERMES_BUILD_GIT_SHA` (1676), the literal `Oracle Cloud MDS (3307)` as "Database Host" (1705), plus live CPU/RAM/load fetched client-side from `/api/system/stats` (1709–1724). | **NOT a pure liveness body.** Exposes build version, DB connectivity and port, and commercial volume telemetry. Kept public **only** as a documented, operator-owned exception — see "Decision" below. |
| `GET /api/health` (2662) | `{"status":"OK","engine":"C++20","revision":"<HERMES_BUILD_GIT_SHA>","db_connected":<bool>}` (2671–2673). | **Version + DB state disclosure,** nothing else. Liveness. Kept public as a documented exception. |

`/health?format=json` is the *same* branch as `/api/health` (2662 matches `req.find("GET /health?format=json")`).
The new resolver tightens this: only the exact query `format=json` selects JSON, and `format=jsonX`
does not (pinned in tests/auth_tests.cpp:345–365, CHAR-03).

## The other 36 table entries — one line each

"UNGATED" = the branch contains no `is_auth` test at all.

| # | Route (line) | Unauthenticated result | Safe to be public? |
|---|---|---|---|
| 1 | `GET /`, `GET /home` (2372) | `render_home_page(false)`: marketing landing page + nav; **no DB read** (verified: no `db_client_` in 190–282) | YES — static marketing |
| 2 | `GET /api/market/session-status` (2393) | **UNGATED** JSON of live signal inputs: session phase, trigger rule, LTP, prev close, change %, open, VWAP, VWAP delta, ORB high/low, **OFI**, ATR-14, 20-day baseline vol, intraday range, evaluated_at_ist (2400–2421) | NO — live trading telemetry |
| 3 | `GET /admin/visitors` (2426) | 303 → `/login` when not authed; full IP-level visitor table when authed | NO — IPs, locations |
| 4 | `GET /admin/visitor`, `GET /admin/visitors/<id>` (2443) | 303 → `/login` when not authed; per-visitor detail (raw IP, geo, UA) when authed | NO — IPs, locations |
| 5 | `POST /admin/analytics/retention-purge` (2457) | 401 JSON when not authed; destructive purge when authed | NO — mutating |
| 6 | `GET /dashboard` (2468) | 303 → `/login` when not authed | NO — operator panel |
| 7 | `GET /portfolio` (2476) | **UNGATED** `render_portfolio_page(false)`: real default user's capital, deployed, net P&L, portfolio id and email read from DB (430–436, 469) | NO — account financials |
| 8 | `GET /paper-trading` (2478) | **UNGATED** `render_paper_trading_page(false)`: trades, broker token validity, market snapshots, decay calibrations, learning summary, sandbox logs, session telemetry (515–528) | NO — trading data |
| 9 | `GET /fnf-trading` (2478) | same branch as #8, same body | NO |
| 10 | `GET /tokens` (2486) | **UNGATED** `render_tokens_page(false)`: broker client IDs, token status and expiry per broker (950–957, 996–1000) | NO — broker credentials metadata |
| 11 | `GET /login` (2488) | Login form (1175). Note: the form ships a default operator email `bapay.9@gmail.com` in the `value=` attribute (1207) | YES (required) — email disclosure noted |
| 12 | `POST /auth/login` (2490) | Password check (2498–2500); on success sets `auth_token=operator_valid_session` (2504) | YES (required) — see step D |
| 13 | `POST /auth/logout` (2509) | Clears the cookie; no session state | YES — no-op without a session |
| 14 | `POST /api/roadmap/item/update` (2513) | **UNGATED DB WRITE** — `update_hermes_cpp_item_status_and_note(item_id,status,note)` (2519) with values taken from the body | NO — unauthenticated mutation |
| 15 | `POST /api/roadmap/clarification/ask` (2523) | **UNGATED DB WRITE** — `add_hermes_cpp_clarification(...)` (2529) | NO |
| 16 | `POST /api/roadmap/clarification/answer` (2533) | **UNGATED DB WRITE** — `answer_hermes_cpp_clarification(id, answer)` (2540) | NO |
| 17 | `GET /api/seasonality-patterns` (2544) | **UNGATED** research JSON from DB: per-pattern underlying, bucket, DTE, volatility, persistence, spread, OI build-up, gating status, hypothesis summary (2547–2562) | NO — strategy research |
| 18 | `GET /api/user/portfolio` (2563) | 401 JSON when not authed; capital/deployed/net P&L when authed | NO |
| 19 | `POST /api/upstox/order-webhook` (2572) | **UNGATED.** Body is a fixed JSON echo `{"status":"RECEIVED",...}` (2575); **no DB call, no state change** | NO (but non-mutating; see step B) |
| 20 | `POST /api/upstox/notifier` (2572) | same branch as #19 — echo only, non-mutating | NO (non-mutating) |
| 21 | `GET /api/upstox/token/init` (2576) | **UNGATED** 303 to the Upstox authorize URL, leaking `client_id` in `Location` (2585) | NO — must require a session and issue one-time state |
| 22 | `GET /api/upstox/callback` (2589) | **UNGATED and MUTATING**: exchanges `?code=` for a token and **writes it to the DB** (2595–2597) | NO — public but must be state-gated |
| 23 | `GET /auth/upstox/callback` (2589) | same branch as #22 | NO — same |
| 24 | `GET /api/fyers/token/init` (2612) | **UNGATED** 303 to the Fyers authorize URL with a **constant** `state=hermes_state` (2621) | NO |
| 25 | `GET /api/fyers/callback` (2625) | **UNGATED and MUTATING**: exchanges `auth_code`/`code` and writes a token (2632–2634) | NO — state-gate |
| 26 | `GET /auth/fyers/callback` (2625) | same branch as #25 | NO — same |
| 27 | `GET /api/upstox-sandbox/token/verify` (2649) | **UNGATED DB WRITE** of a hardcoded sandbox token, client id and expiry (2650) | NO — unauthenticated mutation |
| 28 | `GET /docs`, `GET /swagger` (2654) | **UNGATED** Swagger UI page | NO — API surface (operator decision) |
| 29 | `GET /api/v1/openapi.json` (2656) | **UNGATED** full OpenAPI description of every route | NO — API surface |
| 30 | `GET /project-status/json` (2659) | **UNGATED** roadmap/checklist JSON read from DB (`fetch_hermes_cpp_items`, 1221–1225) | NO — internal planning data |
| 31 | `GET /api/system/stats` (2677) | **UNGATED** CPU, RAM, load, today/total tick counts, MySQL SSL cipher, and `StrategyConfigManager::to_json()` — the live strategy thresholds (163–186) | NO — infra + strategy config |
| 32 | `GET /api/strategy/config` (2680) | **UNGATED** active strategy config plus the last 10 config-audit rows (old value, new value, approver, reason) (2681–2699) | NO — strategy + audit trail |
| 33 | `GET /project-status` (2701) | `render_html_page(false)`: roadmap page; part of the body is `is_auth`-conditional (1369) | NO |
| 34 | `GET /health` (2675) | see above | exception, documented |
| 35 | `GET /api/health` (2662) | see above | exception, documented |
| 36 | *(no match)* — the dispatcher's `else` (2703) | **falls through to the home page with status 200** for any unrouted request | MUST NOT resolve at all: step 3 makes an unknown route deny |

## Decision on `is_public`

The allow-list in `route_table.hpp` (`is_public`, line 215) stands as:

    public:  LoginPage, LoginPost, UpstoxCallback, FyersCallback,
             Health, HealthJson, Home, VisitorInfo, VisitorStats

Everything else — including `/docs`, `/swagger`, `/api/v1/openapi.json`, `/api/system/stats`,
`/api/strategy/config`, `/api/market/session-status`, `/portfolio`, `/paper-trading`, `/tokens`,
`/project-status[/json]` and all four mutating OAuth/token routes — is default-deny.

Two entries are deliberate exceptions with a residual disclosure the operator owns:

* `Health`, `HealthJson` — reachable without a session so that liveness is answerable from outside
  (the unauthenticated nav links to `/health`, line 89; a probe cannot hold a session). They expose
  the build revision, DB connectivity and — for the HTML page — stored tick counts and the DB
  host/port string. **Recommended follow-up (not in this commit, to keep the step-2 differential
  comparison clean):** render the tick-count and DB-host cards only when `is_auth`, leaving
  `{"status":"OK","db_connected":...}` public. Say the word and it goes in with step 4.
* `VisitorInfo`, `VisitorStats` — aggregate-only, kept public as the site's own analytics page.

If the operator wants a stricter reading of "safe" (no version, no DB state on a public route),
the change is one line: drop `Health`/`HealthJson` from `is_public` and point the unauth nav at
`/login`. Everything else is unaffected.
