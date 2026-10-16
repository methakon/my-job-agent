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
        CHECK(is_mutating(Route::RoadmapItemUpdate));
        CHECK(is_mutating(Route::ClarificationAsk));
        CHECK(is_mutating(Route::ClarificationAnswer));
        CHECK(is_mutating(Route::AnalyticsRetentionPurge));
        CHECK(is_mutating(Route::UpstoxOrderWebhook));
        CHECK(is_mutating(Route::UpstoxNotifier));
        CHECK(is_mutating(Route::Logout));
        CHECK_MSG(is_mutating(Route::UpstoxSandboxTokenVerify), "ROUTE-06: sandbox token GET mutates");
        CHECK_MSG(is_mutating(Route::UpstoxTokenInit), "ROUTE-06: token init starts a flow");
        CHECK_MSG(is_mutating(Route::FyersTokenInit), "ROUTE-06: token init starts a flow");
        CHECK_MSG(is_mutating(Route::AdminVisitors), "ROUTE-06: admin visitors is gated");
        CHECK_MSG(!is_mutating(Route::Dashboard), "ROUTE-06: dashboard is read-only");
        CHECK_MSG(!is_mutating(Route::Health), "ROUTE-06: health is read-only");

        CHECK(is_allowlisted(Route::LoginPost));
        CHECK(is_allowlisted(Route::UpstoxCallback));
        CHECK(is_allowlisted(Route::FyersCallback));
        CHECK_MSG(!is_allowlisted(Route::RoadmapItemUpdate), "ROUTE-06: no other route is open");
        CHECK_MSG(!is_allowlisted(Route::AdminVisitors), "ROUTE-06: admin is not open");
    }

    std::cout << "\n  checks=" << checks << "  failures=" << failures << "\n";
    if (failures == 0) {
        std::cout << "  ✅ all auth regression tests passed\n";
        return 0;
    }
    std::cout << "  ❌ " << failures << " auth regression test(s) failed\n";
    return 1;
}
