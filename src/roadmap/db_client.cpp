#include "db_client.hpp"
#include <iostream>
#include <sstream>
#include <array>
#include <memory>
#include <algorithm>

RoadmapDbClient::RoadmapDbClient(std::string host, int port, std::string user, std::string password, std::string db_name)
    : host_(std::move(host)), port_(port), user_(std::move(user)), password_(std::move(password)), db_name_(std::move(db_name)) {}

RoadmapDbClient::~RoadmapDbClient() {}

static std::string exec_cmd(const std::string& cmd) {
    std::array<char, 4096> buffer;
    std::string result;
    std::unique_ptr<FILE, decltype(&pclose)> pipe(popen(cmd.c_str(), "r"), pclose);
    if (!pipe) {
        return "";
    }
    while (fgets(buffer.data(), buffer.size(), pipe.get()) != nullptr) {
        result += buffer.data();
    }
    return result;
}

static inline std::string escape_shell(const std::string& s) {
    std::string out;
    for (char c : s) {
        if (c == '\'') out += "'\\''";
        else out += c;
    }
    return "'" + out + "'";
}

bool RoadmapDbClient::test_connection() {
    std::string cmd = "MYSQL_PWD=" + escape_shell(password_) + " mysql -h " + escape_shell(host_) +
                      " -P " + std::to_string(port_) + " -u " + escape_shell(user_) +
                      " " + escape_shell(db_name_) + " -e \"SELECT 1;\" 2>&1";
    std::string out = exec_cmd(cmd);
    return out.find("1") != std::string::npos;
}

static std::vector<std::string> split_tsv_line(const std::string& line) {
    std::vector<std::string> tokens;
    std::stringstream ss(line);
    std::string item;
    while (std::getline(ss, item, '\t')) {
        tokens.push_back(item);
    }
    return tokens;
}

std::vector<ChecklistItem> RoadmapDbClient::fetch_all_items() {
    std::vector<ChecklistItem> items;
    std::string query = "SELECT id, item_order, grp, IFNULL(goal,''), item, status, IFNULL(note,''), IFNULL(instr,''), IFNULL(doneWhen,'') FROM project_checklist_items ORDER BY id ASC;";
    std::string cmd = "MYSQL_PWD=" + escape_shell(password_) + " mysql -h " + escape_shell(host_) +
                      " -P " + std::to_string(port_) + " -u " + escape_shell(user_) +
                      " " + escape_shell(db_name_) + " -B -N -e " + escape_shell(query) + " 2>/dev/null";

    std::string output = exec_cmd(cmd);
    std::stringstream ss(output);
    std::string line;

    while (std::getline(ss, line)) {
        if (line.empty()) continue;
        auto cols = split_tsv_line(line);
        if (cols.size() >= 9) {
            ChecklistItem item;
            try {
                item.id = std::stoi(cols[0]);
                item.item_order = std::stoi(cols[1]);
            } catch (...) {
                continue;
            }
            item.grp = cols[2];
            item.goal = cols[3];
            item.item = cols[4];
            item.status = cols[5];
            item.note = cols[6];
            item.instr = cols[7];
            item.doneWhen = cols[8];
            items.push_back(item);
        }
    }
    return items;
}

RoadmapOverview RoadmapDbClient::compute_overview(const std::vector<ChecklistItem>& items) {
    RoadmapOverview ov;
    ov.total = items.size();
    for (const auto& it : items) {
        if (it.status == "done") ov.done++;
        else if (it.status == "in_progress") ov.in_progress++;
        else if (it.status == "blocked") ov.blocked++;
        else ov.pending++;
    }
    if (ov.total > 0) {
        ov.pct = (ov.done * 100) / ov.total;
    }
    return ov;
}

bool RoadmapDbClient::update_item_status(int id, const std::string& status) {
    std::string query = "UPDATE project_checklist_items SET status = " + escape_shell(status) + " WHERE id = " + std::to_string(id) + ";";
    std::string cmd = "MYSQL_PWD=" + escape_shell(password_) + " mysql -h " + escape_shell(host_) +
                      " -P " + std::to_string(port_) + " -u " + escape_shell(user_) +
                      " " + escape_shell(db_name_) + " -e " + escape_shell(query) + " 2>&1";
    std::string out = exec_cmd(cmd);
    return out.empty() || out.find("ERROR") == std::string::npos;
}

bool RoadmapDbClient::update_item_note(int id, const std::string& note) {
    std::string query = "UPDATE project_checklist_items SET note = " + escape_shell(note) + " WHERE id = " + std::to_string(id) + ";";
    std::string cmd = "MYSQL_PWD=" + escape_shell(password_) + " mysql -h " + escape_shell(host_) +
                      " -P " + std::to_string(port_) + " -u " + escape_shell(user_) +
                      " " + escape_shell(db_name_) + " -e " + escape_shell(query) + " 2>&1";
    std::string out = exec_cmd(cmd);
    return out.empty() || out.find("ERROR") == std::string::npos;
}
