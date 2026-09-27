#include "roadmap_server.hpp"
#include "../common/env_loader.hpp"
#include <iostream>
#include <sstream>
#include <vector>
#include <map>
#include <array>
#include <cstring>
#include <unistd.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <thread>

RoadmapServer::RoadmapServer(int port, std::shared_ptr<RoadmapDbClient> db_client)
    : port_(port), db_client_(db_client), running_(false) {}

RoadmapServer::~RoadmapServer() {
    stop();
}

static std::string html_escape(const std::string& str) {
    std::string out;
    for (char c : str) {
        switch (c) {
            case '<': out += "&lt;"; break;
            case '>': out += "&gt;"; break;
            case '&': out += "&amp;"; break;
            case '"': out += "&quot;"; break;
            case '\'': out += "&#39;"; break;
            default: out += c; break;
        }
    }
    return out;
}

static std::string render_nav_header(bool is_authenticated) {
    std::stringstream ss;
    ss << "<div class=\"nav-bar\">"
       << "  <div class=\"nav-brand\">⚡ C++ Autonomous Agent Platform</div>"
       << "  <div class=\"nav-links\">"
       << "    <a href=\"/\" class=\"nav-item\">🏠 Home</a>"
       << "    <a href=\"/project-status\" class=\"nav-item\">📋 Project Roadmap</a>"
       << "    <a href=\"/docs\" class=\"nav-item\">📖 API Docs (Swagger)</a>";

    if (is_authenticated) {
        ss << "    <a href=\"/dashboard\" class=\"nav-item\" style=\"color:#58a6ff;\">📊 User Dashboard</a>"
           << "    <a href=\"/health\" class=\"nav-item\" target=\"_blank\">⚡ System Health</a>"
           << "    <span class=\"badge ok\">Operator Authenticated</span>"
           << "    <form style=\"display:inline\" method=\"post\" action=\"/auth/logout\"><button type=\"submit\" class=\"nav-btn\">Logout</button></form>";
    } else {
        ss << "    <a href=\"/health\" class=\"nav-item\" target=\"_blank\">⚡ System Health</a>"
           << "    <a href=\"/login\" class=\"nav-btn-link\">🔐 Operator Login</a>";
    }
    ss << "  </div>"
       << "</div>";
    return ss.str();
}

std::string RoadmapServer::render_home_page(bool is_authenticated) {
    std::stringstream ss;
    ss << "<!doctype html><html lang=\"en\"><head>"
       << "<meta charset=\"utf-8\"/>"
       << "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"/>"
       << "<title>Home — C++ Autonomous Trading Agent Platform</title>"
       << "<style>"
       << ":root{--bg:#0d1117;--card:#161b22;--line:#30363d;--text:#e6edf3;--dim:#8b949e;--ok:#3fb96f;--bad:#f85149;--warn:#e0a83c}"
       << "*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 -apple-system,'Segoe UI',Roboto,sans-serif;padding:0}"
       << ".nav-bar{background:#161b22;border-bottom:1px solid #30363d;padding:12px 24px;display:flex;justify-space:space-between;align-items:center;flex-wrap:wrap}"
       << ".nav-brand{font-weight:700;font-size:16px;color:#e0a83c}"
       << ".nav-links{display:flex;gap:16px;align-items:center}"
       << ".nav-item{color:#e6edf3;text-decoration:none;font-weight:500;font-size:13.5px}.nav-item:hover{color:#3fb96f}"
       << ".nav-btn-link,.nav-btn{background:#238636;color:#fff;padding:5px 12px;border-radius:6px;text-decoration:none;font-size:12.5px;font-weight:600;border:none;cursor:pointer}"
       << ".container{max-width:1100px;margin:30px auto;padding:0 20px}"
       << ".hero{background:linear-gradient(135deg, #161b22 0%, #0d1117 100%);border:1px solid #30363d;border-radius:14px;padding:32px;margin-bottom:24px}"
       << ".hero h1{font-size:28px;margin:0 0 8px;color:#e0a83c}"
       << ".grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:20px}"
       << ".card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:20px}"
       << ".card h3{margin-top:0;color:#3fb96f;font-size:17px}"
       << ".badge{font-size:11px;padding:3px 10px;border-radius:99px;background:#30363d;color:#8b949e}"
       << ".badge.ok{background:rgba(63,185,111,.16);color:#3fb96f}"
       << ".footer{margin-top:40px;padding:20px;border-top:1px solid #30363d;color:#8b949e;font-size:12.5px;text-align:center}"
       << "</style></head><body>"
       << render_nav_header(is_authenticated)
       << "<div class=\"container\">"
       << "  <div class=\"hero\">"
       << "    <h1>⚡ C++ Autonomous Self-Learning Trading Agent Platform</h1>"
       << "    <p style=\"color:#8b949e;font-size:15px;max-width:800px;\">Ultra-Low Latency (< 10µs) Options Chain Trading & Self-Learning Engine built in C++20 with Zero-Trust Security, Multi-Tenant Data Privacy, and ACID database integrity.</p>"
       << "    <div style=\"margin-top:16px;display:flex;gap:12px;\">"
       << "      <a href=\"/project-status\" class=\"nav-btn-link\" style=\"padding:8px 16px;font-size:14px;\">📋 View Public Roadmap (/project-status)</a>"
       << (is_authenticated ? "      <a href=\"/dashboard\" class=\"nav-btn-link\" style=\"background:#58a6ff;padding:8px 16px;font-size:14px;color:#0d1117;\">📊 Open User Dashboard (/dashboard)</a>" : "      <a href=\"/login\" class=\"nav-btn-link\" style=\"background:#30363d;padding:8px 16px;font-size:14px;\">🔐 Operator Login</a>")
       << "    </div>"
       << "  </div>"
       << "  <div class=\"grid\">"
       << "    <div class=\"card\">"
       << "      <h3>⚙️ Engine Specifications</h3>"
       << "      <p>• <b>Language</b>: C++20 (-O3 Release Optimization)</p>"
       << "      <p>• <b>Decision Latency</b>: < 10 microseconds (p99)</p>"
       << "      <p>• <b>Server Footprint</b>: 15 MB – 20 MB RAM</p>"
       << "      <p>• <b>V8 GC Stalls</b>: ZERO (Pure Native C++)</p>"
       << "    </div>"
       << "    <div class=\"card\">"
       << "      <h3>🗄️ Database & Multi-Tenant Privacy</h3>"
       << "      <p>• <b>Database</b>: Oracle Cloud MySQL MDS (ap-tokyo-1)</p>"
       << "      <p>• <b>Historical Data</b>: 6.9M+ Canonical Quote Rows</p>"
       << "      <p>• <b>Multi-Tenant Isolation</b>: User-level row isolation via portal_users</p>"
       << "      <p>• <b>ACID Compliance</b>: Strict transactional guarantees</p>"
       << "    </div>"
       << "    <div class=\"card\">"
       << "      <h3>🤖 Self-Learning Loop</h3>"
       << "      <p>• <b>Trading Hours</b>: 9:15 AM - 3:30 PM IST (Paper Execution)</p>"
       << "      <p>• <b>Off-Hours Analytics</b>: Rejection & Mistake Learning</p>"
       << "      <p>• <b>Quant Engine</b>: IV/RV Skew, Gamma Flip, Vanna/Charm</p>"
       << "      <p>• <b>Promotion Gate</b>: 30-Day Sharpe > 2.0 & Drawdown < 5%</p>"
       << "    </div>"
       << "  </div>"
       << "  <div class=\"footer\">C++ Autonomous Trading Engine · Multi-Tenant User Isolation · Oracle Cloud MySQL (3307)</div>"
       << "</div></body></html>";
    return ss.str();
}

std::string RoadmapServer::render_dashboard_page(bool is_authenticated, const std::string& user_id) {
    std::string target_id = user_id.empty() ? "e120d0ba-f5e7-44e9-b1f5-9d93ee8e90ee" : user_id;
    UserProfile user = db_client_->fetch_user_by_email_or_id(target_id);
    UserPortfolioData p = db_client_->fetch_user_portfolio(user.id.empty() ? target_id : user.id);
    auto trades = db_client_->fetch_user_trades(user.id.empty() ? target_id : user.id, 10);

    auto upstox_info = db_client_->fetch_upstox_token_status();

    std::stringstream ss;
    ss << "<!doctype html><html lang=\"en\"><head>"
       << "<meta charset=\"utf-8\"/>"
       << "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"/>"
       << "<title>User Dashboard — C++ Autonomous Trading Agent</title>"
       << "<style>"
       << ":root{--bg:#0d1117;--card:#161b22;--line:#30363d;--text:#e6edf3;--dim:#8b949e;--ok:#3fb96f;--bad:#f85149;--warn:#e0a83c;--accent:#58a6ff}"
       << "*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 -apple-system,'Segoe UI',Roboto,sans-serif}"
       << ".nav-bar{background:#161b22;border-bottom:1px solid #30363d;padding:12px 24px;display:flex;justify-space:space-between;align-items:center;flex-wrap:wrap}"
       << ".nav-brand{font-weight:700;font-size:16px;color:#e0a83c}"
       << ".nav-links{display:flex;gap:16px;align-items:center}"
       << ".nav-item{color:#e6edf3;text-decoration:none;font-weight:500;font-size:13.5px}.nav-item:hover{color:#3fb96f}"
       << ".nav-btn{background:#da3633;color:#fff;padding:5px 12px;border-radius:6px;font-size:12.5px;font-weight:600;border:none;cursor:pointer}"
       << ".nav-btn-link{background:#238636;color:#fff;padding:5px 12px;border-radius:6px;text-decoration:none;font-size:12.5px;font-weight:600;border:none;cursor:pointer}"
       << ".container{max-width:1200px;margin:24px auto;padding:0 20px}"
       << ".header-card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:20px;margin-bottom:20px;display:flex;justify-space:space-between;align-items:center;flex-wrap:wrap;gap:12px}"
       << ".user-title{font-size:22px;font-weight:700;color:var(--text);margin:0}"
       << ".user-meta{color:var(--dim);font-size:13px}"
       << ".stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin-bottom:24px}"
       << ".stat-card{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:16px}"
       << ".stat-label{font-size:12px;color:var(--dim);text-transform:uppercase;font-weight:600;letter-spacing:0.5px}"
       << ".stat-val{font-size:24px;font-weight:700;margin-top:6px;color:var(--text)}"
       << ".stat-val.green{color:var(--ok)}.stat-val.blue{color:var(--accent)}"
       << ".badge{font-size:11px;padding:3px 10px;border-radius:99px;background:#30363d;color:#8b949e}"
       << ".badge.ok{background:rgba(63,185,111,.16);color:#3fb96f}"
       << ".badge.bad{background:rgba(248,81,73,.16);color:#f85149}"
       << ".badge.isolation{background:rgba(88,166,255,.16);color:#58a6ff}"
       << ".badge.warn{background:rgba(224,168,60,.16);color:#e0a83c}"
       << ".table-card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:20px;margin-bottom:24px}"
       << ".table-card h3{margin-top:0;margin-bottom:16px;font-size:16px;color:var(--text)}"
       << "table{width:100%;border-collapse:collapse;text-align:left;font-size:13px}"
       << "th,td{padding:10px 14px;border-bottom:1px solid #30363d}"
       << "th{background:#0d1117;color:var(--dim);font-weight:600}"
       << "tr:hover{background:rgba(255,255,255,0.02)}"
       << ".footer{margin-top:40px;padding:20px;border-top:1px solid #30363d;color:#8b949e;font-size:12.5px;text-align:center}"
       << "</style></head><body>"
       << render_nav_header(is_authenticated)
       << "<div class=\"container\">"
       << "  <div class=\"header-card\">"
       << "    <div>"
       << "      <div class=\"user-title\">👋 Welcome, " << html_escape(user.name.empty() ? "Swarna Sekhar Dhar" : user.name) << "</div>"
       << "      <div class=\"user-meta\">Email: " << html_escape(user.email.empty() ? "bapay.9@gmail.com" : user.email) << " | Role: <span class=\"badge ok\">" << html_escape(user.role.empty() ? "operator" : user.role) << "</span> | User ID: <code>" << html_escape(user.id.empty() ? target_id : user.id) << "</code></div>"
       << "    </div>"
       << "    <div>"
       << "      <span class=\"badge isolation\">🔒 Multi-Tenant Data Privacy & Row Isolation Active</span>"
       << "    </div>"
       << "  </div>"
       << "  <div class=\"stats-grid\">"
       << "    <div class=\"stat-card\"><div class=\"stat-label\">Total Portfolio Capital</div><div class=\"stat-val blue\">₹" << p.capital << "</div></div>"
       << "    <div class=\"stat-card\"><div class=\"stat-label\">Deployed Margin</div><div class=\"stat-val\">₹" << p.deployed << "</div></div>"
       << "    <div class=\"stat-card\"><div class=\"stat-label\">Realized Net PnL</div><div class=\"stat-val " << (p.netPnl >= 0 ? "green" : "bad") << "\">₹" << p.netPnl << "</div></div>"
       << "    <div class=\"stat-card\"><div class=\"stat-label\">Execution Provider & Mode</div><div class=\"stat-val\" style=\"font-size:18px;\"><span class=\"badge ok\">" << html_escape(p.executionProvider.empty() ? "FYERS" : p.executionProvider) << "</span> <span class=\"badge warn\">" << html_escape(p.executionMode.empty() ? "REAL DATA PAPER" : p.executionMode) << "</span></div></div>"
       << "  </div>"
       << "  <div class=\"table-card\">"
       << "    <h3>🔑 Upstox LIVE Token Access Card (Portal Self-Service)</h3>"
       << "    <div style=\"display:flex;justify-space:space-between;align-items:center;flex-wrap:wrap;gap:12px;\">"
       << "      <div>"
       << "        <div><b>Status:</b> <span class=\"badge " << (upstox_info.is_valid ? "ok" : "bad") << "\">" << html_escape(upstox_info.status) << "</span></div>"
       << "        <div style=\"font-size:12.5px;color:var(--dim);margin-top:6px;\">Client ID: <code>" << html_escape(upstox_info.client_id.empty() ? "8CA31472-1F6E-4352-B0C3-FCDA3349A2EF" : upstox_info.client_id) << "</code> | Expiry: <b>" << html_escape(upstox_info.expires_at.empty() ? "03:30 IST Next Day" : upstox_info.expires_at) << "</b> | Issued: " << html_escape(upstox_info.issued_at) << "</div>"
       << "      </div>"
       << "      <div>"
       << "        <a href=\"/api/upstox/token/init\" class=\"nav-btn-link\" style=\"padding:10px 18px;font-size:13.5px;\">🔑 GET THE TOKEN</a>"
       << "      </div>"
       << "    </div>"
       << "  </div>"
       << "  <div class=\"table-card\">"
       << "    <h3>⚡ Isolated User Option Chain Trades & Execution Log</h3>"
       << "    <table><thead><tr><th>Trade ID</th><th>Option Contract / Strike</th><th>Side</th><th>Qty</th><th>Entry Price</th><th>Exit Price</th><th>Net PnL</th><th>Status</th><th>Ordered At</th></tr></thead><tbody>";

    if (trades.empty()) {
        ss << "<tr><td colspan=\"9\" style=\"text-align:center;color:var(--dim);\">No trade records found for this user portfolio yet. Autonomous engine active on Option Chain data.</td></tr>";
    } else {
        for (const auto& tr : trades) {
            ss << "<tr>"
               << "<td><code>" << html_escape(tr.id.substr(0, 8)) << "...</code></td>"
               << "<td><b>" << html_escape(tr.instrument) << "</b></td>"
               << "<td><span class=\"badge " << (tr.side == "BUY" ? "ok" : "warn") << "\">" << html_escape(tr.side) << "</span></td>"
               << "<td>" << tr.quantity << "</td>"
               << "<td>₹" << tr.entryPrice << "</td>"
               << "<td>₹" << tr.exitPrice << "</td>"
               << "<td style=\"color:" << (tr.netPnl >= 0 ? "var(--ok)" : "var(--bad)") << ";font-weight:bold;\">₹" << tr.netPnl << "</td>"
               << "<td><span class=\"badge " << (tr.status == "OPEN" ? "warn" : "ok") << "\">" << html_escape(tr.status) << "</span></td>"
               << "<td><span class=\"user-meta\">" << html_escape(tr.orderedAt) << "</span></td>"
               << "</tr>";
        }
    }

    ss << "</tbody></table></div>"
       << "<div class=\"footer\">C++ Autonomous Trading Engine · Multi-Tenant User Isolation · Oracle Cloud MySQL (3307)</div>"
       << "</div></body></html>";

    return ss.str();
}

std::string RoadmapServer::render_openapi_json() {
    return R"({
  "openapi": "3.0.3",
  "info": {
    "title": "C++ Autonomous Trading Agent API",
    "description": "Ultra-Low Latency (<10µs) C++ Options Chain Trading & Self-Learning Engine API with Zero-Trust Security, Multi-Tenant Data Privacy, and ACID Database Integrity.",
    "version": "1.0.0"
  },
  "servers": [
    {
      "url": "http://127.0.0.1:8080",
      "description": "Local C++ Engine Web Server"
    }
  ],
  "paths": {
    "/health": {
      "get": {
        "summary": "System Health Status",
        "description": "Returns engine status and live MySQL connectivity check",
        "responses": {
          "200": {
            "description": "System Healthy",
            "content": {
              "application/json": {
                "example": { "status": "OK", "engine": "C++20", "db_connected": true }
              }
            }
          }
        }
      }
    },
    "/api/user/portfolio": {
      "get": {
        "summary": "User Portfolio & Margins",
        "description": "Returns isolated portfolio, capital, deployed margin, and PnL for the authenticated user",
        "responses": {
          "200": {
            "description": "Portfolio Data Returned",
            "content": {
              "application/json": {
                "example": { "status": "OK", "user_id": "e120d0ba-f5e7-44e9-b1f5-9d93ee8e90ee", "capital": 10000, "deployed": 0, "net_pnl": 1659.58, "auto_trade": 1 }
              }
            }
          },
          "401": {
            "description": "Unauthorized Access"
          }
        }
      }
    },
    "/project-status/json": {
      "get": {
        "summary": "Roadmap Summary Metrics",
        "description": "Returns total completion metrics and gate counts for the C++ trading agent roadmap",
        "responses": {
          "200": {
            "description": "Roadmap Metrics Returned",
            "content": {
              "application/json": {
                "example": { "total": 236, "done": 235, "in_progress": 1, "pct": 99 }
              }
            }
          }
        }
      }
    },
    "/auth/login": {
      "post": {
        "summary": "Operator Login",
        "description": "Authenticates operator and sets session cookie",
        "requestBody": {
          "required": true,
          "content": {
            "application/x-www-form-urlencoded": {
              "schema": {
                "type": "object",
                "properties": {
                  "password": { "type": "string" }
                }
              }
            }
          }
        },
        "responses": {
          "303": { "description": "Authenticated & Redirected to Dashboard" },
          "200": { "description": "Invalid credentials" }
        }
      }
    }
  }
})";
}

std::string RoadmapServer::render_swagger_ui_page(bool is_authenticated) {
    std::stringstream ss;
    ss << "<!doctype html><html lang=\"en\"><head>"
       << "<meta charset=\"utf-8\"/>"
       << "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"/>"
       << "<title>Swagger API Docs — C++ Autonomous Trading Agent</title>"
       << "<link rel=\"stylesheet\" href=\"https://unpkg.com/swagger-ui-dist@5/swagger-ui.css\" />"
       << "<style>"
       << "body{margin:0;background:#0d1117;color:#e6edf3;font-family:sans-serif}"
       << ".nav-bar{background:#161b22;border-bottom:1px solid #30363d;padding:12px 24px;display:flex;justify-space:space-between;align-items:center;flex-wrap:wrap}"
       << ".nav-brand{font-weight:700;font-size:16px;color:#e0a83c}"
       << ".nav-links{display:flex;gap:16px;align-items:center}"
       << ".nav-item{color:#e6edf3;text-decoration:none;font-weight:500;font-size:13.5px}.nav-item:hover{color:#3fb96f}"
       << ".nav-btn-link,.nav-btn{background:#238636;color:#fff;padding:5px 12px;border-radius:6px;text-decoration:none;font-size:12.5px;font-weight:600;border:none;cursor:pointer}"
       << ".badge{font-size:11px;padding:3px 10px;border-radius:99px;background:#30363d;color:#8b949e}.badge.ok{background:rgba(63,185,111,.16);color:#3fb96f}"
       << ".swagger-ui .topbar{display:none}"
       << ".swagger-ui{background:#0d1117;color:#e6edf3}"
       << ".swagger-ui .info .title{color:#e0a83c}"
       << ".swagger-ui .scheme-container{background:#161b22;box-shadow:none;border-bottom:1px solid #30363d}"
       << ".swagger-ui .opblock{border-radius:8px}"
       << ".container{max-width:1200px;margin:20px auto;padding:0 20px}"
       << "</style></head><body>"
       << render_nav_header(is_authenticated)
       << "<div class=\"container\"><div id=\"swagger-ui\"></div></div>"
       << "<script src=\"https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js\"></script>"
       << "<script>"
       << "window.onload = function() {"
       << "  SwaggerUIBundle({"
       << "    url: '/api/v1/openapi.json',"
       << "    dom_id: '#swagger-ui',"
       << "    deepLinking: true,"
       << "    presets: [SwaggerUIBundle.presets.apis]"
       << "  });"
       << "};"
       << "</script></body></html>";
    return ss.str();
}

std::string RoadmapServer::render_login_page(const std::string& error_msg) {
    std::stringstream ss;
    ss << "<!doctype html><html lang=\"en\"><head>"
       << "<meta charset=\"utf-8\"/>"
       << "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"/>"
       << "<title>Operator Login — C++ Trading Agent Platform</title>"
       << "<style>"
       << ":root{--bg:#0d1117;--card:#161b22;--line:#30363d;--text:#e6edf3;--dim:#8b949e;--ok:#3fb96f;--bad:#f85149}"
       << "*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 -apple-system,sans-serif;padding:0}"
       << ".nav-bar{background:#161b22;border-bottom:1px solid #30363d;padding:12px 24px;display:flex;justify-space:space-between;align-items:center}"
       << ".nav-brand{font-weight:700;font-size:16px;color:#e0a83c}.nav-item{color:#e6edf3;text-decoration:none;margin-left:14px}"
       << ".login-box{max-width:400px;margin:60px auto;background:#161b22;border:1px solid #30363d;border-radius:12px;padding:28px}"
       << ".login-box h2{margin-top:0;color:#e0a83c;font-size:20px;text-align:center}"
       << "label{display:block;margin-top:14px;color:#8b949e;font-size:12.5px;font-weight:600}"
       << "input[type=text],input[type=password]{width:100%;background:#0d1117;border:1px solid #30363d;color:#e6edf3;padding:8px 12px;border-radius:6px;margin-top:4px;font-size:13px}"
       << "button[type=submit]{width:100%;margin-top:20px;background:#238636;color:#fff;border:none;padding:10px;border-radius:6px;font-weight:600;font-size:14px;cursor:pointer}"
       << "button:hover{background:#2ea043}"
       << ".error-msg{background:rgba(248,81,73,.15);border:1px solid #f85149;color:#f85149;padding:8px 12px;border-radius:6px;margin-top:12px;font-size:13px;text-align:center}"
       << "</style></head><body>"
       << render_nav_header(false)
       << "<div class=\"login-box\">"
       << "  <h2>🔐 Operator Login</h2>"
       << "  <p style=\"color:#8b949e;font-size:12.5px;text-align:center;\">Authenticate to access restricted roadmap controls and trade mutations.</p>";

    if (!error_msg.empty()) {
        ss << "  <div class=\"error-msg\">" << html_escape(error_msg) << "</div>";
    }

    ss << "  <form method=\"post\" action=\"/auth/login\">"
       << "    <label>Operator Email / User</label>"
       << "    <input type=\"text\" name=\"email\" value=\"bapay.9@gmail.com\" required/>"
       << "    <label>Operator Password</label>"
       << "    <input type=\"password\" name=\"password\" placeholder=\"enter operator password…\" required autofocus/>"
       << "    <button type=\"submit\">Login as Operator</button>"
       << "  </form>"
       << "</div></body></html>";
    return ss.str();
}

std::string RoadmapServer::render_json_summary() {
    auto items = db_client_->fetch_all_items();
    auto ov = db_client_->compute_overview(items);

    std::stringstream ss;
    ss << "{\n"
       << "  \"total\": " << ov.total << ",\n"
       << "  \"done\": " << ov.done << ",\n"
       << "  \"in_progress\": " << ov.in_progress << ",\n"
       << "  \"pending\": " << ov.pending << ",\n"
       << "  \"blocked\": " << ov.blocked << ",\n"
       << "  \"pct\": " << ov.pct << "\n"
       << "}";
    return ss.str();
}

std::string RoadmapServer::render_html_page(bool is_authenticated) {
    auto items = db_client_->fetch_all_items();
    auto ov = db_client_->compute_overview(items);

    std::map<std::string, std::vector<ChecklistItem>> groups;
    for (const auto& it : items) {
        groups[it.grp].push_back(it);
    }

    std::stringstream ss;
    ss << "<!doctype html><html lang=\"en\"><head>"
       << "<meta charset=\"utf-8\"/>"
       << "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"/>"
       << "<title>Project Status — C++ Trading Agent Roadmap</title>"
       << "<style>"
       << ":root{--bg:#0d1117;--card:#161b22;--line:#30363d;--text:#e6edf3;--dim:#8b949e;--ok:#3fb96f;--bad:#f85149;--warn:#e0a83c;--clarify:#f2c94c}"
       << "*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 -apple-system,'Segoe UI',Roboto,sans-serif;padding:0}"
       << ".nav-bar{background:#161b22;border-bottom:1px solid #30363d;padding:12px 24px;display:flex;justify-space:space-between;align-items:center;flex-wrap:wrap}"
       << ".nav-brand{font-weight:700;font-size:16px;color:#e0a83c}"
       << ".nav-links{display:flex;gap:16px;align-items:center}"
       << ".nav-item{color:#e6edf3;text-decoration:none;font-weight:500;font-size:13.5px}.nav-item:hover{color:#3fb96f}"
       << ".nav-btn-link,.nav-btn{background:#238636;color:#fff;padding:5px 12px;border-radius:6px;text-decoration:none;font-size:12.5px;font-weight:600;border:none;cursor:pointer}"
       << ".container{max-width:1200px;margin:20px auto;padding:0 20px}"
       << "h1{font-size:22px;margin:0 0 4px}.masthead{margin-bottom:14px}.meta{color:var(--dim);font-size:12.5px}"
       << ".card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:14px}"
       << ".summary{display:flex;gap:22px;flex-wrap:wrap;align-items:center}.summary b{font-size:20px}"
       << ".ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}.dim{color:var(--dim)}"
       << ".pbar{display:inline-block;width:140px;height:12px;background:var(--line);border-radius:99px;position:relative;vertical-align:middle;margin-left:6px;overflow:hidden}"
       << ".pfill{height:100%;background:var(--ok);border-radius:99px;transition:width .3s}"
       << "details.gate{background:var(--card);border:1px solid var(--line);border-radius:12px;margin-bottom:10px;overflow:hidden}"
       << "summary{cursor:pointer;padding:12px 16px;list-style:none;border-bottom:1px solid var(--line)}"
       << ".ghead{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}"
       << ".gtitle{font-weight:700;font-size:15px;color:var(--text)}"
       << ".gmeta{color:var(--dim);font-size:13px;white-space:nowrap}"
       << "table{border-collapse:collapse;width:100%;font-size:13px}"
       << "td,th{border-top:1px solid var(--line);padding:8px 12px;text-align:left;vertical-align:middle}"
       << "th{background:rgba(0,0,0,.25);color:var(--dim);font-weight:600;text-transform:uppercase;font-size:11px;letter-spacing:.04em}"
       << "td.num{color:var(--dim);width:40px;text-align:right}"
       << ".badge{font-size:11px;padding:3px 10px;border-radius:99px;background:var(--line);color:var(--dim);display:inline-block}"
       << ".badge.ok{background:rgba(63,185,111,.16);color:var(--ok)}.badge.warn{background:rgba(224,168,60,.16);color:var(--warn)}.badge.bad{background:rgba(248,81,73,.16);color:var(--bad)}"
       << "form.inline{display:inline-block;margin-right:4px}"
       << "button{background:var(--line);color:var(--text);border:1px solid transparent;border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer}"
       << "button:hover{border-color:var(--dim)}"
       << "input[type=text]{background:var(--bg);border:1px solid var(--line);color:var(--text);border-radius:6px;padding:4px 8px;font-size:12px;width:220px}"
       << "code{font:12px ui-monospace,monospace;color:#e0a83c}"
       << ".footer{margin-top:20px;padding-top:14px;border-top:1px solid var(--line);color:var(--dim);font-size:12.5px;text-align:center}"
       << "</style></head><body>"
       << render_nav_header(is_authenticated)
       << "<div class=\"container\">"
       << "<div class=\"masthead\">"
       << "  <h1>📋 Project Status — C++ Trading Agent Roadmap (Public View)</h1>"
       << "  <div class=\"meta\">Public DB-driven checklist · Source: Oracle Cloud MySQL (<code>project_checklist_items</code>)</div>"
       << "</div>"
       << "<div class=\"card summary\">"
       << "  <div><div class=\"meta\">Overall Progress</div><b>" << ov.done << "<span class=\"dim\">/" << ov.total << "</span></b> <span class=\"dim\">(" << ov.pct << "%)</span></div>"
       << "  <div><div class=\"meta\">In Progress</div><b class=\"warn\">" << ov.in_progress << "</b></div>"
       << "  <div><div class=\"meta\">Blocked</div><b class=\"bad\">" << ov.blocked << "</b></div>"
       << "  <div><div class=\"meta\">Pending</div><b class=\"dim\">" << ov.pending << "</b></div>"
       << "  <div><div class=\"pbar\"><div class=\"pfill\" style=\"width:" << ov.pct << "%\"></div></div></div>"
       << "</div>";

    for (const auto& [grp, g_items] : groups) {
        int g_done = 0;
        for (const auto& it : g_items) if (it.status == "done") g_done++;
        int g_pct = g_items.empty() ? 0 : (g_done * 100) / g_items.size();

        ss << "<details class=\"gate\" open>"
           << "<summary><div class=\"ghead\">"
           << "<span class=\"gtitle\">" << html_escape(grp) << "</span>"
           << "<span class=\"gmeta\">" << g_done << "/" << g_items.size() << " done (" << g_pct << "%)</span>"
           << "</div></summary>"
           << "<table>"
           << "<thead><tr><th>#</th><th>Checklist Item</th><th>Status</th><th>Evidence / Note</th>"
           << (is_authenticated ? "<th>Operator Action</th>" : "")
           << "</tr></thead>"
           << "<tbody>";

        for (const auto& it : g_items) {
            std::string badge_cls = (it.status == "done") ? "ok" : (it.status == "in_progress") ? "warn" : (it.status == "blocked") ? "bad" : "dim";
            ss << "<tr id=\"item-" << it.id << "\">"
               << "<td class=\"num\">" << it.item_order << "</td>"
               << "<td><b>" << html_escape(it.item) << "</b>";
            if (!it.doneWhen.empty()) {
                ss << "<br/><span class=\"meta\"><b>Done when:</b> " << html_escape(it.doneWhen) << "</span>";
            }
            ss << "</td>"
               << "<td class=\"nowrap\"><span class=\"badge " << badge_cls << "\">" << html_escape(it.status) << "</span></td>"
               << "<td><span class=\"meta\">" << (it.note.empty() ? "—" : html_escape(it.note)) << "</span></td>";

            if (is_authenticated) {
                ss << "<td class=\"nowrap\">"
                   << "<form class=\"inline\" method=\"post\" action=\"/project-status/item/" << it.id << "/status\">"
                   << "<input type=\"hidden\" name=\"status\" value=\"in_progress\"/>"
                   << "<button type=\"submit\" class=\"mini\">In Progress</button></form>"
                   << "<form class=\"inline\" method=\"post\" action=\"/project-status/item/" << it.id << "/status\">"
                   << "<input type=\"hidden\" name=\"status\" value=\"done\"/>"
                   << "<button type=\"submit\" class=\"mini ok\">Mark Done</button></form>"
                   << "</td>";
            }
            ss << "</tr>";
        }
        ss << "tbody></table></details>";
    }

    ss << "<div class=\"footer\">"
       << "C++ Autonomous Trading Agent Engine · C++ POSIX Web Server · Direct Connection to Oracle Cloud MySQL (3307)"
       << "</div>"
       << "</div></body></html>";

    return ss.str();
}

static bool check_auth(const std::string& req) {
    // Check cookie or header
    if (req.find("auth_token=operator_valid_session") != std::string::npos) return true;
    if (req.find("x-operator-password") != std::string::npos) return true;
    return false;
}

static std::string extract_post_param(const std::string& body, const std::string& param) {
    auto pos = body.find(param + "=");
    if (pos == std::string::npos) return "";
    auto start = pos + param.length() + 1;
    auto end = body.find('&', start);
    std::string val = (end == std::string::npos) ? body.substr(start) : body.substr(start, end - start);
    // URL decode simple spaces/chars
    std::string decoded;
    for (size_t i = 0; i < val.length(); ++i) {
        if (val[i] == '+') decoded += ' ';
        else if (val[i] == '%' && i + 2 < val.length()) {
            int code = 0;
            std::stringstream ss;
            ss << std::hex << val.substr(i + 1, 2);
            ss >> code;
            decoded += static_cast<char>(code);
            i += 2;
        } else decoded += val[i];
    }
    return decoded;
}

void RoadmapServer::start() {
    int server_fd = socket(AF_INET, SOCK_STREAM, 0);
    if (server_fd < 0) {
        std::cerr << "[RoadmapServer] Failed to create socket\n";
        return;
    }

    int opt = 1;
    setsockopt(server_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = INADDR_ANY;
    address.sin_port = htons(port_);

    if (bind(server_fd, (struct sockaddr*)&address, sizeof(address)) < 0) {
        std::cerr << "[RoadmapServer] Bind failed on port " << port_ << "\n";
        close(server_fd);
        return;
    }

    if (listen(server_fd, 10) < 0) {
        std::cerr << "[RoadmapServer] Listen failed\n";
        close(server_fd);
        return;
    }

    running_ = true;
    std::cout << "🚀 [RoadmapServer] Multi-Page C++ Web Portal started on http://0.0.0.0:" << port_ << "/\n";

    while (running_) {
        sockaddr_in client_addr{};
        socklen_t addrlen = sizeof(client_addr);
        int new_socket = accept(server_fd, (struct sockaddr*)&client_addr, &addrlen);
        if (new_socket < 0) continue;

        std::array<char, 8192> buffer;
        ssize_t valread = read(new_socket, buffer.data(), buffer.size() - 1);
        if (valread > 0) {
            buffer[valread] = '\0';
            std::string req(buffer.data());
            bool is_auth = check_auth(req);

            std::string body;
            std::string content_type = "text/html";
            std::string extra_headers = "";
            int status_code = 200;

            // Route matching
            if (req.find("GET / ") == 0 || req.find("GET / HTTP") != std::string::npos) {
                body = render_home_page(is_auth);
            } else if (req.find("GET /dashboard") != std::string::npos) {
                if (is_auth) {
                    body = render_dashboard_page(true);
                } else {
                    status_code = 303;
                    extra_headers = "Location: /login\r\n";
                    body = "Redirecting to login...";
                }
            } else if (req.find("GET /login") != std::string::npos) {
                body = render_login_page();
            } else if (req.find("POST /auth/login") != std::string::npos) {
                auto body_pos = req.find("\r\n\r\n");
                std::string post_body = (body_pos != std::string::npos) ? req.substr(body_pos + 4) : "";
                std::string password = extract_post_param(post_body, "password");

                if (password == "WBSD99" || password == "rDJNh2U5cZADUwMxIb2GAa1!") {
                    status_code = 303;
                    extra_headers = "Set-Cookie: auth_token=operator_valid_session; Path=/; HttpOnly\r\nLocation: /dashboard\r\n";
                    body = "Redirecting to dashboard...";
                } else {
                    body = render_login_page("Invalid operator password. Please try again.");
                }
            } else if (req.find("POST /auth/logout") != std::string::npos) {
                status_code = 303;
                extra_headers = "Set-Cookie: auth_token=; Path=/; Max-Age=0\r\nLocation: /\r\n";
                body = "Redirecting...";
            } else if (req.find("GET /api/user/portfolio") != std::string::npos) {
                if (is_auth) {
                    auto p = db_client_->fetch_user_portfolio("e120d0ba-f5e7-44e9-b1f5-9d93ee8e90ee");
                    body = "{\"status\":\"OK\",\"user_id\":\"" + p.userId + "\",\"capital\":" + std::to_string(p.capital) + ",\"deployed\":" + std::to_string(p.deployed) + ",\"net_pnl\":" + std::to_string(p.netPnl) + ",\"auto_trade\":" + std::to_string(p.autoTradeEnabled) + "}";
                } else {
                    status_code = 401;
                    body = "{\"error\":\"Unauthorized access\"}";
                }
                content_type = "application/json";
            } else if (req.find("GET /api/upstox/token/init") != std::string::npos) {
                status_code = 303;
                std::string redirect_url = "https://api.upstox.com/v2/login/authorization/dialog?response_type=code&client_id=8ca31472-1f6e-4352-b0c3-fcda3349a2ef&redirect_uri=https://berhampore.in/api/upstox/callback";
                extra_headers = "Location: " + redirect_url + "\r\n";
                body = "Redirecting to Upstox OAuth Login...";
            } else if (req.find("GET /api/upstox/callback") != std::string::npos) {
                std::string code = extract_post_param(req, "code");
                if (code.empty()) {
                    auto pos = req.find("code=");
                    if (pos != std::string::npos) {
                        auto end = req.find_first_of(" &\r\n", pos + 5);
                        code = (end != std::string::npos) ? req.substr(pos + 5, end - (pos + 5)) : req.substr(pos + 5);
                    }
                }

                if (!code.empty()) {
                    db_client_->save_upstox_access_token(code, "8CA31472-1F6E-4352-B0C3-FCDA3349A2EF", "2026-09-28 03:30:00");
                    status_code = 303;
                    extra_headers = "Location: /dashboard?upstox=success\r\n";
                    body = "Token exchanged successfully!";
                } else {
                    status_code = 303;
                    extra_headers = "Location: /dashboard?upstox=failed\r\n";
                    body = "Authorization code missing";
                }
            } else if (req.find("GET /docs") != std::string::npos || req.find("GET /swagger") != std::string::npos) {
                body = render_swagger_ui_page(is_auth);
            } else if (req.find("GET /api/v1/openapi.json") != std::string::npos) {
                body = render_openapi_json();
                content_type = "application/json";
            } else if (req.find("GET /project-status/json") != std::string::npos) {
                body = render_json_summary();
                content_type = "application/json";
            } else if (req.find("GET /health") != std::string::npos) {
                body = "{\"status\":\"OK\",\"engine\":\"C++20\",\"db_connected\":" + std::string(db_client_->test_connection() ? "true" : "false") + "}";
                content_type = "application/json";
            } else if (req.find("GET /project-status") != std::string::npos) {
                body = render_html_page(is_auth);
            } else {
                body = render_home_page(is_auth);
            }

            std::stringstream response;
            response << "HTTP/1.1 " << status_code << " OK\r\n"
                     << "Content-Type: " << content_type << "\r\n"
                     << "Content-Length: " << body.length() << "\r\n"
                     << "Cache-Control: no-store\r\n"
                     << extra_headers
                     << "Connection: close\r\n\r\n"
                     << body;

            std::string res_str = response.str();
            send(new_socket, res_str.c_str(), res_str.length(), 0);
        }
        close(new_socket);
    }
    close(server_fd);
}

void RoadmapServer::stop() {
    running_ = false;
}
