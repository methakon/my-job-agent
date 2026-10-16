// Differential dispatcher harness.
//
// Purpose: compare the roadmap portal's request handling between two revisions of this
// repository -- the pre-fix revision f3c5e1d and the revision under test -- by starting the SAME
// server class (RoadmapServer) on a real TCP port on each side and replaying an identical,
// fixed request set. Nothing here re-implements dispatch: the binary links the real
// src/roadmap/roadmap_server.cpp of whichever revision it is compiled against.
//
// Safety properties, by construction:
//   * The trading engine, the market-data feed, the single-instance lock in src/main.cpp and
//     the daily-P&L mailer are NOT linked into the harness; only the portal is started.
//   * The database client is built from the .env of the harness's working directory, which
//     holds a closed port and a harness-only password. No production credentials are loaded.
//   * Results are written to a file, so server stdout cannot contaminate the comparison.
//
// Output, one line per request, stable across runs:
//   REQ <idx> <label> -> status=<n> ctype=<t> loc=<location-or-'-'> body=<marker>
// where <marker> is the <title> of an HTML body, the sorted top-level key set of a JSON body,
// or the first 48 printable characters otherwise. Counts, tickers, timestamps and tick totals
// deliberately do not appear, so two runs of the same side produce identical output.
//
// Build (identical command for both sides, only the source root differs):
//   g++ -std=c++20 -O1 -I<ROOT>/src -I<ROOT>/include \
//       -DHERMES_BUILD_GIT_SHA='"<SHA>"' tests/differential_harness.cpp \
//       <ROOT>/src/engine/*.cpp <ROOT>/src/roadmap/*.cpp <ROOT>/src/common/*.cpp \
//       <ROOT>/src/market_data/*.cpp <ROOT>/src/analytics/*.cpp \
//       -o <out> -lpthread -lmysqlclient -lcurl -lssl -lcrypto
//
// Run:  <harness> <port> <outfile>      (from a directory holding the harness .env)

#include "roadmap/roadmap_server.hpp"
#include "roadmap/db_client.hpp"
#include "common/env_loader.hpp"

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <chrono>
#include <cstring>
#include <fstream>
#include <iostream>
#include <memory>
#include <sstream>
#include <string>
#include <thread>
#include <vector>
#include <algorithm>

namespace {

struct Req {
    const char* label;
    std::string raw;      // request WITHOUT the trailing body, i.e. head + "\r\n\r\n" + body
};

std::string with_body(const std::string& head, const std::string& body) {
    std::ostringstream ss;
    ss << head << "Content-Length: " << body.size() << "\r\n\r\n" << body;
    return ss.str();
}

const std::vector<Req>& request_set() {
    static const std::vector<Req> set = {
        // ---- the ordinary table routes, no credentials at all ----
        {"GET_/",                        "GET / HTTP/1.1\r\nHost: h\r\n\r\n"},
        {"GET_/home",                    "GET /home HTTP/1.1\r\nHost: h\r\n\r\n"},
        {"GET_/visitor-info",            "GET /visitor-info HTTP/1.1\r\nHost: h\r\n\r\n"},
        {"GET_/api_visitor-info_stats",  "GET /api/visitor-info/stats HTTP/1.1\r\nHost: h\r\n\r\n"},
        {"GET_/api_market_session",      "GET /api/market/session-status HTTP/1.1\r\nHost: h\r\n\r\n"},
        {"GET_/admin_visitors",          "GET /admin/visitors HTTP/1.1\r\nHost: h\r\n\r\n"},
        {"GET_/admin_visitor",           "GET /admin/visitor HTTP/1.1\r\nHost: h\r\n\r\n"},
        {"GET_/admin_visitors_id",       "GET /admin/visitors/abc123 HTTP/1.1\r\nHost: h\r\n\r\n"},
        {"POST_/admin_retention-purge",  "POST /admin/analytics/retention-purge HTTP/1.1\r\nHost: h\r\n\r\n"},
        {"GET_/dashboard",               "GET /dashboard HTTP/1.1\r\nHost: h\r\n\r\n"},
        {"GET_/portfolio",               "GET /portfolio HTTP/1.1\r\nHost: h\r\n\r\n"},
        {"GET_/paper-trading",           "GET /paper-trading HTTP/1.1\r\nHost: h\r\n\r\n"},
        {"GET_/fnf-trading",             "GET /fnf-trading HTTP/1.1\r\nHost: h\r\n\r\n"},
        {"GET_/tokens",                  "GET /tokens HTTP/1.1\r\nHost: h\r\n\r\n"},
        {"GET_/login",                   "GET /login HTTP/1.1\r\nHost: h\r\n\r\n"},
        {"POST_/auth_login_wrong",       with_body("POST /auth/login HTTP/1.1\r\nHost: h\r\n", "email=nobody%40example.invalid&password=definitely-not-the-password")},
        {"POST_/auth_logout",            "POST /auth/logout HTTP/1.1\r\nHost: h\r\n\r\n"},
        {"POST_/api_roadmap_item_update",with_body("POST /api/roadmap/item/update HTTP/1.1\r\nHost: h\r\n", "item_id=1&status=done&note=harness")},
        {"POST_/api_roadmap_ask",        with_body("POST /api/roadmap/clarification/ask HTTP/1.1\r\nHost: h\r\n", "item_id=1&stage_label=x&question=y")},
        {"POST_/api_roadmap_answer",     with_body("POST /api/roadmap/clarification/answer HTTP/1.1\r\nHost: h\r\n", "clarification_id=1&answer=z")},
        {"GET_/api_seasonality",         "GET /api/seasonality-patterns HTTP/1.1\r\nHost: h\r\n\r\n"},
        {"GET_/api_user_portfolio",      "GET /api/user/portfolio HTTP/1.1\r\nHost: h\r\n\r\n"},
        {"POST_/api_upstox_order-webhook","POST /api/upstox/order-webhook HTTP/1.1\r\nHost: h\r\n\r\n"},
        {"POST_/api_upstox_notifier",    "POST /api/upstox/notifier HTTP/1.1\r\nHost: h\r\n\r\n"},
        {"GET_/api_upstox_token_init",   "GET /api/upstox/token/init HTTP/1.1\r\nHost: h\r\n\r\n"},
        {"GET_/api_upstox_callback",     "GET /api/upstox/callback?code=HARNESS_CODE HTTP/1.1\r\nHost: h\r\n\r\n"},
        {"GET_/auth_upstox_callback",    "GET /auth/upstox/callback?code=HARNESS_CODE HTTP/1.1\r\nHost: h\r\n\r\n"},
        {"GET_/api_fyers_token_init",    "GET /api/fyers/token/init HTTP/1.1\r\nHost: h\r\n\r\n"},
        {"GET_/api_fyers_callback",      "GET /api/fyers/callback?auth_code=HARNESS_CODE HTTP/1.1\r\nHost: h\r\n\r\n"},
        {"GET_/auth_fyers_callback",     "GET /auth/fyers/callback?auth_code=HARNESS_CODE HTTP/1.1\r\nHost: h\r\n\r\n"},
        {"GET_/api_upstox-sandbox_verify","GET /api/upstox-sandbox/token/verify HTTP/1.1\r\nHost: h\r\n\r\n"},
        {"GET_/docs",                    "GET /docs HTTP/1.1\r\nHost: h\r\n\r\n"},
        {"GET_/swagger",                 "GET /swagger HTTP/1.1\r\nHost: h\r\n\r\n"},
        {"GET_/api_v1_openapi.json",     "GET /api/v1/openapi.json HTTP/1.1\r\nHost: h\r\n\r\n"},
        {"GET_/project-status_json",     "GET /project-status/json HTTP/1.1\r\nHost: h\r\n\r\n"},
        {"GET_/api_health",              "GET /api/health HTTP/1.1\r\nHost: h\r\n\r\n"},
        {"GET_/health",                  "GET /health HTTP/1.1\r\nHost: h\r\n\r\n"},
        {"GET_/health_format_json",      "GET /health?format=json HTTP/1.1\r\nHost: h\r\n\r\n"},
        {"GET_/health_format_jsonX",     "GET /health?format=jsonX HTTP/1.1\r\nHost: h\r\n\r\n"},
        {"GET_/api_system_stats",        "GET /api/system/stats HTTP/1.1\r\nHost: h\r\n\r\n"},
        {"GET_/api_strategy_config",     "GET /api/strategy/config HTTP/1.1\r\nHost: h\r\n\r\n"},
        {"GET_/project-status",          "GET /project-status HTTP/1.1\r\nHost: h\r\n\r\n"},

        // ---- unrouted / malformed ----
        {"UNROUTED_/nope",               "GET /nope HTTP/1.1\r\nHost: h\r\n\r\n"},
        {"UNROUTED_traversal",           "GET /../../etc/passwd HTTP/1.1\r\nHost: h\r\n\r\n"},
        {"METHOD_MISMATCH_POST_dashboard","POST /dashboard HTTP/1.1\r\nHost: h\r\n\r\n"},
        {"METHOD_MISMATCH_GET_login",    "GET /auth/login HTTP/1.1\r\nHost: h\r\n\r\n"},

        // ---- the original bypass classes. Each must have SUCCEEDED before the fix ----
        {"BYPASS_1_header_name_only",    "GET /dashboard HTTP/1.1\r\nHost: h\r\nx-operator-password: \r\n\r\n"},
        {"BYPASS_2_hardcoded_cookie",    "GET /admin/visitors HTTP/1.1\r\nHost: h\r\nCookie: auth_token=operator_valid_session\r\n\r\n"},
        {"BYPASS_3_name_in_query",       "GET /answer?x-operator-password=1 HTTP/1.1\r\nHost: h\r\n\r\n"},
        {"BYPASS_4_route_string_in_body",with_body("GET /portfolio HTTP/1.1\r\nHost: h\r\n", "POST /api/roadmap/item/update")},
        {"BYPASS_5_wrong_secret_value",  "GET /tokens HTTP/1.1\r\nHost: h\r\nx-operator-password: not-the-secret\r\n\r\n"},
        {"BYPASS_6_name_in_user_agent",  "GET /health HTTP/1.1\r\nHost: h\r\nUser-Agent: x-operator-password\r\n\r\n"},
        {"BYPASS_7_looking_header",      with_body("POST /auth/login HTTP/1.1\r\nHost: h\r\n", "x-operator-password: whatever")},
        {"BYPASS_8_double_header",       "GET /api/strategy/config HTTP/1.1\r\nHost: h\r\nx-operator-password: a\r\nx-operator-password: b\r\n\r\n"},

        // ---- legitimate access, using the harness-only secrets ----
        {"LEGIT_correct_password",       "GET /dashboard HTTP/1.1\r\nHost: h\r\nx-operator-password: harness-operator-secret\r\n\r\n"},
        {"LEGIT_login_correct",          with_body("POST /auth/login HTTP/1.1\r\nHost: h\r\n", "email=bapay.9@gmail.com&password=harness-operator-secret")},
    };
    return set;
}

// ---- stable body markers ----

std::string json_top_level_keys(const std::string& body) {
    std::vector<std::string> keys;
    size_t i = 0;
    if (body.empty() || body[0] != '{') return "";
    int depth = 0;
    bool in_str = false, esc = false, expect_key = true;
    std::string cur;
    for (; i < body.size(); ++i) {
        const char c = body[i];
        if (in_str) {
            if (esc) { esc = false; cur.push_back(c); continue; }
            if (c == '\\') { esc = true; continue; }
            if (c == '"') {
                in_str = false;
                if (depth == 1 && expect_key) { keys.push_back(cur); expect_key = false; }
                continue;
            }
            if (depth == 1 && expect_key) cur.push_back(c);
            continue;
        }
        if (c == '"') { in_str = true; cur.clear(); continue; }
        if (c == '{' || c == '[') { ++depth; continue; }
        if (c == '}' || c == ']') { --depth; if (depth <= 0) break; continue; }
        if (c == ',' && depth == 1) { expect_key = true; }
    }
    std::sort(keys.begin(), keys.end());
    std::string out;
    for (size_t k = 0; k < keys.size(); ++k) {
        if (k) out += ",";
        out += keys[k];
    }
    return out;
}

std::string marker_for(const std::string& body, const std::string& ctype) {
    const size_t t = body.find("<title>");
    if (t != std::string::npos) {
        const size_t e = body.find("</title>", t);
        if (e != std::string::npos) return "title:" + body.substr(t + 7, e - (t + 7));
    }
    std::string trimmed = body;
    size_t s = trimmed.find_first_not_of(" \t\r\n");
    if (s != std::string::npos && trimmed[s] == '{') {
        const std::string keys = json_top_level_keys(trimmed.substr(s));
        if (!keys.empty()) return "json:" + keys;
        return "json:<none>";
    }
    std::string first = body.substr(0, 48);
    for (char& ch : first) if (ch == '\r' || ch == '\n') ch = ' ';
    return "text:" + first;
}

struct Result { int status; std::string ctype, location, marker; };

Result send_request(int port, const std::string& raw) {
    Result r{0, "", "", ""};
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) return r;
    timeval tv{};
    tv.tv_sec = 3; tv.tv_usec = 0;
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(static_cast<uint16_t>(port));
    inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr);
    if (connect(fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) < 0) { close(fd); return r; }
    size_t sent = 0;
    while (sent < raw.size()) {
        const ssize_t n = write(fd, raw.data() + sent, raw.size() - sent);
        if (n <= 0) break;
        sent += static_cast<size_t>(n);
    }
    std::string resp;
    char buf[8192];
    while (true) {
        const ssize_t n = read(fd, buf, sizeof(buf));
        if (n <= 0) break;
        resp.append(buf, static_cast<size_t>(n));
        if (resp.size() > 4u * 1024u * 1024u) break;
    }
    close(fd);

    const size_t eol = resp.find("\r\n");
    if (eol != std::string::npos) {
        std::istringstream il(resp.substr(0, eol));
        std::string ver; il >> ver >> r.status;
    }
    const size_t head_end = resp.find("\r\n\r\n");
    const std::string head = (head_end == std::string::npos) ? resp : resp.substr(0, head_end);
    const std::string body = (head_end == std::string::npos) ? "" : resp.substr(head_end + 4);

    size_t p = 0;
    while (p < head.size()) {
        size_t e = head.find("\r\n", p);
        if (e == std::string::npos) e = head.size();
        const std::string line = head.substr(p, e - p);
        const std::string lower = [&] {
            std::string l = line; for (char& c : l) c = static_cast<char>(::tolower(c)); return l;
        }();
        if (lower.rfind("content-type:", 0) == 0) {
            r.ctype = line.substr(13);
            while (!r.ctype.empty() && (r.ctype.front() == ' ' || r.ctype.front() == '\t')) r.ctype.erase(r.ctype.begin());
            while (!r.ctype.empty() && (r.ctype.back() == ' ' || r.ctype.back() == '\t' || r.ctype.back() == '\r')) r.ctype.pop_back();
        } else if (lower.rfind("location:", 0) == 0) {
            r.location = line.substr(9);
            while (!r.location.empty() && (r.location.front() == ' ' || r.location.front() == '\t')) r.location.erase(r.location.begin());
            while (!r.location.empty() && (r.location.back() == '\r' || r.location.back() == '\n')) r.location.pop_back();
        } else if (lower.rfind("set-cookie:", 0) == 0) {
            // Record only the ATTRIBUTES of an auth_token cookie, never its value.
            std::string c = line.substr(11);
            if (c.find("auth_token=") != std::string::npos) {
                std::string attrs;
                size_t pos = c.find(';');
                while (pos != std::string::npos) {
                    size_t nx = c.find(';', pos + 1);
                    const std::string a = c.substr(pos + 1, (nx == std::string::npos ? c.size() : nx) - pos - 1);
                    if (!a.empty()) { if (!attrs.empty()) attrs += "|"; attrs += a; }
                    pos = nx;
                }
                r.marker += " cookie-attrs:" + (attrs.empty() ? "<none>" : attrs);
            }
        }
        p = e + 2;
    }
    r.marker = marker_for(body, r.ctype) + r.marker;
    if (r.status == 0) r.marker = "<no-response>";
    return r;
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 3) {
        std::cerr << "usage: differential_harness <port> <outfile> [hold_seconds]\n";
        return 2;
    }
    const int port = std::atoi(argv[1]);
    const std::string out_path = argv[2];
    const int hold_seconds = (argc > 3) ? std::atoi(argv[3]) : 0;

    EnvLoader::load(".env");
    const std::string host = EnvLoader::get("MYSQL_HOST", "127.0.0.1");
    const int db_port = EnvLoader::get_int("MYSQL_PORT", 3399);
    const std::string user = EnvLoader::get("MYSQL_USER", "nobody");
    const std::string pass = EnvLoader::get("MYSQL_PASSWORD", "none");
    const std::string db = EnvLoader::get("DATABASE_NAME", "harness_nodb");

    std::cout << "[harness] db target " << host << ":" << db_port << "/" << db << " user=" << user
              << " (harness .env; no credential is printed)\n";

    auto db_client = std::make_shared<RoadmapDbClient>(host, db_port, user, pass, db,
                                                      host, db_port, user, pass, db);
    auto server = std::make_shared<RoadmapServer>(port, db_client);
    std::thread t([server]() { server->start(); });

    bool ready = false;
    for (int i = 0; i < 100 && !ready; ++i) {
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
        int fd = socket(AF_INET, SOCK_STREAM, 0);
        if (fd < 0) continue;
        sockaddr_in a{};
        a.sin_family = AF_INET;
        a.sin_port = htons(static_cast<uint16_t>(port));
        inet_pton(AF_INET, "127.0.0.1", &a.sin_addr);
        if (connect(fd, reinterpret_cast<sockaddr*>(&a), sizeof(a)) == 0) ready = true;
        close(fd);
    }
    if (!ready) { std::cerr << "[harness] server did not come up on port " << port << "\n"; return 3; }

    std::ofstream out(out_path, std::ios::trunc);
    if (!out) { std::cerr << "[harness] cannot write " << out_path << "\n"; return 4; }

    int idx = 0;
    for (const Req& q : request_set()) {
        const Result r = send_request(port, q.raw);
        out << "REQ " << idx++ << " " << q.label
            << " -> status=" << r.status
            << " ctype=" << (r.ctype.empty() ? "-" : r.ctype)
            << " loc=" << (r.location.empty() ? "-" : r.location)
            << " body=" << r.marker
            << "\n";
        out.flush();
    }
    out.close();
    std::cout << "[harness] wrote " << idx << " results to " << out_path << "\n";
    if (hold_seconds > 0) {
        std::cout << "[harness] holding the port open for " << hold_seconds
                  << "s so the caller can inspect this process's connections\n";
        std::cout.flush();
        std::this_thread::sleep_for(std::chrono::seconds(hold_seconds));
    }
    server->stop();
    std::cout.flush();
    std::_Exit(0);   // the portal's accept loop blocks on a socket; do not run static destructors
}
