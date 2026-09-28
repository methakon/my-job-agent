#include "db_client.hpp"
#include "../engine/tick_receiver.hpp"
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
            std::cerr << "⚠️ [MySQLPool] Warning: Initial connection attempt deferred for pool slot " << (i + 1) << "\n";
            break; // Don't block startup loop if DB host is temporarily unreachable
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

    unsigned int timeout = 1;
    mysql_options(conn, MYSQL_OPT_CONNECT_TIMEOUT, &timeout);
    enum mysql_ssl_mode ssl_mode = SSL_MODE_DISABLED;
    mysql_options(conn, MYSQL_OPT_SSL_MODE, &ssl_mode);

    if (!mysql_real_connect(conn, host_.c_str(), user_.c_str(), password_.c_str(), db_name_.c_str(), port_, nullptr, 0)) {
        mysql_close(conn);
        return nullptr;
    }

    return conn;
}

MYSQL* MySQLConnectionPool::acquire() {
    std::unique_lock<std::mutex> lock(mutex_);
    if (pool_.empty()) {
        MYSQL* conn = create_connection();
        return conn;
    }

    MYSQL* conn = pool_.front();
    pool_.pop();

    if (!conn || mysql_ping(conn) != 0) {
        if (conn) mysql_close(conn);
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
    std::string query = "SELECT t.id, t.instrument, t.side, t.quantity, t.entryPrice, t.exitPrice, t.netPnl, t.status, IFNULL(t.orderedAt,''), IFNULL(t.closedAt,'') "
                        "FROM fnf_trades t "
                        "LEFT JOIN fnf_portfolios p ON t.portfolioId = p.id "
                        "WHERE (p.userId = '" + safe_uid + "' OR p.userId IS NULL) "
                        "AND t.onRealData = 1 "
                        "AND t.executionMode != 'SANDBOX' "
                        "AND t.executionProvider NOT LIKE '%SANDBOX%' "
                        "AND t.instrument NOT LIKE '%SANDBOX%' "
                        "AND t.instrument NOT LIKE 'ISO%' "
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
                tr.closedAt = row[9] ? row[9] : "";
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

std::string RoadmapDbClient::fetch_active_broker_token_raw(const std::string& provider) {
    MYSQL* conn = pool_->acquire();
    if (!conn) return "";
    std::string token;
    std::string safe_prov = escape_string(conn, provider);
    std::string query = "SELECT IFNULL(accessTokenEncrypted,'') FROM provider_tokens WHERE provider = '" + safe_prov + "' AND status IN ('active', 'TOKEN_VALID', 'ACTIVE') ORDER BY issuedAt DESC LIMIT 1;";
    if (mysql_query(conn, query.c_str()) == 0) {
        MYSQL_RES* res = mysql_store_result(conn);
        if (res) {
            MYSQL_ROW row = mysql_fetch_row(res);
            if (row && row[0]) {
                token = row[0];
            }
            mysql_free_result(res);
        }
    }
    pool_->release(conn);
    return token;
}

bool RoadmapDbClient::save_canonical_market_snapshot(const CanonicalOptionTick& tick) {
    MYSQL* conn = pool_->acquire();
    if (!conn) return false;

    std::string safe_inst = escape_string(conn, tick.instrument_key.empty() ? tick.symbol : tick.instrument_key);
    std::string safe_src = escape_string(conn, tick.provenance.empty() ? "LIVE_FEED" : tick.provenance);

    std::ostringstream ss;
    ss << "INSERT INTO fnf_market_snapshots (id, instrument, price, volume, open, high, low, close, ts, source, createdAt) "
       << "VALUES (UUID(), '" << safe_inst << "', " << tick.ltp << ", " << tick.volume << ", "
       << tick.bid_price << ", " << tick.ask_price << ", " << tick.bid_price << ", " << tick.ltp << ", NOW(), '"
       << safe_src << "', NOW(6));";

    std::string query = ss.str();
    bool ok = (mysql_query(conn, query.c_str()) == 0);
    pool_->release(conn);
    return ok;
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

std::vector<HermesCppStage> RoadmapDbClient::fetch_hermes_cpp_stages() {
    std::vector<HermesCppStage> stages;
    MYSQL* conn = pool_->acquire();
    if (!conn) return stages;

    const char* query = "SELECT s.stage_id, s.stage_label, IFNULL(s.goal,''), s.order_index, IFNULL(p.total_items,0), IFNULL(p.done_items,0), IFNULL(p.blocked_items,0), IFNULL(p.in_progress_items,0), IFNULL(p.pct_complete,0.0) FROM hermes_cpp_project_stages s LEFT JOIN hermes_cpp_stage_progress p ON s.stage_id = p.stage_id ORDER BY s.order_index ASC;";
    if (mysql_query(conn, query) == 0) {
        MYSQL_RES* res = mysql_store_result(conn);
        if (res) {
            MYSQL_ROW row;
            while ((row = mysql_fetch_row(res))) {
                HermesCppStage st;
                st.stage_id = row[0] ? row[0] : "";
                st.stage_label = row[1] ? row[1] : "";
                st.goal = row[2] ? row[2] : "";
                try {
                    st.order_index = row[3] ? std::stoi(row[3]) : 0;
                    st.total_items = row[4] ? std::stoi(row[4]) : 0;
                    st.done_items = row[5] ? std::stoi(row[5]) : 0;
                    st.blocked_items = row[6] ? std::stoi(row[6]) : 0;
                    st.in_progress_items = row[7] ? std::stoi(row[7]) : 0;
                    st.pct_complete = row[8] ? std::stod(row[8]) : 0.0;
                } catch (...) {}
                stages.push_back(st);
            }
            mysql_free_result(res);
        }
    } else {
        std::cerr << "❌ [RoadmapDbClient] fetch_hermes_cpp_stages error: " << mysql_error(conn) << "\n";
    }
    pool_->release(conn);
    return stages;
}

std::vector<HermesCppItem> RoadmapDbClient::fetch_hermes_cpp_items() {
    std::vector<HermesCppItem> items;
    MYSQL* conn = pool_->acquire();
    if (!conn) return items;

    const char* query = "SELECT item_id, stage_id, description, IFNULL(instruction,''), done_when, status, IFNULL(note,'') FROM hermes_cpp_project_checklist_items;";
    if (mysql_query(conn, query) == 0) {
        MYSQL_RES* res = mysql_store_result(conn);
        if (res) {
            MYSQL_ROW row;
            while ((row = mysql_fetch_row(res))) {
                HermesCppItem item;
                item.item_id = row[0] ? row[0] : "";
                item.stage_id = row[1] ? row[1] : "";
                item.description = row[2] ? row[2] : "";
                item.instruction = row[3] ? row[3] : "";
                item.done_when = row[4] ? row[4] : "";
                item.status = row[5] ? row[5] : "";
                item.note = row[6] ? row[6] : "";
                items.push_back(item);
            }
            mysql_free_result(res);
        }
    } else {
        std::cerr << "❌ [RoadmapDbClient] fetch_hermes_cpp_items error: " << mysql_error(conn) << "\n";
    }
    pool_->release(conn);
    return items;
}

std::vector<HermesCppClarification> RoadmapDbClient::fetch_hermes_cpp_clarifications() {
    std::vector<HermesCppClarification> list;
    MYSQL* conn = pool_->acquire();
    if (!conn) return list;

    const char* query = "SELECT id, IFNULL(item_id,''), IFNULL(stage_label,''), question, IFNULL(answer,''), status, DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s IST'), IFNULL(DATE_FORMAT(answered_at, '%Y-%m-%d %H:%i:%s IST'),'') FROM hermes_cpp_project_clarifications ORDER BY created_at DESC;";
    if (mysql_query(conn, query) == 0) {
        MYSQL_RES* res = mysql_store_result(conn);
        if (res) {
            MYSQL_ROW row;
            while ((row = mysql_fetch_row(res))) {
                HermesCppClarification cl;
                try { cl.clarification_id = row[0] ? std::stoll(row[0]) : 0; } catch(...) {}
                cl.item_id = row[1] ? row[1] : "";
                cl.stage_label = row[2] ? row[2] : "";
                cl.question = row[3] ? row[3] : "";
                cl.answer = row[4] ? row[4] : "";
                cl.status = row[5] ? row[5] : "";
                cl.created_at = row[6] ? row[6] : "";
                cl.answered_at = row[7] ? row[7] : "";
                list.push_back(cl);
            }
            mysql_free_result(res);
        }
    } else {
        std::cerr << "❌ [RoadmapDbClient] fetch_hermes_cpp_clarifications error: " << mysql_error(conn) << "\n";
    }
    pool_->release(conn);
    return list;
}

bool RoadmapDbClient::update_hermes_cpp_item_status_and_note(const std::string& item_id, const std::string& status, const std::string& note) {
    MYSQL* conn = pool_->acquire();
    if (!conn) return false;

    TransactionGuard tx(conn);
    std::string safe_id = escape_string(conn, item_id);
    std::string safe_status = escape_string(conn, status);
    std::string safe_note = escape_string(conn, note);

    std::string query;
    if (!safe_note.empty()) {
        query = "UPDATE hermes_cpp_project_checklist_items SET status = '" + safe_status + "', note = CONCAT(IFNULL(note,''), IF(note IS NULL OR note='', '', '\n'), '" + safe_note + "') WHERE item_id = '" + safe_id + "';";
    } else {
        query = "UPDATE hermes_cpp_project_checklist_items SET status = '" + safe_status + "' WHERE item_id = '" + safe_id + "';";
    }

    if (mysql_query(conn, query.c_str()) != 0) {
        std::cerr << "❌ [RoadmapDbClient] update_hermes_cpp_item error: " << mysql_error(conn) << "\n";
        return false;
    }

    bool ok = tx.commit();
    pool_->release(conn);
    return ok;
}

bool RoadmapDbClient::add_hermes_cpp_clarification(const std::string& item_id, const std::string& stage_label, const std::string& question) {
    MYSQL* conn = pool_->acquire();
    if (!conn) return false;

    TransactionGuard tx(conn);
    std::string safe_item = escape_string(conn, item_id);
    std::string safe_stage = escape_string(conn, stage_label);
    std::string safe_q = escape_string(conn, question);

    std::string query = "INSERT INTO hermes_cpp_project_clarifications (item_id, stage_label, question, status, created_at) "
                        "VALUES (" + (safe_item.empty() ? "NULL" : "'" + safe_item + "'") + ", "
                        + (safe_stage.empty() ? "NULL" : "'" + safe_stage + "'") + ", '" + safe_q + "', 'pending', NOW());";

    if (mysql_query(conn, query.c_str()) != 0) {
        std::cerr << "❌ [RoadmapDbClient] add_hermes_cpp_clarification error: " << mysql_error(conn) << "\n";
        return false;
    }

    bool ok = tx.commit();
    pool_->release(conn);
    return ok;
}

bool RoadmapDbClient::answer_hermes_cpp_clarification(long long id, const std::string& answer) {
    MYSQL* conn = pool_->acquire();
    if (!conn) return false;

    TransactionGuard tx(conn);
    std::string safe_ans = escape_string(conn, answer);

    std::string query = "UPDATE hermes_cpp_project_clarifications SET answer = '" + safe_ans + "', status = 'answered', answered_at = NOW() WHERE id = " + std::to_string(id) + ";";

    if (mysql_query(conn, query.c_str()) != 0) {
        std::cerr << "❌ [RoadmapDbClient] answer_hermes_cpp_clarification error: " << mysql_error(conn) << "\n";
        return false;
    }

    bool ok = tx.commit();
    pool_->release(conn);
    return ok;
}

bool RoadmapDbClient::log_decision_journal_record(const std::string& uuid, const std::string& session_id, const std::string& git_sha, const std::string& version, const std::string& symbol, const std::string& action, double confidence, double margin, const std::string& reason, const std::string& snapshot_json) {
    MYSQL* conn = pool_->acquire();
    if (!conn) return false;

    TransactionGuard tx(conn);
    std::string s_uuid = escape_string(conn, uuid);
    std::string s_sess = escape_string(conn, session_id);
    std::string s_git  = escape_string(conn, git_sha);
    std::string s_ver  = escape_string(conn, version);
    std::string s_sym  = escape_string(conn, symbol);
    std::string s_act  = escape_string(conn, action);
    std::string s_rsn  = escape_string(conn, reason);
    std::string s_json = escape_string(conn, snapshot_json);

    std::string query = "INSERT INTO hermes_cpp_decision_journal (decision_uuid, session_id, git_commit_sha, engine_version, symbol, action, confidence, allocated_margin, reason, feature_snapshot_json, created_at) "
                        "VALUES ('" + s_uuid + "', '" + s_sess + "', '" + s_git + "', '" + s_ver + "', '" + s_sym + "', '" + s_act + "', "
                        + std::to_string(confidence) + ", " + std::to_string(margin) + ", '" + s_rsn + "', '" + s_json + "', NOW());";

    if (mysql_query(conn, query.c_str()) != 0) {
        std::cerr << "❌ [RoadmapDbClient] log_decision_journal_record error: " << mysql_error(conn) << "\n";
        return false;
    }

    bool ok = tx.commit();
    pool_->release(conn);
    return ok;
}

bool RoadmapDbClient::fetch_decision_journal_record(const std::string& uuid, std::string& out_session_id, std::string& out_git_sha, std::string& out_version, std::string& out_symbol, std::string& out_action, double& out_confidence, double& out_margin, std::string& out_reason, std::string& out_snapshot_json) {
    MYSQL* conn = pool_->acquire();
    if (!conn) return false;

    std::string s_uuid = escape_string(conn, uuid);
    std::string query = "SELECT session_id, git_commit_sha, engine_version, symbol, action, confidence, allocated_margin, reason, feature_snapshot_json FROM hermes_cpp_decision_journal WHERE decision_uuid = '" + s_uuid + "';";

    bool found = false;
    if (mysql_query(conn, query.c_str()) == 0) {
        MYSQL_RES* res = mysql_store_result(conn);
        if (res) {
            MYSQL_ROW row = mysql_fetch_row(res);
            if (row) {
                out_session_id = row[0] ? row[0] : "";
                out_git_sha = row[1] ? row[1] : "";
                out_version = row[2] ? row[2] : "";
                out_symbol = row[3] ? row[3] : "";
                out_action = row[4] ? row[4] : "";
                try {
                    out_confidence = row[5] ? std::stod(row[5]) : 0.0;
                    out_margin = row[6] ? std::stod(row[6]) : 0.0;
                } catch(...) {}
                out_reason = row[7] ? row[7] : "";
                out_snapshot_json = row[8] ? row[8] : "";
                found = true;
            }
            mysql_free_result(res);
        }
    }
    pool_->release(conn);
    return found;
}

std::vector<MarketSnapshotData> RoadmapDbClient::fetch_market_snapshots() {
    std::vector<MarketSnapshotData> list;
    MYSQL* conn = pool_->acquire();
    if (!conn) return list;

    const char* query = "SELECT instrument, price, volume, DATE_FORMAT(ts, '%Y-%m-%d %H:%i:%s IST') FROM fnf_market_snapshots ORDER BY ts DESC LIMIT 20;";
    if (mysql_query(conn, query) == 0) {
        MYSQL_RES* res = mysql_store_result(conn);
        if (res) {
            MYSQL_ROW row;
            while ((row = mysql_fetch_row(res))) {
                MarketSnapshotData m;
                m.instrument = row[0] ? row[0] : "";
                try {
                    m.price = row[1] ? std::stod(row[1]) : 0.0;
                    m.volume = row[2] ? std::stod(row[2]) : 0.0;
                } catch(...) {}
                m.ts = row[3] ? row[3] : "";
                m.changePct = 0.5;
                list.push_back(m);
            }
            mysql_free_result(res);
        }
    }

    pool_->release(conn);
    return list;
}

std::vector<DecayCalibrationData> RoadmapDbClient::fetch_decay_calibrations() {
    std::vector<DecayCalibrationData> list;
    MYSQL* conn = pool_->acquire();
    if (!conn) return list;

    const char* query = "SELECT weekday, decayRate, windowStartHour, windowEndHour, samples, IFNULL(DATE_FORMAT(lastRectifiedAt, '%Y-%m-%d %H:%i:%s IST'),'') FROM fnf_decay_calibrations ORDER BY weekday ASC;";
    if (mysql_query(conn, query) == 0) {
        MYSQL_RES* res = mysql_store_result(conn);
        if (res) {
            MYSQL_ROW row;
            while ((row = mysql_fetch_row(res))) {
                DecayCalibrationData d;
                try {
                    d.weekday = row[0] ? std::stoi(row[0]) : 0;
                    d.decayRate = row[1] ? std::stod(row[1]) : 0.04;
                    d.windowStartHour = row[2] ? std::stod(row[2]) : 9.5;
                    d.windowEndHour = row[3] ? std::stod(row[3]) : 15.25;
                    d.samples = row[4] ? std::stoi(row[4]) : 0;
                } catch(...) {}
                d.lastRectifiedAt = row[5] ? row[5] : "";
                list.push_back(d);
            }
            mysql_free_result(res);
        }
    }

    pool_->release(conn);
    return list;
}

LearningSummaryData RoadmapDbClient::fetch_learning_summary() {
    LearningSummaryData summary;
    MYSQL* conn = pool_->acquire();
    if (!conn) return summary;

    const char* query = "SELECT status, netPnl, IFNULL(algoSource, 'GapFadeP0Strategy') FROM fnf_trades WHERE onRealData = 1 AND executionMode != 'SANDBOX';";
    if (mysql_query(conn, query) == 0) {
        MYSQL_RES* res = mysql_store_result(conn);
        if (res) {
            MYSQL_ROW row;
            while ((row = mysql_fetch_row(res))) {
                std::string status = row[0] ? row[0] : "";
                if (status == "CLOSED") {
                    summary.totalClosed++;
                    double pnl = 0.0;
                    try { pnl = row[1] ? std::stod(row[1]) : 0.0; } catch(...) {}
                    summary.netPnl += pnl;
                    if (pnl >= 0) summary.winners++;

                    std::string algo = row[2] ? row[2] : "GapFadeP0Strategy";
                    auto& item = summary.byAlgo[algo];
                    std::get<0>(item)++;
                    std::get<2>(item) += pnl;
                }
            }
            mysql_free_result(res);
        }
    }

    if (summary.totalClosed > 0) {
        summary.winRate = (100.0 * summary.winners) / summary.totalClosed;
    }

    pool_->release(conn);
    return summary;
}

std::vector<SandboxLogData> RoadmapDbClient::fetch_sandbox_logs(int limit) {
    std::vector<SandboxLogData> list;
    MYSQL* conn = pool_->acquire();
    if (!conn) return list;

    std::string query = "SELECT id, instrument, side, quantity, entryPrice, exitPrice, netPnl, status, IFNULL(orderedAt,''), IFNULL(closedAt,''), executionProvider FROM fnf_trades WHERE onRealData = 0 OR executionMode = 'SANDBOX' OR executionProvider LIKE '%SANDBOX%' OR instrument LIKE '%SANDBOX%' ORDER BY orderedAt DESC LIMIT " + std::to_string(limit) + ";";
    if (mysql_query(conn, query.c_str()) == 0) {
        MYSQL_RES* res = mysql_store_result(conn);
        if (res) {
            MYSQL_ROW row;
            while ((row = mysql_fetch_row(res))) {
                SandboxLogData s;
                s.id = row[0] ? row[0] : "";
                s.instrument = row[1] ? row[1] : "";
                s.side = row[2] ? row[2] : "";
                try {
                    s.quantity = row[3] ? std::stoi(row[3]) : 0;
                    s.entryPrice = row[4] ? std::stod(row[4]) : 0.0;
                    s.exitPrice = row[5] ? std::stod(row[5]) : 0.0;
                    s.netPnl = row[6] ? std::stod(row[6]) : 0.0;
                } catch(...) {}
                s.status = row[7] ? row[7] : "";
                s.orderedAt = row[8] ? row[8] : "";
                s.closedAt = row[9] ? row[9] : "";
                s.executionProvider = row[10] ? row[10] : "";
                list.push_back(s);
            }
            mysql_free_result(res);
        }
    }

    pool_->release(conn);
    return list;
}
