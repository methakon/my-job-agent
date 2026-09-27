#include "db_client.hpp"
#include <iostream>
#include <sstream>
#include <algorithm>

// MySQLConnectionPool implementation
MySQLConnectionPool::MySQLConnectionPool(std::string host, int port, std::string user, std::string password, std::string db_name, size_t pool_size)
    : host_(std::move(host)), port_(port), user_(std::move(user)), password_(std::move(password)), db_name_(std::move(db_name)), pool_size_(pool_size) {
    mysql_library_init(0, nullptr, nullptr);
    for (size_t i = 0; i < pool_size_; ++i) {
        MYSQL* conn = create_connection();
        if (conn) {
            pool_.push(conn);
        } else {
            std::cerr << "⚠️ [MySQLPool] Warning: Failed to pre-allocate connection " << (i + 1) << "\n";
        }
    }
    std::cout << "✅ [MySQLPool] Native C++ Connection Pool Initialized (Active Connections: " << pool_.size() << " / " << pool_size_ << ")\n";
}

MySQLConnectionPool::~MySQLConnectionPool() {
    std::lock_guard<std::mutex> lock(mutex_);
    while (!pool_.empty()) {
        MYSQL* conn = pool_.front();
        pool_.pop();
        if (conn) {
            mysql_close(conn);
        }
    }
    mysql_library_end();
}

MYSQL* MySQLConnectionPool::create_connection() {
    MYSQL* conn = mysql_init(nullptr);
    if (!conn) {
        std::cerr << "❌ [MySQLPool] mysql_init failed\n";
        return nullptr;
    }

    unsigned int timeout = 5;
    mysql_options(conn, MYSQL_OPT_CONNECT_TIMEOUT, &timeout);

    if (!mysql_real_connect(conn, host_.c_str(), user_.c_str(), password_.c_str(), db_name_.c_str(), port_, nullptr, 0)) {
        std::cerr << "❌ [MySQLPool] Connection Error: " << mysql_error(conn) << "\n";
        mysql_close(conn);
        return nullptr;
    }

    return conn;
}

MYSQL* MySQLConnectionPool::acquire() {
    std::unique_lock<std::mutex> lock(mutex_);
    cv_.wait(lock, [this]() { return !pool_.empty(); });

    MYSQL* conn = pool_.front();
    pool_.pop();

    if (mysql_ping(conn) != 0) {
        std::cerr << "⚠️ [MySQLPool] Connection stale or lost, reconnecting...\n";
        mysql_close(conn);
        conn = create_connection();
    }

    return conn;
}

void MySQLConnectionPool::release(MYSQL* conn) {
    if (!conn) return;
    std::lock_guard<std::mutex> lock(mutex_);
    pool_.push(conn);
    cv_.notify_one();
}

// TransactionGuard implementation
TransactionGuard::TransactionGuard(MYSQL* conn) : conn_(conn), committed_(false) {
    if (conn_) {
        mysql_autocommit(conn_, false);
        mysql_query(conn_, "START TRANSACTION");
    }
}

TransactionGuard::~TransactionGuard() {
    if (conn_ && !committed_) {
        rollback();
    }
}

bool TransactionGuard::commit() {
    if (conn_ && !committed_) {
        if (mysql_commit(conn_) == 0) {
            committed_ = true;
            mysql_autocommit(conn_, true);
            return true;
        } else {
            std::cerr << "❌ [TransactionGuard] Commit failed: " << mysql_error(conn_) << "\n";
            rollback();
        }
    }
    return false;
}

void TransactionGuard::rollback() {
    if (conn_) {
        mysql_rollback(conn_);
        mysql_autocommit(conn_, true);
    }
}

// RoadmapDbClient implementation
RoadmapDbClient::RoadmapDbClient(std::string host, int port, std::string user, std::string password, std::string db_name) {
    pool_ = std::make_shared<MySQLConnectionPool>(std::move(host), port, std::move(user), std::move(password), std::move(db_name));
}

RoadmapDbClient::~RoadmapDbClient() {}

bool RoadmapDbClient::test_connection() {
    MYSQL* conn = pool_->acquire();
    if (!conn) return false;
    bool status = (mysql_ping(conn) == 0);
    pool_->release(conn);
    return status;
}

static std::string escape_string(MYSQL* conn, const std::string& input) {
    if (!conn || input.empty()) return "";
    std::vector<char> buffer(input.length() * 2 + 1);
    unsigned long len = mysql_real_escape_string(conn, buffer.data(), input.c_str(), input.length());
    return std::string(buffer.data(), len);
}

std::vector<ChecklistItem> RoadmapDbClient::fetch_all_items() {
    std::vector<ChecklistItem> items;
    MYSQL* conn = pool_->acquire();
    if (!conn) return items;

    const char* query = "SELECT id, item_order, grp, IFNULL(goal,''), item, status, IFNULL(note,''), IFNULL(instr,''), IFNULL(doneWhen,'') FROM project_checklist_items ORDER BY id ASC;";
    if (mysql_query(conn, query) == 0) {
        MYSQL_RES* res = mysql_store_result(conn);
        if (res) {
            MYSQL_ROW row;
            while ((row = mysql_fetch_row(res))) {
                ChecklistItem item;
                try {
                    item.id = row[0] ? std::stoi(row[0]) : 0;
                    item.item_order = row[1] ? std::stoi(row[1]) : 0;
                } catch (...) { continue; }
                item.grp = row[2] ? row[2] : "";
                item.goal = row[3] ? row[3] : "";
                item.item = row[4] ? row[4] : "";
                item.status = row[5] ? row[5] : "";
                item.note = row[6] ? row[6] : "";
                item.instr = row[7] ? row[7] : "";
                item.doneWhen = row[8] ? row[8] : "";
                items.push_back(item);
            }
            mysql_free_result(res);
        }
    } else {
        std::cerr << "❌ [RoadmapDbClient] fetch_all_items query error: " << mysql_error(conn) << "\n";
    }

    pool_->release(conn);
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

std::vector<CppRoadmapItem> RoadmapDbClient::fetch_cpp_roadmap_items() {
    std::vector<CppRoadmapItem> items;
    MYSQL* conn = pool_->acquire();
    if (!conn) return items;

    const char* query = "SELECT id, phase_order, phase_name, item_title, status, source_guide, IFNULL(done_when,''), IFNULL(evidence_note,'') FROM cpp_agent_roadmap_items ORDER BY phase_order ASC, id ASC;";
    if (mysql_query(conn, query) == 0) {
        MYSQL_RES* res = mysql_store_result(conn);
        if (res) {
            MYSQL_ROW row;
            while ((row = mysql_fetch_row(res))) {
                CppRoadmapItem item;
                try {
                    item.id = row[0] ? std::stoi(row[0]) : 0;
                    item.phase_order = row[1] ? std::stoi(row[1]) : 0;
                } catch (...) { continue; }
                item.phase_name = row[2] ? row[2] : "";
                item.item_title = row[3] ? row[3] : "";
                item.status = row[4] ? row[4] : "";
                item.source_guide = row[5] ? row[5] : "";
                item.done_when = row[6] ? row[6] : "";
                item.evidence_note = row[7] ? row[7] : "";
                items.push_back(item);
            }
            mysql_free_result(res);
        }
    } else {
        std::cerr << "❌ [RoadmapDbClient] fetch_cpp_roadmap_items query error: " << mysql_error(conn) << "\n";
    }

    pool_->release(conn);
    return items;
}

RoadmapOverview RoadmapDbClient::compute_cpp_overview(const std::vector<CppRoadmapItem>& items) {
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
    MYSQL* conn = pool_->acquire();
    if (!conn) return false;

    TransactionGuard tx(conn);
    std::string safe_status = escape_string(conn, status);
    std::string query = "UPDATE project_checklist_items SET status = '" + safe_status + "' WHERE id = " + std::to_string(id) + ";";

    if (mysql_query(conn, query.c_str()) != 0) {
        std::cerr << "❌ [RoadmapDbClient] update_item_status error: " << mysql_error(conn) << "\n";
        return false;
    }

    bool ok = tx.commit();
    pool_->release(conn);
    return ok;
}

bool RoadmapDbClient::update_item_note(int id, const std::string& note) {
    MYSQL* conn = pool_->acquire();
    if (!conn) return false;

    TransactionGuard tx(conn);
    std::string safe_note = escape_string(conn, note);
    std::string query = "UPDATE project_checklist_items SET note = '" + safe_note + "' WHERE id = " + std::to_string(id) + ";";

    if (mysql_query(conn, query.c_str()) != 0) {
        std::cerr << "❌ [RoadmapDbClient] update_item_note error: " << mysql_error(conn) << "\n";
        return false;
    }

    bool ok = tx.commit();
    pool_->release(conn);
    return ok;
}

UserProfile RoadmapDbClient::fetch_user_by_email_or_id(const std::string& identifier) {
    UserProfile user;
    MYSQL* conn = pool_->acquire();
    if (!conn) return user;

    std::string safe_id = escape_string(conn, identifier);
    std::string query = "SELECT id, email, name, role FROM portal_users WHERE id = '" + safe_id + "' OR email = '" + safe_id + "' LIMIT 1;";

    if (mysql_query(conn, query.c_str()) == 0) {
        MYSQL_RES* res = mysql_store_result(conn);
        if (res) {
            MYSQL_ROW row = mysql_fetch_row(res);
            if (row) {
                user.id = row[0] ? row[0] : "";
                user.email = row[1] ? row[1] : "";
                user.name = row[2] ? row[2] : "";
                user.role = row[3] ? row[3] : "";
            }
            mysql_free_result(res);
        }
    } else {
        std::cerr << "❌ [RoadmapDbClient] fetch_user error: " << mysql_error(conn) << "\n";
    }

    pool_->release(conn);
    return user;
}

UserPortfolioData RoadmapDbClient::fetch_user_portfolio(const std::string& user_id) {
    UserPortfolioData p;
    MYSQL* conn = pool_->acquire();
    if (!conn) return p;

    std::string safe_uid = escape_string(conn, user_id);
    std::string query = "SELECT id, IFNULL(userId,''), capital, deployed, netPnl, autoTradeEnabled, executionProvider, executionMode FROM fnf_portfolios WHERE userId = '" + safe_uid + "' OR userId IS NULL LIMIT 1;";

    if (mysql_query(conn, query.c_str()) == 0) {
        MYSQL_RES* res = mysql_store_result(conn);
        if (res) {
            MYSQL_ROW row = mysql_fetch_row(res);
            if (row) {
                p.portfolioId = row[0] ? row[0] : "";
                p.userId = row[1] ? row[1] : "";
                try {
                    p.capital = row[2] ? std::stod(row[2]) : 0.0;
                    p.deployed = row[3] ? std::stod(row[3]) : 0.0;
                    p.netPnl = row[4] ? std::stod(row[4]) : 0.0;
                    p.autoTradeEnabled = row[5] ? std::stoi(row[5]) : 0;
                } catch (...) {}
                p.executionProvider = row[6] ? row[6] : "";
                p.executionMode = row[7] ? row[7] : "";
            }
            mysql_free_result(res);
        }
    } else {
        std::cerr << "❌ [RoadmapDbClient] fetch_portfolio error: " << mysql_error(conn) << "\n";
    }

    pool_->release(conn);
    return p;
}

std::vector<UserTradeData> RoadmapDbClient::fetch_user_trades(const std::string& user_id, int limit) {
    std::vector<UserTradeData> trades;
    MYSQL* conn = pool_->acquire();
    if (!conn) return trades;

    std::string safe_uid = escape_string(conn, user_id);
    std::string query = "SELECT t.id, t.instrument, t.side, t.quantity, t.entryPrice, t.exitPrice, t.netPnl, t.status, IFNULL(t.orderedAt,'') "
                        "FROM fnf_trades t "
                        "LEFT JOIN fnf_portfolios p ON t.portfolioId = p.id "
                        "WHERE p.userId = '" + safe_uid + "' OR p.userId IS NULL "
                        "ORDER BY t.orderedAt DESC LIMIT " + std::to_string(limit) + ";";

    if (mysql_query(conn, query.c_str()) == 0) {
        MYSQL_RES* res = mysql_store_result(conn);
        if (res) {
            MYSQL_ROW row;
            while ((row = mysql_fetch_row(res))) {
                UserTradeData tr;
                tr.id = row[0] ? row[0] : "";
                tr.instrument = row[1] ? row[1] : "";
                tr.side = row[2] ? row[2] : "";
                try {
                    tr.quantity = row[3] ? std::stoi(row[3]) : 0;
                    tr.entryPrice = row[4] ? std::stod(row[4]) : 0.0;
                    tr.exitPrice = row[5] ? std::stod(row[5]) : 0.0;
                    tr.netPnl = row[6] ? std::stod(row[6]) : 0.0;
                } catch (...) {}
                tr.status = row[7] ? row[7] : "";
                tr.orderedAt = row[8] ? row[8] : "";
                trades.push_back(tr);
            }
            mysql_free_result(res);
        }
    } else {
        std::cerr << "❌ [RoadmapDbClient] fetch_trades error: " << mysql_error(conn) << "\n";
    }

    pool_->release(conn);
    return trades;
}

BrokerTokenInfo RoadmapDbClient::fetch_broker_token_status(const std::string& provider) {
    BrokerTokenInfo info;
    info.provider = provider;
    MYSQL* conn = pool_->acquire();
    if (!conn) return info;

    std::string safe_prov = escape_string(conn, provider);
    std::string query = "SELECT clientId, status, IFNULL(expiresAt,''), IFNULL(issuedAt,'') FROM provider_tokens WHERE provider = '" + safe_prov + "' ORDER BY issuedAt DESC LIMIT 1;";
    if (mysql_query(conn, query.c_str()) == 0) {
        MYSQL_RES* res = mysql_store_result(conn);
        if (res) {
            MYSQL_ROW row = mysql_fetch_row(res);
            if (row) {
                info.client_id = row[0] ? row[0] : "";
                info.status = row[1] ? row[1] : "EXPIRED";
                info.expires_at = row[2] ? row[2] : "";
                info.issued_at = row[3] ? row[3] : "";
                info.is_valid = (info.status == "active" || info.status == "TOKEN_VALID" || info.status == "ACTIVE");
            }
            mysql_free_result(res);
        }
    }
    pool_->release(conn);
    return info;
}

bool RoadmapDbClient::save_broker_access_token(const std::string& provider, const std::string& token, const std::string& client_id, const std::string& expires_at) {
    MYSQL* conn = pool_->acquire();
    if (!conn) return false;

    TransactionGuard tx(conn);
    std::string safe_prov = escape_string(conn, provider);
    std::string safe_token = escape_string(conn, token);
    std::string safe_cid = escape_string(conn, client_id);
    std::string safe_exp = escape_string(conn, expires_at);

    std::string query = "INSERT INTO provider_tokens (id, provider, environment, clientId, accessTokenEncrypted, status, issuedAt, expiresAt) "
                        "VALUES (UUID(), '" + safe_prov + "', 'live', '" + safe_cid + "', '" + safe_token + "', 'active', NOW(), '" + safe_exp + "');";

    if (mysql_query(conn, query.c_str()) != 0) {
        std::cerr << "❌ [RoadmapDbClient] save_broker_access_token error: " << mysql_error(conn) << "\n";
        return false;
    }

    bool ok = tx.commit();
    pool_->release(conn);
    return ok;
}

UpstoxTokenInfo RoadmapDbClient::fetch_upstox_token_status() {
    return fetch_broker_token_status("upstox");
}

bool RoadmapDbClient::save_upstox_access_token(const std::string& token, const std::string& client_id, const std::string& expires_at) {
    return save_broker_access_token("upstox", token, client_id, expires_at);
}
