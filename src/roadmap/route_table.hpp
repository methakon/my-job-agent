#ifndef HERMES_ROADMAP_ROUTE_TABLE_HPP
#define HERMES_ROADMAP_ROUTE_TABLE_HPP

// Route resolution for the roadmap portal.
//
// The dispatcher this replaces selected handlers with `req.find("POST /api/roadmap/item/update")`
// and similar substring searches over the ENTIRE raw request. That has two consequences:
//   * a request whose body or query string merely CONTAINS a route string routes into that
//     handler -- so a body carrying the text of a mutating route reached the mutating handler;
//   * authentication cannot be decided against a route, because "which route is this?" was not
//     a well-defined question.
//
// This file makes the route an exact (method, path) lookup over a single table, so that a
// default-deny gate can be expressed against the route rather than against request text.
//
// Request-line parsing is deliberately strict: the version must be HTTP/1.x, the path must
// begin with '/', and a malformed line resolves to Unknown (deny), never to a guess.

#include <cstddef>
#include <cstring>
#include <string>

namespace hermes {
namespace route_table {

enum class Route {
    Unknown = 0,
    Home, VisitorInfo, VisitorStats, MarketSessionStatus, AdminVisitors, AdminVisitorDetail,
    AnalyticsRetentionPurge,
    Dashboard, Portfolio, PaperTrading, FnfTrading, Tokens,
    LoginPage, LoginPost, Logout,
    RoadmapItemUpdate, ClarificationAsk, ClarificationAnswer,
    SeasonalityPatterns, UserPortfolio,
    UpstoxOrderWebhook, UpstoxNotifier,
    UpstoxTokenInit, UpstoxCallback,
    FyersTokenInit, FyersCallback,
    UpstoxSandboxTokenVerify,
    Docs, OpenApiJson, ProjectStatusJson, HealthJson, Health, SystemStats,
    StrategyConfig, ProjectStatus
};

struct Entry {
    const char* method;
    const char* path;
    Route route;
    bool prefix;   // true = path is a prefix match (e.g. /admin/visitors/<id>)
};

// The dispatch table. Method is exact; path is exact unless prefix is set. There is no
// substring matching anywhere in this file.
inline const Entry* table() {
    static const Entry entries[] = {
        {"GET",  "/",                                 Route::Home,                    false},
        {"GET",  "/home",                             Route::Home,                    false},
        {"GET",  "/visitor-info",                     Route::VisitorInfo,             false},
        {"GET",  "/api/visitor-info/stats",           Route::VisitorStats,            false},
        {"GET",  "/api/market/session-status",        Route::MarketSessionStatus,     false},
        {"GET",  "/admin/visitors",                   Route::AdminVisitors,           false},
        {"GET",  "/admin/visitor",                    Route::AdminVisitorDetail,      false},
        {"GET",  "/admin/visitors/",                  Route::AdminVisitorDetail,      true},
        {"POST", "/admin/analytics/retention-purge",  Route::AnalyticsRetentionPurge, false},
        {"GET",  "/dashboard",                        Route::Dashboard,               false},
        {"GET",  "/portfolio",                        Route::Portfolio,               false},
        {"GET",  "/paper-trading",                    Route::PaperTrading,            false},
        {"GET",  "/fnf-trading",                      Route::FnfTrading,              false},
        {"GET",  "/tokens",                           Route::Tokens,                  false},
        {"GET",  "/login",                            Route::LoginPage,               false},
        {"POST", "/auth/login",                       Route::LoginPost,               false},
        {"POST", "/auth/logout",                      Route::Logout,                  false},
        {"POST", "/api/roadmap/item/update",          Route::RoadmapItemUpdate,       false},
        {"POST", "/api/roadmap/clarification/ask",    Route::ClarificationAsk,        false},
        {"POST", "/api/roadmap/clarification/answer", Route::ClarificationAnswer,     false},
        {"GET",  "/api/seasonality-patterns",         Route::SeasonalityPatterns,     false},
        {"GET",  "/api/user/portfolio",               Route::UserPortfolio,           false},
        {"POST", "/api/upstox/order-webhook",         Route::UpstoxOrderWebhook,      false},
        {"POST", "/api/upstox/notifier",              Route::UpstoxNotifier,          false},
        {"GET",  "/api/upstox/token/init",            Route::UpstoxTokenInit,         false},
        {"GET",  "/api/upstox/callback",              Route::UpstoxCallback,          false},
        {"GET",  "/auth/upstox/callback",             Route::UpstoxCallback,          false},
        {"GET",  "/api/fyers/token/init",             Route::FyersTokenInit,          false},
        {"GET",  "/api/fyers/callback",               Route::FyersCallback,           false},
        {"GET",  "/auth/fyers/callback",              Route::FyersCallback,           false},
        {"GET",  "/api/upstox-sandbox/token/verify",  Route::UpstoxSandboxTokenVerify,false},
        {"GET",  "/docs",                             Route::Docs,                    false},
        {"GET",  "/swagger",                          Route::Docs,                    false},
        {"GET",  "/api/v1/openapi.json",              Route::OpenApiJson,             false},
        {"GET",  "/project-status/json",              Route::ProjectStatusJson,       false},
        {"GET",  "/api/health",                       Route::HealthJson,              false},
        {"GET",  "/api/system/stats",                 Route::SystemStats,             false},
        {"GET",  "/api/strategy/config",              Route::StrategyConfig,          false},
        {"GET",  "/project-status",                   Route::ProjectStatus,           false},
        {"GET",  "/health",                           Route::Health,                  false},
        {nullptr, nullptr, Route::Unknown, false}
    };
    return entries;
}

// A parsed request line. `ok` is false for anything malformed, and a malformed request line
// resolves to Route::Unknown -- there is no lenient fallback.
struct RequestLine {
    bool ok = false;
    std::string method;
    std::string path;     // no query string
    std::string query;
};

// Parse "METHOD /path?query HTTP/1.x". Rejects a missing or malformed version, a path that does
// not start with '/', an empty method, and anything with embedded control characters.
inline RequestLine parse_request_line(const std::string& req) {
    RequestLine out;
    const size_t line_end = req.find("\r\n");
    const std::string line = (line_end == std::string::npos) ? req : req.substr(0, line_end);
    if (line.empty()) return out;

    const size_t sp1 = line.find(' ');
    if (sp1 == std::string::npos || sp1 == 0) return out;
    const size_t sp2 = line.find(' ', sp1 + 1);
    if (sp2 == std::string::npos || sp2 == sp1 + 1) return out;

    const std::string method  = line.substr(0, sp1);
    const std::string target  = line.substr(sp1 + 1, sp2 - sp1 - 1);
    const std::string version = line.substr(sp2 + 1);

    for (size_t i = 0; i < method.size(); ++i) {
        const char c = method[i];
        if (!((c >= 'A' && c <= 'Z') || c == '-')) return out;   // no lowercase, no controls
    }
    if (version.rfind("HTTP/1.", 0) != 0) return out;

    std::string path = target, query;
    const size_t q = target.find('?');
    if (q != std::string::npos) { path = target.substr(0, q); query = target.substr(q + 1); }
    if (path.empty() || path[0] != '/') return out;

    out.ok = true;
    out.method = method;
    out.path = path;
    out.query = query;
    return out;
}

// Exact (method, path) lookup. Prefix entries match only on a '/' boundary.
inline Route resolve(const std::string& method, const std::string& path) {
    for (const Entry* e = table(); e->path != nullptr; ++e) {
        if (method != e->method) continue;
        if (e->prefix) {
            const size_t n = std::strlen(e->path);
            if (path.size() >= n && path.compare(0, n, e->path) == 0) return e->route;
        } else if (path == e->path) {
            return e->route;
        }
    }
    return Route::Unknown;
}

inline const char* name(Route r) {
    switch (r) {
        case Route::Home: return "Home";
        case Route::VisitorInfo: return "VisitorInfo";
        case Route::VisitorStats: return "VisitorStats";
        case Route::MarketSessionStatus: return "MarketSessionStatus";
        case Route::AdminVisitors: return "AdminVisitors";
        case Route::AdminVisitorDetail: return "AdminVisitorDetail";
        case Route::AnalyticsRetentionPurge: return "AnalyticsRetentionPurge";
        case Route::Dashboard: return "Dashboard";
        case Route::Portfolio: return "Portfolio";
        case Route::PaperTrading: return "PaperTrading";
        case Route::FnfTrading: return "FnfTrading";
        case Route::Tokens: return "Tokens";
        case Route::LoginPage: return "LoginPage";
        case Route::LoginPost: return "LoginPost";
        case Route::Logout: return "Logout";
        case Route::RoadmapItemUpdate: return "RoadmapItemUpdate";
        case Route::ClarificationAsk: return "ClarificationAsk";
        case Route::ClarificationAnswer: return "ClarificationAnswer";
        case Route::SeasonalityPatterns: return "SeasonalityPatterns";
        case Route::UserPortfolio: return "UserPortfolio";
        case Route::UpstoxOrderWebhook: return "UpstoxOrderWebhook";
        case Route::UpstoxNotifier: return "UpstoxNotifier";
        case Route::UpstoxTokenInit: return "UpstoxTokenInit";
        case Route::UpstoxCallback: return "UpstoxCallback";
        case Route::FyersTokenInit: return "FyersTokenInit";
        case Route::FyersCallback: return "FyersCallback";
        case Route::UpstoxSandboxTokenVerify: return "UpstoxSandboxTokenVerify";
        case Route::Docs: return "Docs";
        case Route::OpenApiJson: return "OpenApiJson";
        case Route::ProjectStatusJson: return "ProjectStatusJson";
        case Route::HealthJson: return "HealthJson";
        case Route::Health: return "Health";
        case Route::SystemStats: return "SystemStats";
        case Route::StrategyConfig: return "StrategyConfig";
        case Route::ProjectStatus: return "ProjectStatus";
        case Route::Unknown: return "Unknown";
    }
    return "Unknown";
}

// A route is "mutating" when it changes state. This classification drives the default-deny gate,
// so it is derived from the route identity, never from the request text.
inline bool is_mutating(Route r) {
    switch (r) {
        // all POSTs other than the allow-list
        case Route::Logout:
        case Route::RoadmapItemUpdate:
        case Route::ClarificationAsk:
        case Route::ClarificationAnswer:
        case Route::UpstoxOrderWebhook:
        case Route::UpstoxNotifier:
        case Route::AnalyticsRetentionPurge:
        // GET routes that are NOT side-effect free
        case Route::UpstoxSandboxTokenVerify:   // writes a token record
        case Route::UpstoxTokenInit:            // starts an OAuth flow
        case Route::FyersTokenInit:             // starts an OAuth flow
        case Route::AdminVisitors:              // admin data
        case Route::AdminVisitorDetail:         // admin data
            return true;
        default:
            return false;
    }
}

// The explicit allow-list: routes reachable without a session, each with its reason.
//   LoginPost     -- the login submission itself; throttled separately (step D).
//   UpstoxCallback / FyersCallback -- OAuth redirects arrive from the broker's browser session
//       with no operator cookie, so they cannot require one. They are instead gated by a
//       one-time server-issued state token: the matching /token/init route requires a session
//       and issues the state, and the callback verifies it (step B).
inline bool is_allowlisted(Route r) {
    return r == Route::LoginPost || r == Route::UpstoxCallback || r == Route::FyersCallback;
}

}  // namespace route_table
}  // namespace hermes

#endif  // HERMES_ROADMAP_ROUTE_TABLE_HPP
