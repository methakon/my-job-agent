// Roadmap portal authentication regression tests. No database, no network.
//
// These tests are written so that they FAIL against the previous check_auth. That function is
// reproduced verbatim below as legacy_allows(), and every bypass test asserts BOTH that the new
// implementation refuses the request AND that the legacy predicate accepted it. If someone
// reinstates the old logic, the "legacy accepted" assertions still pass while the new ones fail --
// so the tests pin the defect, not just the fix.

#include "roadmap/http_auth.hpp"

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

    std::cout << "\n  checks=" << checks << "  failures=" << failures << "\n";
    if (failures == 0) {
        std::cout << "  ✅ all auth regression tests passed\n";
        return 0;
    }
    std::cout << "  ❌ " << failures << " auth regression test(s) failed\n";
    return 1;
}
