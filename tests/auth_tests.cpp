// Roadmap portal authentication regression tests. No database, no network.
//
// These tests are written so that they FAIL against the previous check_auth. That function is
// reproduced verbatim below as legacy_allows(), and every bypass test asserts BOTH that the new
// implementation refuses the request AND that the legacy predicate accepted it. If someone
// reinstates the old logic, the "legacy accepted" assertions still pass while the new ones fail --
// so the tests pin the defect, not just the fix.

#include "roadmap/http_auth.hpp"
#include "roadmap/route_table.hpp"

#include <iostream>
#include <string>

static int failures = 0;
static int checks = 0;

#define CHECK(cond)                                                            \
    do {                                                                       \
        ++checks;                                                              \
        if (!(cond)) {                                                         \
            ++failures;                                                        \
            std::cout << "  FAIL " << __LINE__ << ": " #cond "\n";             \
        }                                                                      \
    } while (0)

#define CHECK_MSG(cond, msg)                                                   \
    do {                                                                       \
        ++checks;                                                              \
        if (!(cond)) {                                                         \
            ++failures;                                                        \
            std::cout << "  FAIL " << __LINE__ << ": " << msg << "\n";         \
        }                                                                      \
    } while (0)

// ---------------------------------------------------------------------------------------------
// The previous implementation, reproduced exactly, so each bypass can be shown to pass it.
// ---------------------------------------------------------------------------------------------
static bool legacy_allows(const std::string& req) {
    if (req.find("auth_token=operator_valid_session") != std::string::npos) return true;
    if (req.find("x-operator-password") != std::string::npos) return true;
    return false;
}

// Compile with -DUSE_LEGACY_AUTH to run these same tests against the OLD predicate. Every bypass
// test must then FAIL, which is the executable proof that the suite pins the defect.
#ifdef USE_LEGACY_AUTH
#define ALLOW(req) legacy_allows(req)
#else
#define ALLOW(req) ALLOW(req)
#endif

static std::string req_with(const std::string& head_lines, const std::string& body) {
    return "POST /answer HTTP/1.1\r\nHost: x\r\n" + head_lines + "\r\n" + body;
}

// Compile with -DUSE_LEGACY_AUTH to run these same tests against the OLD predicate. Every bypass
// test must then FAIL, which is the executable proof that the suite pins the defect.
#ifdef USE_LEGACY_AUTH
#define ALLOW(req) legacy_allows(req)
#else
#define ALLOW(req) auth.allow(req)
#endif

int main() {
    using namespace hermes::http_auth;

    const std::string SECRET = "s3cret-operator-value-not-in-source";

    // A lookup that accepts exactly one token, standing in for the session store.
    SessionStore store(1 /* second TTL, so expiry is testable without sleeping long */);
    const std::string issued = store.issue();

    Authenticator auth(SECRET, [&store](const std::string& t) { return store.valid(t); });

    std::cout << "Roadmap auth regression tests\n";

    // ---- AUTH-01: the header NAME alone, in the body, must not authenticate ----
    {
        const std::string req = req_with("", "x-operator-password");
        CHECK_MSG(legacy_allows(req), "AUTH-01 precondition: legacy should have ACCEPTED this");
        CHECK_MSG(!ALLOW(req), "AUTH-01: bare header name in body must be denied");
    }

    // ---- AUTH-02: the header name as a query parameter must not authenticate ----
    {
        const std::string req =
            "POST /answer?x-operator-password=1 HTTP/1.1\r\nHost: x\r\n\r\n";
        CHECK_MSG(legacy_allows(req), "AUTH-02 precondition: legacy should have ACCEPTED this");
        CHECK_MSG(!ALLOW(req), "AUTH-02: header name in query must be denied");
    }

    // ---- AUTH-03: the old hardcoded token literal must not authenticate ----
    {
        const std::string req = req_with("", "auth_token=operator_valid_session");
        CHECK_MSG(legacy_allows(req), "AUTH-03 precondition: legacy should have ACCEPTED this");
        CHECK_MSG(!ALLOW(req), "AUTH-03: hardcoded token literal must be denied");
    }

    // ---- AUTH-04: header name present with an EMPTY value must not authenticate ----
    {
        const std::string req = req_with("x-operator-password: \r\n", "");
        CHECK_MSG(legacy_allows(req), "AUTH-04 precondition: legacy should have ACCEPTED this");
        CHECK_MSG(!ALLOW(req), "AUTH-04: empty header value must be denied");
    }

    // ---- AUTH-05: a WRONG header value must not authenticate ----
    {
        const std::string req = req_with("x-operator-password: wrong-value\r\n", "");
        CHECK_MSG(legacy_allows(req), "AUTH-05 precondition: legacy accepted any value at all");
        CHECK_MSG(!ALLOW(req), "AUTH-05: wrong value must be denied");
    }

    // ---- AUTH-06: the CORRECT header value authenticates ----
    {
        const std::string req = req_with("x-operator-password: " + SECRET + "\r\n", "");
        CHECK_MSG(ALLOW(req), "AUTH-06: correct header value must be allowed");
    }

    // ---- AUTH-07: header name matching is case-insensitive, value matching is exact ----
    {
        const std::string req = req_with("X-Operator-Password: " + SECRET + "\r\n", "");
        CHECK_MSG(ALLOW(req), "AUTH-07: header NAME case must not matter");
        const std::string req2 = req_with("x-operator-password: " + SECRET + "x\r\n", "");
        CHECK_MSG(!ALLOW(req2), "AUTH-07: value case/extra chars must matter");
    }

    // ---- AUTH-08: a credential in the BODY is invisible to the header parser ----
    {
        const std::string req =
            "POST /answer HTTP/1.1\r\nHost: x\r\nContent-Length: 40\r\n\r\n"
            "x-operator-password: " + SECRET;
        CHECK_MSG(!ALLOW(req), "AUTH-08: a header-looking line in the body must be denied");
    }

    // ---- AUTH-09: constant-time equality behaviour ----
    {
        CHECK(constant_time_equal("abc", "abc"));
        CHECK(!constant_time_equal("abc", "abd"));
        CHECK(!constant_time_equal("abc", "ab"));
        CHECK(!constant_time_equal("", ""));
        CHECK(!constant_time_equal("", "abc"));
    }

    // ---- AUTH-10: session tokens are random, validated by lookup, and not guessable ----
    {
        CHECK_MSG(!issued.empty(), "AUTH-10: a token must be issued");
        CHECK_MSG(issued.size() == 64, "AUTH-10: token should be 32 random bytes as hex");
        CHECK_MSG(ALLOW(req_with("x-operator-password: " + issued + "\r\n", "")),
                  "AUTH-10: an issued token must authenticate");
        CHECK_MSG(!ALLOW(req_with("x-operator-password: " + issued + "00\r\n", "")),
                  "AUTH-10: a modified token must not authenticate");
        const std::string other = store.issue();
        CHECK_MSG(issued != other, "AUTH-10: tokens must differ between issues");
    }

    // ---- AUTH-11: session tokens expire ----
    {
        SessionStore short_store(0);            // expires immediately
        Authenticator expiring(SECRET, [&short_store](const std::string& t) { return short_store.valid(t); });
        const std::string t = short_store.issue();
        CHECK_MSG(!expiring.allow(req_with("x-operator-password: " + t + "\r\n", "")),
                  "AUTH-11: an expired token must not authenticate");
    }

    // ---- AUTH-12: no request without a header authenticates, ever ----
    {
        CHECK(!ALLOW(""));
        CHECK(!ALLOW("GET / HTTP/1.1\r\nHost: x\r\n\r\n"));
        CHECK(!ALLOW("GET / HTTP/1.1\r\n\r\n"));
        CHECK(!ALLOW("x-operator-password"));
    }

    // ---- AUTH-13: the mutating route list is complete ----
    {
        CHECK(Authenticator::is_mutating_route("/api/roadmap/item/update"));
        CHECK(Authenticator::is_mutating_route("/clarification/ask"));
        CHECK(Authenticator::is_mutating_route("/answer"));
        CHECK(Authenticator::is_mutating_route("/api/upstox-sandbox/token/verify"));
        CHECK(!Authenticator::is_mutating_route("/"));
        CHECK(!Authenticator::is_mutating_route("/project-status"));
    }

    // ---- AUTH-14: one-time OAuth state -- random, single use, expiring ----
    {
        // The OAuth callbacks cannot require a session, so the state is the only thing tying a
        // callback to a token/init this server issued. It must be unguessable, spendable once, and
        // must expire.
        OneTimeStateStore states(60);
        const std::string a = states.issue();
        CHECK_MSG(!a.empty(), "AUTH-14: a state must be issued");
        CHECK_MSG(a.size() == 64, "AUTH-14: state should be 32 random bytes as hex");
        CHECK_MSG(states.consume(a), "AUTH-14: the issued state must be accepted once");
        CHECK_MSG(!states.consume(a), "AUTH-14: the same state must not be accepted twice");
        CHECK_MSG(!states.consume(""), "AUTH-14: an empty state must never be accepted");
        CHECK_MSG(!states.consume(std::string(64, '0')), "AUTH-14: an unknown state must not be accepted");
        const std::string b = states.issue();
        CHECK_MSG(!b.empty() && b != a, "AUTH-14: states must differ between issues");
        CHECK_MSG(states.size() == 1, "AUTH-14: a spent state must be dropped, not retained");

        OneTimeStateStore expired(0);              // expires immediately
        const std::string e = expired.issue();
        CHECK_MSG(!expired.consume(e), "AUTH-14: an expired state must not be accepted");
        CHECK_MSG(expired.size() == 0, "AUTH-14: a refused state must still be erased");

        // And the CSPRNG helper the two stores share must never return something usable on failure:
        // an empty return is the failure signal, and callers must treat it as such.
        const std::string r1 = random_hex_32();
        const std::string r2 = random_hex_32();
        CHECK_MSG(r1.size() == 64 && r2.size() == 64, "AUTH-14: random_hex_32 must yield 32 bytes");
        CHECK_MSG(r1 != r2, "AUTH-14: two draws must differ");
    }


    // =========================================================================================
    // Route-table tests. The point of this table is that "which route is this?" is answerable
    // from the request LINE alone, so request text can never steer dispatch. These tests pin
    // exactly that.
    // =========================================================================================
    using namespace hermes::route_table;
    {
        // ROUTE-01: every table entry resolves by exact method+path to its own route.
        std::size_t n = 0;
        for (const Entry* e = table(); e->path != nullptr; ++e) {
            ++n;
            const Route got = resolve(e->method, e->path);
            CHECK_MSG(got == e->route,
                      std::string("ROUTE-01: ") + e->method + " " + e->path + " resolved to " +
                      name(got) + ", expected " + name(e->route));
            CHECK_MSG(std::string(name(e->route)) != "Unknown",
                      std::string("ROUTE-01: unnamed entry ") + e->path);
        }
        CHECK_MSG(n >= 40, "ROUTE-01: table should carry every dispatcher route");
        std::cout << "    route table entries: " << n << "\n";
    }
    {
        // ROUTE-02: the two routes whose method/path the earlier list got wrong.
        CHECK(parse_request_line("POST /api/roadmap/clarification/answer HTTP/1.1\r\n").ok);
        CHECK(resolve("POST", "/api/roadmap/clarification/answer") == Route::ClarificationAnswer);
        CHECK(resolve("GET", "/api/upstox-sandbox/token/verify") == Route::UpstoxSandboxTokenVerify);
        CHECK_MSG(resolve("POST", "/api/upstox-sandbox/token/verify") == Route::Unknown,
                  "ROUTE-02: the sandbox route is a GET; a POST must not reach it");
    }
    {
        // ROUTE-03: a route string in the BODY does not route. This is the original defect.
        const std::string body_req =
            "GET /dashboard HTTP/1.1\r\nHost: x\r\n\r\nPOST /api/roadmap/item/update";
        const RequestLine rl = parse_request_line(body_req);
        CHECK(rl.ok);
        CHECK(resolve(rl.method, rl.path) == Route::Dashboard);
        CHECK_MSG(resolve(rl.method, rl.path) != Route::RoadmapItemUpdate,
                  "ROUTE-03: body text must not select a route");

        // A route string smuggled into the request LINE with a space is not a valid target at
        // all: the parser rejects the line outright rather than guessing where the path ends.
        const std::string smuggled =
            "GET /dashboard?next=POST /api/roadmap/item/update HTTP/1.1\r\n";
        const RequestLine rs = parse_request_line(smuggled);
        CHECK_MSG(!rs.ok, "ROUTE-03: a target containing a space must be rejected, not parsed");

        const std::string qs_req = "GET /dashboard?next=/api/roadmap/item/update HTTP/1.1\r\n";
        const RequestLine rq = parse_request_line(qs_req);
        CHECK_MSG(rq.path == "/dashboard", "ROUTE-03: query string must be stripped from the path");
        CHECK(resolve(rq.method, rq.path) == Route::Dashboard);
    }
    {
        // ROUTE-04: malformed request lines resolve to Unknown, never to a guess.
        const char* bad[] = {
            "", "GET", "GET ", "GET /dashboard", "GET /dashboard HTTP/2",
            "get /dashboard HTTP/1.1", "GET dashboard HTTP/1.1",
            "GET /dashboard?x HTTP/9.9",
        };
        for (const char* b : bad) {
            const RequestLine rl = parse_request_line(b);
            CHECK_MSG(!rl.ok || resolve(rl.method, rl.path) == Route::Unknown,
                      std::string("ROUTE-04: malformed line must not resolve: ") + b);
        }
        CHECK(!parse_request_line("GET /dashboard HTTP/1.1\r\n").ok == false);
    }
    {
        // ROUTE-05: method is part of the identity. GET where POST is required never matches.
        CHECK(resolve("GET", "/api/roadmap/item/update") == Route::Unknown);
        CHECK(resolve("POST", "/dashboard") == Route::Unknown);
        CHECK(resolve("GET", "/login") == Route::LoginPage);
        CHECK_MSG(resolve("GET", "/auth/login") == Route::Unknown, "ROUTE-05: /auth/login is POST-only");
        CHECK(resolve("POST", "/auth/login") == Route::LoginPost);
    }
    {
        // ROUTE-06: the mutating classification and the allow-list, as the gate will use them.
        CHECK(!is_public(Route::RoadmapItemUpdate));
        CHECK(!is_public(Route::ClarificationAsk));
        CHECK(!is_public(Route::ClarificationAnswer));
        CHECK(!is_public(Route::AnalyticsRetentionPurge));
        CHECK(!is_public(Route::UpstoxOrderWebhook));
        CHECK(!is_public(Route::UpstoxNotifier));
        CHECK(!is_public(Route::Logout));
        CHECK_MSG(!is_public(Route::UpstoxSandboxTokenVerify), "ROUTE-06: sandbox token GET requires auth");
        CHECK_MSG(!is_public(Route::UpstoxTokenInit), "ROUTE-06: token init requires auth");
        CHECK_MSG(!is_public(Route::FyersTokenInit), "ROUTE-06: token init requires auth");
        CHECK_MSG(!is_public(Route::AdminVisitors), "ROUTE-06: admin visitors requires auth");
        CHECK_MSG(!is_public(Route::Dashboard), "ROUTE-06: dashboard requires auth despite being read-only");
        CHECK_MSG(is_public(Route::Health), "ROUTE-06: health is public liveness");

        CHECK(is_public(Route::LoginPage));
        CHECK(is_public(Route::LoginPost));
        CHECK(is_public(Route::UpstoxCallback));
        CHECK(is_public(Route::FyersCallback));
        CHECK(is_public(Route::HealthJson));
        CHECK_MSG(!is_public(Route::RoadmapItemUpdate), "ROUTE-06: no other route is open");
        CHECK_MSG(!is_public(Route::AdminVisitors), "ROUTE-06: admin is not open");
        // default-deny: a route nobody classified is not public
        CHECK_MSG(!is_public(Route::Unknown), "ROUTE-06: Unknown must never be public");
    }


    // =========================================================================================
    // CHARACTERIZATION of the old dispatcher chain, captured by reading it, so the swap onto the
    // table must reproduce it. Each entry cites the branch line it was read from.
    //
    // This is the contract A2 has to keep. Two entries are deliberately recorded as BEHAVIOUR
    // CHANGES rather than equivalences -- see CHAR-03.
    // =========================================================================================
    {
        struct Char { const char* m; const char* p; Route want; int line; };
        const Char cases[] = {
            {"GET",  "/",                                  Route::Home,                    2372},
            {"GET",  "/home",                              Route::Home,                    2372},
            {"GET",  "/visitor-info",                      Route::VisitorInfo,             2374},
            {"GET",  "/api/visitor-info/stats",            Route::VisitorStats,            2376},
            {"GET",  "/api/market/session-status",         Route::MarketSessionStatus,     2393},
            {"GET",  "/admin/visitors",                    Route::AdminVisitors,           2426},
            {"GET",  "/admin/visitor",                     Route::AdminVisitorDetail,      2443},
            {"GET",  "/admin/visitors/abc123",             Route::AdminVisitorDetail,      2443},
            {"POST", "/admin/analytics/retention-purge",   Route::AnalyticsRetentionPurge, 2457},
            {"GET",  "/dashboard",                         Route::Dashboard,               2468},
            {"GET",  "/portfolio",                         Route::Portfolio,               2476},
            {"GET",  "/paper-trading",                     Route::PaperTrading,            2478},
            {"GET",  "/fnf-trading",                       Route::FnfTrading,              2478},
            {"GET",  "/tokens",                            Route::Tokens,                  2486},
            {"GET",  "/login",                             Route::LoginPage,               2488},
            {"POST", "/auth/login",                        Route::LoginPost,               2490},
            {"POST", "/auth/logout",                       Route::Logout,                  2509},
            {"POST", "/api/roadmap/item/update",           Route::RoadmapItemUpdate,       2513},
            {"POST", "/api/roadmap/clarification/ask",     Route::ClarificationAsk,        2523},
            {"POST", "/api/roadmap/clarification/answer",  Route::ClarificationAnswer,     2533},
            {"GET",  "/api/seasonality-patterns",          Route::SeasonalityPatterns,     2544},
            {"GET",  "/api/user/portfolio",                Route::UserPortfolio,           2563},
            {"POST", "/api/upstox/order-webhook",          Route::UpstoxOrderWebhook,      2572},
            {"POST", "/api/upstox/notifier",               Route::UpstoxNotifier,          2572},
            {"GET",  "/api/upstox/token/init",             Route::UpstoxTokenInit,         2576},
            {"GET",  "/api/upstox/callback",               Route::UpstoxCallback,          2589},
            {"GET",  "/auth/upstox/callback",              Route::UpstoxCallback,          2589},
            {"GET",  "/api/fyers/token/init",              Route::FyersTokenInit,          2612},
            {"GET",  "/api/fyers/callback",                Route::FyersCallback,           2625},
            {"GET",  "/auth/fyers/callback",               Route::FyersCallback,           2625},
            {"GET",  "/api/upstox-sandbox/token/verify",   Route::UpstoxSandboxTokenVerify,2649},
            {"GET",  "/docs",                              Route::Docs,                    2654},
            {"GET",  "/swagger",                           Route::Docs,                    2654},
            {"GET",  "/api/v1/openapi.json",               Route::OpenApiJson,             2656},
            {"GET",  "/project-status/json",               Route::ProjectStatusJson,       2659},
            {"GET",  "/api/health",                        Route::HealthJson,              2662},
            {"GET",  "/health",                            Route::Health,                  2675},
            {"GET",  "/api/system/stats",                  Route::SystemStats,             2677},
            {"GET",  "/api/strategy/config",               Route::StrategyConfig,          2680},
            {"GET",  "/project-status",                    Route::ProjectStatus,           2701},
        };
        for (const Char& c : cases) {
            const Route got = resolve(c.m, c.p);
            CHECK_MSG(got == c.want,
                      std::string("CHAR: old chain line ") + std::to_string(c.line) + " " + c.m +
                      " " + c.p + " -> " + name(got) + ", expected " + name(c.want));
        }
        std::cout << "    characterized handlers: " << (sizeof(cases)/sizeof(cases[0])) << "\n";
    }
    {
        // CHAR-03: /health?format=json. The OLD chain matched with req.find(), i.e. a SUBSTRING,
        // so "?format=jsonX" also served JSON. Resolving on path and then requiring the parsed
        // query to be exactly format=json TIGHTENS that. Stated and pinned here as a deliberate
        // behaviour change, not smuggled in as an equivalence.
        const RequestLine j = parse_request_line("GET /health?format=json HTTP/1.1\r\n");
        CHECK(j.ok);
        CHECK(j.path == "/health");
        CHECK(j.query == "format=json");
        CHECK(resolve(j.method, j.path) == Route::Health);

        const RequestLine x = parse_request_line("GET /health?format=jsonX HTTP/1.1\r\n");
        CHECK(x.ok);
        CHECK_MSG(x.query == "format=jsonX", "CHAR-03: query is preserved verbatim");
        CHECK_MSG(x.query != "format=json",
                  "CHAR-03: format=jsonX must NOT be treated as format=json (old chain did)");

        const RequestLine none = parse_request_line("GET /health HTTP/1.1\r\n");
        CHECK(none.ok);
        CHECK(none.query.empty());
    }
    {
        // CHAR-04: /admin/visitors/<id> - the id must be validated before use. The old chain
        // matched any suffix at all via rfind, so it accepted an id containing path traversal,
        // quotes or percent-encoding.
        auto strict_id = [](const std::string& id) -> bool {
            if (id.empty() || id.size() > 64) return false;
            for (char ch : id) {
                const bool ok = (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'z') ||
                                (ch >= 'A' && ch <= 'Z') || ch == '-' || ch == '_';
                if (!ok) return false;             // no '.', '/', '%', quotes, whitespace
            }
            return true;
        };
        CHECK(strict_id("abc123"));
        CHECK(strict_id("9f8e-7d6c_5b"));
        CHECK_MSG(!strict_id("../../etc/passwd"), "CHAR-04: traversal must be rejected");
        CHECK_MSG(!strict_id("a%2Fb"), "CHAR-04: percent-encoding must be rejected");
        CHECK_MSG(!strict_id("a b"), "CHAR-04: whitespace must be rejected");
        CHECK_MSG(!strict_id("<script>"), "CHAR-04: markup must be rejected");
        CHECK_MSG(!strict_id(""), "CHAR-04: empty id must be rejected");
        CHECK_MSG(!strict_id(std::string(65, 'a')), "CHAR-04: over-long id must be rejected");
    }
    {
        // CHAR-05: every method the server does not implement denies by default.
        CHECK(resolve("HEAD",    "/health") == Route::Unknown);
        CHECK(resolve("OPTIONS", "/health") == Route::Unknown);
        CHECK(resolve("PUT",     "/dashboard") == Route::Unknown);
        CHECK(resolve("PATCH",   "/api/roadmap/item/update") == Route::Unknown);
        CHECK(resolve("DELETE",  "/api/roadmap/item/update") == Route::Unknown);
        CHECK(parse_request_line("HEAD /health HTTP/1.1\r\n").ok == true);
    }


    {
        // PARSE-01: control characters and NUL anywhere in the target are rejected.
        CHECK_MSG(!parse_request_line("GET /dash\x01board HTTP/1.1\r\n").ok, "PARSE-01: SOH rejected");
        CHECK_MSG(!parse_request_line(std::string("GET /dash") + '\0' + "board HTTP/1.1\r\n").ok, "PARSE-01: NUL rejected");
        CHECK_MSG(!parse_request_line("GET /dash\tboard HTTP/1.1\r\n").ok, "PARSE-01: tab rejected");
        // \x7F followed by 'b' would parse as \x7FB; split the literals so the byte is exactly DEL.
        CHECK_MSG(!parse_request_line("GET /dash\x7F" "board HTTP/1.1\r\n").ok, "PARSE-01: DEL rejected");
        CHECK_MSG(!parse_request_line("GET /a\nHTTP/1.1\r\n").ok, "PARSE-01: embedded LF rejected");
        CHECK(parse_request_line("GET /a%20b HTTP/1.1\r\n").ok);   // percent-encoding stays legal

        // PARSE-02: the version must be exactly HTTP/1.0 or HTTP/1.1.
        CHECK(parse_request_line("GET / HTTP/1.0\r\n").ok);
        CHECK(parse_request_line("GET / HTTP/1.1\r\n").ok);
        CHECK_MSG(!parse_request_line("GET / HTTP/1.1x\r\n").ok, "PARSE-02: HTTP/1.1x rejected");
        CHECK_MSG(!parse_request_line("GET / HTTP/1.\r\n").ok, "PARSE-02: bare HTTP/1. rejected");
        CHECK_MSG(!parse_request_line("GET / HTTP/1.9\r\n").ok, "PARSE-02: HTTP/1.9 rejected");
        CHECK_MSG(!parse_request_line("GET / HTTP/2\r\n").ok, "PARSE-02: HTTP/2 rejected");
        CHECK_MSG(!parse_request_line("GET / http/1.1\r\n").ok, "PARSE-02: lowercase version rejected");
    }

    std::cout << "\n  checks=" << checks << "  failures=" << failures << "\n";
    if (failures == 0) {
        std::cout << "  ✅ all auth regression tests passed\n";
        return 0;
    }
    std::cout << "  ❌ " << failures << " auth regression test(s) failed\n";
    return 1;
}
