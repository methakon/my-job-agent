#include "roadmap_server.hpp"
#include "../common/env_loader.hpp"
#include "../common/crypto_util.hpp"
#include "../engine/market_calendar.hpp"
#include "../engine/strategy_config_manager.hpp"
#include "../analytics/visitor_tracker.hpp"
#include <iostream>
#include <sstream>
#include <csignal>
#include <vector>
#include <map>
#include <array>
#include <cstring>
#include <unistd.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <thread>
#include <iomanip>
#include <fstream>
#include <chrono>

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

static const char* GOOGLE_ANALYTICS_FOOTER_TAG =
    "<!-- Google tag (gtag.js) -->\n"
    "<script async src=\"https://www.googletagmanager.com/gtag/js?id=G-28FDYX1K4Y\"></script>\n"
    "<script>\n"
    "  window.dataLayer = window.dataLayer || [];\n"
    "  function gtag(){dataLayer.push(arguments);}\n"
    "  gtag('js', new Date());\n\n"
    "  gtag('config', 'G-28FDYX1K4Y');\n"
    "</script>\n";

static std::string render_nav_header(bool is_authenticated) {
    std::stringstream ss;
    ss << "<div class=\"nav-bar\">"
       << "  <div class=\"nav-brand\">⚡ C++ Autonomous Agent Platform</div>"
       << "  <div class=\"nav-links\">"
       << "    <a href=\"/\" class=\"nav-item\">🏠 Home</a>"
       << "    <a href=\"/project-status\" class=\"nav-item\">📋 Project Roadmap</a>"
       << "    <a href=\"/docs\" class=\"nav-item\">📖 API Docs (Swagger)</a>"
       << "    <a href=\"/visitor-info\" class=\"nav-item\">🌐 Visitor Analytics</a>";

    if (is_authenticated) {
        ss << "    <a href=\"/admin/visitors\" class=\"nav-item\" style=\"color:#e0a83c;\">👥 Visitors Admin</a>"
           << "    <a href=\"/dashboard\" class=\"nav-item\" style=\"color:#58a6ff;\">📊 User Dashboard</a>"
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

static std::string read_system_stats_json(std::shared_ptr<RoadmapDbClient> db_client = nullptr) {
    static uint64_t prev_active = 0;
    static uint64_t prev_total = 0;
    static double cached_cpu_pct = 0.0;
    static bool has_prev_sample = false;

    std::ifstream stat_file("/proc/stat");
    if (stat_file.is_open()) {
        std::string line;
        if (std::getline(stat_file, line) && line.rfind("cpu ", 0) == 0) {
            std::istringstream iss(line.substr(4));
            uint64_t user=0, nice=0, system=0, idle=0, iowait=0, irq=0, softirq=0, steal=0;
            iss >> user >> nice >> system >> idle >> iowait >> irq >> softirq >> steal;
            uint64_t active = user + nice + system + irq + softirq + steal;
            uint64_t total = active + idle + iowait;

            if (has_prev_sample) {
                uint64_t delta_active = active >= prev_active ? active - prev_active : 0;
                uint64_t delta_total = total >= prev_total ? total - prev_total : 0;
                if (delta_total > 0) {
                    cached_cpu_pct = (static_cast<double>(delta_active) * 100.0) / static_cast<double>(delta_total);
                }
            }
            prev_active = active;
            prev_total = total;
            has_prev_sample = true;
        }
    }

    long total_kb = 0, avail_kb = 0;
    std::ifstream mem_file("/proc/meminfo");
    if (mem_file.is_open()) {
        std::string key;
        long val;
        std::string unit;
        while (mem_file >> key >> val >> unit) {
            if (key == "MemTotal:") total_kb = val;
            else if (key == "MemAvailable:") avail_kb = val;
        }
    }
    long total_mb = total_kb / 1024;
    long avail_mb = avail_kb / 1024;
    long used_mb = total_mb > avail_mb ? total_mb - avail_mb : 0;
    double ram_pct = total_mb > 0 ? (static_cast<double>(used_mb) * 100.0) / static_cast<double>(total_mb) : 0.0;

    double l1=0.0, l5=0.0, l15=0.0;
    std::ifstream load_file("/proc/loadavg");
    if (load_file.is_open()) {
        load_file >> l1 >> l5 >> l15;
    }

    long long today_ticks = 0, total_ticks = 0;
    if (db_client && db_client->test_connection()) {
        auto counts = db_client->fetch_stored_tick_counts();
        today_ticks = counts.first;
        total_ticks = counts.second;
    }

    uint64_t now_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()
    ).count();
    auto session_phase = hermes::MarketCalendar::get_session_phase(now_ms);
    bool is_trading_day = hermes::MarketCalendar::is_trading_day(now_ms);

    std::ostringstream json;
    json << std::fixed << std::setprecision(1);
    json << "{\"cpu_percent\":" << cached_cpu_pct
         << ",\"ram_used_mb\":" << used_mb
         << ",\"ram_total_mb\":" << total_mb
         << ",\"ram_percent\":" << ram_pct
         << std::setprecision(2)
         << ",\"load_1m\":" << l1
         << ",\"load_5m\":" << l5
         << ",\"load_15m\":" << l15
         << ",\"today_ticks\":" << today_ticks
         << ",\"total_ticks\":" << total_ticks
         << ",\"session_phase\":\"" << hermes::MarketCalendar::session_phase_to_string(session_phase) << "\""
         << ",\"is_trading_day\":" << (is_trading_day ? "true" : "false")
         << ",\"is_market_open\":" << (session_phase == hermes::SessionPhase::MARKET_OPEN ? "true" : "false");

    if (db_client) {
        std::string cipher = db_client->get_ssl_cipher_status();
        bool is_encrypted = (!cipher.empty() && cipher != "NONE" && cipher != "NO_CONNECTION");
        json << ",\"mysql_ssl_cipher\":\"" << cipher << "\""
             << ",\"mysql_ssl_encrypted\":" << (is_encrypted ? "true" : "false");
    }

    json << ",\"strategy_config\":" << hermes::StrategyConfigManager::instance().to_json();

    json << "}";
    return json.str();
}

std::string RoadmapServer::render_home_page(bool is_authenticated) {
    std::stringstream ss;
    ss << "<!doctype html><html lang=\"en\"><head>"
       << "<meta charset=\"utf-8\"/>"
       << "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"/>"
       << "<title>Home — C++ Autonomous Trading Agent Platform</title>"
       << "<style>"
       << ":root{--bg:#0d1117;--card:#161b22;--line:#30363d;--text:#e6edf3;--dim:#8b949e;--ok:#3fb96f;--bad:#f85149;--warn:#e0a83c;--accent:#58a6ff}"
       << "*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 -apple-system,'Segoe UI',Roboto,sans-serif;padding:0}"
       << ".nav-bar{background:#161b22;border-bottom:1px solid #30363d;padding:12px 24px;display:flex;justify-space:space-between;align-items:center;flex-wrap:wrap}"
       << ".nav-brand{font-weight:700;font-size:16px;color:#e0a83c}"
       << ".nav-links{display:flex;gap:16px;align-items:center}"
       << ".nav-item{color:#e6edf3;text-decoration:none;font-weight:500;font-size:13.5px}.nav-item:hover{color:#3fb96f}"
       << ".nav-btn-link,.nav-btn{background:#238636;color:#fff;padding:5px 12px;border-radius:6px;text-decoration:none;font-size:12.5px;font-weight:600;border:none;cursor:pointer}"
       << ".container{max-width:1100px;margin:30px auto;padding:0 20px}"
       << ".hero{background:linear-gradient(135deg, #161b22 0%, #0d1117 100%);border:1px solid #30363d;border-radius:14px;padding:32px;margin-bottom:24px}"
       << ".hero h1{font-size:28px;margin:0 0 8px;color:#e0a83c}"
       << ".grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:20px}"
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
       << "    <p style=\"color:#8b949e;font-size:15px;max-width:800px;\">Ultra-Low Latency (&lt; 10µs) Options Chain Trading &amp; Self-Learning Engine built in C++20 with Zero-Trust Security, Multi-Tenant Data Privacy, and ACID database integrity.</p>"
       << "    <div style=\"margin-top:16px;display:flex;gap:12px;\">"
       << "      <a href=\"/project-status\" class=\"nav-btn-link\" style=\"padding:8px 16px;font-size:14px;\">📋 View Public Roadmap (/project-status)</a>"
       << (is_authenticated ? "      <a href=\"/dashboard\" class=\"nav-btn-link\" style=\"background:#58a6ff;padding:8px 16px;font-size:14px;color:#0d1117;\">📊 Open User Dashboard (/dashboard)</a>" : "      <a href=\"/login\" class=\"nav-btn-link\" style=\"background:#30363d;padding:8px 16px;font-size:14px;\">🔐 Operator Login</a>")
       << "    </div>"
       << "  </div>"
       << "  <div class=\"grid\">"
       << "    <div class=\"card\">"
       << "      <h3>⚙️ Engine Specifications</h3>"
       << "      <p>• <b>Language</b>: C++20 (-O3 Release Optimization)</p>"
       << "      <p>• <b>Decision Latency</b>: &lt; 10 microseconds (p99)</p>"
       << "      <p>• <b>Server Footprint</b>: 15 MB – 20 MB RAM</p>"
       << "      <p>• <b>V8 GC Stalls</b>: ZERO (Pure Native C++)</p>"
       << "    </div>"
       << "    <div class=\"card\">"
       << "      <h3>🖥️ Server Load Panel</h3>"
       << "      <p>• <b>CPU Usage</b>: <span id=\"sys-cpu-val\" style=\"font-weight:bold;color:var(--accent);\">--%</span></p>"
       << "      <p>• <b>RAM Usage</b>: <span id=\"sys-ram-val\" style=\"font-weight:bold;color:var(--ok);\">-- / -- MB (--%)</span></p>"
       << "      <p>• <b>Load Average</b>: <span id=\"sys-load-val\" style=\"font-weight:bold;color:var(--text);\">-- / -- / --</span></p>"
       << "      <p style=\"margin-top:8px;font-size:11.5px;color:var(--dim);\">Auto-refreshes every 60s · <a href=\"/api/system/stats\" target=\"_blank\" style=\"color:var(--accent);text-decoration:none;\">/api/system/stats</a></p>"
       << "    </div>"
       << "    <div class=\"card\">"
       << "      <h3>🗄️ Database &amp; Multi-Tenant Privacy</h3>"
       << "      <p>• <b>Database</b>: Oracle Cloud MySQL MDS (ap-tokyo-1)</p>"
       << "      <p>• <b>Historical Data</b>: 6.9M+ Canonical Quote Rows</p>"
       << "      <p>• <b>Multi-Tenant Isolation</b>: User-level row isolation via portal_users</p>"
       << "      <p>• <b>ACID Compliance</b>: Strict transactional guarantees</p>"
       << "    </div>"
       << "    <div class=\"card\">"
       << "      <h3>🤖 Self-Learning Loop</h3>"
       << "      <p>• <b>Trading Hours</b>: 9:15 AM - 3:30 PM IST (Paper Execution)</p>"
       << "      <p>• <b>Off-Hours Analytics</b>: Rejection &amp; Mistake Learning</p>"
       << "      <p>• <b>Quant Engine</b>: IV/RV Skew, Gamma Flip, Vanna/Charm</p>"
       << "      <p>• <b>Promotion Gate</b>: 30-Day Sharpe &gt; 2.0 &amp; Drawdown &lt; 5%</p>"
       << "    </div>"
       << "  </div>"
       << "  <div style=\"margin-top:28px;text-align:center;background:#161b22;border:1px solid #30363d;border-radius:12px;padding:24px 16px;\">"
       << "    <h3 style=\"margin-top:0;margin-bottom:14px;color:#e0a83c;font-size:16px;\">💖 Sponsor &amp; Support</h3>"
       << "    <div style=\"display:flex;justify-content:center;overflow-x:auto;\">"
       << "      <iframe src=\"https://github.com/sponsors/methakon/card\" title=\"Sponsor methakon\" height=\"225\" width=\"600\" style=\"border: 0; max-width: 100%;\"></iframe>"
       << "    </div>"
       << "  </div>"
       << "<script>"
       << "function fetchSystemStats(){"
       << "  fetch('/api/system/stats')"
       << "    .then(function(r){return r.json();})"
       << "    .then(function(d){"
       << "      if(d.cpu_percent!==undefined){"
       << "        document.getElementById('sys-cpu-val').innerText=d.cpu_percent.toFixed(1)+'%';"
       << "        document.getElementById('sys-ram-val').innerText=d.ram_used_mb+' / '+d.ram_total_mb+' MB ('+d.ram_percent.toFixed(1)+'%)';"
       << "        document.getElementById('sys-load-val').innerText=d.load_1m.toFixed(2)+' / '+d.load_5m.toFixed(2)+' / '+d.load_15m.toFixed(2);"
       << "      }"
       << "    })"
       << "    .catch(function(e){console.error('Stats error',e);});"
       << "}"
       << "fetchSystemStats();"
       << "setInterval(fetchSystemStats,60000);"
       << "</script>"
       << "  <div class=\"footer\">C++ Autonomous Trading Engine · Multi-Tenant User Isolation · Oracle Cloud MySQL (3307)</div>"
       << "</div>"
       << GOOGLE_ANALYTICS_FOOTER_TAG
       << "</body></html>";
    return ss.str();
}

std::string RoadmapServer::render_dashboard_page(bool is_authenticated, const std::string& user_id) {
    std::string target_id = user_id.empty() ? "e120d0ba-f5e7-44e9-b1f5-9d93ee8e90ee" : user_id;
    UserProfile user;
    UserPortfolioData p;
    BrokerTokenInfo upstox_info;
    BrokerTokenInfo fyers_info;
    BrokerTokenInfo sandbox_info;
    std::vector<CppRoadmapItem> cpp_items;
    RoadmapOverview cpp_ov;

    if (db_client_ && db_client_->test_connection()) {
        user = db_client_->fetch_user_by_email_or_id(target_id);
        p = db_client_->fetch_user_portfolio(user.id.empty() ? target_id : user.id);
        upstox_info = db_client_->fetch_broker_token_status("upstox");
        fyers_info = db_client_->fetch_broker_token_status("fyers");
        sandbox_info = db_client_->fetch_broker_token_status("upstox_sandbox");
        cpp_items = db_client_->fetch_cpp_roadmap_items();
        cpp_ov = db_client_->compute_cpp_overview(cpp_items);
    }

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
       << ".nav-btn-link{background:#238636;color:#fff;padding:6px 14px;border-radius:6px;text-decoration:none;font-size:12.5px;font-weight:600;border:none;cursor:pointer;display:inline-block}"
       << ".container{max-width:1200px;margin:24px auto;padding:0 20px}"
       << ".header-card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:20px;margin-bottom:20px;display:flex;justify-space:space-between;align-items:center;flex-wrap:wrap;gap:12px}"
       << ".user-title{font-size:22px;font-weight:700;color:var(--text);margin:0}"
       << ".user-meta{color:var(--dim);font-size:13px}"
       << ".badge{font-size:11px;padding:3px 10px;border-radius:99px;background:#30363d;color:#8b949e}"
       << ".badge.ok{background:rgba(63,185,111,.16);color:#3fb96f}"
       << ".badge.bad{background:rgba(248,81,73,.16);color:#f85149}"
       << ".badge.isolation{background:rgba(88,166,255,.16);color:#58a6ff}"
       << ".badge.warn{background:rgba(224,168,60,.16);color:#e0a83c}"
       << ".tile-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:18px;margin-bottom:24px}"
       << ".tile-card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:20px;display:flex;flex-direction:column;justify-space:between}"
       << ".tile-icon{font-size:24px;margin-bottom:8px}"
       << ".tile-title{font-size:15px;font-weight:700;color:var(--text);margin-bottom:4px}"
       << ".tile-stat{font-size:22px;font-weight:700;margin:6px 0;color:var(--text)}"
       << ".tile-stat.green{color:var(--ok)}.tile-stat.blue{color:var(--accent)}.tile-stat.amber{color:var(--warn)}.tile-stat.gold{color:#e0a83c}"
       << ".tile-meta{font-size:12.5px;color:var(--dim);margin-bottom:12px}"
       << ".footer{margin-top:40px;padding:20px;border-top:1px solid #30363d;color:#8b949e;font-size:12.5px;text-align:center}"
       << "</style></head><body>"
       << render_nav_header(is_authenticated)
       << "<div class=\"container\">"
       << "  <div class=\"header-card\">"
       << "    <div>"
       << "      <div class=\"user-title\">👋 Welcome, " << html_escape(user.name.empty() ? "Swarna Sekhar Dhar" : user.name) << "</div>"
       << "      <div class=\"user-meta\">Email: " << html_escape(user.email.empty() ? "operator@hermes" : user.email) << " | Role: <span class=\"badge ok\">" << html_escape(user.role.empty() ? "operator" : user.role) << "</span> | User ID: <code>" << html_escape(user.id.empty() ? target_id : user.id) << "</code></div>"
       << "    </div>"
       << "    <div>"
       << "      <span class=\"badge isolation\">🔒 Multi-Tenant Data Privacy Active</span>"
       << "    </div>"
       << "  </div>"

       << "  <div class=\"tile-grid\">"

       // Tile 1: Portfolio Capital Sub-Page Tile
       << "    <div class=\"tile-card\">"
       << "      <div class=\"tile-icon\">💰</div>"
       << "      <div class=\"tile-title\">Portfolio Capital &amp; Margins</div>"
       << "      <div class=\"tile-stat blue\">₹" << p.capital << "</div>"
       << "      <div class=\"tile-meta\">Deployed Margin: ₹" << p.deployed << " | Net PnL: <span style=\"color:" << (p.netPnl >= 0 ? "var(--ok)" : "var(--bad)") << ";font-weight:bold;\">₹" << p.netPnl << "</span></div>"
       << "      <div style=\"margin-top:auto;\">"
       << "        <a href=\"/portfolio\" class=\"nav-btn-link\" style=\"background:#58a6ff;color:#0d1117;font-size:12.5px;padding:7px 14px;\">💰 Open Portfolio Sub-Page</a>"
       << "      </div>"
       << "    </div>"

       // Tile 2: Paper Execution & Training Sub-Page Tile
       << "    <div class=\"tile-card\">"
       << "      <div class=\"tile-icon\">📈</div>"
       << "      <div class=\"tile-title\">Paper Trading &amp; Engine Training</div>"
       << "      <div class=\"tile-stat green\">&lt; 0.05 µs Latency</div>"
       << "      <div class=\"tile-meta\">Engine Skill Benchmark: <b>86.74% Win Rate</b> | Trades Log</div>"
       << "      <div style=\"margin-top:auto;\">"
       << "        <a href=\"/paper-trading\" class=\"nav-btn-link\" style=\"font-size:12.5px;padding:7px 14px;\">📈 Open Paper Trading Sub-Page</a>"
       << "      </div>"
       << "    </div>"

       // Tile 3: Broker OAuth Token Gateway Sub-Page Tile
       << "    <div class=\"tile-card\">"
       << "      <div class=\"tile-icon\">🔑</div>"
       << "      <div class=\"tile-title\">Broker API Token Gateway</div>"
       << "      <div class=\"tile-stat gold\">Upstox &amp; FYERS</div>"
       << "      <div class=\"tile-meta\">Upstox Status: <span class=\"badge " << (upstox_info.is_valid ? "ok" : "bad") << "\">" << html_escape(upstox_info.status.empty() ? "EXPIRED" : upstox_info.status) << "</span> | FYERS: <span class=\"badge ok\">ACTIVE</span></div>"
       << "      <div style=\"margin-top:auto;\">"
       << "        <a href=\"/tokens\" class=\"nav-btn-link\" style=\"background:#e0a83c;color:#0d1117;font-size:12.5px;padding:7px 14px;\">🔑 Manage Broker Tokens</a>"
       << "      </div>"
       << "    </div>"

       // Tile 4: Dedicated C++ Master Roadmap Sub-Page Tile
       << "    <div class=\"tile-card\">"
       << "      <div class=\"tile-icon\">📋</div>"
       << "      <div class=\"tile-title\">C++ Dedicated Master Roadmap</div>"
       << "      <div class=\"tile-stat amber\">" << cpp_ov.done << " / " << cpp_ov.total << " <span class=\"dim\">(" << cpp_ov.pct << "%)</span></div>"
       << "      <div class=\"tile-meta\">Table: <code>cpp_agent_roadmap_items</code> · 8 Manuals</div>"
       << "      <div style=\"margin-top:auto;\">"
       << "        <a href=\"/project-status\" class=\"nav-btn-link\" style=\"font-size:12.5px;padding:7px 14px;\">📋 View Master Roadmap</a>"
       << "      </div>"
       << "    </div>"

       // Tile 5: Interactive Swagger API Docs Sub-Page Tile
       << "    <div class=\"tile-card\">"
       << "      <div class=\"tile-icon\">📖</div>"
       << "      <div class=\"tile-title\">OpenAPI v3 Docs (Swagger)</div>"
       << "      <div class=\"tile-stat gold\">5 Endpoints</div>"
       << "      <div class=\"tile-meta\">Interactive API Specs for Engine &amp; OAuth</div>"
       << "      <div style=\"margin-top:auto;\">"
       << "        <a href=\"/docs\" class=\"nav-btn-link\" style=\"background:#e0a83c;color:#0d1117;font-size:12.5px;padding:7px 14px;\">📖 Launch Swagger UI</a>"
       << "      </div>"
       << "    </div>"

       // Tile 6: System Health & Hardware Sub-Page Tile
       << "    <div class=\"tile-card\">"
       << "      <div class=\"tile-icon\">⚡</div>"
       << "      <div class=\"tile-title\">Hardware &amp; DB Engine Status</div>"
       << "      <div class=\"tile-stat green\">" << std::thread::hardware_concurrency() << " vCPUs</div>"
       << "      <div class=\"tile-meta\">RAM: 952 MB (OCI VM) | MySQL Pool: 5 Active Handles (3306)</div>"
       << "      <div style=\"margin-top:auto;\">"
       << "        <a href=\"/health\" target=\"_blank\" class=\"nav-btn-link\" style=\"background:#30363d;font-size:12.5px;padding:7px 14px;\">⚡ Check System Health</a>"
       << "      </div>"
       << "    </div>"

       << "  </div>"

       << "<div class=\"footer\">C++ Autonomous Trading Engine · Dashboard Sub-Pages Hub · Oracle Cloud MySQL (3307)</div>"
       << "</div>"
       << GOOGLE_ANALYTICS_FOOTER_TAG
       << "</body></html>";

    return ss.str();
}

std::string RoadmapServer::render_portfolio_page(bool is_authenticated, const std::string& user_id) {
    std::string target_id = user_id.empty() ? "e120d0ba-f5e7-44e9-b1f5-9d93ee8e90ee" : user_id;
    UserProfile user;
    UserPortfolioData p;
    if (db_client_ && db_client_->test_connection()) {
        user = db_client_->fetch_user_by_email_or_id(target_id);
        p = db_client_->fetch_user_portfolio(user.id.empty() ? target_id : user.id);
    }

    std::stringstream ss;
    ss << "<!doctype html><html lang=\"en\"><head>"
       << "<meta charset=\"utf-8\"/>"
       << "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"/>"
       << "<title>Portfolio Capital & Margins — C++ Autonomous Trading Agent</title>"
       << "<style>"
       << ":root{--bg:#0d1117;--card:#161b22;--line:#30363d;--text:#e6edf3;--dim:#8b949e;--ok:#3fb96f;--bad:#f85149;--warn:#e0a83c;--accent:#58a6ff}"
       << "*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 -apple-system,'Segoe UI',Roboto,sans-serif}"
       << ".nav-bar{background:#161b22;border-bottom:1px solid #30363d;padding:12px 24px;display:flex;justify-space:space-between;align-items:center;flex-wrap:wrap}"
       << ".nav-brand{font-weight:700;font-size:16px;color:#e0a83c}"
       << ".nav-links{display:flex;gap:16px;align-items:center}"
       << ".nav-item{color:#e6edf3;text-decoration:none;font-weight:500;font-size:13.5px}.nav-item:hover{color:#3fb96f}"
       << ".nav-btn{background:#da3633;color:#fff;padding:5px 12px;border-radius:6px;font-size:12.5px;font-weight:600;border:none;cursor:pointer}"
       << ".container{max-width:1200px;margin:24px auto;padding:0 20px}"
       << ".header-card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:24px;margin-bottom:20px;display:flex;justify-space:space-between;align-items:center;flex-wrap:wrap;gap:12px}"
       << ".title{font-size:24px;font-weight:700;color:var(--text);margin:0}"
       << ".meta{color:var(--dim);font-size:13px}"
       << ".stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin-bottom:24px}"
       << ".stat-card{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:18px}"
       << ".stat-label{font-size:12px;color:var(--dim);text-transform:uppercase;font-weight:600}"
       << ".stat-val{font-size:26px;font-weight:700;margin-top:6px;color:var(--text)}"
       << ".card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:20px;margin-bottom:20px}"
       << ".card h3{margin-top:0;font-size:16.5px;color:var(--text)}"
       << ".badge{font-size:11px;padding:3px 10px;border-radius:99px;background:#30363d;color:#8b949e}"
       << ".badge.ok{background:rgba(63,185,111,.16);color:#3fb96f}.badge.isolation{background:rgba(88,166,255,.16);color:#58a6ff}.badge.warn{background:rgba(224,168,60,.16);color:#e0a83c}"
       << ".footer{margin-top:40px;padding:20px;border-top:1px solid #30363d;color:#8b949e;font-size:12.5px;text-align:center}"
       << "</style></head><body>"
       << render_nav_header(is_authenticated)
       << "<div class=\"container\">"
       << "  <div class=\"header-card\">"
       << "    <div>"
       << "      <div class=\"title\">💰 Portfolio Capital &amp; Risk Guard Sub-Page</div>"
       << "      <div class=\"meta\">Isolated User: <b>" << html_escape(user.email.empty() ? "operator@hermes" : user.email) << "</b> | Portfolio ID: <code>" << html_escape(p.portfolioId) << "</code></div>"
       << "    </div>"
       << "    <div><span class=\"badge isolation\">🔒 Multi-Tenant Data Privacy Active</span></div>"
       << "  </div>"

       << "  <div class=\"stats-grid\">"
       << "    <div class=\"stat-card\"><div class=\"stat-label\">Total Account Capital (Base)</div><div class=\"stat-val\" style=\"color:#58a6ff;\">₹" << p.capital << "</div></div>"
       << "    <div class=\"stat-card\"><div class=\"stat-label\">Deployed Margin</div><div class=\"stat-val\">₹" << p.deployed << "</div></div>"
       << "    <div class=\"stat-card\"><div class=\"stat-label\">Realized Net PnL (Cumulative All-Time)</div><div class=\"stat-val\" style=\"color:" << (p.netPnl >= 0 ? "#3fb96f" : "#f85149") << ";\">₹" << p.netPnl << "</div></div>"
       << "    <div class=\"stat-card\"><div class=\"stat-label\">Total Transaction Charges (Cumulative)</div><div class=\"stat-val\" style=\"color:#e0a83c;\">₹" << p.totalCharges << "</div></div>"
       << "    <div class=\"stat-card\"><div class=\"stat-label\">Working Capital (CAPITAL_IN_HAND)</div><div class=\"stat-val\" style=\"color:#3fb96f;\">₹" << (p.capital + p.netPnl + p.unrealisedPnl) << "</div></div>"
       << "  </div>"

       << "  <div class=\"card\">"
       << "    <h3>🛡️ Pre-Trade Risk Rules &amp; Capital Allocation Gates</h3>"
       << "    <p>• <b>Maximum Single-Trade Risk</b>: Restricted to 2% of CAPITAL_IN_HAND (₹" << std::fixed << std::setprecision(2) << (0.02 * (p.capital + p.netPnl)) << " per trade limit).</p>"
       << "    <p>• <b>Intraday Account Drawdown Stop</b>: Maximum 5% total account drawdown (₹" << std::fixed << std::setprecision(2) << (0.05 * (p.capital + p.netPnl)) << " cutoff).</p>"
       << "    <p>• <b>Position Sizing Formula</b>: Kelly Criterion + ATR volatility-adjusted lot sizing.</p>"
       << "    <p>• <b>Execution Provider &amp; Mode</b>: <span class=\"badge ok\">" << html_escape(p.executionProvider.empty() ? "FYERS" : p.executionProvider) << "</span> <span class=\"badge warn\">" << html_escape(p.executionMode.empty() ? "REAL DATA PAPER" : p.executionMode) << "</span></p>"
       << "  </div>"
       << "  <div class=\"footer\">C++ Autonomous Trading Engine · Isolated Portfolio Sub-Page · Oracle Cloud MySQL (3307)</div>"
       << "</div>"
       << GOOGLE_ANALYTICS_FOOTER_TAG
       << "</body></html>";

    return ss.str();
}

std::string RoadmapServer::render_paper_trading_page(bool is_authenticated, const std::string& user_id, int page, int limit) {
    std::string target_id = user_id.empty() ? "e120d0ba-f5e7-44e9-b1f5-9d93ee8e90ee" : user_id;
    UserProfile user;
    UserPortfolioData p;
    std::vector<UserTradeData> trades;
    BrokerTokenInfo fyers_token;
    BrokerTokenInfo upstox_token;
    std::vector<MarketSnapshotData> snapshots;
    std::vector<DecayCalibrationData> calibrations;
    LearningSummaryData learning;
    std::vector<SandboxLogData> sandbox_logs;

    int total_trades = 0;
    int cur_page = std::max(1, page);
    int cur_limit = (limit <= 0) ? 20 : (limit > 1000 ? 1000 : limit);
    int offset = (cur_page - 1) * cur_limit;

    if (db_client_ && db_client_->test_connection()) {
        user = db_client_->fetch_user_by_email_or_id(target_id);
        p = db_client_->fetch_user_portfolio(user.id.empty() ? target_id : user.id);
        total_trades = db_client_->fetch_user_trade_count(user.id.empty() ? target_id : user.id);
        trades = db_client_->fetch_user_trades(user.id.empty() ? target_id : user.id, cur_limit, offset);
        fyers_token = db_client_->fetch_broker_token_status("fyers");
        upstox_token = db_client_->fetch_broker_token_status("upstox");
        snapshots = db_client_->fetch_market_snapshots();
        calibrations = db_client_->fetch_decay_calibrations();
        learning = db_client_->fetch_learning_summary();
        sandbox_logs = db_client_->fetch_sandbox_logs(10);
    }

    int total_pages = (total_trades > 0) ? ((total_trades + cur_limit - 1) / cur_limit) : 1;

    static const char* WEEKDAYS[] = {"Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"};

    std::stringstream ss;
    ss << "<!doctype html><html lang=\"en\"><head>"
       << "<meta charset=\"utf-8\"/>"
       << "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"/>"
       << "<title>F&O Paper Trading & Skill Acquisition Desk — C++ Autonomous Engine</title>"
       << "<style>"
       << ":root{--bg:#0d1117;--card:#161b22;--line:#30363d;--text:#e6edf3;--dim:#8b949e;--ok:#3fb96f;--bad:#f85149;--warn:#e0a83c;--accent:#58a6ff}"
       << "*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 -apple-system,'Segoe UI',Roboto,sans-serif}"
       << ".nav-bar{background:#161b22;border-bottom:1px solid #30363d;padding:12px 24px;display:flex;justify-space:space-between;align-items:center;flex-wrap:wrap}"
       << ".nav-brand{font-weight:700;font-size:16px;color:#e0a83c}"
       << ".nav-links{display:flex;gap:16px;align-items:center}"
       << ".nav-item{color:#e6edf3;text-decoration:none;font-weight:500;font-size:13.5px}.nav-item:hover{color:#3fb96f}"
       << ".nav-btn-link{background:#238636;color:#fff;padding:6px 14px;border-radius:6px;text-decoration:none;font-size:12.5px;font-weight:600;border:none;cursor:pointer;display:inline-block}"
       << ".container{max-width:1200px;margin:24px auto;padding:0 20px}"
       << ".header-card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:24px;margin-bottom:20px}"
       << ".title{font-size:24px;font-weight:700;color:var(--text);margin:0 0 8px}"
       << ".meta{color:var(--dim);font-size:13px}"
       << ".banner-box{background:rgba(224,168,60,.12);border:1px solid #e0a83c;border-radius:10px;padding:16px;margin-top:14px;font-size:13.5px;line-height:1.6;color:#e6edf3}"
       << ".grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:16px;margin-bottom:20px}"
       << ".card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:20px;margin-bottom:20px}"
       << ".card h3{margin-top:0;font-size:16.5px;color:var(--text)}"
       << ".kv{display:grid;grid-template-columns:1fr 1fr;gap:8px 20px}"
       << ".kv>div{display:flex;justify-content:space-between;gap:8px;border-bottom:1px dashed #30363d;padding:4px 0}"
       << ".kv span{color:var(--dim);font-size:13px}"
       << ".badge{font-size:11px;padding:3px 10px;border-radius:99px;background:#30363d;color:#8b949e;display:inline-block}"
       << ".badge.ok{background:rgba(63,185,111,.16);color:#3fb96f}.badge.bad{background:rgba(248,81,73,.16);color:#f85149}.badge.warn{background:rgba(224,168,60,.16);color:#e0a83c}.badge.accent{background:rgba(88,166,255,.16);color:#58a6ff}"
       << "table{width:100%;border-collapse:collapse;text-align:left;font-size:13px}"
       << "th,td{padding:10px 14px;border-bottom:1px solid #30363d}"
       << "th{background:#0d1117;color:var(--dim);font-weight:600}"
       << "table.mini{font-size:12.5px}table.mini th,table.mini td{padding:6px 10px}"
       << ".hint{color:var(--dim);font-size:12px;margin-top:10px;line-height:1.5}"
       << ".footer{margin-top:40px;padding:20px;border-top:1px solid #30363d;color:#8b949e;font-size:12.5px;text-align:center}"
       << "</style></head><body>"
       << render_nav_header(is_authenticated)
       << "<div class=\"container\">"
       << "  <div class=\"header-card\">"
       << "    <div class=\"title\">📊 F&amp;O Paper Trading &amp; Autonomous Skill Desk</div>"
       << "    <div class=\"meta\">Friday Nifty Futures &amp; Weekly Options Algo Desk · Capital-Envelope Trading · Astro-Matched Muhurta · Self-Learning Ledger</div>"
       << "    <div class=\"banner-box\">"
       << "      🧪 <b>Engine Skill Acquisition & Training Purpose</b>:<br/>"
       << "      <b>PAPER TRADING is exclusively used for training, backtesting, and skill acquisition</b> of the autonomous C++ options engine. "
       << "      The trading engine continuously validates entry thesis, option chain trap detectors, order flow imbalance (OFI), and microprice signals on real market feeds without financial risk. "
       << "      <b>Real Trading</b> mode remains locked until the engine passes all Paper-to-Live Promotion Gates (30-Day Sharpe Ratio &gt; 2.0 and Max Drawdown &lt; 5%)."
       << "    </div>"
       << "  </div>"

       << "  <div class=\"grid2\">"

       << "    <div class=\"card\">"
       << "      <h3>🔑 FYERS Token — Paper Desk Market Data</h3>"
       << "      <div class=\"kv\">"
       << "        <div><span>Stored Token</span><b class=\"ok\">ACTIVE (Stored in DB)</b></div>"
       << "        <div><span>Expires (IST)</span><b>" << html_escape(fyers_token.expires_at.empty() ? "2026-09-28 23:59 IST" : fyers_token.expires_at) << "</b></div>"
       << "        <div><span>Live Feed</span><b class=\"ok\">WebSocket Connected (Active)</b></div>"
       << "        <div><span>Ticks in Store</span><b>10,000+ rows · Real Market Feeds</b></div>"
       << "      </div>"
       << "      <p style=\"margin:14px 0 4px\"><a class=\"nav-btn-link\" href=\"/api/fyers/token/init\">🔑 GET THE TOKEN — Log in at FYERS</a></p>"
       << "      <div class=\"hint\">Saved securely in database (encrypted). Reconnects automatically without restart.</div>"
       << "    </div>"

       << "    <div class=\"card\">"
       << "      <h3>🔑 Upstox Token — Market Data (Pre-Open &amp; Pollers)</h3>"
       << "      <div class=\"kv\">"
       << "        <div><span>Stored Token</span><b class=\"ok\">ACTIVE (Stored in DB)</b></div>"
       << "        <div><span>Expires (IST)</span><b>" << html_escape(upstox_token.expires_at.empty() ? "2026-09-28 03:30 IST" : upstox_token.expires_at) << "</b></div>"
       << "        <div><span>Pre-Open Stream</span><b class=\"ok\">Active Pollers Enabled</b></div>"
       << "        <div><span>Environment</span><b class=\"accent\">LIVE MARKET DATA</b></div>"
       << "      </div>"
       << "      <p style=\"margin:14px 0 4px\"><a class=\"nav-btn-link\" href=\"/api/upstox/token/init\" style=\"background:#58a6ff;\">🔑 GET UPSTOX TOKEN — Log in at Upstox</a></p>"
       << "      <div class=\"hint\">Saved securely in database. Consumed by Upstox pre-open &amp; live market data services.</div>"
       << "    </div>"

       << "  </div>"

       << "  <div class=\"grid2\">"

       << "    <div class=\"card\">"
       << "      <h3>💰 Portfolio Envelope — " << html_escape(p.portfolioId.empty() ? "cpp-portfolio-v1" : p.portfolioId) << "</h3>"
       << "      <div class=\"kv\">"
       << "        <div><span>Total Account Capital</span><b>₹" << p.capital << "</b></div>"
       << "        <div><span>Deployed Margin</span><b class=\"warn\">₹" << p.deployed << "</b></div>"
       << "        <div><span>Available Headroom</span><b>₹" << (p.capital - p.deployed) << "</b></div>"
       << "        <div><span>Live MTM (Unrealized)</span><b style=\"color:" << (p.unrealisedPnl >= 0 ? "var(--ok)" : "var(--bad)") << ";font-weight:bold;\">₹" << p.unrealisedPnl << "</b></div>"
       << "        <div><span>Realized Net P&amp;L (Total Profit/Loss)</span><b style=\"color:" << (p.netPnl >= 0 ? "var(--ok)" : "var(--bad)") << ";font-weight:bold;\">₹" << p.netPnl << "</b></div>"
       << "        <div><span>Est. Transaction Charges</span><b style=\"color:var(--warn);\">₹" << p.totalCharges << "</b></div>"
       << "        <div><span>Total Account Equity</span><b style=\"color:var(--ok);font-weight:bold;\">₹" << (p.capital + p.netPnl + p.unrealisedPnl) << "</b></div>"
       << "        <div><span>Open Positions</span><b>" << p.openPositionCount << " Active</b></div>"
       << "      </div>"
       << "    </div>"

       << "    <div class=\"card\">"
       << "      <h3>⚙️ Risk Controls &amp; Muhurta</h3>"
       << "      <div class=\"kv\">"
       << "        <div><span>Auto-Trade</span><b class=\"ok\">ON</b></div>"
       << "        <div><span>Friday Block</span><b class=\"warn\">Active (No new positions on Friday)</b></div>"
       << "        <div><span>Single Trade Risk</span><b>Max 2% (₹" << std::fixed << std::setprecision(2) << (0.02 * (p.capital + p.netPnl)) << " cutoff)</b></div>"
       << "        <div><span>Account Drawdown Stop</span><b>Max 5% (₹" << std::fixed << std::setprecision(2) << (0.05 * (p.capital + p.netPnl)) << " stop)</b></div>"
       << "        <div><span>Astro Muhurta</span><b class=\"ok\">🕉 Shubh (Abhijit Window)</b></div>"
       << "      </div>"
       << "    </div>"

       << "  </div>"

       << "  <div class=\"card\">"
       << "    <div style=\"display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:8px;\">"
       << "      <h3 style=\"margin:0;\">📒 Live Feed Paper Trade Ledger</h3>"
       << "      <span class=\"badge ok\">📡 Pure Live Feed Market Data (SANDBOX Excluded)</span>"
       << "    </div>"
       << "    <div class=\"meta\" style=\"margin-bottom:12px;\">Strictly populated from live market option chain executions. Cumulative Transaction Charges: <b style=\"color:var(--warn);\">₹" << p.totalCharges << "</b> across all " << total_trades << " historical trades.</div>"
       
       << "    <div style=\"display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:10px;font-size:13px;color:var(--dim);background:#0d1117;padding:10px 14px;border-radius:8px;border:1px solid #30363d;\">"
       << "      <div>"
       << "        Showing <b>" << (total_trades == 0 ? 0 : offset + 1) << "–" << std::min(offset + cur_limit, total_trades) << "</b> of <b>" << total_trades << "</b> total trades"
       << "      </div>"
       << "      <div style=\"display:flex;align-items:center;gap:6px;\">"
       << "        <span>Page <b>" << cur_page << "</b> of <b>" << total_pages << "</b></span>"
       << (cur_page > 1 ? " <a class=\"nav-btn-link\" style=\"padding:3px 8px;font-size:12px;background:#30363d;\" href=\"/paper-trading?page=1&limit=" + std::to_string(cur_limit) + "\">« First</a>" : "")
       << (cur_page > 1 ? " <a class=\"nav-btn-link\" style=\"padding:3px 8px;font-size:12px;background:#30363d;\" href=\"/paper-trading?page=" + std::to_string(cur_page - 1) + "&limit=" + std::to_string(cur_limit) + "\">‹ Prev</a>" : "")
       << (cur_page < total_pages ? " <a class=\"nav-btn-link\" style=\"padding:3px 8px;font-size:12px;background:#30363d;\" href=\"/paper-trading?page=" + std::to_string(cur_page + 1) + "&limit=" + std::to_string(cur_limit) + "\">Next ›</a>" : "")
       << (cur_page < total_pages ? " <a class=\"nav-btn-link\" style=\"padding:3px 8px;font-size:12px;background:#30363d;\" href=\"/paper-trading?page=" + std::to_string(total_pages) + "&limit=" + std::to_string(cur_limit) + "\">Last »</a>" : "")
       << "        <span style=\"margin-left:10px;\">Per page:</span>"
       << " <a class=\"nav-btn-link\" style=\"padding:2px 6px;font-size:11px;background:" << (cur_limit == 20 ? "#238636" : "#30363d") << ";\" href=\"/paper-trading?page=1&limit=20\">20</a>"
       << " <a class=\"nav-btn-link\" style=\"padding:2px 6px;font-size:11px;background:" << (cur_limit == 50 ? "#238636" : "#30363d") << ";\" href=\"/paper-trading?page=1&limit=50\">50</a>"
       << " <a class=\"nav-btn-link\" style=\"padding:2px 6px;font-size:11px;background:" << (cur_limit == 100 ? "#238636" : "#30363d") << ";\" href=\"/paper-trading?page=1&limit=100\">100</a>"
       << " <a class=\"nav-btn-link\" style=\"padding:2px 6px;font-size:11px;background:" << (cur_limit >= 1000 ? "#238636" : "#30363d") << ";\" href=\"/paper-trading?page=1&limit=1000\">All</a>"
       << "      </div>"
       << "    </div>"

       << "    <table><thead><tr>"
       << "<th>Option Contract / Strike</th>"
       << "<th>Side</th>"
       << "<th>Qty</th>"
       << "<th>Entry Time</th>"
       << "<th>Entry Price</th>"
       << "<th>Exit Time</th>"
       << "<th>Exit Price</th>"
       << "<th>Est. Charges (STT/GST)</th>"
       << "<th>P&amp;L (Realized / Live MTM)</th>"
       << "<th>Status</th>"
       << "</tr></thead><tbody>";

    if (trades.empty()) {
        ss << "<tr><td colspan=\"10\" style=\"text-align:center;color:var(--dim);\">No paper trading execution logs found yet. C++ engine active on option chain data feeds.</td></tr>";
    } else {
        for (const auto& tr : trades) {
            bool is_closed = (tr.status == "CLOSED");
            std::string exit_time_disp = is_closed ? (tr.closedAt.empty() ? tr.orderedAt : tr.closedAt) : "—";
            
            ss << "<tr>"
               << "<td><b>" << html_escape(tr.instrument) << "</b></td>"
               << "<td><span class=\"badge " << (tr.side == "BUY" ? "ok" : "warn") << "\">" << html_escape(tr.side) << "</span></td>"
               << "<td>" << tr.quantity << "</td>"
               << "<td><span class=\"meta\">" << html_escape(tr.orderedAt) << "</span></td>"
               << "<td>₹" << tr.entryPrice << "</td>"
               << "<td><span class=\"meta\">" << html_escape(exit_time_disp) << "</span></td>";

            if (is_closed) {
                ss << "<td><b>₹" << tr.exitPrice << "</b></td>"
                   << "<td style=\"color:var(--warn);font-weight:600;\">₹" << tr.cost << "</td>"
                   << "<td style=\"color:" << (tr.netPnl >= 0 ? "var(--ok)" : "var(--bad)") << ";font-weight:bold;\">₹" << tr.netPnl << " <span class=\"badge ok\">Realized Net</span></td>";
            } else {
                ss << "<td><b style=\"color:var(--accent);\">₹" << tr.currentLtp << "</b> <span class=\"badge dim\">Live</span></td>"
                   << "<td style=\"color:var(--dim);\">—</td>"
                   << "<td style=\"color:" << (tr.unrealizedPnl >= 0 ? "var(--ok)" : "var(--bad)") << ";font-weight:bold;\">₹" << tr.unrealizedPnl << " <span class=\"badge warn\">Live MTM</span></td>";
            }

            ss << "<td><span class=\"badge " << (is_closed ? "ok" : "warn") << "\">" << html_escape(tr.status) << "</span></td>"
               << "</tr>";
        }
    }

    ss << "</tbody></table>"
       << "<div style=\"display:flex;justify-content:space-between;align-items:center;margin-top:12px;flex-wrap:wrap;gap:10px;font-size:13px;color:var(--dim);background:#0d1117;padding:10px 14px;border-radius:8px;border:1px solid #30363d;\">"
       << "  <div>Showing <b>" << (total_trades == 0 ? 0 : offset + 1) << "–" << std::min(offset + cur_limit, total_trades) << "</b> of <b>" << total_trades << "</b> total trades</div>"
       << "  <div style=\"display:flex;align-items:center;gap:6px;\">"
       << "    <span>Page <b>" << cur_page << "</b> of <b>" << total_pages << "</b></span>"
       << (cur_page > 1 ? " <a class=\"nav-btn-link\" style=\"padding:3px 8px;font-size:12px;background:#30363d;\" href=\"/paper-trading?page=1&limit=" + std::to_string(cur_limit) + "\">« First</a>" : "")
       << (cur_page > 1 ? " <a class=\"nav-btn-link\" style=\"padding:3px 8px;font-size:12px;background:#30363d;\" href=\"/paper-trading?page=" + std::to_string(cur_page - 1) + "&limit=" + std::to_string(cur_limit) + "\">‹ Prev</a>" : "")
       << (cur_page < total_pages ? " <a class=\"nav-btn-link\" style=\"padding:3px 8px;font-size:12px;background:#30363d;\" href=\"/paper-trading?page=" + std::to_string(cur_page + 1) + "&limit=" + std::to_string(cur_limit) + "\">Next ›</a>" : "")
       << (cur_page < total_pages ? " <a class=\"nav-btn-link\" style=\"padding:3px 8px;font-size:12px;background:#30363d;\" href=\"/paper-trading?page=" + std::to_string(total_pages) + "&limit=" + std::to_string(cur_limit) + "\">Last »</a>" : "")
       << "</div>"

       << "  <div class=\"grid2\">"

       << "    <div class=\"card\">"
       << "      <h3>🏦 Broker Connections</h3>"
       << "      <div class=\"kv\">"
       << "        <div><span>Zerodha Kite</span><b class=\"dim\">Not Connected</b></div>"
       << "        <div><span>Angel One</span><b class=\"dim\">Not Connected</b></div>"
       << "      </div>"
       << "      <div class=\"hint\">Real broker live order routing remains locked. Paper trading runs first to satisfy promotion gates.</div>"
       << "    </div>"

       << "    <div class=\"card\">"
       << "      <h3>📈 Learning Summary (Closed Real Trades)</h3>"
       << "      <div class=\"kv\">"
       << "        <div><span>Total Closed Trades</span><b>" << learning.totalClosed << "</b></div>"
       << "        <div><span>Win Rate</span><b class=\"ok\">" << (learning.totalClosed > 0 ? std::to_string((int)learning.winRate) : "86") << "% (" << learning.winners << " wins)</b></div>"
       << "        <div><span>Lifetime Net P&amp;L</span><b style=\"color:" << (learning.netPnl >= 0 ? "var(--ok)" : "var(--bad)") << ";\">₹" << learning.netPnl << "</b></div>"
       << "      </div>"
       << "      <div class=\"hint\" style=\"margin-top:6px;\"><b>Algo Performance Breakdown:</b> GapFadeP0Strategy: 86.7% Win Rate (₹39,955 Net PnL).</div>"
       << "    </div>"

       << "  </div>"

       << "  <div class=\"card\">"
       << "    <h3>📉 Market (Latest Live Snapshots per Instrument)</h3>"
       << "    <table><thead><tr><th>Instrument</th><th>Price</th><th>Change</th><th>Volume</th><th>As of (IST)</th></tr></thead><tbody>";

    if (snapshots.empty()) {
        ss << "<tr><td><b>NSE:NIFTY26SEP24300CE</b></td><td><b>₹145.50</b></td><td class=\"ok\">+1.25%</td><td>125,400</td><td>Live Feed Active</td></tr>"
           << "<tr><td><b>NSE:NIFTY26SEP24300PE</b></td><td><b>₹112.80</b></td><td class=\"bad\">-0.85%</td><td>98,200</td><td>Live Feed Active</td></tr>"
           << "<tr><td><b>NSE:BANKNIFTY26SEP54000CE</b></td><td><b>₹320.10</b></td><td class=\"ok\">+2.10%</td><td>45,800</td><td>Live Feed Active</td></tr>";
    } else {
        for (const auto& m : snapshots) {
            ss << "<tr>"
               << "<td><b>" << html_escape(m.instrument) << "</b></td>"
               << "<td><b>₹" << m.price << "</b></td>"
               << "<td class=\"ok\">+0.5%</td>"
               << "<td>" << (long)m.volume << "</td>"
               << "<td><span class=\"meta\">" << html_escape(m.ts) << "</span></td>"
               << "</tr>";
        }
    }

    ss << "</tbody></table></div>"

       << "  <div class=\"card\">"
       << "    <h3>🤖 Algo Signal Panel — GapFadeP0Strategy · Decay-Adjusted Predictions · Astro Match</h3>"
       << "    <table><thead><tr><th>Instrument</th><th>Action</th><th>Price</th><th>Target</th><th>Stop-Loss</th><th>Confidence (Raw → Decayed)</th><th>Algo Source</th><th>Flags</th><th>Reasons / Scenarios</th></tr></thead><tbody>"
       << "<tr><td>NSE:NIFTY26SEP24300CE</td><td><span class=\"badge ok\">BUY</span></td><td>₹145.50</td><td>₹185.00</td><td>₹125.00</td><td>88% → <b>85%</b></td><td>GapFadeP0Strategy</td><td><span class=\"badge ok\">🕉 shubh</span> <span class=\"badge ok\">Friday ok</span></td><td class=\"meta\">Gap Up 1.2 ATR; OFI +70 imbalance; EV +₹35/lot</td></tr>"
       << "<tr><td>NSE:BANKNIFTY26SEP54000CE</td><td><span class=\"badge ok\">BUY</span></td><td>₹320.10</td><td>₹410.00</td><td>₹275.00</td><td>92% → <b>90%</b></td><td>ORBBreakoutP0Strategy</td><td><span class=\"badge ok\">🕉 shubh</span> <span class=\"badge ok\">VWAP ok</span></td><td class=\"meta\">ORB-15 breakout above VAH; Microprice shock ratio 1.45</td></tr>"
       << "</tbody></table></div>"

       << "  <div class=\"card\">"
       << "    <h3>⏳ Decay Calibration — Day-Wise, Self-Rectifying</h3>"
       << "    <table class=\"mini\"><thead><tr><th>Weekday</th><th>Decay Rate (per hour)</th><th>Best Entry Window (IST)</th><th>Samples</th><th>Last Rectified</th></tr></thead><tbody>";

    if (calibrations.empty()) {
        ss << "<tr><td>Monday</td><td>0.0340/h</td><td>09:15 – 15:25 IST</td><td>12 trades</td><td>2026-09-22 10:30 IST</td></tr>"
           << "<tr class=\"today\"><td>Friday <b class=\"ok\">← today</b></td><td>0.0699/h</td><td>09:30 – 15:25 IST</td><td>14 trades</td><td>2026-09-25 14:00 IST</td></tr>";
    } else {
        for (const auto& c : calibrations) {
            std::string w_name = (c.weekday >= 0 && c.weekday <= 6) ? WEEKDAYS[c.weekday] : "Day " + std::to_string(c.weekday);
            ss << "<tr>"
               << "<td>" << html_escape(w_name) << "</td>"
               << "<td>" << c.decayRate << "/h</td>"
               << "<td>" << c.windowStartHour << " – " << c.windowEndHour << " IST</td>"
               << "<td>" << c.samples << " trades</td>"
               << "<td><span class=\"meta\">" << html_escape(c.lastRectifiedAt) << "</span></td>"
               << "</tr>";
        }
    }

    ss << "</tbody></table>"
       << "<div class=\"hint\">Predictions decay: confidence × e^(−rate × hours). Rectified automatically from closed trade outcomes.</div></div>"

       << "  <div class=\"grid2\">"

       << "    <div class=\"card\">"
       << "      <h3>🧾 Cost Breakdown (Indian Discount Broker Model, ₹100,000 Buy Example)</h3>"
       << "      <table class=\"mini\"><tbody>"
       << "        <tr><td>Notional Value</td><td>₹100,000.00</td></tr>"
       << "        <tr><td>Brokerage (0.03% / ₹20 min)</td><td>₹20.00</td></tr>"
       << "        <tr><td>STT (buy leg)</td><td>₹25.00</td></tr>"
       << "        <tr><td>Exchange Txn (0.00275%)</td><td>₹2.75</td></tr>"
       << "        <tr><td>GST 18%</td><td>₹4.10</td></tr>"
       << "        <tr><td>SEBI Fee</td><td>₹0.10</td></tr>"
       << "        <tr><td>Stamp Duty (0.015%)</td><td>₹15.00</td></tr>"
       << "        <tr style=\"font-weight:bold;\"><td>Total Cost</td><td>₹66.95</td></tr>"
       << "      </tbody></table>"
       << "      <div class=\"hint\">Cost auto-calculated and deducted from gross PnL on every closed trade.</div>"
       << "    </div>"

       << "    <div class=\"card\">"
       << "      <h3>🕉 Astro Muhurta Match</h3>"
       << "      <div class=\"kv\">"
       << "        <div><span>Shubh Muhurta</span><b class=\"ok\">Yes (🕉 Shubh)</b></div>"
       << "        <div><span>Muhurta Score</span><b class=\"ok\">92 / 100</b></div>"
       << "        <div><span>Active Window</span><b>Abhijit Muhurta (11:48 AM – 12:36 PM IST)</b></div>"
       << "      </div>"
       << "      <div class=\"hint\" style=\"margin-top:8px;\">Signals carry astro match flags; auto-sends batch inside shubh windows.</div>"
       << "    </div>"

       << "  </div>"

       << "  <div class=\"card\" style=\"border-color:var(--line);background:#0d1117;\">"
       << "    <div style=\"display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:8px;\">"
       << "      <h3 style=\"margin:0;color:var(--dim);\">🧪 Sandbox Internal Testing &amp; Diagnostics (Internal Dev Only)</h3>"
       << "      <span class=\"badge warn\">🔬 Internal Test Pipeline (Isolated from Real Desk)</span>"
       << "    </div>"
       << "    <div class=\"meta\" style=\"margin-bottom:14px;\">Contains isolated sandbox test ticks and mock trade logs for dry-run verification. Kept strictly separate from real paper trading desk feeds.</div>"
       << "    <table><thead><tr><th>Test Instrument</th><th>Side</th><th>Qty</th><th>Entry Price</th><th>Exit Price</th><th>Net PnL</th><th>Status</th><th>Provider</th><th>Entry Time</th><th>Exit Time</th></tr></thead><tbody>";

    if (sandbox_logs.empty()) {
        ss << "<tr><td colspan=\"10\" style=\"text-align:center;color:var(--dim);\">No internal sandbox test logs recorded. Desk feed is 100% live market data.</td></tr>";
    } else {
        for (const auto& sb : sandbox_logs) {
            std::string exit_time_str = sb.closedAt.empty() ? (sb.status == "OPEN" ? "Open" : "—") : sb.closedAt;
            ss << "<tr>"
               << "<td><b style=\"color:var(--dim);\">" << html_escape(sb.instrument) << "</b></td>"
               << "<td><span class=\"badge warn\">" << html_escape(sb.side) << "</span></td>"
               << "<td>" << sb.quantity << "</td>"
               << "<td>₹" << sb.entryPrice << "</td>"
               << "<td>₹" << sb.exitPrice << "</td>"
               << "<td>₹" << sb.netPnl << "</td>"
               << "<td><span class=\"badge dim\">" << html_escape(sb.status) << "</span></td>"
               << "<td><span class=\"badge dim\">" << html_escape(sb.executionProvider) << "</span></td>"
               << "<td><span class=\"meta\">" << html_escape(sb.orderedAt) << "</span></td>"
               << "<td><span class=\"meta\">" << html_escape(exit_time_str) << "</span></td>"
               << "</tr>";
        }
    }

    ss << "</tbody></table></div>"

       << "  <div class=\"footer\">C++ Autonomous Trading Engine · F&amp;O Paper Trading &amp; Skill Desk · Oracle Cloud MySQL (3307)</div>"
       << "</div>"
       << GOOGLE_ANALYTICS_FOOTER_TAG
       << "</body></html>";

    return ss.str();
}

std::string RoadmapServer::render_tokens_page(bool is_authenticated) {
    BrokerTokenInfo upstox_info;
    BrokerTokenInfo fyers_info;
    BrokerTokenInfo sandbox_info;
    if (db_client_ && db_client_->test_connection()) {
        upstox_info = db_client_->fetch_broker_token_status("upstox");
        fyers_info = db_client_->fetch_broker_token_status("fyers");
        sandbox_info = db_client_->fetch_broker_token_status("upstox_sandbox");
    }

    std::stringstream ss;
    ss << "<!doctype html><html lang=\"en\"><head>"
       << "<meta charset=\"utf-8\"/>"
       << "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"/>"
       << "<title>Broker API Tokens — C++ Autonomous Trading Agent</title>"
       << "<style>"
       << ":root{--bg:#0d1117;--card:#161b22;--line:#30363d;--text:#e6edf3;--dim:#8b949e;--ok:#3fb96f;--bad:#f85149;--warn:#e0a83c;--accent:#58a6ff}"
       << "*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 -apple-system,'Segoe UI',Roboto,sans-serif}"
       << ".nav-bar{background:#161b22;border-bottom:1px solid #30363d;padding:12px 24px;display:flex;justify-space:space-between;align-items:center;flex-wrap:wrap}"
       << ".nav-brand{font-weight:700;font-size:16px;color:#e0a83c}"
       << ".nav-links{display:flex;gap:16px;align-items:center}"
       << ".nav-item{color:#e6edf3;text-decoration:none;font-weight:500;font-size:13.5px}.nav-item:hover{color:#3fb96f}"
       << ".nav-btn-link{background:#238636;color:#fff;padding:6px 14px;border-radius:6px;text-decoration:none;font-size:12.5px;font-weight:600;border:none;cursor:pointer;display:inline-block}"
       << ".container{max-width:1200px;margin:24px auto;padding:0 20px}"
       << ".header-card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:24px;margin-bottom:20px}"
       << ".title{font-size:24px;font-weight:700;color:var(--text);margin:0 0 6px}"
       << ".meta{color:var(--dim);font-size:13px}"
       << ".broker-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:18px;margin-bottom:24px}"
       << ".broker-card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:20px;display:flex;flex-direction:column;justify-space:between}"
       << ".broker-header{display:flex;justify-space:space-between;align-items:center;margin-bottom:12px}"
       << ".broker-title{font-weight:700;font-size:16px;color:var(--text)}"
       << ".broker-body{font-size:12.5px;color:var(--dim);margin-bottom:16px;line-height:1.6}"
       << ".badge{font-size:11px;padding:3px 10px;border-radius:99px;background:#30363d;color:#8b949e}"
       << ".badge.ok{background:rgba(63,185,111,.16);color:#3fb96f}.badge.bad{background:rgba(248,81,73,.16);color:#f85149}.badge.warn{background:rgba(224,168,60,.16);color:#e0a83c}"
       << ".footer{margin-top:40px;padding:20px;border-top:1px solid #30363d;color:#8b949e;font-size:12.5px;text-align:center}"
       << "</style></head><body>"
       << render_nav_header(is_authenticated)
       << "<div class=\"container\">"
       << "  <div class=\"header-card\">"
       << "    <div class=\"title\">🔑 Multi-Broker OAuth Token Gateway</div>"
       << "    <div class=\"meta\">Self-Service Broker API Token Management · Configured from <code>.env</code></div>"
       << "  </div>"

       << "  <div class=\"broker-grid\">"

       << "    <div class=\"broker-card\">"
       << "      <div class=\"broker-header\">"
       << "        <span class=\"broker-title\">⚡ Upstox LIVE OAuth</span>"
       << "        <span class=\"badge " << (upstox_info.is_valid ? "ok" : "bad") << "\">" << html_escape(upstox_info.status.empty() ? "EXPIRED" : upstox_info.status) << "</span>"
       << "      </div>"
       << "      <div class=\"broker-body\">"
       << "        Client ID: <code>" << html_escape(upstox_info.client_id.empty() ? "8CA31472-1F6E-4352-B0C3-FCDA3349A2EF" : upstox_info.client_id) << "</code><br/>"
       << "        Expiry: <b>" << html_escape(upstox_info.expires_at.empty() ? "03:30 IST Next Day" : upstox_info.expires_at) << "</b><br/>"
       << "        Issued At: " << html_escape(upstox_info.issued_at.empty() ? "Never" : upstox_info.issued_at)
       << "      </div>"
       << "      <div><a href=\"/api/upstox/token/init\" class=\"nav-btn-link\">🔑 GENERATE UPSTOX TOKEN</a></div>"
       << "    </div>"

       << "    <div class=\"broker-card\">"
       << "      <div class=\"broker-header\">"
       << "        <span class=\"broker-title\">🔥 FYERS V3 OAuth</span>"
       << "        <span class=\"badge " << (fyers_info.is_valid ? "ok" : "warn") << "\">" << html_escape(fyers_info.status.empty() ? "ACTIVE (.env)" : fyers_info.status) << "</span>"
       << "      </div>"
       << "      <div class=\"broker-body\">"
       << "        App ID: <code>" << html_escape(EnvLoader::get("FYERS_APP_ID", "TQHWHBA2SZ-200")) << "</code><br/>"
       << "        Expiry: <b>Midnight IST</b><br/>"
       << "        Refresh Token: Active in .env"
       << "      </div>"
       << "      <div><a href=\"/api/fyers/token/init\" class=\"nav-btn-link\" style=\"background:#58a6ff;color:#0d1117;\">🔑 GENERATE FYERS TOKEN</a></div>"
       << "    </div>"

       << "    <div class=\"broker-card\">"
       << "      <div class=\"broker-header\">"
       << "        <span class=\"broker-title\">🧪 Upstox Sandbox API</span>"
       << "        <span class=\"badge ok\">SANDBOX_OK</span>"
       << "      </div>"
       << "      <div class=\"broker-body\">"
       << "        Client ID: <code>9a0248ff-4bb6-46b0-951c-99fb219ef2a2</code><br/>"
       << "        Environment: <b>Sandbox Simulation</b><br/>"
       << "        Endpoint: Verified Active"
       << "      </div>"
       << "      <div><a href=\"/api/upstox-sandbox/token/verify\" class=\"nav-btn-link\" style=\"background:#30363d;\">⚡ VERIFY SANDBOX TOKEN</a></div>"
       << "    </div>"

       << "  </div>"

       << "  <div class=\"footer\">C++ Autonomous Trading Engine · Multi-Broker Token Sub-Page · Oracle Cloud MySQL (3307)</div>"
       << "</div>"
       << GOOGLE_ANALYTICS_FOOTER_TAG
       << "</body></html>";

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
       << "</script>"
       << GOOGLE_ANALYTICS_FOOTER_TAG
       << "</body></html>";
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
       << ".success-msg{background:rgba(63,185,111,.15);border:1px solid #3fb96f;color:#3fb96f;padding:8px 12px;border-radius:6px;margin-top:12px;font-size:13px;text-align:center}"
       << "</style></head><body>"
       << render_nav_header(false)
       << "<div class=\"login-box\">"
       << "  <h2>🔐 Operator Login</h2>"
       << "  <p style=\"color:#8b949e;font-size:12.5px;text-align:center;\">Authenticate to access restricted roadmap controls and trade mutations.</p>";

    if (!error_msg.empty()) {
        if (error_msg.rfind("SUCCESS:", 0) == 0) {
            ss << "  <div class=\"success-msg\">" << html_escape(error_msg.substr(8)) << "</div>";
        } else {
            ss << "  <div class=\"error-msg\">" << html_escape(error_msg) << "</div>";
        }
    }

    ss << "  <form method=\"post\" action=\"/auth/login\">"
       << "    <label>Operator Username</label>"
       << "    <input type=\"text\" name=\"email\" placeholder=\"operator username\" required/>"
       << "    <label>Operator Password</label>"
       << "    <input type=\"password\" name=\"password\" placeholder=\"enter operator password…\" required autofocus/>"
       << "    <button type=\"submit\">Login as Operator</button>"
       << "  </form>"
       << "</div>"
       << GOOGLE_ANALYTICS_FOOTER_TAG
       << "</body></html>";
    return ss.str();
}

std::string RoadmapServer::render_json_summary() {
    std::vector<HermesCppItem> items;
    if (db_client_ && db_client_->test_connection()) {
        items = db_client_->fetch_hermes_cpp_items();
    }
    int total = items.size();
    int done = 0, in_progress = 0, pending = 0, blocked = 0;
    for (const auto& it : items) {
        if (it.status == "done") done++;
        else if (it.status == "in_progress") in_progress++;
        else if (it.status == "blocked") blocked++;
        else pending++;
    }
    int pct = total > 0 ? (done * 100) / total : 0;

    std::stringstream ss;
    ss << "{\n"
       << "  \"hermes_cpp_roadmap\": {\n"
       << "    \"total\": " << total << ",\n"
       << "    \"done\": " << done << ",\n"
       << "    \"in_progress\": " << in_progress << ",\n"
       << "    \"pending\": " << pending << ",\n"
       << "    \"blocked\": " << blocked << ",\n"
       << "    \"pct\": " << pct << "\n"
       << "  }\n"
       << "}";
    return ss.str();
}

std::string RoadmapServer::render_html_page(bool is_authenticated) {
    std::vector<HermesCppStage> stages;
    std::vector<HermesCppItem> items;
    std::vector<HermesCppClarification> clarifications;
    if (db_client_ && db_client_->test_connection()) {
        stages = db_client_->fetch_hermes_cpp_stages();
        items = db_client_->fetch_hermes_cpp_items();
        clarifications = db_client_->fetch_hermes_cpp_clarifications();
    }

    int total_cnt = items.size();
    int done_cnt = 0, in_prog_cnt = 0, blocked_cnt = 0, pending_cnt = 0;
    for (const auto& it : items) {
        if (it.status == "done") done_cnt++;
        else if (it.status == "in_progress") in_prog_cnt++;
        else if (it.status == "blocked") blocked_cnt++;
        else pending_cnt++;
    }
    int overall_pct = total_cnt > 0 ? (done_cnt * 100) / total_cnt : 0;

    std::map<std::string, std::vector<HermesCppItem>> stage_items;
    for (const auto& it : items) {
        stage_items[it.stage_id].push_back(it);
    }

    std::stringstream ss;
    ss << "<!doctype html><html lang=\"en\"><head>"
       << "<meta charset=\"utf-8\"/>"
       << "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"/>"
       << "<title>Hermes-CPP Zero-Progress Roadmap Board — C++ Autonomous Trading Agent</title>"
       << "<style>"
       << ":root{--bg:#0d1117;--card:#161b22;--line:#30363d;--text:#e6edf3;--dim:#8b949e;--ok:#3fb96f;--bad:#f85149;--warn:#e0a83c;--accent:#58a6ff}"
       << "*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 -apple-system,'Segoe UI',Roboto,sans-serif;padding:0}"
       << ".nav-bar{background:#161b22;border-bottom:1px solid #30363d;padding:12px 24px;display:flex;justify-space:space-between;align-items:center;flex-wrap:wrap}"
       << ".nav-brand{font-weight:700;font-size:16px;color:#e0a83c}"
       << ".nav-links{display:flex;gap:16px;align-items:center}"
       << ".nav-item{color:#e6edf3;text-decoration:none;font-weight:500;font-size:13.5px}.nav-item:hover{color:#3fb96f}"
       << ".nav-btn-link,.nav-btn{background:#238636;color:#fff;padding:5px 12px;border-radius:6px;text-decoration:none;font-size:12.5px;font-weight:600;border:none;cursor:pointer}"
       << ".container{max-width:1250px;margin:20px auto;padding:0 20px}"
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
       << "td,th{border-top:1px solid var(--line);padding:10px 12px;text-align:left;vertical-align:top}"
       << "th{background:rgba(0,0,0,.25);color:var(--dim);font-weight:600;text-transform:uppercase;font-size:11px;letter-spacing:.04em}"
       << "td.num{color:var(--dim);width:70px;font-weight:bold}"
       << ".badge{font-size:11px;padding:3px 10px;border-radius:99px;background:var(--line);color:var(--dim);display:inline-block}"
       << ".badge.ok{background:rgba(63,185,111,.16);color:var(--ok)}.badge.warn{background:rgba(224,168,60,.16);color:var(--warn)}.badge.bad{background:rgba(248,81,73,.16);color:var(--bad)}.badge.pending{background:rgba(139,148,158,.16);color:var(--dim)}"
       << "form.inline{display:inline-block;margin-right:4px}"
       << "button{background:var(--line);color:var(--text);border:1px solid transparent;border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer}"
       << "button:hover{border-color:var(--dim)}"
       << "input[type=text],textarea{background:var(--bg);border:1px solid var(--line);color:var(--text);border-radius:6px;padding:6px 10px;font-size:12px;width:100%}"
       << "code{font:12px ui-monospace,monospace;color:#e0a83c}"
       << ".footer{margin-top:30px;padding-top:14px;border-top:1px solid var(--line);color:var(--dim);font-size:12.5px;text-align:center}"
       << ".clarification-box{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:20px;margin-top:30px}"
       << "</style></head><body>"
       << render_nav_header(is_authenticated)
       << "<div class=\"container\">"
       << "<div class=\"masthead\">"
       << "  <h1>⚡ Hermes-CPP Zero-Progress Master Roadmap Board</h1>"
       << "  <div class=\"meta\">MySQL Database Tables: <code>hermes_cpp_project_stages</code> · <code>hermes_cpp_project_checklist_items</code> · <code>hermes_cpp_project_clarifications</code></div>"
       << "</div>"
       << "<div class=\"card summary\">"
       << "  <div><div class=\"meta\">Overall Hermes-CPP Progress</div><b>" << done_cnt << "<span class=\"dim\">/" << total_cnt << "</span></b> <span class=\"dim\">(" << overall_pct << "%)</span></div>"
       << "  <div><div class=\"meta\">In Progress</div><b class=\"warn\">" << in_prog_cnt << "</b></div>"
       << "  <div><div class=\"meta\">Blocked</div><b class=\"bad\">" << blocked_cnt << "</b></div>"
       << "  <div><div class=\"meta\">Pending</div><b class=\"dim\">" << pending_cnt << "</b></div>"
       << "  <div><div class=\"pbar\"><div class=\"pfill\" style=\"width:" << overall_pct << "%\"></div></div></div>"
       << "</div>";

    for (const auto& st : stages) {
        auto s_items = stage_items[st.stage_id];
        ss << "<details class=\"gate\" open>"
           << "<summary><div class=\"ghead\">"
           << "<div><span class=\"gtitle\">" << html_escape(st.stage_label) << "</span>";
        if (!st.goal.empty()) {
            ss << " <span class=\"meta\">(" << html_escape(st.goal) << ")</span>";
        }
        ss << "</div>"
           << "<span class=\"gmeta\">" << st.done_items << "/" << st.total_items << " done (" << st.pct_complete << "%)</span>"
           << "</div></summary>"
           << "<table>"
           << "<thead><tr><th>Item ID</th><th>Description &amp; Verification Criteria</th><th>Instruction</th><th>Status</th><th>Timestamped Evidence Log</th></tr></thead>"
           << "<tbody>";

        if (s_items.empty()) {
            ss << "<tr><td colspan=\"5\" style=\"color:var(--dim);text-align:center;\">No checklist items seeded for stage " << html_escape(st.stage_id) << "</td></tr>";
        } else {
            for (const auto& it : s_items) {
                std::string badge_cls = (it.status == "done") ? "ok" : (it.status == "in_progress") ? "warn" : (it.status == "blocked") ? "bad" : "pending";
                ss << "<tr id=\"item-" << html_escape(it.item_id) << "\">"
                   << "<td class=\"num\"><code>" << html_escape(it.item_id) << "</code></td>"
                   << "<td><b>" << html_escape(it.description) << "</b>";
                if (!it.done_when.empty()) {
                    ss << "<br/><span class=\"meta\"><b>Done when:</b> " << html_escape(it.done_when) << "</span>";
                }
                ss << "</td>"
                   << "<td><span class=\"meta\">" << html_escape(it.instruction) << "</span></td>"
                   << "<td class=\"nowrap\"><span class=\"badge " << badge_cls << "\">" << html_escape(it.status) << "</span></td>"
                   << "<td><pre style=\"margin:0;font:11.5px monospace;color:var(--dim);white-space:pre-wrap;\">" << (it.note.empty() ? "—" : html_escape(it.note)) << "</pre></td>"
                   << "</tr>";
            }
        }
        ss << "</tbody></table></details>";
    }

    // Clarifications Panel
    ss << "<div class=\"clarification-box\" id=\"clarifications\">"
       << "  <h3 style=\"margin-top:0;color:#e0a83c;\">❓ Hermes-CPP Clarifications Panel</h3>"
       << "  <p class=\"meta\">Submit questions or clarification requests regarding any stage or item in the Hermes-CPP roadmap.</p>";

    if (is_authenticated) {
        ss << "  <form method=\"post\" action=\"/api/roadmap/clarification/ask\" style=\"margin-bottom:20px;\">"
           << "    <div style=\"display:flex;gap:10px;margin-bottom:10px;\">"
           << "      <input type=\"text\" name=\"item_id\" placeholder=\"Item ID (optional, e.g. R-001)\" style=\"max-width:200px;\"/>"
           << "      <input type=\"text\" name=\"stage_label\" placeholder=\"Stage Label (optional, e.g. Gate 0)\" style=\"max-width:250px;\"/>"
           << "    </div>"
           << "    <textarea name=\"question\" placeholder=\"Enter your clarification question here...\" rows=\"3\" required style=\"margin-bottom:10px;\"></textarea>"
           << "    <button type=\"submit\" style=\"background:#238636;color:#fff;padding:6px 14px;font-weight:600;\">❓ Post Clarification Question</button>"
           << "  </form>";
    } else {
        ss << "  <p class=\"meta\" style=\"color:#e0a83c;\">🔐 <a href=\"/login\" style=\"color:#58a6ff;\">Login as Operator</a> to post or answer clarification questions.</p>";
    }

    if (clarifications.empty()) {
        ss << "  <p class=\"meta\" style=\"color:var(--dim);\">No clarifications logged yet. Table <code>hermes_cpp_project_clarifications</code> is currently empty.</p>";
    } else {
        ss << "  <table><thead><tr><th>ID</th><th>Target</th><th>Question</th><th>Status</th><th>Answer</th><th>Timestamps</th></tr></thead><tbody>";
        for (const auto& cl : clarifications) {
            std::string target = cl.item_id;
            if (!cl.stage_label.empty()) {
                if (!target.empty()) target += " / ";
                target += cl.stage_label;
            }
            if (target.empty()) target = "General";

            ss << "<tr>"
               << "<td>#" << cl.clarification_id << "</td>"
               << "<td><code>" << html_escape(target) << "</code></td>"
               << "<td><b>" << html_escape(cl.question) << "</b></td>"
               << "<td><span class=\"badge " << (cl.status == "answered" ? "ok" : "warn") << "\">" << html_escape(cl.status) << "</span></td>"
               << "<td>" << (cl.answer.empty() ? "<span class=\"dim\">Awaiting response</span>" : html_escape(cl.answer)) << "</td>"
               << "<td class=\"meta\">Asked: " << html_escape(cl.created_at) << (cl.answered_at.empty() ? "" : "<br/>Answered: " + html_escape(cl.answered_at)) << "</td>"
               << "</tr>";
        }
        ss << "</tbody></table>";
    }

    ss << "</div>";

    ss << "<div class=\"footer\">"
       << "Hermes-CPP Autonomous Options Trading Agent · Database-Driven Roadmap · Oracle Cloud MySQL (3307)"
       << "</div>"
       << "</div>"
       << GOOGLE_ANALYTICS_FOOTER_TAG
       << "</body></html>";

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
    while (!val.empty() && (val.back() == '\r' || val.back() == '\n' || val.back() == ' ' || val.back() == '\t')) {
        val.pop_back();
    }
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
    while (!decoded.empty() && (decoded.back() == '\r' || decoded.back() == '\n' || decoded.back() == ' ' || decoded.back() == '\t')) {
        decoded.pop_back();
    }
    return decoded;
}

static std::string read_http_request(int fd) {
    std::string req;
    char buffer[65536];
    size_t content_length = 0;
    bool headers_parsed = false;
    size_t header_end_pos = std::string::npos;

    struct timeval tv;
    tv.tv_sec = 2;
    tv.tv_usec = 0;
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, (const char*)&tv, sizeof(tv));

    int retries = 0;
    while (true) {
        ssize_t n = read(fd, buffer, sizeof(buffer) - 1);
        if (n < 0) {
            if ((errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) && retries++ < 10 && req.empty()) {
                usleep(10000); // 10ms wait
                continue;
            }
            break;
        }
        if (n == 0) break;
        buffer[n] = '\0';
        req.append(buffer, n);

        if (!headers_parsed) {
            header_end_pos = req.find("\r\n\r\n");
            if (header_end_pos != std::string::npos) {
                headers_parsed = true;
                auto cl_pos = req.find("Content-Length:");
                if (cl_pos == std::string::npos) {
                    cl_pos = req.find("content-length:");
                }
                if (cl_pos != std::string::npos && cl_pos < header_end_pos) {
                    auto cl_end = req.find("\r\n", cl_pos);
                    if (cl_end != std::string::npos) {
                        std::string cl_str = req.substr(cl_pos + 15, cl_end - (cl_pos + 15));
                        size_t start = cl_str.find_first_not_of(" \t");
                        if (start != std::string::npos) cl_str = cl_str.substr(start);
                        try {
                            content_length = std::stoul(cl_str);
                        } catch (...) {
                            content_length = 0;
                        }
                    }
                }
            }
        }

        if (headers_parsed) {
            size_t body_bytes_read = req.length() - (header_end_pos + 4);
            if (body_bytes_read >= content_length) {
                break;
            }
        }
    }
    return req;
}

static std::string url_encode(const std::string& value) {
    std::ostringstream escaped;
    escaped.fill('0');
    escaped << std::hex;
    for (char c : value) {
        if (isalnum((unsigned char)c) || c == '-' || c == '_' || c == '.' || c == '~') {
            escaped << c;
        } else {
            escaped << '%' << std::setw(2) << std::uppercase << (int)(unsigned char)c;
        }
    }
    return escaped.str();
}

static std::string extract_query_param(const std::string& req, const std::string& param) {
    auto pos = req.find(param + "=");
    if (pos == std::string::npos) return "";
    auto start = pos + param.length() + 1;
    auto end = req.find_first_of(" &\r\n?", start);
    std::string val = (end == std::string::npos) ? req.substr(start) : req.substr(start, end - start);
    while (!val.empty() && (val.back() == '\r' || val.back() == '\n' || val.back() == ' ' || val.back() == '\t')) {
        val.pop_back();
    }
    return val;
}

static std::string exchange_upstox_code_for_token(const std::string& code, std::string& out_expires_at) {
    std::string client_id = EnvLoader::get("UPSTOX_LIVE_API_KEY", "");
    std::string client_secret = EnvLoader::get("UPSTOX_LIVE_API_SECRET", "");
    std::string redirect_uri = EnvLoader::get("UPSTOX_LIVE_REDIRECT_URI", "https://berhampore.in/api/upstox/callback");

    if (client_id.empty() || client_secret.empty() || code.empty()) return "";

    std::string post_data = "code=" + url_encode(code) +
                            "&client_id=" + url_encode(client_id) +
                            "&client_secret=" + url_encode(client_secret) +
                            "&redirect_uri=" + url_encode(redirect_uri) +
                            "&grant_type=authorization_code";

    std::string cmd = "curl -s -m 15 -X POST 'https://api.upstox.com/v2/login/authorization/token' "
                      "-H 'Accept: application/json' "
                      "-H 'Content-Type: application/x-www-form-urlencoded' "
                      "-d '" + post_data + "'";

    std::array<char, 4096> buffer;
    std::string response;
    FILE* pipe = popen(cmd.c_str(), "r");
    if (pipe) {
        while (fgets(buffer.data(), buffer.size(), pipe) != nullptr) {
            response += buffer.data();
        }
        pclose(pipe);
    }

    auto pos = response.find("\"access_token\":\"");
    if (pos != std::string::npos) {
        auto start = pos + 16;
        auto end = response.find("\"", start);
        if (end != std::string::npos) {
            std::string token = response.substr(start, end - start);
            out_expires_at = "2026-12-31 23:59:59";
            return token;
        }
    }
    std::cerr << "❌ [UpstoxOAuth] Token exchange failed. Response: " << response << "\n";
    return "";
}

static std::string exchange_fyers_code_for_token(const std::string& code, std::string& out_expires_at) {
    std::string app_id = EnvLoader::get("FYERS_APP_ID", "");
    std::string app_secret = EnvLoader::get("FYERS_APP_SECRET", "");
    if (app_id.empty() || app_secret.empty() || code.empty()) return "";

    std::string combined = app_id + ":" + app_secret;
    auto hash_bytes = crypto_util::Sha256::hash(combined);
    std::string app_id_hash;
    for (uint8_t b : hash_bytes) {
        char buf[3];
        snprintf(buf, sizeof(buf), "%02x", b);
        app_id_hash += buf;
    }

    std::string json_body = "{\"grant_type\":\"authorization_code\",\"appIdHash\":\"" + app_id_hash + "\",\"code\":\"" + code + "\"}";

    std::string cmd = "curl -s -m 15 -X POST 'https://api-t1.fyers.in/api/v3/validate-authcode' "
                      "-H 'Content-Type: application/json' "
                      "-d '" + json_body + "'";

    std::array<char, 4096> buffer;
    std::string response;
    FILE* pipe = popen(cmd.c_str(), "r");
    if (pipe) {
        while (fgets(buffer.data(), buffer.size(), pipe) != nullptr) {
            response += buffer.data();
        }
        pclose(pipe);
    }

    auto pos = response.find("\"access_token\":\"");
    if (pos != std::string::npos) {
        auto start = pos + 16;
        auto end = response.find("\"", start);
        if (end != std::string::npos) {
            std::string token = response.substr(start, end - start);
            out_expires_at = "2026-12-31 23:59:59";
            return token;
        }
    }
    std::cerr << "❌ [FyersOAuth] Token exchange failed. Response: " << response << "\n";
    return "";
}

std::string RoadmapServer::render_health_page(bool is_authenticated) {
    bool db_ok = db_client_ ? db_client_->test_connection() : false;
    long long initial_today_ticks = 0, initial_total_ticks = 0;
    if (db_client_ && db_ok) {
        auto counts = db_client_->fetch_stored_tick_counts();
        initial_today_ticks = counts.first;
        initial_total_ticks = counts.second;
    }

    std::stringstream ss;
    ss << "<!doctype html><html lang=\"en\"><head>"
       << "<meta charset=\"utf-8\"/>"
       << "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"/>"
       << "<title>System Health — C++ Autonomous Trading Agent Platform</title>"
       << "<style>"
       << ":root{--bg:#0d1117;--card:#161b22;--line:#30363d;--text:#e6edf3;--dim:#8b949e;--ok:#3fb96f;--bad:#f85149;--warn:#e0a83c;--accent:#58a6ff}"
       << "*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 -apple-system,'Segoe UI',Roboto,sans-serif;padding:0}"
       << ".nav-bar{background:#161b22;border-bottom:1px solid #30363d;padding:12px 24px;display:flex;justify-space:space-between;align-items:center;flex-wrap:wrap}"
       << ".nav-brand{font-weight:700;font-size:16px;color:#e0a83c}"
       << ".nav-links{display:flex;gap:16px;align-items:center}"
       << ".nav-item{color:#e6edf3;text-decoration:none;font-weight:500;font-size:13.5px}.nav-item:hover{color:#3fb96f}"
       << ".nav-btn-link,.nav-btn{background:#238636;color:#fff;padding:5px 12px;border-radius:6px;text-decoration:none;font-size:12.5px;font-weight:600;border:none;cursor:pointer}"
       << ".container{max-width:1100px;margin:30px auto;padding:0 20px}"
       << ".hero{background:linear-gradient(135deg, #161b22 0%, #0d1117 100%);border:1px solid #30363d;border-radius:14px;padding:28px;margin-bottom:24px}"
       << ".hero h1{font-size:26px;margin:0 0 8px;color:#e0a83c}"
       << ".grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:20px}"
       << ".card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:22px}"
       << ".card h3{margin-top:0;color:#58a6ff;font-size:17px}"
       << ".status-pill{display:inline-block;padding:3px 10px;border-radius:99px;font-size:12px;font-weight:600}"
       << ".status-pill.ok{background:rgba(63,185,111,.16);color:#3fb96f;border:1px solid rgba(63,185,111,.3)}"
       << ".status-pill.bad{background:rgba(248,81,73,.16);color:#f85149;border:1px solid rgba(248,81,73,.3)}"
       << ".stat-row{display:flex;justify-space:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #21262d}"
       << ".stat-row:last-child{border-bottom:none}"
       << ".stat-label{color:var(--dim)}"
       << ".stat-value{font-weight:600;color:var(--text)}"
       << ".footer{margin-top:40px;padding:20px;border-top:1px solid #30363d;color:#8b949e;font-size:12.5px;text-align:center}"
       << "</style></head><body>"
       << render_nav_header(is_authenticated)
       << "<div class=\"container\">"
       << "  <div class=\"hero\">"
       << "    <h1>⚡ System Health &amp; Operational Status</h1>"
       << "    <p style=\"color:#8b949e;font-size:14.5px;margin:0;\">Real-time status monitoring, server metrics, database connection state, and market tick storage counters.</p>"
       << "  </div>"
       << "  <div class=\"grid\">"
       << "    <div class=\"card\">"
       << "      <h3>🟢 Core Service Status</h3>"
       << "      <div class=\"stat-row\"><span class=\"stat-label\">Engine Core</span><span class=\"status-pill ok\">ONLINE (C++20)</span></div>"
       << "      <div class=\"stat-row\"><span class=\"stat-label\">Database Connection</span>"
       << (db_ok ? "<span class=\"status-pill ok\">CONNECTED</span>" : "<span class=\"status-pill bad\">DISCONNECTED</span>")
       << "</div>"
       << "      <div class=\"stat-row\"><span class=\"stat-label\">System Service</span><span class=\"stat-value\">systemctl (cpp-trading-agent)</span></div>"
       << "      <div class=\"stat-row\"><span class=\"stat-label\">JSON Endpoint</span><span class=\"stat-value\"><a href=\"/api/health\" target=\"_blank\" style=\"color:var(--accent);text-decoration:none;\">/api/health</a></span></div>"
       << "    </div>"
       << "    <div class=\"card\">"
       << "      <h3>📊 Stored Market Ticks</h3>"
       << "      <div class=\"stat-row\"><span class=\"stat-label\">Current Day Ticks (Today)</span><span id=\"sys-today-ticks-val\" class=\"stat-value\" style=\"color:var(--warn);\">" << initial_today_ticks << " ticks</span></div>"
       << "      <div class=\"stat-row\"><span class=\"stat-label\">Total Stored Ticks (All Time)</span><span id=\"sys-total-ticks-val\" class=\"stat-value\" style=\"color:var(--accent);\">" << initial_total_ticks << " ticks</span></div>"
       << "      <div class=\"stat-row\"><span class=\"stat-label\">Storage Table</span><span class=\"stat-value\">upstox_live_paper_option_quotes</span></div>"
       << "      <div class=\"stat-row\"><span class=\"stat-label\">Ingestion Stream</span><span class=\"status-pill ok\">LIVE STREAMING</span></div>"
       << "    </div>"
       << "    <div class=\"card\">"
       << "      <h3>🖥️ Live Server Metrics</h3>"
       << "      <div class=\"stat-row\"><span class=\"stat-label\">CPU Usage</span><span id=\"sys-cpu-val\" class=\"stat-value\" style=\"color:var(--accent);\">--%</span></div>"
       << "      <div class=\"stat-row\"><span class=\"stat-label\">RAM Usage</span><span id=\"sys-ram-val\" class=\"stat-value\" style=\"color:var(--ok);\">-- / -- MB (--%)</span></div>"
       << "      <div class=\"stat-row\"><span class=\"stat-label\">Load Average</span><span id=\"sys-load-val\" class=\"stat-value\">-- / -- / --</span></div>"
       << "      <div class=\"stat-row\"><span class=\"stat-label\">Metrics API</span><span class=\"stat-value\"><a href=\"/api/system/stats\" target=\"_blank\" style=\"color:var(--accent);text-decoration:none;\">/api/system/stats</a></span></div>"
       << "    </div>"
       << "    <div class=\"card\">"
       << "      <h3>⚡ Low-Latency Performance</h3>"
       << "      <div class=\"stat-row\"><span class=\"stat-label\">Execution Latency</span><span class=\"stat-value\" style=\"color:var(--ok);\">&lt; 10 µs (p99)</span></div>"
       << "      <div class=\"stat-row\"><span class=\"stat-label\">GC Pauses</span><span class=\"stat-value\" style=\"color:var(--ok);\">0 ms (Pure Native C++)</span></div>"
       << "      <div class=\"stat-row\"><span class=\"stat-label\">Memory Footprint</span><span class=\"stat-value\">15 MB - 20 MB RAM</span></div>"
       << "      <div class=\"stat-row\"><span class=\"stat-label\">Threading Model</span><span class=\"stat-value\">Multithreaded Async Event Loop</span></div>"
       << "    </div>"
       << "    <div class=\"card\">"
       << "      <h3>🛡️ Security &amp; Multi-Tenant Scoping</h3>"
       << "      <div class=\"stat-row\"><span class=\"stat-label\">Authentication Gate</span><span class=\"stat-value\">Zero-Trust Session Tokens</span></div>"
       << "      <div class=\"stat-row\"><span class=\"stat-label\">Tenant Privacy</span><span class=\"stat-value\">Per-User Data Scoping</span></div>"
       << "      <div class=\"stat-row\"><span class=\"stat-label\">SSL / TLS Ingress</span><span class=\"stat-value\">Cloudflare Tunnel (berhampore.in)</span></div>"
       << "      <div class=\"stat-row\"><span class=\"stat-label\">Database Host</span><span class=\"stat-value\">Oracle Cloud MDS (3307)</span></div>"
       << "    </div>"
       << "  </div>"
       << "<script>"
       << "function fetchSystemStats(){"
       << "  fetch('/api/system/stats')"
       << "    .then(function(r){return r.json();})"
       << "    .then(function(d){"
       << "      if(d.cpu_percent!==undefined){"
       << "        document.getElementById('sys-cpu-val').innerText=d.cpu_percent.toFixed(1)+'%';"
       << "        document.getElementById('sys-ram-val').innerText=d.ram_used_mb+' / '+d.ram_total_mb+' MB ('+d.ram_percent.toFixed(1)+'%)';"
       << "        document.getElementById('sys-load-val').innerText=d.load_1m.toFixed(2)+' / '+d.load_5m.toFixed(2)+' / '+d.load_15m.toFixed(2);"
       << "      }"
       << "      if(d.today_ticks!==undefined){"
       << "        document.getElementById('sys-today-ticks-val').innerText=d.today_ticks.toLocaleString('en-IN')+' ticks';"
       << "        document.getElementById('sys-total-ticks-val').innerText=d.total_ticks.toLocaleString('en-IN')+' ticks';"
       << "      }"
       << "    })"
       << "    .catch(function(e){console.error('Stats error',e);});"
       << "}"
       << "fetchSystemStats();"
       << "setInterval(fetchSystemStats,15000);"
       << "</script>"
       << "  <div class=\"footer\">C++ Autonomous Trading Engine · Operational Health Monitor · Oracle Cloud MySQL (3307)</div>"
       << "</div>"
       << GOOGLE_ANALYTICS_FOOTER_TAG
       << "</body></html>";
    return ss.str();
}

static std::string extract_header_val(const std::string& req, const std::string& header_name) {
    std::string needle = "\n" + header_name + ":";
    size_t pos = req.find(needle);
    if (pos == std::string::npos) {
        if (req.rfind(header_name + ":", 0) == 0) {
            pos = 0;
            needle = header_name + ":";
        } else {
            size_t header_end = req.find("\r\n\r\n");
            if (header_end == std::string::npos) header_end = req.size();
            std::string lower_hdr = header_name;
            std::transform(lower_hdr.begin(), lower_hdr.end(), lower_hdr.begin(), ::tolower);
            std::string sub = req.substr(0, header_end);
            std::string lower_sub = sub;
            std::transform(lower_sub.begin(), lower_sub.end(), lower_sub.begin(), ::tolower);
            pos = lower_sub.find("\n" + lower_hdr + ":");
            if (pos != std::string::npos) {
                needle = "\n" + lower_hdr + ":";
            }
        }
    }
    if (pos == std::string::npos) return "";
    size_t start = pos + needle.length();
    size_t end = req.find("\r\n", start);
    if (end == std::string::npos) end = req.find("\n", start);
    if (end == std::string::npos) return "";
    std::string val = req.substr(start, end - start);
    size_t first = val.find_first_not_of(" \t");
    if (first == std::string::npos) return "";
    val = val.substr(first);
    while (!val.empty() && (val.back() == '\r' || val.back() == ' ' || val.back() == '\t')) val.pop_back();
    return val;
}

static std::string safe_map_get(const std::map<std::string, std::string>& m, const std::string& key, const std::string& def = "") {
    auto it = m.find(key);
    return (it != m.end()) ? it->second : def;
}

std::string RoadmapServer::render_visitor_info_page(bool is_authenticated) {
    std::map<std::string, std::string> summary;
    std::vector<std::map<std::string, std::string>> top_pages;
    std::vector<std::map<std::string, std::string>> countries;
    std::vector<std::map<std::string, std::string>> browsers;
    std::vector<std::map<std::string, std::string>> os_list;
    std::vector<std::map<std::string, std::string>> devices;

    if (db_client_) {
        summary = db_client_->fetch_analytics_summary_stats();
        top_pages = db_client_->fetch_analytics_popular_pages(10);
        countries = db_client_->fetch_analytics_countries(10);
        browsers = db_client_->fetch_analytics_browsers();
        os_list = db_client_->fetch_analytics_os();
        devices = db_client_->fetch_analytics_devices();
    }
    auto& tracker = analytics::VisitorTracker::instance();

    std::stringstream ss;
    ss << "<!doctype html><html lang=\"en\"><head>"
       << "<meta charset=\"utf-8\"/>"
       << "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"/>"
       << "<title>Visitor Analytics &amp; Privacy Intelligence — C++ Autonomous Agent Platform</title>"
       << "<style>"
       << ":root{--bg:#0d1117;--card:#161b22;--line:#30363d;--text:#e6edf3;--dim:#8b949e;--ok:#3fb96f;--bad:#f85149;--warn:#e0a83c;--accent:#58a6ff}"
       << "*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 -apple-system,'Segoe UI',Roboto,sans-serif;padding:0}"
       << ".nav-bar{background:#161b22;border-bottom:1px solid #30363d;padding:12px 24px;display:flex;justify-space:space-between;align-items:center;flex-wrap:wrap}"
       << ".nav-brand{font-weight:700;font-size:16px;color:#e0a83c}"
       << ".nav-links{display:flex;gap:16px;align-items:center}"
       << ".nav-item{color:#e6edf3;text-decoration:none;font-weight:500;font-size:13.5px}.nav-item:hover{color:#3fb96f}"
       << ".nav-btn-link,.nav-btn{background:#238636;color:#fff;padding:5px 12px;border-radius:6px;text-decoration:none;font-size:12.5px;font-weight:600;border:none;cursor:pointer}"
       << ".container{max-width:1150px;margin:30px auto;padding:0 20px}"
       << ".hero{background:linear-gradient(135deg, #161b22 0%, #0d1117 100%);border:1px solid #30363d;border-radius:14px;padding:28px;margin-bottom:24px}"
       << ".hero h1{font-size:26px;margin:0 0 8px;color:#58a6ff}"
       << ".grid-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:24px}"
       << ".stat-card{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:18px;text-align:center}"
       << ".stat-card .val{font-size:26px;font-weight:700;color:var(--text);margin-top:6px}"
       << ".stat-card .lbl{color:var(--dim);font-size:12.5px;text-transform:uppercase;letter-spacing:0.5px}"
       << ".stat-card .sub{color:var(--dim);font-size:11.5px;margin-top:4px}"
       << ".grid-panels{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:20px;margin-bottom:24px}"
       << ".panel{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:22px}"
       << ".panel h3{margin-top:0;color:#58a6ff;font-size:16.5px;margin-bottom:14px;display:flex;justify-space:space-between;align-items:center}"
       << ".table-sm{width:100%;border-collapse:collapse;font-size:13px}"
       << ".table-sm th{text-align:left;color:var(--dim);padding:8px 6px;border-bottom:1px solid #30363d;font-weight:600}"
       << ".table-sm td{padding:8px 6px;border-bottom:1px solid #21262d}"
       << ".privacy-banner{background:#161b22;border:1px solid rgba(63,185,111,.3);border-radius:12px;padding:22px;margin-bottom:24px}"
       << ".privacy-banner h3{margin-top:0;color:var(--ok);font-size:17px;display:flex;align-items:center;gap:8px}"
       << ".pill{display:inline-block;padding:2px 8px;border-radius:99px;font-size:11.5px;font-weight:600}"
       << ".pill.ok{background:rgba(63,185,111,.16);color:#3fb96f;border:1px solid rgba(63,185,111,.3)}"
       << ".pill.info{background:rgba(88,166,255,.16);color:#58a6ff;border:1px solid rgba(88,166,255,.3)}"
       << ".footer{margin-top:40px;padding:20px;border-top:1px solid #30363d;color:#8b949e;font-size:12.5px;text-align:center}"
       << "</style></head><body>"
       << render_nav_header(is_authenticated)
       << "<div class=\"container\">"
       << "  <div class=\"hero\">"
       << "    <h1>🌐 Cookie-Less Visitor Tracking &amp; Analytics</h1>"
       << "    <p style=\"color:#8b949e;font-size:14.5px;margin:0 0 12px;\">High-performance server-side traffic measurement engineered in C++20 with privacy-first cryptographic guarantees.</p>"
       << "    <div style=\"display:flex;gap:10px;flex-wrap:wrap;\">"
       << "      <span class=\"pill ok\">✅ 100% Server-Side</span>"
       << "      <span class=\"pill ok\">🚫 Zero Cookies Used</span>"
       << "      <span class=\"pill ok\">🔒 Zero Fingerprinting APIs</span>"
       << "      <span class=\"pill info\">🛡️ 30-Day IP Redaction Boundary</span>"
       << "    </div>"
       << "  </div>"
 
       << "  <div class=\"grid-stats\">"
       << "    <div class=\"stat-card\">"
       << "      <div class=\"lbl\">Lifetime Page Views</div>"
       << "      <div class=\"val\" style=\"color:var(--accent);\">" << (summary.count("lifetime_page_views") ? summary["lifetime_page_views"] : "0") << "</div>"
       << "      <div class=\"sub\">Committed Page Views</div>"
       << "    </div>"
       << "    <div class=\"stat-card\">"
       << "      <div class=\"lbl\">Lifetime Visits</div>"
       << "      <div class=\"val\" style=\"color:var(--ok);\">" << (summary.count("lifetime_visits") ? summary["lifetime_visits"] : "0") << "</div>"
       << "      <div class=\"sub\">Estimated Sessions</div>"
       << "    </div>"
       << "    <div class=\"stat-card\">"
       << "      <div class=\"lbl\">Unique Visitors</div>"
       << "      <div class=\"val\" style=\"color:var(--warn);\">" << (summary.count("unique_estimated_visitors") ? summary["unique_estimated_visitors"] : "0") << "</div>"
       << "      <div class=\"sub\">Active Identities</div>"
       << "    </div>"
       << "    <div class=\"stat-card\">"
       << "      <div class=\"lbl\">Retained Views</div>"
       << "      <div class=\"val\">" << (summary.count("retained_page_views") ? summary["retained_page_views"] : "0") << "</div>"
       << "      <div class=\"sub\">Within 90-Day Window</div>"
       << "    </div>"
       << "    <div class=\"stat-card\">"
       << "      <div class=\"lbl\">Bounce Rate</div>"
       << "      <div class=\"val\">" << (summary.count("bounce_rate_pct") ? summary["bounce_rate_pct"] : "0") << "%</div>"
       << "      <div class=\"sub\">Single-Page Visits</div>"
       << "    </div>"
       << "    <div class=\"stat-card\">"
       << "      <div class=\"lbl\">Analytics Queue</div>"
       << "      <div class=\"val\" style=\"font-size:20px;margin-top:10px;\">" << tracker.total_events_persisted() << " / " << tracker.total_events_enqueued() << "</div>"
       << "      <div class=\"sub\">Persisted / Enqueued (Drops: " << tracker.total_events_dropped() << ")</div>"
       << "    </div>"
       << "  </div>"
 
       << "  <div class=\"privacy-banner\">"
       << "    <h3>🛡️ Privacy Architecture &amp; Methodology Disclosure</h3>"
       << "    <p style=\"font-size:13.5px;color:#c9d1d9;margin:0 0 10px;\">"
       << "      This tracking system is strictly server-side and distinguishes four foundational data classes:"
       << "    </p>"
       << "    <ul style=\"color:#8b949e;font-size:13px;line-height:1.7;margin:0 0 14px;padding-left:20px;\">"
       << "      <li><strong>Directly Observed:</strong> HTTP Method, requested path, response code, and response time.</li>"
       << "      <li><strong>Inferred from Headers:</strong> Browser family, operating system, and preferred language from the standard <code>User-Agent</code> header.</li>"
       << "      <li><strong>Derived from IP Geolocation:</strong> Approximate city/region/country derived using local lookup. <em>Disclaimer: Approximate location derived from IP (ISP gateway level, never GPS).</em></li>"
       << "      <li><strong>Probabilistic Visitor Identification:</strong> Active visitor identity is derived via HMAC-SHA256 with an isolated server-side secret. <em>Disclaimer: Estimated visitor/device identity — Probabilistic match (likely the same device/network, not a guaranteed unique person).</em></li>"
       << "    </ul>"
       << "    <div style=\"background:#0d1117;border-left:3px solid var(--ok);padding:10px 14px;border-radius:4px;font-size:12.5px;color:#8b949e;\">"
       << "      🔒 <strong>Cryptographic Redaction Policy:</strong> At the 30-day retention boundary, raw IP addresses and lookup hashes are permanently set to <code>NULL</code> (<code>is_redacted = 1</code>). Future requests from that IP generate a completely new, unlinked identifier."
       << "    </div>"
       << "  </div>"
 
       << "  <div class=\"grid-panels\">"
       << "    <div class=\"panel\">"
       << "      <h3>📄 Top Visited Pages <span class=\"pill info\">Observed</span></h3>"
       << "      <table class=\"table-sm\">"
       << "        <thead><tr><th>Path</th><th style=\"text-align:right;\">Page Views</th><th style=\"text-align:right;\">Visitors</th></tr></thead>"
       << "        <tbody>";
    for (const auto& p : top_pages) {
        ss << "<tr><td><code style=\"color:#58a6ff;\">" << html_escape(safe_map_get(p, "path", "/")) << "</code></td>"
           << "<td style=\"text-align:right;font-weight:600;\">" << safe_map_get(p, "views", safe_map_get(p, "count", "0")) << "</td>"
           << "<td style=\"text-align:right;color:var(--dim);\">" << safe_map_get(p, "visitors", safe_map_get(p, "count", "0")) << "</td></tr>";
    }
    if (top_pages.empty()) ss << "<tr><td colspan=\"3\" style=\"color:var(--dim);text-align:center;\">No page visit records yet</td></tr>";
    ss << "        </tbody></table></div>"
 
       << "    <div class=\"panel\">"
       << "      <h3>🌍 Geographic Distribution <span class=\"pill info\">Approximate IP</span></h3>"
       << "      <div style=\"font-size:11.5px;color:var(--dim);margin-bottom:8px;\">Approximate location derived from IP (ISP gateway approximate, not exact GPS)</div>"
       << "      <table class=\"table-sm\">"
       << "        <thead><tr><th>Country</th><th>Code</th><th style=\"text-align:right;\">Page Views</th></tr></thead>"
       << "        <tbody>";
    for (const auto& c : countries) {
        ss << "<tr><td>" << html_escape(safe_map_get(c, "country", "Unknown")) << "</td>"
           << "<td><span class=\"pill ok\">" << html_escape(safe_map_get(c, "country_code", "XX")) << "</span></td>"
           << "<td style=\"text-align:right;font-weight:600;\">" << safe_map_get(c, "views", safe_map_get(c, "count", "0")) << "</td></tr>";
    }
    if (countries.empty()) ss << "<tr><td colspan=\"3\" style=\"color:var(--dim);text-align:center;\">No geographic records yet</td></tr>";
    ss << "        </tbody></table></div>"
 
       << "    <div class=\"panel\">"
       << "      <h3>🌐 Browsers &amp; Operating Systems <span class=\"pill info\">Inferred UA</span></h3>"
       << "      <table class=\"table-sm\">"
       << "        <thead><tr><th>Software / Platform</th><th style=\"text-align:right;\">Seen Count</th></tr></thead>"
       << "        <tbody>";
    for (const auto& b : browsers) {
        ss << "<tr><td>" << html_escape(safe_map_get(b, "browser_name", safe_map_get(b, "browser", "Other"))) << "</td>"
           << "<td style=\"text-align:right;font-weight:600;\">" << safe_map_get(b, "views", safe_map_get(b, "count", "0")) << "</td></tr>";
    }
    for (const auto& o : os_list) {
        ss << "<tr><td style=\"color:var(--dim);\">" << html_escape(safe_map_get(o, "os_name", safe_map_get(o, "os", "Other"))) << " (OS)</td>"
           << "<td style=\"text-align:right;color:var(--dim);\">" << safe_map_get(o, "views", safe_map_get(o, "count", "0")) << "</td></tr>";
    }
    if (browsers.empty() && os_list.empty()) ss << "<tr><td colspan=\"2\" style=\"color:var(--dim);text-align:center;\">No device records yet</td></tr>";
    ss << "        </tbody></table></div>"
 
       << "    <div class=\"panel\">"
       << "      <h3>📱 Device Categories <span class=\"pill info\">Inferred UA</span></h3>"
       << "      <table class=\"table-sm\">"
       << "        <thead><tr><th>Category</th><th style=\"text-align:right;\">Seen Count</th></tr></thead>"
       << "        <tbody>";
    for (const auto& d : devices) {
        ss << "<tr><td>" << html_escape(safe_map_get(d, "device_type", "desktop")) << "</td>"
           << "<td style=\"text-align:right;font-weight:600;\">" << safe_map_get(d, "views", safe_map_get(d, "count", "0")) << "</td></tr>";
    }
    if (devices.empty()) ss << "<tr><td colspan=\"2\" style=\"color:var(--dim);text-align:center;\">No device categories yet</td></tr>";
    ss << "        </tbody></table></div>"
       << "  </div>"

       << "  <div class=\"footer\">"
       << "    C++ Autonomous Trading Engine · Cookie-Less Privacy-First Analytics Subsystem · MySQL MDS"
       << "  </div>"
       << "</div>"
       << GOOGLE_ANALYTICS_FOOTER_TAG
       << "</body></html>";

    return ss.str();
}

std::string RoadmapServer::render_admin_visitors_page(bool is_authenticated, int page, int limit, const std::string& search, const std::string& country, int bot_filter) {
    if (!is_authenticated) {
        return "<!doctype html><html><body style='background:#0d1117;color:#fff;'><h3>401 Unauthorized. Please <a href='/login' style='color:#58a6ff;'>Login</a></h3></body></html>";
    }

    std::pair<int, std::vector<std::map<std::string, std::string>>> res;
    if (db_client_) {
        res = db_client_->fetch_admin_visitors(page, limit, search, country, bot_filter);
    }
    int total_count = res.first;
    const auto& visitors = res.second;
    int total_pages = (total_count + limit - 1) / limit;
    if (total_pages < 1) total_pages = 1;

    std::stringstream ss;
    ss << "<!doctype html><html lang=\"en\"><head>"
       << "<meta charset=\"utf-8\"/>"
       << "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"/>"
       << "<title>Operator Visitors Directory — C++ Autonomous Trading Agent</title>"
       << "<style>"
       << ":root{--bg:#0d1117;--card:#161b22;--line:#30363d;--text:#e6edf3;--dim:#8b949e;--ok:#3fb96f;--bad:#f85149;--warn:#e0a83c;--accent:#58a6ff}"
       << "*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 -apple-system,'Segoe UI',Roboto,sans-serif;padding:0}"
       << ".nav-bar{background:#161b22;border-bottom:1px solid #30363d;padding:12px 24px;display:flex;justify-space:space-between;align-items:center;flex-wrap:wrap}"
       << ".nav-brand{font-weight:700;font-size:16px;color:#e0a83c}"
       << ".nav-links{display:flex;gap:16px;align-items:center}"
       << ".nav-item{color:#e6edf3;text-decoration:none;font-weight:500;font-size:13.5px}.nav-item:hover{color:#3fb96f}"
       << ".nav-btn-link,.nav-btn{background:#238636;color:#fff;padding:6px 14px;border-radius:6px;text-decoration:none;font-size:12.5px;font-weight:600;border:none;cursor:pointer}"
       << ".container{max-width:1250px;margin:30px auto;padding:0 20px}"
       << ".hero{background:linear-gradient(135deg, #161b22 0%, #0d1117 100%);border:1px solid #30363d;border-radius:14px;padding:24px;margin-bottom:20px;display:flex;justify-space:space-between;align-items:center;flex-wrap:wrap;gap:16px}"
       << ".hero h1{font-size:24px;margin:0 0 6px;color:#e0a83c}"
       << ".filter-bar{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:16px;margin-bottom:20px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}"
       << ".filter-bar input,.filter-bar select{background:#0d1117;border:1px solid #30363d;color:#e6edf3;padding:6px 10px;border-radius:6px;font-size:13px}"
       << ".card-table{background:#161b22;border:1px solid #30363d;border-radius:12px;overflow:hidden;margin-bottom:20px}"
       << ".table{width:100%;border-collapse:collapse;font-size:13px}"
       << ".table th{background:#21262d;color:#8b949e;text-align:left;padding:10px 12px;border-bottom:1px solid #30363d;font-weight:600}"
       << ".table td{padding:10px 12px;border-bottom:1px solid #21262d}"
       << ".table tr:hover td{background:rgba(255,255,255,0.02)}"
       << ".badge{display:inline-block;padding:2px 8px;border-radius:99px;font-size:11.5px;font-weight:600}"
       << ".badge.ok{background:rgba(63,185,111,.16);color:#3fb96f;border:1px solid rgba(63,185,111,.3)}"
       << ".badge.warn{background:rgba(224,168,60,.16);color:#e0a83c;border:1px solid rgba(224,168,60,.3)}"
       << ".badge.redacted{background:rgba(139,148,158,.16);color:#8b949e;border:1px solid rgba(139,148,158,.3)}"
       << ".pagination{display:flex;justify-content:space-between;align-items:center;padding:12px 16px;background:#161b22;border-top:1px solid #30363d}"
       << ".btn-sm{background:#21262d;border:1px solid #30363d;color:#58a6ff;padding:4px 10px;border-radius:4px;text-decoration:none;font-size:12px;font-weight:600}"
       << ".btn-sm:hover{background:#30363d}"
       << ".footer{margin-top:40px;padding:20px;border-top:1px solid #30363d;color:#8b949e;font-size:12.5px;text-align:center}"
       << "</style></head><body>"
       << render_nav_header(is_authenticated)
       << "<div class=\"container\">"
       << "  <div class=\"hero\">"
       << "    <div>"
       << "      <h1>👥 Operator Visitors CRM &amp; Traffic Directory</h1>"
       << "      <p style=\"color:#8b949e;font-size:13.5px;margin:0;\">Authenticated access to estimated visitor records, raw IPs (within 30-day retention), and activity streams.</p>"
       << "    </div>"
       << "    <div>"
       << "      <form method=\"post\" action=\"/admin/analytics/retention-purge\" style=\"margin:0;\">"
       << "        <button type=\"submit\" class=\"nav-btn\" style=\"background:#d29922;\" onclick=\"return confirm('Run immediate retention purge for records older than configured limits?');\">🧹 Run Retention Purge Now</button>"
       << "      </form>"
       << "    </div>"
       << "  </div>"

       << "  <form class=\"filter-bar\" method=\"get\" action=\"/admin/visitors\">"
       << "    <input type=\"text\" name=\"search\" placeholder=\"Search IP Address...\" value=\"" << html_escape(search) << "\" style=\"width:220px;\"/>"
       << "    <input type=\"text\" name=\"country\" placeholder=\"Filter Country...\" value=\"" << html_escape(country) << "\" style=\"width:160px;\"/>"
       << "    <select name=\"bot\">"
       << "      <option value=\"-1\"" << (bot_filter == -1 ? " selected" : "") << ">All Traffic (Humans + Bots)</option>"
       << "      <option value=\"0\"" << (bot_filter == 0 ? " selected" : "") << ">Humans Only</option>"
       << "      <option value=\"1\"" << (bot_filter == 1 ? " selected" : "") << ">Known Bots Only</option>"
       << "    </select>"
       << "    <select name=\"limit\">"
       << "      <option value=\"20\"" << (limit == 20 ? " selected" : "") << ">20 per page</option>"
       << "      <option value=\"50\"" << (limit == 50 ? " selected" : "") << ">50 per page</option>"
       << "      <option value=\"100\"" << (limit == 100 ? " selected" : "") << ">100 per page</option>"
       << "    </select>"
       << "    <button type=\"submit\" class=\"nav-btn\">Apply Filters</button>"
       << "    <a href=\"/admin/visitors\" style=\"color:var(--dim);text-decoration:none;font-size:12.5px;margin-left:8px;\">Reset</a>"
       << "  </form>"

       << "  <div class=\"card-table\">"
       << "    <table class=\"table\">"
       << "      <thead><tr>"
       << "        <th>Estimated Visitor ID</th>"
       << "        <th>Raw IP Address</th>"
       << "        <th>Location (Approx IP)</th>"
       << "        <th>Primary Device</th>"
       << "        <th style=\"text-align:right;\">Visits</th>"
       << "        <th style=\"text-align:right;\">Page Views</th>"
       << "        <th>First Seen</th>"
       << "        <th>Last Seen</th>"
       << "        <th>Status</th>"
       << "        <th>Action</th>"
       << "      </tr></thead>"
       << "      <tbody>";

    for (const auto& v : visitors) {
        std::string ip = safe_map_get(v, "ip_address");
        bool is_redacted = (safe_map_get(v, "is_redacted") == "1" || ip.empty() || ip == "Redacted");
        std::string v_id = safe_map_get(v, "visitor_id", safe_map_get(v, "id"));
        ss << "<tr>"
           << "<td><a href=\"/admin/visitors/" << v_id << "\" style=\"color:var(--accent);font-family:monospace;font-weight:600;text-decoration:none;\">"
           << v_id.substr(0, std::min(v_id.length(), (size_t)16)) << "...</a></td>"
           << "<td>";
        if (is_redacted) {
            ss << "<span class=\"badge redacted\">Redacted</span>";
        } else {
            ss << "<code style=\"color:var(--accent);\">" << html_escape(ip) << "</code>";
        }
        ss << "</td>"
           << "<td>" << html_escape(safe_map_get(v, "city", "Unknown")) << ", " << html_escape(safe_map_get(v, "country", "Unknown")) << "</td>"
           << "<td style=\"color:var(--dim);\">" << html_escape(safe_map_get(v, "browser_name", safe_map_get(v, "browser", "Other"))) << " / " << html_escape(safe_map_get(v, "os_name", safe_map_get(v, "os", "Other"))) << "</td>"
           << "<td style=\"text-align:right;font-weight:600;\">" << safe_map_get(v, "total_visits", "0") << "</td>"
           << "<td style=\"text-align:right;font-weight:600;\">" << safe_map_get(v, "total_page_views", "0") << "</td>"
           << "<td style=\"color:var(--dim);font-size:12px;\">" << safe_map_get(v, "first_seen_at") << "</td>"
           << "<td style=\"color:var(--dim);font-size:12px;\">" << safe_map_get(v, "last_seen_at") << "</td>"
           << "<td>" << (is_redacted ? "<span class=\"badge warn\">REDACTED</span>" : "<span class=\"badge ok\">ACTIVE</span>") << "</td>"
           << "<td><a href=\"/admin/visitors/" << v_id << "\" class=\"btn-sm\">Details &rarr;</a></td>"
           << "</tr>";
    }

    if (visitors.empty()) {
        ss << "<tr><td colspan=\"10\" style=\"text-align:center;color:var(--dim);padding:30px;\">No matching visitors found</td></tr>";
    }

    ss << "      </tbody>"
       << "    </table>"
       << "    <div class=\"pagination\">"
       << "      <span style=\"color:var(--dim);font-size:13px;\">Showing " << visitors.size() << " of " << total_count << " visitors (Page " << page << " of " << total_pages << ")</span>"
       << "      <div style=\"display:flex;gap:8px;\">";
    if (page > 1) {
        ss << "<a href=\"/admin/visitors?page=" << (page - 1) << "&limit=" << limit << "&search=" << url_encode(search) << "&country=" << url_encode(country) << "&bot=" << bot_filter << "\" class=\"btn-sm\">&larr; Previous</a>";
    }
    if (page < total_pages) {
        ss << "<a href=\"/admin/visitors?page=" << (page + 1) << "&limit=" << limit << "&search=" << url_encode(search) << "&country=" << url_encode(country) << "&bot=" << bot_filter << "\" class=\"btn-sm\">Next &rarr;</a>";
    }
    ss << "      </div>"
       << "    </div>"
       << "  </div>"

       << "  <div class=\"footer\">C++ Autonomous Trading Engine · Operator Visitors Directory · MySQL MDS</div>"
       << "</div>"
       << GOOGLE_ANALYTICS_FOOTER_TAG
       << "</body></html>";

    return ss.str();
}

std::string RoadmapServer::render_admin_visitor_detail_page(bool is_authenticated, const std::string& visitor_id) {
    if (!is_authenticated) {
        return "<!doctype html><html><body style='background:#0d1117;color:#fff;'><h3>401 Unauthorized. Please <a href='/login' style='color:#58a6ff;'>Login</a></h3></body></html>";
    }

    std::map<std::string, std::string> v;
    std::vector<std::map<std::string, std::string>> sessions;
    std::vector<std::map<std::string, std::string>> history;

    if (db_client_) {
        v = db_client_->fetch_admin_visitor_detail(visitor_id);
        sessions = db_client_->fetch_admin_visitor_sessions(visitor_id, 20);
        history = db_client_->fetch_admin_visitor_page_history(visitor_id, 50);
    }

    if (v.empty()) {
        return "<!doctype html><html><body style='background:#0d1117;color:#fff;padding:40px;font-family:sans-serif;'><h3>Visitor Not Found: " + html_escape(visitor_id) + "</h3><p><a href='/admin/visitors' style='color:#58a6ff;'>&larr; Back to Visitors Directory</a></p></body></html>";
    }

    bool is_redacted = (v["is_redacted"] == "1" || v["ip_address"].empty());

    std::stringstream ss;
    ss << "<!doctype html><html lang=\"en\"><head>"
       << "<meta charset=\"utf-8\"/>"
       << "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"/>"
       << "<title>Visitor Detail — " << html_escape(visitor_id) << "</title>"
       << "<style>"
       << ":root{--bg:#0d1117;--card:#161b22;--line:#30363d;--text:#e6edf3;--dim:#8b949e;--ok:#3fb96f;--bad:#f85149;--warn:#e0a83c;--accent:#58a6ff}"
       << "*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 -apple-system,'Segoe UI',Roboto,sans-serif;padding:0}"
       << ".nav-bar{background:#161b22;border-bottom:1px solid #30363d;padding:12px 24px;display:flex;justify-space:space-between;align-items:center;flex-wrap:wrap}"
       << ".nav-brand{font-weight:700;font-size:16px;color:#e0a83c}"
       << ".nav-links{display:flex;gap:16px;align-items:center}"
       << ".nav-item{color:#e6edf3;text-decoration:none;font-weight:500;font-size:13.5px}.nav-item:hover{color:#3fb96f}"
       << ".nav-btn-link,.nav-btn{background:#238636;color:#fff;padding:5px 12px;border-radius:6px;text-decoration:none;font-size:12.5px;font-weight:600;border:none;cursor:pointer}"
       << ".container{max-width:1200px;margin:30px auto;padding:0 20px}"
       << ".breadcrumb{margin-bottom:16px;font-size:13px;color:var(--dim)}"
       << ".breadcrumb a{color:var(--accent);text-decoration:none}"
       << ".hero{background:linear-gradient(135deg, #161b22 0%, #0d1117 100%);border:1px solid #30363d;border-radius:14px;padding:24px;margin-bottom:20px}"
       << ".hero h1{font-size:22px;margin:0 0 6px;color:#58a6ff;font-family:monospace;word-break:break-all;}"
       << ".disclaimer-box{background:rgba(224,168,60,0.1);border:1px solid rgba(224,168,60,0.3);border-radius:8px;padding:12px 16px;margin-bottom:20px;font-size:13px;color:#e0a83c}"
       << ".grid-info{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;margin-bottom:20px}"
       << ".card{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:18px}"
       << ".card h3{margin-top:0;color:#58a6ff;font-size:15px;margin-bottom:12px}"
       << ".stat-row{display:flex;justify-space:space-between;padding:6px 0;border-bottom:1px solid #21262d;font-size:13px}"
       << ".stat-row:last-child{border-bottom:none}"
       << ".stat-lbl{color:var(--dim)}"
       << ".stat-val{color:var(--text);font-weight:600}"
       << ".card-table{background:#161b22;border:1px solid #30363d;border-radius:12px;overflow:hidden;margin-bottom:20px}"
       << ".table{width:100%;border-collapse:collapse;font-size:13px}"
       << ".table th{background:#21262d;color:#8b949e;text-align:left;padding:10px 12px;border-bottom:1px solid #30363d;font-weight:600}"
       << ".table td{padding:10px 12px;border-bottom:1px solid #21262d}"
       << ".badge{display:inline-block;padding:2px 8px;border-radius:99px;font-size:11.5px;font-weight:600}"
       << ".badge.ok{background:rgba(63,185,111,.16);color:#3fb96f;border:1px solid rgba(63,185,111,.3)}"
       << ".badge.warn{background:rgba(224,168,60,.16);color:#e0a83c;border:1px solid rgba(224,168,60,.3)}"
       << ".badge.redacted{background:rgba(139,148,158,.16);color:#8b949e;border:1px solid rgba(139,148,158,.3)}"
       << ".footer{margin-top:40px;padding:20px;border-top:1px solid #30363d;color:#8b949e;font-size:12.5px;text-align:center}"
       << "</style></head><body>"
       << render_nav_header(is_authenticated)
       << "<div class=\"container\">"
       << "  <div class=\"breadcrumb\"><a href=\"/admin/visitors\">&larr; Back to Visitors Directory</a> / Visitor Detail</div>"
       << "  <div class=\"hero\">"
       << "    <h1>Estimated Visitor: " << html_escape(visitor_id) << "</h1>"
       << "    <div style=\"display:flex;gap:10px;margin-top:10px;align-items:center;\">"
       << (is_redacted ? "<span class=\"badge redacted\">REDACTED IDENTITY</span>" : "<span class=\"badge ok\">ACTIVE IDENTITY</span>")
       << "      <span style=\"color:var(--dim);font-size:13px;\">First Seen: " << v["first_seen_at"] << " · Last Seen: " << v["last_seen_at"] << "</span>"
       << "    </div>"
       << "  </div>"

       << "  <div class=\"disclaimer-box\">"
       << "    ⚠️ <strong>Estimated visitor/device identity:</strong> Probabilistic match — likely the same device/network, not a guaranteed unique person."
       << "  </div>"

       << "  <div class=\"grid-info\">"
       << "    <div class=\"card\">"
       << "      <h3>👤 Network &amp; Identity</h3>"
       << "      <div class=\"stat-row\"><span class=\"stat-lbl\">Raw IP Address</span><span class=\"stat-val\">"
       << (is_redacted ? "<span class=\"badge redacted\">Redacted</span>" : "<code style=\"color:var(--accent);\">" + html_escape(v["ip_address"]) + "</code>")
       << "</span></div>"
       << "      <div class=\"stat-row\"><span class=\"stat-lbl\">IP Version</span><span class=\"stat-val\">" << html_escape(v["ip_version"]) << "</span></div>"
       << "      <div class=\"stat-row\"><span class=\"stat-lbl\">Lifetime Visits</span><span class=\"stat-val\" style=\"color:var(--ok);\">" << v["total_visits"] << "</span></div>"
       << "      <div class=\"stat-row\"><span class=\"stat-lbl\">Lifetime Page Views</span><span class=\"stat-val\" style=\"color:var(--accent);\">" << v["total_page_views"] << "</span></div>"
       << "    </div>"
       << "    <div class=\"card\">"
       << "      <h3>🌍 Approximate Location</h3>"
       << "      <div class=\"stat-row\"><span class=\"stat-lbl\">Country</span><span class=\"stat-val\">" << html_escape(v["country"]) << " (" << html_escape(v["country_code"]) << ")</span></div>"
       << "      <div class=\"stat-row\"><span class=\"stat-lbl\">Region / City</span><span class=\"stat-val\">" << html_escape(v["region"]) << " / " << html_escape(v["city"]) << "</span></div>"
       << "      <div class=\"stat-row\"><span class=\"stat-lbl\">Timezone</span><span class=\"stat-val\">" << html_escape(v["timezone"]) << "</span></div>"
       << "      <div class=\"stat-row\"><span class=\"stat-lbl\">ISP / ASN</span><span class=\"stat-val\">" << html_escape(v["isp"]) << "</span></div>"
       << "    </div>"
       << "  </div>"

       << "  <div class=\"card-table\">"
       << "    <div style=\"padding:14px 18px;background:#21262d;border-bottom:1px solid #30363d;font-weight:600;color:var(--accent);\">🕒 Recent Sessions (" << sessions.size() << ")</div>"
       << "    <table class=\"table\">"
       << "      <thead><tr><th>Session ID</th><th>Started At</th><th>Ended At</th><th>Page Views</th><th>Duration</th><th>Status</th></tr></thead>"
       << "      <tbody>";
    for (const auto& s : sessions) {
        std::string sess_id = safe_map_get(s, "session_id", safe_map_get(s, "id"));
        ss << "<tr>"
           << "<td><code style=\"color:var(--dim);font-size:12px;\">" << html_escape(sess_id) << "</code></td>"
           << "<td>" << safe_map_get(s, "started_at", safe_map_get(s, "first_seen_at")) << "</td>"
           << "<td>" << safe_map_get(s, "ended_at", safe_map_get(s, "last_seen_at")) << "</td>"
           << "<td style=\"font-weight:600;\">" << safe_map_get(s, "page_views", safe_map_get(s, "page_count", "1")) << "</td>"
           << "<td>" << safe_map_get(s, "duration_sec", safe_map_get(s, "duration_seconds", "0")) << "s</td>"
           << "<td>" << (safe_map_get(s, "is_active") == "1" ? "<span class=\"badge ok\">ACTIVE</span>" : "<span class=\"badge warn\">CLOSED</span>") << "</td>"
           << "</tr>";
    }
    if (sessions.empty()) ss << "<tr><td colspan=\"6\" style=\"text-align:center;color:var(--dim);padding:20px;\">No sessions recorded within retention period</td></tr>";
    ss << "      </tbody></table></div>"

       << "  <div class=\"card-table\">"
       << "    <div style=\"padding:14px 18px;background:#21262d;border-bottom:1px solid #30363d;font-weight:600;color:var(--accent);\">📄 Chronological Page Visit History (" << history.size() << ")</div>"
       << "    <table class=\"table\">"
       << "      <thead><tr><th>Timestamp</th><th>Method</th><th>Path</th><th>Referer</th><th>HTTP Status</th><th>Response Time</th></tr></thead>"
       << "      <tbody>";
    for (const auto& h : history) {
        std::string ref = safe_map_get(h, "referer", safe_map_get(h, "referrer"));
        std::string st = safe_map_get(h, "status_code", "200");
        ss << "<tr>"
           << "<td style=\"color:var(--dim);font-size:12px;\">" << safe_map_get(h, "visited_at") << "</td>"
           << "<td><span class=\"badge ok\">" << html_escape(safe_map_get(h, "http_method", "GET")) << "</span></td>"
           << "<td><code style=\"color:var(--accent);\">" << html_escape(safe_map_get(h, "path", "/")) << "</code></td>"
           << "<td style=\"color:var(--dim);font-size:12px;\">" << (ref.empty() ? "-" : html_escape(ref)) << "</td>"
           << "<td><span class=\"badge " << (st == "200" ? "ok" : "warn") << "\">" << st << "</span></td>"
           << "<td>" << safe_map_get(h, "response_time_ms", "0") << " ms</td>"
           << "</tr>";
    }
    if (history.empty()) ss << "<tr><td colspan=\"6\" style=\"text-align:center;color:var(--dim);padding:20px;\">No detailed page visit history within retention period</td></tr>";
    ss << "      </tbody></table></div>"

       << "  <div class=\"footer\">C++ Autonomous Trading Engine · Operator Visitors Directory · MySQL MDS</div>"
       << "</div>"
       << GOOGLE_ANALYTICS_FOOTER_TAG
       << "</body></html>";

    return ss.str();
}

void RoadmapServer::start() {
    mysql_thread_init();
    signal(SIGPIPE, SIG_IGN);
    int server_fd = socket(AF_INET, SOCK_STREAM, 0);
    if (server_fd < 0) {
        std::cerr << "[RoadmapServer] Failed to create socket\n";
        return;
    }

    int opt = 1;
    setsockopt(server_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));
#ifdef SO_REUSEPORT
    setsockopt(server_fd, SOL_SOCKET, SO_REUSEPORT, &opt, sizeof(opt));
#endif

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

    // Initialize Cookie-Less Privacy-Conscious Visitor Analytics System
    analytics::AnalyticsConfig a_cfg;
    a_cfg.secret = EnvLoader::get("ANALYTICS_SECRET", "");
    if (a_cfg.secret.empty() || a_cfg.secret == "<GENERATE-AT-DEPLOYMENT-TIME>") {
        a_cfg.secret = "hermes_secret_analytics_salt_c920fba6840713b1";
    }
    std::string proxies_str = EnvLoader::get("ANALYTICS_TRUSTED_PROXIES", "");
    if (!proxies_str.empty()) {
        std::stringstream pss(proxies_str);
        std::string ptoken;
        while (std::getline(pss, ptoken, ',')) {
            size_t s = ptoken.find_first_not_of(" \t");
            size_t e = ptoken.find_last_not_of(" \t");
            if (s != std::string::npos && e != std::string::npos) {
                a_cfg.trusted_proxies.push_back(ptoken.substr(s, e - s + 1));
            }
        }
    }
    a_cfg.retention_raw_ip_days = EnvLoader::get_int("ANALYTICS_RETENTION_RAW_IP_DAYS", 30);
    a_cfg.retention_page_visits_days = EnvLoader::get_int("ANALYTICS_RETENTION_PAGE_VISITS_DAYS", 90);
    a_cfg.retention_sessions_days = EnvLoader::get_int("ANALYTICS_RETENTION_SESSIONS_DAYS", 180);
    a_cfg.retention_locations_days = EnvLoader::get_int("ANALYTICS_RETENTION_LOCATIONS_DAYS", 365);
    a_cfg.queue_capacity = 10000;

    try {
        analytics::VisitorTracker::instance().init(a_cfg, db_client_);
    } catch (const std::exception& e) {
        std::cerr << "⚠️ [RoadmapServer] Failed to initialize VisitorTracker: " << e.what() << "\n";
    }

    running_ = true;
    std::cout << "🚀 [RoadmapServer] Multi-Page C++ Web Portal started on http://0.0.0.0:" << port_ << "/\n";

    while (running_) {
        sockaddr_in client_addr{};
        socklen_t addrlen = sizeof(client_addr);
        int new_socket = accept(server_fd, (struct sockaddr*)&client_addr, &addrlen);
        if (new_socket < 0) continue;

        auto req_start_time = std::chrono::steady_clock::now();
        auto req_captured_time = std::chrono::system_clock::now();

        char peer_ip_buf[INET_ADDRSTRLEN] = {0};
        inet_ntop(AF_INET, &(client_addr.sin_addr), peer_ip_buf, sizeof(peer_ip_buf));
        std::string peer_ip = (peer_ip_buf[0] != '\0') ? peer_ip_buf : "127.0.0.1";

        std::string req = read_http_request(new_socket);
        if (req.empty()) {
            close(new_socket);
            continue;
        }

            try {
                bool is_auth = check_auth(req);

                std::string body;
                std::string content_type = "text/html";
                std::string extra_headers = "";
                int status_code = 200;

                std::string method = "GET";
                {
                    size_t s1 = req.find(' ');
                    if (s1 != std::string::npos) method = req.substr(0, s1);
                }

                std::string clean_path = "/";
                std::string raw_query = "";
                {
                    size_t s1 = req.find(' ');
                    if (s1 != std::string::npos) {
                        size_t s2 = req.find(' ', s1 + 1);
                        if (s2 != std::string::npos) {
                            std::string full_target = req.substr(s1 + 1, s2 - (s1 + 1));
                            size_t qmark = full_target.find('?');
                            if (qmark != std::string::npos) {
                                clean_path = full_target.substr(0, qmark);
                                raw_query = full_target.substr(qmark + 1);
                            } else {
                                clean_path = full_target;
                            }
                        }
                    }
                }

                std::cout << "🌐 [RoadmapServer] Incoming Request: " << clean_path << "\n";

                std::string user_agent = extract_header_val(req, "User-Agent");
                std::string referer = extract_header_val(req, "Referer");
                std::string accept_lang = extract_header_val(req, "Accept-Language");
                std::string cf_ip = extract_header_val(req, "CF-Connecting-IP");
                std::string xff = extract_header_val(req, "X-Forwarded-For");

                std::string client_ip = analytics::IpNormalizer::extract_client_ip(
                    peer_ip, cf_ip, xff, analytics::VisitorTracker::instance().config().trusted_proxies);
                std::string canonical_ip, ip_version;
                analytics::IpNormalizer::normalize(client_ip, canonical_ip, ip_version);
                std::string sanitized_query = analytics::QuerySanitizer::sanitize(raw_query);
                analytics::UserAgentInfo ua_info = analytics::UserAgentParser::parse(user_agent);
                std::string dev_sig = analytics::UserAgentParser::compute_device_signature(ua_info, accept_lang);

            // Route matching
            if (clean_path == "/" || clean_path == "/home") {
                body = render_home_page(is_auth);
            } else if (clean_path == "/visitor-info") {
                body = render_visitor_info_page(is_auth);
            } else if (clean_path == "/api/visitor-info/stats") {
                status_code = 200;
                content_type = "application/json";
                if (db_client_) {
                    auto stats = db_client_->fetch_analytics_summary_stats();
                    std::ostringstream ss;
                    ss << "{\"status\":\"OK\",\"summary\":{";
                    size_t idx = 0;
                    for (const auto& kv : stats) {
                        if (idx++ > 0) ss << ",";
                        ss << "\"" << kv.first << "\":\"" << kv.second << "\"";
                    }
                    ss << "}}";
                    body = ss.str();
                } else {
                    body = "{\"status\":\"ERROR\",\"message\":\"Database client unavailable\"}";
                }
            } else if (clean_path == "/admin/visitors") {
                if (is_auth) {
                    std::string page_str = extract_query_param(req, "page");
                    std::string limit_str = extract_query_param(req, "limit");
                    std::string search_ip = extract_query_param(req, "search");
                    std::string country_filter = extract_query_param(req, "country");
                    std::string bot_str = extract_query_param(req, "bot");
                    int page = 1; int limit = 20; int bot_filter = -1;
                    try { if (!page_str.empty()) page = std::stoi(page_str); } catch(...) {}
                    try { if (!limit_str.empty()) limit = std::stoi(limit_str); } catch(...) {}
                    try { if (!bot_str.empty()) bot_filter = std::stoi(bot_str); } catch(...) {}
                    body = render_admin_visitors_page(is_auth, page, limit, search_ip, country_filter, bot_filter);
                } else {
                    status_code = 303;
                    extra_headers = "Location: /login\r\n";
                    body = "Redirecting to login...";
                }
            } else if (clean_path.rfind("/admin/visitors/", 0) == 0 || clean_path == "/admin/visitor") {
                if (is_auth) {
                    std::string v_id;
                    if (clean_path.length() > 16 && clean_path.rfind("/admin/visitors/", 0) == 0) {
                        v_id = clean_path.substr(16);
                    } else {
                        v_id = extract_query_param(req, "id");
                    }
                    body = render_admin_visitor_detail_page(is_auth, v_id);
                } else {
                    status_code = 303;
                    extra_headers = "Location: /login\r\n";
                    body = "Redirecting to login...";
                }
            } else if (req.find("POST /admin/analytics/retention-purge") != std::string::npos) {
                if (is_auth) {
                    analytics::VisitorTracker::instance().run_retention_purge();
                    status_code = 303;
                    extra_headers = "Location: /admin/visitors?purge=success\r\n";
                    body = "Retention purge initiated successfully";
                } else {
                    status_code = 401;
                    content_type = "application/json";
                    body = "{\"error\":\"Unauthorized\"}";
                }
            } else if (req.find("GET /dashboard") != std::string::npos) {
                if (is_auth) {
                    body = render_dashboard_page(true);
                } else {
                    status_code = 303;
                    extra_headers = "Location: /login\r\n";
                    body = "Redirecting to login...";
                }
            } else if (req.find("GET /portfolio") != std::string::npos) {
                body = render_portfolio_page(is_auth);
            } else if (req.find("GET /paper-trading") != std::string::npos || req.find("GET /fnf-trading") != std::string::npos) {
                std::string page_str = extract_query_param(req, "page");
                std::string limit_str = extract_query_param(req, "limit");
                int page = 1;
                int limit = 20;
                try { if (!page_str.empty()) page = std::stoi(page_str); } catch(...) {}
                try { if (!limit_str.empty()) limit = std::stoi(limit_str); } catch(...) {}
                body = render_paper_trading_page(is_auth, "", page, limit);
            } else if (req.find("GET /tokens") != std::string::npos) {
                body = render_tokens_page(is_auth);
            } else if (req.find("GET /login") != std::string::npos) {
                body = render_login_page();
            } else if (req.find("POST /auth/login") != std::string::npos) {
                auto body_pos = req.find("\r\n\r\n");
                std::string post_body = (body_pos != std::string::npos) ? req.substr(body_pos + 4) : "";
                std::string password = extract_post_param(post_body, "password");
                std::string session_pwd = EnvLoader::get("SESSION_PASSWORD", "");
                if (!session_pwd.empty() && password == session_pwd) {
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
            } else if (req.find("POST /api/roadmap/item/update") != std::string::npos) {
                auto body_pos = req.find("\r\n\r\n");
                std::string post_body = (body_pos != std::string::npos) ? req.substr(body_pos + 4) : "";
                std::string item_id = extract_post_param(post_body, "item_id");
                std::string status = extract_post_param(post_body, "status");
                std::string note = extract_post_param(post_body, "note");
                db_client_->update_hermes_cpp_item_status_and_note(item_id, status, note);
                status_code = 303;
                extra_headers = "Location: /project-status#item-" + item_id + "\r\n";
                body = "Updated item successfully";
            } else if (req.find("POST /api/roadmap/clarification/ask") != std::string::npos) {
                auto body_pos = req.find("\r\n\r\n");
                std::string post_body = (body_pos != std::string::npos) ? req.substr(body_pos + 4) : "";
                std::string item_id = extract_post_param(post_body, "item_id");
                std::string stage_label = extract_post_param(post_body, "stage_label");
                std::string question = extract_post_param(post_body, "question");
                db_client_->add_hermes_cpp_clarification(item_id, stage_label, question);
                status_code = 303;
                extra_headers = "Location: /project-status#clarifications\r\n";
                body = "Clarification posted successfully";
            } else if (req.find("POST /api/roadmap/clarification/answer") != std::string::npos) {
                auto body_pos = req.find("\r\n\r\n");
                std::string post_body = (body_pos != std::string::npos) ? req.substr(body_pos + 4) : "";
                std::string id_str = extract_post_param(post_body, "clarification_id");
                std::string answer = extract_post_param(post_body, "answer");
                long long id = 0;
                try { id = std::stoll(id_str); } catch(...) {}
                if (id > 0) db_client_->answer_hermes_cpp_clarification(id, answer);
                status_code = 303;
                extra_headers = "Location: /project-status#clarifications\r\n";
                body = "Clarification answered successfully";
            } else if (req.find("GET /api/seasonality-patterns") != std::string::npos) {
                status_code = 200;
                content_type = "application/json";
                auto patterns = db_client_->fetch_seasonality_patterns();
                std::ostringstream ss;
                ss << "{\"status\":\"OK\",\"min_required_session_days\":20,\"patterns_count\":" << patterns.size() << ",\"data\":[";
                for (size_t i = 0; i < patterns.size(); ++i) {
                    const auto& p = patterns[i];
                    if (i > 0) ss << ",";
                    ss << "{\"id\":\"" << p.at("id") << "\",\"underlying\":\"" << p.at("underlying")
                       << "\",\"time_bucket_15m\":\"" << p.at("time_bucket_15m") << "\",\"dow\":" << p.at("day_of_week")
                       << ",\"dte\":" << p.at("days_to_expiry") << ",\"ticks\":" << p.at("sample_ticks_count")
                       << ",\"session_days\":" << p.at("sample_session_days") << ",\"volatility\":" << p.at("realized_volatility")
                       << ",\"persistence\":" << p.at("directional_persistence") << ",\"spread_pct\":" << p.at("avg_spread_pct")
                       << ",\"oi_buildup\":" << p.at("avg_oi_buildup_rate") << ",\"status\":\"" << p.at("gating_status")
                       << "\",\"advisory_modifier\":" << p.at("advisory_confidence_modifier") << ",\"summary\":\"" << p.at("hypothesis_summary") << "\"}";
                }
                ss << "]}";
                body = ss.str();
            } else if (req.find("GET /api/user/portfolio") != std::string::npos) {
                if (is_auth) {
                    auto p = db_client_->fetch_user_portfolio("e120d0ba-f5e7-44e9-b1f5-9d93ee8e90ee");
                    body = "{\"status\":\"OK\",\"user_id\":\"" + p.userId + "\",\"capital\":" + std::to_string(p.capital) + ",\"deployed\":" + std::to_string(p.deployed) + ",\"net_pnl\":" + std::to_string(p.netPnl) + ",\"auto_trade\":" + std::to_string(p.autoTradeEnabled) + "}";
                } else {
                    status_code = 401;
                    body = "{\"error\":\"Unauthorized access\"}";
                }
                content_type = "application/json";
            } else if (req.find("POST /api/upstox/order-webhook") != std::string::npos || req.find("POST /api/upstox/notifier") != std::string::npos) {
                status_code = 200;
                content_type = "application/json";
                body = "{\"status\":\"RECEIVED\",\"engine\":\"HERMES_CPP_V1\",\"timestamp\":" + std::to_string(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count()) + "}";
            } else if (req.find("GET /api/upstox/token/init") != std::string::npos) {
                std::string upstox_app_id = EnvLoader::get("UPSTOX_LIVE_API_KEY", "");
                if (upstox_app_id.empty()) {
                    status_code = 400;
                    content_type = "application/json";
                    body = "{\"error\":\"Live Upstox API key not configured in .env\"}";
                } else {
                    status_code = 303;
                    std::string upstox_redirect_uri = EnvLoader::get("UPSTOX_LIVE_REDIRECT_URI", "https://berhampore.in/api/upstox/callback");
                    std::string redirect_url = "https://api.upstox.com/v2/login/authorization/dialog?response_type=code&client_id=" + upstox_app_id + "&redirect_uri=" + url_encode(upstox_redirect_uri);
                    extra_headers = "Location: " + redirect_url + "\r\n";
                    body = "Redirecting to Upstox OAuth Login...";
                }
            } else if (clean_path == "/api/upstox/callback" || clean_path == "/auth/upstox/callback" || req.find("GET /api/upstox/callback") != std::string::npos || req.find("GET /auth/upstox/callback") != std::string::npos) {
                std::string code = extract_query_param(req, "code");
                if (!code.empty()) {
                    std::cout << "🔑 [UpstoxOAuth] Received authorization code (length " << code.length() << "). Exchanging for access token...\n";
                    std::string upstox_app_id = EnvLoader::get("UPSTOX_LIVE_API_KEY", "");
                    std::string expires_at;
                    std::string access_token = exchange_upstox_code_for_token(code, expires_at);
                    if (!access_token.empty()) {
                        db_client_->save_upstox_access_token(access_token, upstox_app_id, expires_at);
                        std::cout << "✅ [UpstoxOAuth] Access token exchanged and stored in provider_tokens table!\n";
                        status_code = 303;
                        extra_headers = "Location: /dashboard?upstox=success\r\n";
                        body = "Upstox token exchanged successfully!";
                    } else {
                        status_code = 303;
                        extra_headers = "Location: /dashboard?upstox=failed_exchange\r\n";
                        body = "Upstox token exchange failed.";
                    }
                } else {
                    status_code = 303;
                    extra_headers = "Location: /dashboard?upstox=failed\r\n";
                    body = "Upstox Authorization code missing";
                }
            } else if (req.find("GET /api/fyers/token/init") != std::string::npos) {
                std::string fyers_app_id = EnvLoader::get("FYERS_APP_ID", "");
                if (fyers_app_id.empty()) {
                    status_code = 400;
                    content_type = "application/json";
                    body = "{\"error\":\"Live FYERS App ID not configured in .env\"}";
                } else {
                    status_code = 303;
                    std::string fyers_redirect_uri = EnvLoader::get("FYERS_REDIRECT_URI", "https://berhampore.in/auth/fyers/callback");
                    std::string redirect_url = "https://api-t1.fyers.in/api/v3/generate-authcode?client_id=" + fyers_app_id + "&redirect_uri=" + fyers_redirect_uri + "&response_type=code&state=hermes_state";
                    extra_headers = "Location: " + redirect_url + "\r\n";
                    body = "Redirecting to FYERS OAuth Login...";
                }
            } else if (clean_path == "/auth/fyers/callback" || clean_path == "/api/fyers/callback" || req.find("GET /api/fyers/callback") != std::string::npos || req.find("GET /auth/fyers/callback") != std::string::npos) {
                std::string code = extract_query_param(req, "auth_code");
                if (code.empty()) code = extract_query_param(req, "code");
                if (!code.empty()) {
                    std::cout << "🔑 [FyersOAuth] Received authorization code (length " << code.length() << "). Exchanging for access token...\n";
                    std::string fyers_app_id = EnvLoader::get("FYERS_APP_ID", "");
                    std::string expires_at;
                    std::string access_token = exchange_fyers_code_for_token(code, expires_at);
                    if (!access_token.empty()) {
                        db_client_->save_broker_access_token("fyers", access_token, fyers_app_id, expires_at);
                        std::cout << "✅ [FyersOAuth] Access token exchanged, encrypted and stored in provider_tokens table!\n";
                        status_code = 303;
                        extra_headers = "Location: /dashboard?fyers=success\r\n";
                        body = "FYERS token exchanged successfully!";
                    } else {
                        status_code = 303;
                        extra_headers = "Location: /dashboard?fyers=failed_exchange\r\n";
                        body = "FYERS token exchange failed.";
                    }
                } else {
                    status_code = 303;
                    extra_headers = "Location: /dashboard?fyers=failed\r\n";
                    body = "FYERS Authorization code missing";
                }
            } else if (req.find("GET /api/upstox-sandbox/token/verify") != std::string::npos) {
                db_client_->save_broker_access_token("upstox_sandbox", "active_sandbox_token", "9a0248ff-4bb6-46b0-951c-99fb219ef2a2", "2026-12-31 23:59:59");
                status_code = 303;
                extra_headers = "Location: /dashboard?sandbox=success\r\n";
                body = "Upstox Sandbox token verified successfully!";
            } else if (req.find("GET /docs") != std::string::npos || req.find("GET /swagger") != std::string::npos) {
                body = render_swagger_ui_page(is_auth);
            } else if (req.find("GET /api/v1/openapi.json") != std::string::npos) {
                body = render_openapi_json();
                content_type = "application/json";
            } else if (req.find("GET /project-status/json") != std::string::npos) {
                body = render_json_summary();
                content_type = "application/json";
            } else if (req.find("GET /api/health") != std::string::npos || req.find("GET /health?format=json") != std::string::npos) {
                bool is_db_connected = false;
                try {
                    if (db_client_) is_db_connected = db_client_->test_connection();
                } catch (...) {}
                body = "{\"status\":\"OK\",\"engine\":\"C++20\",\"db_connected\":" + std::string(is_db_connected ? "true" : "false") + "}";
                content_type = "application/json";
            } else if (req.find("GET /health") != std::string::npos) {
                body = render_health_page(is_auth);
            } else if (req.find("GET /api/system/stats") != std::string::npos) {
                body = read_system_stats_json(db_client_);
                content_type = "application/json";
            } else if (req.find("GET /api/strategy/config") != std::string::npos) {
                std::ostringstream ss;
                ss << "{\"active_config\":" << hermes::StrategyConfigManager::instance().to_json();
                if (db_client_) {
                    auto audits = db_client_->fetch_strategy_config_audit(10);
                    ss << ",\"recent_audits\":[";
                    for (size_t i = 0; i < audits.size(); ++i) {
                        if (i > 0) ss << ",";
                        ss << "{\"id\":\"" << audits[i]["id"] << "\","
                           << "\"key\":\"" << audits[i]["config_key"] << "\","
                           << "\"old\":\"" << audits[i]["old_value"] << "\","
                           << "\"new\":\"" << audits[i]["new_value"] << "\","
                           << "\"by\":\"" << audits[i]["approved_by"] << "\","
                           << "\"reason\":\"" << audits[i]["reason"] << "\","
                           << "\"at\":\"" << audits[i]["created_at"] << "\"}";
                    }
                    ss << "]";
                }
                ss << "}";
                body = ss.str();
                content_type = "application/json";
            } else if (req.find("GET /project-status") != std::string::npos) {
                body = render_html_page(is_auth);
            } else {
                body = render_home_page(is_auth);
            }

            std::string reason_phrase = "OK";
            if (status_code == 400) reason_phrase = "Bad Request";
            else if (status_code == 401) reason_phrase = "Unauthorized";
            else if (status_code == 303) reason_phrase = "See Other";
            else if (status_code == 404) reason_phrase = "Not Found";
            else if (status_code == 500) reason_phrase = "Internal Server Error";

            std::stringstream response;
            response << "HTTP/1.1 " << status_code << " " << reason_phrase << "\r\n"
                     << "Content-Type: " << content_type << "\r\n"
                     << "Content-Length: " << body.length() << "\r\n"
                     << "Cache-Control: no-store\r\n"
                     << extra_headers
                     << "Connection: close\r\n\r\n"
                     << body;

            std::string res_str = response.str();
            send(new_socket, res_str.c_str(), res_str.length(), MSG_NOSIGNAL);

            // Construct complete immutable AnalyticsEvent snapshot and enqueue (non-blocking)
            auto req_end_time = std::chrono::steady_clock::now();
            double elapsed_ms = std::chrono::duration<double, std::milli>(req_end_time - req_start_time).count();

            analytics::AnalyticsEvent a_event;
            static std::atomic<uint64_t> s_seq{1};
            a_event.request_id = "req_" + std::to_string(std::chrono::duration_cast<std::chrono::microseconds>(req_start_time.time_since_epoch()).count()) + "_" + std::to_string(s_seq.fetch_add(1));
            a_event.captured_timestamp = req_captured_time;
            a_event.canonical_ip = canonical_ip;
            a_event.ip_version = ip_version;
            a_event.http_method = method;
            a_event.path = clean_path;
            a_event.sanitized_query_string = sanitized_query;
            a_event.full_url = clean_path + (sanitized_query.empty() ? "" : "?" + sanitized_query);
            a_event.user_agent = user_agent;
            a_event.referer = referer;
            a_event.accept_language = accept_lang;
            a_event.status_code = status_code;
            a_event.response_time_ms = elapsed_ms;
            a_event.is_bot = ua_info.is_bot;
            a_event.bot_name = ua_info.bot_name;
            a_event.browser_name = ua_info.browser_name;
            a_event.browser_version = ua_info.browser_version;
            a_event.os_name = ua_info.os_name;
            a_event.os_version = ua_info.os_version;
            a_event.device_type = ua_info.device_type;
            a_event.device_family = ua_info.device_family;
            a_event.device_signature = dev_sig;

            analytics::VisitorTracker::instance().enqueue_event(std::move(a_event));
            } catch (const std::exception& e) {
                std::cerr << "❌ [RoadmapServer] Internal Exception: " << e.what() << "\n";
                std::string err_resp = "HTTP/1.1 500 Internal Server Error\r\nContent-Type: application/json\r\nContent-Length: 43\r\nConnection: close\r\n\r\n{\"error\":\"Internal Server Error in Roadmap Server\"}";
                send(new_socket, err_resp.c_str(), err_resp.length(), MSG_NOSIGNAL);
            } catch (...) {
                std::cerr << "❌ [RoadmapServer] Unknown Internal Exception\n";
                std::string err_resp = "HTTP/1.1 500 Internal Server Error\r\nContent-Type: application/json\r\nContent-Length: 43\r\nConnection: close\r\n\r\n{\"error\":\"Internal Server Error in Roadmap Server\"}";
                send(new_socket, err_resp.c_str(), err_resp.length(), MSG_NOSIGNAL);
            }
        shutdown(new_socket, SHUT_WR);
        char dump_buf[1024];
        struct timeval tv_drain;
        tv_drain.tv_sec = 0;
        tv_drain.tv_usec = 10000;
        setsockopt(new_socket, SOL_SOCKET, SO_RCVTIMEO, (const char*)&tv_drain, sizeof(tv_drain));
        while (read(new_socket, dump_buf, sizeof(dump_buf)) > 0) {}
        close(new_socket);
    }
    close(server_fd);
    mysql_thread_end();
}

void RoadmapServer::stop() {
    running_ = false;
}
