#ifndef HERMES_ROADMAP_HTTP_AUTH_HPP
#define HERMES_ROADMAP_HTTP_AUTH_HPP

// Request authentication for the roadmap portal.
//
// The previous implementation was:
//
//     static bool check_auth(const std::string& req) {
//         if (req.find("auth_token=operator_valid_session") != std::string::npos) return true;
//         if (req.find("x-operator-password") != std::string::npos) return true;
//         return false;
//     }
//
// Two independent total bypasses: matching the header NAME only (so the literal text
// "x-operator-password" anywhere in the request authenticated), and matching a hardcoded token
// literal that ships in a public repository. Substring search over the raw request also cannot
// distinguish a header from a query parameter or a request body.
//
// Rules this file enforces:
//   * Only the request HEAD is examined. A credential can never come from a body or a URL.
//   * A credential must be a header VALUE, compared in constant time.
//   * Session tokens are random (kernel CSPRNG), expiring, and validated by lookup -- never by equality against
//     a constant, and never issued from a value that appears in source.
//   * Absence of credentials denies. There is no fallback that returns true.

#include <cctype>
#include <cstdio>
#include <cstddef>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <functional>
#include <mutex>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace hermes {
namespace http_auth {

// 32 bytes of kernel entropy as lowercase hex, or "" if the CSPRNG cannot be read.
//
// Every caller must treat "" as failure and FAIL CLOSED: an empty token must never be stored,
// issued, or compared, and a route that cannot obtain state must not proceed. Deliberately not
// rand(): the review flagged rand() as a predictable-IV fallback elsewhere in this codebase.
inline std::string random_hex_32() {
    unsigned char raw[32];
    FILE* entropy = std::fopen("/dev/urandom", "rb");
    if (!entropy) return std::string();
    const size_t got = std::fread(raw, 1, sizeof(raw), entropy);
    std::fclose(entropy);
    if (got != sizeof(raw)) return std::string();
    static const char* hex = "0123456789abcdef";
    std::string token;
    token.reserve(sizeof(raw) * 2);
    for (size_t i = 0; i < sizeof(raw); ++i) {
        token.push_back(hex[raw[i] >> 4]);
        token.push_back(hex[raw[i] & 0x0F]);
    }
    return token;
}

// Constant-time equality. Equal length is required, but the comparison over the bytes is not
// short-circuited, and an empty secret never matches.
inline bool constant_time_equal(const std::string& a, const std::string& b) {
    if (a.empty() || b.empty()) return false;
    if (a.size() != b.size()) return false;
    unsigned char diff = 0;
    for (size_t i = 0; i < a.size(); ++i) {
        diff |= static_cast<unsigned char>(a[i]) ^ static_cast<unsigned char>(b[i]);
    }
    return diff == 0;
}

// Extract a header VALUE from a raw HTTP request. Returns "" when absent.
//
// Only the request head (up to the first CRLFCRLF) is scanned, so text placed in a body cannot
// present itself as a header. Header names are matched case-insensitively; values are returned
// verbatim except for surrounding whitespace.
inline std::string header_value(const std::string& req, const char* name) {
    const size_t head_end = req.find("\r\n\r\n");
    const std::string head = (head_end == std::string::npos) ? req : req.substr(0, head_end);

    size_t pos = head.find("\r\n");
    if (pos == std::string::npos) return "";   // request line only: no headers
    pos += 2;

    const size_t want = std::strlen(name);
    while (pos < head.size()) {
        size_t eol = head.find("\r\n", pos);
        if (eol == std::string::npos) eol = head.size();
        const std::string line = head.substr(pos, eol - pos);

        const size_t colon = line.find(':');
        if (colon != std::string::npos) {
            size_t ns = 0;
            while (ns < colon && (line[ns] == ' ' || line[ns] == '\t')) ++ns;
            size_t ne = colon;
            while (ne > ns && (line[ne - 1] == ' ' || line[ne - 1] == '\t')) --ne;
            const std::string hname = line.substr(ns, ne - ns);

            if (hname.size() == want) {
                bool same = true;
                for (size_t i = 0; i < want; ++i) {
                    const char x = static_cast<char>(std::tolower(static_cast<unsigned char>(hname[i])));
                    const char y = static_cast<char>(std::tolower(static_cast<unsigned char>(name[i])));
                    if (x != y) { same = false; break; }
                }
                if (same) {
                    size_t vs = colon + 1;
                    while (vs < line.size() && (line[vs] == ' ' || line[vs] == '\t')) ++vs;
                    std::string v = line.substr(vs);
                    while (!v.empty() && (v.back() == '\r' || v.back() == '\n' ||
                                          v.back() == ' '  || v.back() == '\t')) {
                        v.pop_back();
                    }
                    return v;
                }
            }
        }
        pos = eol + 2;
    }
    return "";
}

// Extract one cookie VALUE from the request's Cookie header(s). Returns "" when absent.
//
// Only the request head is read (via header_value), so a cookie-looking string in a body, a query
// or another header cannot be mistaken for one. Cookie names are matched exactly and case
// sensitively, as browsers send them.
inline std::string cookie_value(const std::string& req, const char* name) {
    const std::string header = header_value(req, "cookie");
    if (header.empty()) return "";
    const std::string want(name);
    size_t pos = 0;
    while (pos < header.size()) {
        size_t end = header.find(';', pos);
        if (end == std::string::npos) end = header.size();
        size_t s = pos;
        while (s < end && (header[s] == ' ' || header[s] == '\t')) ++s;
        const size_t eq = header.find('=', s);
        if (eq != std::string::npos && eq < end && header.compare(s, eq - s, want) == 0 && eq - s == want.size()) {
            size_t e = end;
            while (e > eq + 1 && (header[e - 1] == ' ' || header[e - 1] == '\t')) --e;
            return header.substr(eq + 1, e - (eq + 1));
        }
        pos = end + 1;
    }
    return "";
}

// Exact-key lookup in a query string ("a=1&b=2"). The key must equal `name` (so "homepage=" does
// not satisfy a lookup for "page"), the first match wins, and the value is percent-decoded.
// `parse_request_line` already stripped the query from the path and rejected control characters,
// so this is the only place a query value is read, and it never sees the headers or the body.
inline std::string query_param(const std::string& query, const std::string& name) {
    size_t pos = 0;
    while (pos <= query.size()) {
        size_t amp = query.find('&', pos);
        if (amp == std::string::npos) amp = query.size();
        const size_t eq = query.find('=', pos);
        if (eq != std::string::npos && eq < amp && query.compare(pos, eq - pos, name) == 0 && eq - pos == name.size()) {
            const std::string raw = query.substr(eq + 1, amp - (eq + 1));
            std::string out;
            out.reserve(raw.size());
            for (size_t i = 0; i < raw.size(); ++i) {
                if (raw[i] == '+') {
                    out.push_back(' ');
                } else if (raw[i] == '%' && i + 2 < raw.size() &&
                           std::isxdigit(static_cast<unsigned char>(raw[i + 1])) &&
                           std::isxdigit(static_cast<unsigned char>(raw[i + 2]))) {
                    out.push_back(static_cast<char>(std::strtol(raw.substr(i + 1, 2).c_str(), nullptr, 16)));
                    i += 2;
                } else {
                    out.push_back(raw[i]);   // a lone or malformed '%' is kept literally
                }
            }
            return out;
        }
        if (amp >= query.size()) break;
        pos = amp + 1;
    }
    return "";
}

// A visitor id is server-generated ("cid_" + hex) and travels in a URL path, so anything outside
// [A-Za-z0-9_-] (traversal, percent-encoding, quotes, markup, whitespace) or longer than 64
// characters is not one. Checked before the value reaches a query or a rendered page.
inline bool is_valid_visitor_id(const std::string& id) {
    if (id.empty() || id.size() > 64) return false;
    for (char ch : id) {
        const bool ok = (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'z') ||
                        (ch >= 'A' && ch <= 'Z') || ch == '-' || ch == '_';
        if (!ok) return false;
    }
    return true;
}

// JSON string-body escaping for values interpolated into a JSON document by hand.
inline std::string json_escape(const std::string& in) {
    std::string out;
    out.reserve(in.size() + 8);
    for (char ch : in) {
        const unsigned char c = static_cast<unsigned char>(ch);
        switch (c) {
            case '"':  out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n";  break;
            case '\r': out += "\\r";  break;
            case '\t': out += "\\t";  break;
            default:
                if (c < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out += buf;
                } else {
                    out.push_back(static_cast<char>(c));
                }
        }
    }
    return out;
}

// Random, expiring session tokens. Issued from a CSPRNG (not rand()), stored server-side, and
// validated by lookup. A token is never compared against a constant, so no value in the source
// can authenticate anything.
class SessionStore {
public:
    explicit SessionStore(long ttl_seconds = 3600) : ttl_(ttl_seconds) {}

    std::string issue() {
        const std::string token = random_hex_32();
        if (token.empty()) return std::string();      // CSPRNG unavailable: issue nothing
        std::lock_guard<std::mutex> lock(mutex_);
        sessions_[token] = static_cast<long>(::time(nullptr)) + ttl_;
        return token;
    }

    // Ends a session server-side. Clearing the browser cookie alone leaves a copied token usable
    // until it expires, so logout must delete the entry here.
    void revoke(const std::string& token) {
        if (token.empty()) return;
        std::lock_guard<std::mutex> lock(mutex_);
        sessions_.erase(token);
    }

    bool valid(const std::string& token) {
        if (token.empty()) return false;
        std::lock_guard<std::mutex> lock(mutex_);
        auto it = sessions_.find(token);
        if (it == sessions_.end()) return false;
        if (it->second <= static_cast<long>(::time(nullptr))) {   // expiring AT now is expired
            sessions_.erase(it);
            return false;
        }
        return true;
    }

private:
    long ttl_;
    std::mutex mutex_;
    std::unordered_map<std::string, long> sessions_;
};

// One-time, expiring OAuth `state` values.
//
// The callback routes cannot require a session -- the broker's browser arrives at them directly,
// with no operator cookie -- so the state, and not a cookie, is what proves the callback follows a
// token/init request this server issued. `consume()` is single use: the value is erased whether or
// not it was still valid, so a replayed or injected code cannot reach the token exchange twice.
class OneTimeStateStore {
public:
    explicit OneTimeStateStore(long ttl_seconds = 300) : ttl_(ttl_seconds) {}

    std::string issue() {
        const std::string s = random_hex_32();
        if (s.empty()) return std::string();          // CSPRNG unavailable: issue nothing
        std::lock_guard<std::mutex> lock(mutex_);
        states_[s] = static_cast<long>(::time(nullptr)) + ttl_;
        return s;
    }

    // True exactly once per issued state, and only before it expires.
    bool consume(const std::string& s) {
        if (s.empty()) return false;
        std::lock_guard<std::mutex> lock(mutex_);
        auto it = states_.find(s);
        if (it == states_.end()) return false;
        const bool fresh = it->second > static_cast<long>(::time(nullptr));
        states_.erase(it);                            // single use, valid or not
        return fresh;
    }

    std::size_t size() {
        std::lock_guard<std::mutex> lock(mutex_);
        return states_.size();
    }

private:
    long ttl_;
    std::mutex mutex_;
    std::unordered_map<std::string, long> states_;
};

// Bounds repeated failures per key (client address). Login is public by necessity, so without a
// limit it is a free password-guessing oracle.
class AttemptLimiter {
public:
    AttemptLimiter(int max_failures, long window_seconds) : max_(max_failures), window_(window_seconds) {}

    // False once `key` has reached the failure budget inside the window.
    bool allowed(const std::string& key, long now = 0) {
        if (now == 0) now = static_cast<long>(::time(nullptr));
        std::lock_guard<std::mutex> lock(mutex_);
        auto it = failures_.find(key);
        if (it == failures_.end()) return true;
        prune(it->second, now);
        if (it->second.empty()) { failures_.erase(it); return true; }
        return static_cast<int>(it->second.size()) < max_;
    }

    void record_failure(const std::string& key, long now = 0) {
        if (now == 0) now = static_cast<long>(::time(nullptr));
        std::lock_guard<std::mutex> lock(mutex_);
        if (failures_.size() > 4096) failures_.clear();   // bound memory against address churn
        std::vector<long>& v = failures_[key];
        prune(v, now);
        v.push_back(now);
    }

    void reset(const std::string& key) {
        std::lock_guard<std::mutex> lock(mutex_);
        failures_.erase(key);
    }

private:
    void prune(std::vector<long>& v, long now) const {
        std::vector<long> keep;
        for (long t : v) if (now - t < window_) keep.push_back(t);
        v.swap(keep);
    }

    int max_;
    long window_;
    std::mutex mutex_;
    std::unordered_map<std::string, std::vector<long>> failures_;
};

// The single decision point for request authentication.
//
// A request is authenticated by exactly one of:
//   * the x-operator-password HEADER carrying a configured secret (constant-time compare), or a
//     live session token (lookup) -- for scripts and the gate tooling;
//   * the auth_token COOKIE carrying a live session token (lookup only, never a secret) -- for
//     the browser session that POST /auth/login issues.
// A cookie is never compared against a configured secret or a constant, so no string that appears
// in source (or in a Set-Cookie someone observed) can authenticate unless the server issued it.
class Authenticator {
public:
    using SessionLookup = std::function<bool(const std::string&)>;

    Authenticator(std::string operator_password, SessionLookup lookup)
        : lookup_(std::move(lookup)) {
        if (!operator_password.empty()) passwords_.push_back(std::move(operator_password));
    }

    Authenticator(std::vector<std::string> operator_passwords, SessionLookup lookup)
        : lookup_(std::move(lookup)) {
        for (auto& p : operator_passwords) if (!p.empty()) passwords_.push_back(std::move(p));
    }

    bool allow(const std::string& req) const {
        const std::string presented = header_value(req, "x-operator-password");
        if (!presented.empty()) {
            // Every configured secret is compared (no early exit on a match) to keep the timing
            // independent of which one matched.
            bool match = false;
            for (const std::string& p : passwords_) match |= constant_time_equal(presented, p);
            if (match) return true;
            if (lookup_ && lookup_(presented)) return true;
        }
        const std::string cookie = cookie_value(req, "auth_token");
        if (!cookie.empty() && lookup_ && lookup_(cookie)) return true;
        return false;
    }

    // Routes that change state must be authenticated. Kept here so the route list is testable
    // in one place rather than by inspecting each handler.
    static bool is_mutating_route(const std::string& clean_path) {
        return clean_path == "/api/roadmap/item/update" ||
               clean_path == "/clarification/ask" ||
               clean_path == "/answer" ||
               clean_path == "/api/upstox-sandbox/token/verify";
    }

private:
    std::vector<std::string> passwords_;
    SessionLookup lookup_;
};

}  // namespace http_auth
}  // namespace hermes

#endif  // HERMES_ROADMAP_HTTP_AUTH_HPP
