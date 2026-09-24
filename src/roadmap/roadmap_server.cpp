#include "roadmap_server.hpp"
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

std::string RoadmapServer::render_html_page() {
    auto items = db_client_->fetch_all_items();
    auto ov = db_client_->compute_overview(items);

    // Group items by gate/group
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
       << "*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 -apple-system,'Segoe UI',Roboto,sans-serif;padding:20px}"
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
       << ".footer{margin-top:20px;padding-top:14px;border-top:1px solid var(--line);color:var(--dim);font-size:12.5px}"
       << "</style></head><body>"
       << "<div class=\"masthead\">"
       << "  <h1>⚡ C++ Autonomous Trading Agent — Project Roadmap (/project-status)</h1>"
       << "  <div class=\"meta\">High-Performance C++ Server (Port " << port_ << ") · Source: Oracle Cloud MySQL (<code>project_checklist_items</code>)</div>"
       << "</div>"
       << "<div class=\"card summary\">"
       << "  <div><div class=\"meta\">Overall Progress</div><b>" << ov.done << "<span class=\"dim\">/" << ov.total << "</span></b> <span class=\"dim\">(" << ov.pct << "%)</span></div>"
       << "  <div><div class=\"meta\">In Progress</div><b class=\"warn\">" << ov.in_progress << "</b></div>"
       << "  <div><div class=\"meta\">Blocked</div><b class=\"bad\">" << ov.blocked << "</b></div>"
       << "  <div><div class=\"meta\">Pending</div><b class=\"dim\">" << ov.pending << "</b></div>"
       << "  <div><div class=\"pbar\"><div class=\"pfill\" style=\"width:" << ov.pct << "%\"></div></div></div>"
       << "</div>";

    // Accordions per group
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
           << "<thead><tr><th>#</th><th>Checklist Item</th><th>Status</th><th>Evidence / Note</th></tr></thead>"
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
               << "<td class=\"nowrap\"><span class=\"meta\">" << (it.note.empty() ? "—" : html_escape(it.note)) << "</span></td>"
               << "</tr>";
        }
        ss << "tbody></table></details>";
    }

    ss << "<div class=\"footer\">"
       << "C++ Autonomous Trading Agent Engine · C++ POSIX Web Server · Direct Connection to Oracle Cloud MySQL (3307)"
       << "</div>"
       << "</body></html>";

    return ss.str();
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
    std::cout << "🚀 [RoadmapServer] High-Performance C++ Server started on http://0.0.0.0:" << port_ << "/project-status\n";

    while (running_) {
        sockaddr_in client_addr{};
        socklen_t addrlen = sizeof(client_addr);
        int new_socket = accept(server_fd, (struct sockaddr*)&client_addr, &addrlen);
        if (new_socket < 0) continue;

        std::array<char, 4096> buffer;
        ssize_t valread = read(new_socket, buffer.data(), buffer.size() - 1);
        if (valread > 0) {
            buffer[valread] = '\0';
            std::string req(buffer.data());

            std::string body;
            std::string content_type = "text/html";

            if (req.find("GET /project-status/json") != std::string::npos) {
                body = render_json_summary();
                content_type = "application/json";
            } else if (req.find("GET /health") != std::string::npos) {
                body = "{\"status\":\"OK\",\"engine\":\"C++20\",\"db_connected\":" + std::string(db_client_->test_connection() ? "true" : "false") + "}";
                content_type = "application/json";
            } else {
                body = render_html_page();
                content_type = "text/html";
            }

            std::stringstream response;
            response << "HTTP/1.1 200 OK\r\n"
                     << "Content-Type: " << content_type << "\r\n"
                     << "Content-Length: " << body.length() << "\r\n"
                     << "Cache-Control: no-store\r\n"
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
