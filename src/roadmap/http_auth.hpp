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

namespace hermes {
namespace http_auth {

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

// Random, expiring session tokens. Issued from a CSPRNG (not rand()), stored server-side, and
// validated by lookup. A token is never compared against a constant, so no value in the source
// can authenticate anything.
class SessionStore {
public:
    explicit SessionStore(long ttl_seconds = 3600) : ttl_(ttl_seconds) {}

    std::string issue() {
        // CSPRNG via the kernel. Deliberately not rand(): the review flagged rand() as a
        // predictable-IV fallback elsewhere in this codebase.
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
        std::lock_guard<std::mutex> lock(mutex_);
        sessions_[token] = static_cast<long>(::time(nullptr)) + ttl_;
        return token;
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

// The single decision point for request authentication.
class Authenticator {
public:
    using SessionLookup = std::function<bool(const std::string&)>;

    Authenticator(std::string operator_password, SessionLookup lookup)
        : password_(std::move(operator_password)), lookup_(std::move(lookup)) {}

    // True only when the x-operator-password header VALUE equals the configured secret
    // (constant time), or when that value is a session token that validates by lookup.
    bool allow(const std::string& req) const {
        const std::string presented = header_value(req, "x-operator-password");
        if (presented.empty()) return false;                     // absence denies
        if (!password_.empty() && constant_time_equal(presented, password_)) return true;
        if (lookup_ && lookup_(presented)) return true;
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
    std::string password_;
    SessionLookup lookup_;
};

}  // namespace http_auth
}  // namespace hermes

#endif  // HERMES_ROADMAP_HTTP_AUTH_HPP
