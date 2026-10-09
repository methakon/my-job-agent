#include "db_client.hpp"
#include "../engine/tick_receiver.hpp"
#include "../engine/upstox_historical_backfill.hpp"
#include "../common/crypto_util.hpp"
#include "../common/env_loader.hpp"
#include <iostream>
#include <sstream>
#include <algorithm>
#include <unordered_map>

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
    for (MYSQL* conn : all_created_connections_) {
        if (conn) {
            mysql_close(conn);
        }
    }
    all_created_connections_.clear();
    while (!pool_.empty()) {
        pool_.pop();
    }
    mysql_thread_end();
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
    enum mysql_ssl_mode ssl_mode = SSL_MODE_PREFERRED;
    mysql_options(conn, MYSQL_OPT_SSL_MODE, &ssl_mode);

    if (!mysql_real_connect(conn, host_.c_str(), user_.c_str(), password_.c_str(), db_name_.c_str(), port_, nullptr, 0)) {
        std::cerr << "❌ [MySQLPool] Connection failed to " << host_ << ":" << port_ << " (" << user_ << ") - " << mysql_error(conn) << "\n";
        mysql_close(conn);
        return nullptr;
    }

    all_created_connections_.insert(conn);
    return conn;
}

MYSQL* MySQLConnectionPool::acquire() {
    std::unique_lock<std::mutex> lock(mutex_);
    MYSQL* conn = nullptr;
    if (pool_.empty()) {
        conn = create_connection();
    } else {
        conn = pool_.front();
        pool_.pop();
    }

    if (!conn) {
        conn = create_connection();
    } else if (mysql_ping(conn) != 0) {
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
    pool_local_ = pool_;
}

RoadmapDbClient::RoadmapDbClient(std::string remote_host, int remote_port, std::string remote_user, std::string remote_pass, std::string remote_db,
                                 std::string local_host, int local_port, std::string local_user, std::string local_pass, std::string local_db) {
    pool_ = std::make_shared<MySQLConnectionPool>(std::move(remote_host), remote_port, std::move(remote_user), std::move(remote_pass), std::move(remote_db));
    try {
        pool_local_ = std::make_shared<MySQLConnectionPool>(std::move(local_host), local_port, std::move(local_user), std::move(local_pass), std::move(local_db));
    } catch (...) {
        std::cerr << "⚠️ [RoadmapDbClient] Local DB pool init warning; falling back to remote pool.\n";
        pool_local_ = pool_;
    }
}

RoadmapDbClient::~RoadmapDbClient() {}

MYSQL* RoadmapDbClient::acquire_local() {
    if (pool_local_) {
        MYSQL* conn = pool_local_->acquire();
        if (conn) return conn;
    }
    return pool_->acquire();
}

void RoadmapDbClient::release_local(MYSQL* conn) {
    if (!conn) return;
    if (pool_local_) {
        pool_local_->release(conn);
    } else {
        pool_->release(conn);
    }
}

bool RoadmapDbClient::test_connection() {
    MYSQL* conn = pool_->acquire();
    if (!conn) return false;
    bool status = (mysql_query(conn, "SELECT 1;") == 0);
    if (status) {
        MYSQL_RES* res = mysql_store_result(conn);
        if (res) mysql_free_result(res);
    }
    pool_->release(conn);
    return status;
}

bool RoadmapDbClient::test_local_connection() {
    MYSQL* conn = acquire_local();
    if (!conn) return false;
    bool status = (mysql_query(conn, "SELECT 1;") == 0);
    if (status) {
        MYSQL_RES* res = mysql_store_result(conn);
        if (res) mysql_free_result(res);
    }
    release_local(conn);
    return status;
}

static std::string escape_string(MYSQL* conn, const std::string& input) {
    if (!conn || input.empty()) return "";
    std::vector<char> buffer(input.length() * 2 + 1);
    unsigned long len = mysql_real_escape_string(conn, buffer.data(), input.c_str(), input.length());
    if (len == (unsigned long)-1 || len > buffer.size()) return "";
    return std::string(buffer.data(), len);
}

static std::string extract_symbol(const std::string& inst) {
    size_t pos = inst.find(" (");
    if (pos != std::string::npos) return inst.substr(0, pos);
    return inst;
}

static std::string extract_token(const std::string& inst) {
    size_t start = inst.find("(");
    size_t end = inst.find(")", start);
    if (start != std::string::npos && end != std::string::npos && end > start + 1) {
        return inst.substr(start + 1, end - start - 1);
    }
    return "";
}

static std::unordered_map<std::string, double> fetch_latest_quotes_map(MYSQL* conn) {
    std::unordered_map<std::string, double> quote_map;
    if (!conn) return quote_map;

    std::string q = "SELECT contractSymbol, IFNULL(instrumentToken,''), ltp FROM upstox_live_paper_option_quotes WHERE ts >= DATE_SUB(NOW(), INTERVAL 24 HOUR) ORDER BY ts ASC LIMIT 50000;";
    if (mysql_query(conn, q.c_str()) == 0) {
        MYSQL_RES* res = mysql_store_result(conn);
        if (res) {
            MYSQL_ROW row;
            while ((row = mysql_fetch_row(res))) {
                std::string sym = row[0] ? row[0] : "";
                std::string tok = row[1] ? row[1] : "";
                double ltp = 0.0;
                try {
                    ltp = row[2] ? std::stod(row[2]) : 0.0;
                } catch (...) {}

                if (!sym.empty() && ltp > 0) quote_map[sym] = ltp;
                if (!tok.empty() && ltp > 0) quote_map[tok] = ltp;
            }
            mysql_free_result(res);
        }
    }
    return quote_map;
}

static double lookup_ltp_from_map(const std::unordered_map<std::string, double>& quote_map, const std::string& inst, double default_fallback) {
    if (inst.empty()) return default_fallback;
    std::string sym = extract_symbol(inst);
    std::string tok = extract_token(inst);

    auto it_sym = quote_map.find(sym);
    if (it_sym != quote_map.end() && it_sym->second > 0) {
        return it_sym->second;
    }
    auto it_tok = quote_map.find(tok);
    if (it_tok != quote_map.end() && it_tok->second > 0) {
        return it_tok->second;
    }
    return default_fallback;
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
        pool_->release(conn);
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
        pool_->release(conn);
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
    std::string query = "SELECT id, id as userId, capital, deployed, netPnl, autoTradeEnabled, 'UPSTOX_PAPER' as executionProvider, executionMode FROM cpp_portfolios LIMIT 1;";

    if (mysql_query(conn, query.c_str()) == 0) {
        MYSQL_RES* res = mysql_store_result(conn);
        if (res) {
            MYSQL_ROW row = mysql_fetch_row(res);
            if (row) {
                p.portfolioId = row[0] ? row[0] : "";
                p.userId = row[1] ? row[1] : "";
                try {
                    p.capital = row[2] ? std::stod(row[2]) : 100000.0;
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

    std::string open_q = "SELECT quantity, entryPrice, side, instrument FROM cpp_trade_reports WHERE status = 'OPEN';";
    if (mysql_query(conn, open_q.c_str()) == 0) {
        MYSQL_RES* res2 = mysql_store_result(conn);
        if (res2) {
            MYSQL_ROW r;
            auto quote_map = fetch_latest_quotes_map(conn);
            p.deployed = 0.0;
            p.unrealisedPnl = 0.0;
            p.openPositionCount = 0;
            while ((r = mysql_fetch_row(res2))) {
                int qty = r[0] ? std::stoi(r[0]) : 0;
                double entry = r[1] ? std::stod(r[1]) : 0.0;
                std::string side = r[2] ? r[2] : "BUY";
                std::string inst = r[3] ? r[3] : "";
                p.deployed += (qty * entry);
                double cur_ltp = lookup_ltp_from_map(quote_map, inst, entry);
                p.unrealisedPnl += (side == "BUY") ? (qty * (cur_ltp - entry)) : (qty * (entry - cur_ltp));
                p.openPositionCount++;
            }
            mysql_free_result(res2);
        }
    }

    std::string closed_q = "SELECT IFNULL(SUM(grossPnl), 0.0), IFNULL(SUM(cost), 0.0), IFNULL(SUM(netPnl), 0.0) FROM cpp_trade_reports WHERE status = 'CLOSED';";
    if (mysql_query(conn, closed_q.c_str()) == 0) {
        MYSQL_RES* res_c = mysql_store_result(conn);
        if (res_c) {
            MYSQL_ROW rc = mysql_fetch_row(res_c);
            if (rc) {
                try {
                    p.grossPnl = rc[0] ? std::stod(rc[0]) : 0.0;
                    p.totalCharges = rc[1] ? std::stod(rc[1]) : 0.0;
                    p.netPnl = rc[2] ? std::stod(rc[2]) : 0.0;
                } catch (...) {}
            }
            mysql_free_result(res_c);
        }
    }

    pool_->release(conn);
    return p;
}

std::vector<UserTradeData> RoadmapDbClient::fetch_user_trades(const std::string& user_id, int limit, int offset) {
    std::vector<UserTradeData> trades;
    MYSQL* conn = pool_->acquire();
    if (!conn) return trades;

    std::string safe_uid = escape_string(conn, user_id);
    std::string query = "SELECT id, instrument, side, quantity, entryPrice, IFNULL(exitPrice, 0.0), netPnl, status, IFNULL(orderedAt,''), IFNULL(closedAt,''), IFNULL(cost, 0.0), IFNULL(grossPnl, 0.0) "
                        "FROM cpp_trade_reports "
                        "ORDER BY orderedAt DESC LIMIT " + std::to_string(limit) + " OFFSET " + std::to_string(offset) + ";";

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
                try {
                    tr.cost = row[10] ? std::stod(row[10]) : 0.0;
                    tr.grossPnl = row[11] ? std::stod(row[11]) : 0.0;
                } catch (...) {}
                trades.push_back(tr);
            }
            mysql_free_result(res);
        }

        auto quote_map = fetch_latest_quotes_map(conn);
        for (auto& tr : trades) {
            if (tr.status == "OPEN") {
                tr.currentLtp = lookup_ltp_from_map(quote_map, tr.instrument, tr.entryPrice);
                tr.unrealizedPnl = (tr.side == "BUY") ? (tr.quantity * (tr.currentLtp - tr.entryPrice)) : (tr.quantity * (tr.entryPrice - tr.currentLtp));
            } else {
                tr.currentLtp = tr.exitPrice;
                tr.unrealizedPnl = 0.0;
            }
        }
    } else {
        std::cerr << "❌ [RoadmapDbClient] fetch_trades error: " << mysql_error(conn) << "\n";
    }

    pool_->release(conn);
    return trades;
}

int RoadmapDbClient::fetch_user_trade_count(const std::string& user_id) {
    MYSQL* conn = pool_->acquire();
    if (!conn) return 0;
    int count = 0;
    const char* query = "SELECT COUNT(*) FROM cpp_trade_reports;";
    if (mysql_query(conn, query) == 0) {
        MYSQL_RES* res = mysql_store_result(conn);
        if (res) {
            MYSQL_ROW row = mysql_fetch_row(res);
            if (row && row[0]) {
                try { count = std::stoi(row[0]); } catch(...) {}
            }
            mysql_free_result(res);
        }
    }
    pool_->release(conn);
    return count;
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
    if (client_id.empty() || 
        client_id.rfind("test_", 0) == 0 || 
        client_id.rfind("mock_", 0) == 0 || 
        client_id == "test_client_id" ||
        token.empty() || 
        token.rfind("test_", 0) == 0 || 
        token.rfind("mock_", 0) == 0) {
        std::cerr << "🛡️ [RoadmapDbClient] Guard rejected test/mock token or client ID: " << client_id << "\n";
        return false;
    }

    MYSQL* conn = pool_->acquire();
    if (!conn) return false;

    TransactionGuard tx(conn);
    std::string safe_prov = escape_string(conn, provider);

    // If provider is fyers, encrypt token via AES-256-CBC with SHA256(secret) to match NestJS schema
    std::string token_to_store = token;
    if (provider == "fyers") {
        std::string secret = EnvLoader::get("ENCRYPTION_KEY", EnvLoader::get("APP_SECRET", ""));
        token_to_store = crypto_util::encrypt_token(token, secret);
    }

    std::string safe_token = escape_string(conn, token_to_store);
    std::string safe_cid = escape_string(conn, client_id);
    std::string safe_exp = escape_string(conn, expires_at);

    // Revoke previous active tokens for this provider
    std::string revoke_q = "UPDATE provider_tokens SET status = 'revoked', statusReason = 'superseded_single_active_row', revokedAt = NOW() "
                           "WHERE provider = '" + safe_prov + "' AND environment = 'live' AND status = 'active';";
    mysql_query(conn, revoke_q.c_str());

    std::string query = "INSERT INTO provider_tokens (id, provider, environment, clientId, accessTokenEncrypted, status, issuedAt, expiresAt) "
                        "VALUES (UUID(), '" + safe_prov + "', 'live', '" + safe_cid + "', '" + safe_token + "', 'active', NOW(), '" + safe_exp + "');";

    if (mysql_query(conn, query.c_str()) != 0) {
        std::cerr << "❌ [RoadmapDbClient] save_broker_access_token error: " << mysql_error(conn) << "\n";
        pool_->release(conn);
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

    const char* query = "SELECT clarification_id, IFNULL(item_id,''), IFNULL(stage_label,''), question, IFNULL(answer,''), status, DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s IST'), IFNULL(DATE_FORMAT(answered_at, '%Y-%m-%d %H:%i:%s IST'),'') FROM hermes_cpp_project_clarifications ORDER BY created_at DESC;";
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
        pool_->release(conn);
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
        pool_->release(conn);
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

    std::string query = "UPDATE hermes_cpp_project_clarifications SET answer = '" + safe_ans + "', status = 'answered', answered_at = NOW() WHERE clarification_id = " + std::to_string(id) + ";";

    if (mysql_query(conn, query.c_str()) != 0) {
        std::cerr << "❌ [RoadmapDbClient] answer_hermes_cpp_clarification error: " << mysql_error(conn) << "\n";
        pool_->release(conn);
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
    std::string safe_uuid = (uuid.empty() || uuid == "dj-0") ? ("dj-" + std::to_string(std::chrono::high_resolution_clock::now().time_since_epoch().count())) : uuid;
    std::string s_uuid = escape_string(conn, safe_uuid);
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
        pool_->release(conn);
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

bool RoadmapDbClient::create_paper_trade(const UserTradeData& trade) {
    MYSQL* conn = pool_->acquire();
    if (!conn) return false;

    TransactionGuard tx(conn);
    std::string safe_id = escape_string(conn, trade.id);
    std::string safe_inst = escape_string(conn, trade.instrument);
    std::string safe_side = escape_string(conn, trade.side);
    std::string safe_status = escape_string(conn, trade.status.empty() ? "OPEN" : trade.status);
    std::string safe_prov = escape_string(conn, trade.executionProvider.empty() ? "UPSTOX_PAPER" : trade.executionProvider);
    std::string safe_mode = escape_string(conn, trade.executionMode.empty() ? "PAPER" : trade.executionMode);
    std::string safe_algo = escape_string(conn, trade.algoSource.empty() ? "GapFadeP0Strategy" : trade.algoSource);
    std::string safe_ordered = escape_string(conn, trade.orderedAt);
    if (trade.signal_timestamp.empty()) {
        std::cerr << "❌ [RoadmapDbClient] Rejected paper trade creation: missing mandatory signal_timestamp identity.\n";
        pool_->release(conn);
        return false;
    }

    // Expiry Pre-Insert Guard: Prevent inserting paper trades for contracts whose expiry date string (YYMMDD) is in the past
    std::string sym = extract_symbol(trade.instrument);
    // Find 6-digit date pattern YYMMDD (e.g. 261001)
    std::size_t exp_pos = std::string::npos;
    for (size_t i = 0; i + 6 <= sym.size(); ++i) {
        if (std::isdigit(sym[i]) && std::isdigit(sym[i+1]) && std::isdigit(sym[i+2]) &&
            std::isdigit(sym[i+3]) && std::isdigit(sym[i+4]) && std::isdigit(sym[i+5])) {
            exp_pos = i;
            break;
        }
    }
    if (exp_pos != std::string::npos) {
        int exp_yy = std::stoi(sym.substr(exp_pos, 2)) + 2000;
        int exp_mm = std::stoi(sym.substr(exp_pos + 2, 2));
        int exp_dd = std::stoi(sym.substr(exp_pos + 4, 2));

        time_t rawtime;
        time(&rawtime);
        struct tm* timeinfo = localtime(&rawtime);
        int cur_yy = timeinfo->tm_year + 1900;
        int cur_mm = timeinfo->tm_mon + 1;
        int cur_dd = timeinfo->tm_mday;

        long exp_date_num = exp_yy * 10000 + exp_mm * 100 + exp_dd;
        long cur_date_num = cur_yy * 10000 + cur_mm * 100 + cur_dd;

        if (exp_date_num < cur_date_num) {
            std::cerr << "❌ [RoadmapDbClient] Rejected paper trade creation: Expired contract " 
                      << sym << " (Expiry " << exp_yy << "-" << exp_mm << "-" << exp_dd 
                      << " < Current Date " << cur_yy << "-" << cur_mm << "-" << cur_dd << ").\n";
            pool_->release(conn);
            return false;
        }
    }

    std::string safe_signal_ts = escape_string(conn, trade.signal_timestamp);

    // Pre-insert idempotency guard: prevent duplicate persistent trade records based on signal_timestamp
    std::string dup_check = "SELECT id FROM cpp_trade_reports WHERE executionMode = '" + safe_mode
        + "' AND algoSource = '" + safe_algo
        + "' AND instrument = '" + safe_inst 
        + "' AND side = '" + safe_side 
        + "' AND signal_timestamp = '" + safe_signal_ts + "' LIMIT 1;";

    if (mysql_query(conn, dup_check.c_str()) == 0) {
        MYSQL_RES* res = mysql_store_result(conn);
        if (res) {
            bool duplicate_exists = (mysql_num_rows(res) > 0);
            mysql_free_result(res);
            if (duplicate_exists) {
                std::cout << "ℹ️ [RoadmapDbClient] Idempotency guard: Signal trade already persisted for " << safe_inst << " (" << safe_side << ") at ts " << safe_signal_ts << ". Skipping duplicate insertion.\n";
                pool_->release(conn);
                return true;
            }
        }
    }

    std::string query = "INSERT INTO cpp_trade_reports (id, tradeUuid, instrument, side, quantity, entryPrice, exitPrice, grossPnl, cost, netPnl, status, orderedAt, signal_timestamp, algoSource, executionMode) VALUES ('"
        + safe_id + "', '"
        + safe_id + "', '"
        + safe_inst + "', '"
        + safe_side + "', "
        + std::to_string(trade.quantity) + ", "
        + std::to_string(trade.entryPrice) + ", "
        + std::to_string(trade.exitPrice) + ", 0.0, 0.0, "
        + std::to_string(trade.netPnl) + ", '"
        + safe_status + "', "
        + (safe_ordered.empty() ? "NOW()" : ("'" + safe_ordered + "'")) + ", '"
        + safe_signal_ts + "', '"
        + safe_algo + "', '"
        + safe_mode + "') ON DUPLICATE KEY UPDATE entryPrice = VALUES(entryPrice), status = VALUES(status);";

    if (mysql_query(conn, query.c_str()) != 0) {
        unsigned int err_no = mysql_errno(conn);
        if (err_no == 1062) { // ER_DUP_ENTRY: Duplicate entry safely absorbed by unique constraint
            std::cout << "ℹ️ [RoadmapDbClient] Idempotency guard: Trade safely absorbed by DB unique constraint for " << safe_inst << " (" << safe_side << ").\n";
            tx.commit();
            pool_->release(conn);
            return true;
        }
        std::cerr << "❌ [RoadmapDbClient] create_paper_trade error: " << mysql_error(conn) << "\n";
        return false;
    }

    bool ok = tx.commit();
    pool_->release(conn);
    return ok;
}

static double calculate_authentic_fno_charges(double entry_price, double exit_price, int quantity, const std::string& side, const std::string& instrument = "") {
    double entry_turn = quantity * entry_price;
    double exit_turn = quantity * exit_price;
    double total_turn = entry_turn + exit_turn;

    double entry_brokerage = 20.0;
    double exit_brokerage = 20.0;
    double stt = (side == "BUY" ? exit_turn : entry_turn) * 0.0015; // Published 0.15% STT rate
    
    bool is_bse = (instrument.find("BSE_FO") != std::string::npos || instrument.find("SENSEX") != std::string::npos);
    double exchange_rate = is_bse ? 0.000325 : 0.000355; // 0.0325% for BSE SENSEX vs 0.0355% for NSE
    double exchange_charges = total_turn * exchange_rate;
    
    double stamp_duty = (side == "BUY" ? entry_turn : 0.0) * 0.00003;
    double sebi_fee = total_turn * 0.000001;
    double gst = 0.18 * (entry_brokerage + exit_brokerage + exchange_charges + sebi_fee);

    return entry_brokerage + exit_brokerage + stt + exchange_charges + stamp_duty + sebi_fee + gst;
}

bool RoadmapDbClient::close_paper_trade(const std::string& trade_id, double exit_price, double net_pnl, double cost) {
    MYSQL* conn = pool_->acquire();
    if (!conn) return false;

    TransactionGuard tx(conn);
    std::string safe_id = escape_string(conn, trade_id);

    double gross_pnl = net_pnl + cost;
    std::string query = "UPDATE cpp_trade_reports SET exitPrice = " + std::to_string(exit_price)
                        + ", grossPnl = " + std::to_string(gross_pnl)
                        + ", cost = " + std::to_string(cost)
                        + ", netPnl = " + std::to_string(net_pnl)
                        + ", status = 'CLOSED', closedAt = NOW() WHERE id = '" + safe_id + "';";

    if (mysql_query(conn, query.c_str()) != 0) {
        std::cerr << "❌ [RoadmapDbClient] close_paper_trade error: " << mysql_error(conn) << "\n";
        pool_->release(conn);
        return false;
    }

    // Automate cpp_portfolios sync: keep netPnl and ceiling aligned with live cpp_trade_reports SUM(netPnl)
    std::string sync_sql = "UPDATE cpp_portfolios SET netPnl = (SELECT IFNULL(SUM(netPnl),0.0) FROM cpp_trade_reports WHERE status = 'CLOSED'), ceiling = capital + (SELECT IFNULL(SUM(netPnl),0.0) FROM cpp_trade_reports WHERE status = 'CLOSED') WHERE id = 'cpp-portfolio-v1';";
    mysql_query(conn, sync_sql.c_str());

    bool ok = tx.commit();
    pool_->release(conn);
    return ok;
}

size_t RoadmapDbClient::count_open_trades_for_symbol(const std::string& instrument) {
    MYSQL* conn = pool_->acquire();
    if (!conn) return 0;

    std::string sym = extract_symbol(instrument);
    std::string tok = extract_token(instrument);
    std::string safe_sym = escape_string(conn, sym);
    std::string safe_tok = escape_string(conn, tok);

    if (safe_sym.empty()) {
        pool_->release(conn);
        return 0;
    }

    std::string query = "SELECT COUNT(*) FROM cpp_trade_reports WHERE status = 'OPEN' AND (instrument LIKE '" + safe_sym + "%'";
    if (!safe_tok.empty()) {
        query += " OR instrument LIKE '%" + safe_tok + "%'";
    }
    query += ");";

    size_t count = 0;
    if (mysql_query(conn, query.c_str()) == 0) {
        MYSQL_RES* res = mysql_store_result(conn);
        if (res) {
            MYSQL_ROW row = mysql_fetch_row(res);
            if (row && row[0]) {
                try { count = std::stoull(row[0]); } catch (...) {}
            }
            mysql_free_result(res);
        }
    }
    pool_->release(conn);
    return count;
}

double RoadmapDbClient::fetch_today_session_drawdown() {
    MYSQL* conn = pool_->acquire();
    if (!conn) return 0.0;

    double today_loss = 0.0;
    std::string query = "SELECT IFNULL(SUM(CASE WHEN netPnl < 0 THEN ABS(netPnl) ELSE 0.0 END), 0.0) "
                        "FROM cpp_trade_reports WHERE status = 'CLOSED' AND DATE(closedAt) = CURRENT_DATE();";

    if (mysql_query(conn, query.c_str()) == 0) {
        MYSQL_RES* res = mysql_store_result(conn);
        if (res) {
            MYSQL_ROW row = mysql_fetch_row(res);
            if (row && row[0]) {
                try { today_loss = std::stod(row[0]); } catch (...) {}
            }
            mysql_free_result(res);
        }
    }
    pool_->release(conn);
    return today_loss;
}

int RoadmapDbClient::settle_expired_positions() {
    MYSQL* conn = pool_->acquire();
    if (!conn) return 0;

    std::vector<UserTradeData> to_settle;
    std::string query = "SELECT id, instrument, side, quantity, entryPrice FROM cpp_trade_reports WHERE status = 'OPEN';";

    if (mysql_query(conn, query.c_str()) == 0) {
        MYSQL_RES* res = mysql_store_result(conn);
        if (res) {
            MYSQL_ROW row;
            while ((row = mysql_fetch_row(res))) {
                std::string tid = row[0] ? row[0] : "";
                std::string inst = row[1] ? row[1] : "";
                std::string side = row[2] ? row[2] : "BUY";
                int qty = row[3] ? std::stoi(row[3]) : 0;
                double entry = row[4] ? std::stod(row[4]) : 0.0;

                std::string sym = extract_symbol(inst);
                if (sym.find("261001") != std::string::npos || sym.find("26O01") != std::string::npos) {
                    UserTradeData tr;
                    tr.id = tid;
                    tr.instrument = inst;
                    tr.side = side;
                    tr.quantity = qty;
                    tr.entryPrice = entry;
                    to_settle.push_back(tr);
                }
            }
            mysql_free_result(res);
        }
    }

    if (to_settle.empty()) {
        pool_->release(conn);
        return 0;
    }

    auto quote_map = fetch_latest_quotes_map(conn);
    int settled_count = 0;

    for (const auto& tr : to_settle) {
        double exit_px = lookup_ltp_from_map(quote_map, tr.instrument, 0.0);
        double gross_pnl = (tr.side == "BUY") ? (tr.quantity * (exit_px - tr.entryPrice)) : (tr.quantity * (tr.entryPrice - exit_px));
        double charges = calculate_authentic_fno_charges(tr.entryPrice, exit_px, tr.quantity, tr.side, tr.instrument);
        double net_pnl = gross_pnl - charges;

        std::string u_sql = "UPDATE cpp_trade_reports SET exitPrice = " + std::to_string(exit_px)
                          + ", grossPnl = " + std::to_string(gross_pnl)
                          + ", cost = " + std::to_string(charges)
                          + ", netPnl = " + std::to_string(net_pnl)
                          + ", status = 'CLOSED', closedAt = NOW() WHERE id = '" + escape_string(conn, tr.id) + "';";
        if (mysql_query(conn, u_sql.c_str()) == 0) {
            settled_count++;
        }
    }

    if (settled_count > 0) {
        std::string sync_sql = "UPDATE cpp_portfolios SET netPnl = (SELECT IFNULL(SUM(netPnl),0.0) FROM cpp_trade_reports WHERE status = 'CLOSED'), ceiling = capital + (SELECT IFNULL(SUM(netPnl),0.0) FROM cpp_trade_reports WHERE status = 'CLOSED') WHERE id = 'cpp-portfolio-v1';";
        mysql_query(conn, sync_sql.c_str());
    }

    pool_->release(conn);
    return settled_count;
}

void RoadmapDbClient::update_external_case_study_ltps() {
    MYSQL* conn = pool_->acquire();
    if (!conn) return;

    std::string query =
        "UPDATE cpp_external_trade_case_studies cs "
        "JOIN ( "
        "  SELECT contractSymbol, ltp "
        "  FROM upstox_live_paper_option_quotes "
        "  WHERE ts >= DATE_SUB(NOW(), INTERVAL 24 HOUR) "
        "  ORDER BY ts ASC "
        ") q ON cs.contract_symbol = CONVERT(q.contractSymbol USING utf8mb4) "
        "SET "
        "  cs.last_ltp = q.ltp, "
        "  cs.unrealized_pnl = cs.total_quantity * (q.ltp - cs.avg_entry_price), "
        "  cs.unrealized_pnl_pct = ((cs.total_quantity * (q.ltp - cs.avg_entry_price)) / cs.total_cost) * 100;";

    mysql_query(conn, query.c_str());
    pool_->release(conn);
}

std::vector<CanonicalOptionTick> RoadmapDbClient::fetch_live_quotes_since(const std::string& since_timestamp) {
    std::vector<CanonicalOptionTick> ticks;
    MYSQL* conn = pool_->acquire();
    if (!conn) return ticks;

    std::string safe_ts = escape_string(conn, since_timestamp.empty() ? "2026-09-30 00:00:00.000000" : since_timestamp);
    std::string query = "SELECT contractSymbol, IFNULL(instrumentToken, ''), underlying, DATE_FORMAT(expiry, '%Y-%m-%d'), strike, optionType, ltp, IFNULL(bid, 0.0), IFNULL(ask, 0.0), IFNULL(bidQty, 0), IFNULL(askQty, 0), IFNULL(volume, 0), IFNULL(openInterest, 0), IFNULL(oiChange, 0), IFNULL(impliedVolatility, 0.0), DATE_FORMAT(ts, '%Y-%m-%d %H:%i:%s.%f') "
                        "FROM upstox_live_paper_option_quotes "
                        "WHERE ts > '" + safe_ts + "' "
                        "ORDER BY ts ASC LIMIT 500;";

    if (mysql_query(conn, query.c_str()) == 0) {
        MYSQL_RES* res = mysql_store_result(conn);
        if (res) {
            MYSQL_ROW row;
            while ((row = mysql_fetch_row(res))) {
                CanonicalOptionTick tick;
                tick.symbol = row[0] ? row[0] : "";
                tick.instrument_key = row[1] ? row[1] : (row[2] ? row[2] : "");
                tick.option_type = row[5] ? row[5] : "CE";
                tick.provenance = "UPSTOX_LIVE_READONLY";
                tick.is_real_data = true;
                try {
                    tick.strike = row[4] ? std::stod(row[4]) : 0.0;
                    tick.ltp = row[6] ? std::stod(row[6]) : 0.0;
                    tick.bid_price = row[7] ? std::stod(row[7]) : 0.0;
                    tick.ask_price = row[8] ? std::stod(row[8]) : 0.0;
                    tick.bid_qty = row[9] ? std::stoi(row[9]) : 0;
                    tick.ask_qty = row[10] ? std::stoi(row[10]) : 0;
                    tick.volume = row[11] ? std::stoi(row[11]) : 0;
                    tick.open_interest = row[12] ? std::stoi(row[12]) : 0;
                    tick.change_oi = row[13] ? std::stoi(row[13]) : 0;
                    tick.iv = row[14] ? std::stod(row[14]) : 0.0;
                    if (row[15]) tick.raw_timestamp = row[15];
                } catch (...) {}
                ticks.push_back(tick);
            }
            mysql_free_result(res);
        }
    }
    pool_->release(conn);
    return ticks;
}

std::pair<long long, long long> RoadmapDbClient::fetch_stored_tick_counts() {
    static std::pair<long long, long long> cached_counts{0, 0};
    static auto last_fetch_time = std::chrono::steady_clock::time_point{};
    auto now = std::chrono::steady_clock::now();
    if (std::chrono::duration_cast<std::chrono::seconds>(now - last_fetch_time).count() < 10 && cached_counts.second > 0) {
        return cached_counts;
    }

    MYSQL* conn = pool_->acquire();
    if (!conn) return cached_counts;
    long long today_count = 0;
    long long total_count = 0;
    const char* query = "SELECT "
                        "(SELECT COUNT(*) FROM fnf_market_snapshots WHERE createdAt >= CURRENT_DATE() AND createdAt < CURRENT_DATE() + INTERVAL 1 DAY) AS today_ticks, "
                        "(SELECT COUNT(*) FROM fnf_market_snapshots) AS total_ticks;";
    if (mysql_query(conn, query) == 0) {
        MYSQL_RES* res = mysql_store_result(conn);
        if (res) {
            MYSQL_ROW row = mysql_fetch_row(res);
            if (row) {
                if (row[0]) try { today_count = std::stoll(row[0]); } catch(...) {}
                if (row[1]) try { total_count = std::stoll(row[1]); } catch(...) {}
            }
            mysql_free_result(res);
        }
    }
    pool_->release(conn);
    if (total_count > 0) {
        cached_counts = {today_count, total_count};
        last_fetch_time = now;
    }
    return cached_counts;
}

std::vector<std::map<std::string, std::string>> RoadmapDbClient::fetch_archived_tick_samples(int limit_days) {
    std::vector<std::map<std::string, std::string>> rows;
    MYSQL* conn = pool_->acquire();
    if (!conn) return rows;

    // Shared Read-Only Boundary: upstox_live_paper_option_quotes is owned by TypeScript. C++ reads ONLY.
    // Exclude documented incident dates & low-volume outage days: Sep 12 (weekend artifact), Sep 15-16 (throughput collapse), Sep 17 (stale gap), Sep 18 (crash-loop), Sep 21-22 (flush outage), Sep 24 (deadlock), Sep 25 (dead feed)
    // Perform strict in-query deduplication via GROUP BY (contractSymbol, ts, ltp) to eliminate pre-fix dual-writer duplicate ticks
    std::string query = "SELECT underlying, ltp, IFNULL(bid, 0.0), IFNULL(ask, 0.0), IFNULL(oiChange, 0), "
                        "(CASE WHEN DAYOFWEEK(ts) = 1 THEN 7 ELSE DAYOFWEEK(ts) - 1 END) AS dow, "
                        "IFNULL(DATEDIFF(expiry, ts), 0) AS dte, "
                        "DATE_FORMAT(ts, '%Y-%m-%d %H:%i:%s') AS ts "
                        "FROM upstox_live_paper_option_quotes "
                        "WHERE ts >= DATE_SUB(NOW(), INTERVAL 1 DAY) "
                        "ORDER BY id DESC LIMIT 5000;";

    if (mysql_query(conn, query.c_str()) == 0) {
        MYSQL_RES* res = mysql_store_result(conn);
        if (res) {
            MYSQL_ROW row;
            while ((row = mysql_fetch_row(res))) {
                std::map<std::string, std::string> m;
                m["underlying"] = row[0] ? row[0] : "ALL";
                m["ltp"] = row[1] ? row[1] : "0.0";
                m["bid"] = row[2] ? row[2] : "0.0";
                m["ask"] = row[3] ? row[3] : "0.0";
                m["oiChange"] = row[4] ? row[4] : "0";
                m["dow"] = row[5] ? row[5] : "1";
                m["dte"] = row[6] ? row[6] : "0";
                m["ts"] = row[7] ? row[7] : "";
                rows.push_back(m);
            }
            mysql_free_result(res);
        }
    } else {
        std::cerr << "❌ [RoadmapDbClient] fetch_archived_tick_samples query error: " << mysql_error(conn) << "\n";
    }

    pool_->release(conn);
    return rows;
}

bool RoadmapDbClient::save_seasonality_pattern_record(
    const std::string& id, const std::string& underlying, const std::string& time_bucket_15m,
    int dow, int dte, size_t ticks, size_t session_days, double vol, double persistence,
    double spread, double oi_buildup, int min_days, const std::string& status, double advisory_mod,
    const std::string& summary
) {
    MYSQL* conn = pool_->acquire();
    if (!conn) return false;

    TransactionGuard tx(conn);
    std::string safe_id = escape_string(conn, id);
    std::string safe_und = escape_string(conn, underlying);
    std::string safe_b15 = escape_string(conn, time_bucket_15m);
    std::string safe_status = escape_string(conn, status);
    std::string safe_sum = escape_string(conn, summary);

    std::string query = "CREATE TABLE IF NOT EXISTS cpp_seasonality_patterns ("
                        "id VARCHAR(64) PRIMARY KEY, underlying VARCHAR(32) NOT NULL, time_bucket_15m VARCHAR(16) NOT NULL, "
                        "day_of_week INT NOT NULL, days_to_expiry INT NOT NULL, sample_ticks_count BIGINT NOT NULL DEFAULT 0, "
                        "sample_session_days INT NOT NULL DEFAULT 0, realized_volatility DOUBLE NOT NULL DEFAULT 0.0, "
                        "directional_persistence DOUBLE NOT NULL DEFAULT 0.5, avg_spread_pct DOUBLE NOT NULL DEFAULT 0.0, "
                        "avg_oi_buildup_rate DOUBLE NOT NULL DEFAULT 0.0, min_required_session_days INT NOT NULL DEFAULT 20, "
                        "gating_status VARCHAR(32) NOT NULL DEFAULT 'RESEARCH_ONLY', advisory_confidence_modifier DOUBLE NOT NULL DEFAULT 1.0, "
                        "hypothesis_summary TEXT, updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"
                        ");";
    mysql_query(conn, query.c_str());

    std::string insert_query = "INSERT INTO cpp_seasonality_patterns "
                               "(id, underlying, time_bucket_15m, day_of_week, days_to_expiry, sample_ticks_count, sample_session_days, "
                               "realized_volatility, directional_persistence, avg_spread_pct, avg_oi_buildup_rate, min_required_session_days, "
                               "gating_status, advisory_confidence_modifier, hypothesis_summary, updatedAt) VALUES ('"
                               + safe_id + "', '" + safe_und + "', '" + safe_b15 + "', " + std::to_string(dow) + ", " + std::to_string(dte) + ", "
                               + std::to_string(ticks) + ", " + std::to_string(session_days) + ", " + std::to_string(vol) + ", " + std::to_string(persistence) + ", "
                               + std::to_string(spread) + ", " + std::to_string(oi_buildup) + ", " + std::to_string(min_days) + ", '"
                               + safe_status + "', " + std::to_string(advisory_mod) + ", '" + safe_sum + "', NOW()) "
                               "ON DUPLICATE KEY UPDATE sample_ticks_count=VALUES(sample_ticks_count), sample_session_days=VALUES(sample_session_days), "
                               "realized_volatility=VALUES(realized_volatility), directional_persistence=VALUES(directional_persistence), "
                               "avg_spread_pct=VALUES(avg_spread_pct), avg_oi_buildup_rate=VALUES(avg_oi_buildup_rate), "
                               "gating_status=VALUES(gating_status), advisory_confidence_modifier=VALUES(advisory_confidence_modifier), hypothesis_summary=VALUES(hypothesis_summary);";

    bool ok = (mysql_query(conn, insert_query.c_str()) == 0);
    if (ok) tx.commit();
    pool_->release(conn);
    return ok;
}

std::vector<std::map<std::string, std::string>> RoadmapDbClient::fetch_seasonality_patterns() {
    std::vector<std::map<std::string, std::string>> list;
    MYSQL* conn = pool_->acquire();
    if (!conn) return list;

    std::string query = "SELECT id, underlying, time_bucket_15m, day_of_week, days_to_expiry, sample_ticks_count, sample_session_days, "
                        "realized_volatility, directional_persistence, avg_spread_pct, avg_oi_buildup_rate, min_required_session_days, "
                        "gating_status, advisory_confidence_modifier, hypothesis_summary "
                        "FROM cpp_seasonality_patterns ORDER BY sample_session_days DESC, underlying ASC;";

    if (mysql_query(conn, query.c_str()) == 0) {
        MYSQL_RES* res = mysql_store_result(conn);
        if (res) {
            MYSQL_ROW row;
            while ((row = mysql_fetch_row(res))) {
                std::map<std::string, std::string> m;
                m["id"] = row[0] ? row[0] : "";
                m["underlying"] = row[1] ? row[1] : "";
                m["time_bucket_15m"] = row[2] ? row[2] : "";
                m["day_of_week"] = row[3] ? row[3] : "1";
                m["days_to_expiry"] = row[4] ? row[4] : "0";
                m["sample_ticks_count"] = row[5] ? row[5] : "0";
                m["sample_session_days"] = row[6] ? row[6] : "0";
                m["realized_volatility"] = row[7] ? row[7] : "0.0";
                m["directional_persistence"] = row[8] ? row[8] : "0.5";
                m["avg_spread_pct"] = row[9] ? row[9] : "0.0";
                m["avg_oi_buildup_rate"] = row[10] ? row[10] : "0.0";
                m["min_required_session_days"] = row[11] ? row[11] : "20";
                m["gating_status"] = row[12] ? row[12] : "RESEARCH_ONLY";
                m["advisory_confidence_modifier"] = row[13] ? row[13] : "1.0";
                m["hypothesis_summary"] = row[14] ? row[14] : "";
                list.push_back(m);
            }
            mysql_free_result(res);
        }
    }
    pool_->release(conn);
    return list;
}

bool RoadmapDbClient::save_upstox_historical_candles(
    const std::vector<UpstoxCandleRecord>& candles,
    size_t& out_inserted,
    size_t& out_duplicates
) {
    out_inserted = 0;
    out_duplicates = 0;
    if (candles.empty()) return true;

    MYSQL* conn = acquire_local();
    if (!conn) return false;

    TransactionGuard tx(conn);

    for (const auto& c : candles) {
        std::string safe_inst = escape_string(conn, c.symbol);
        std::string safe_ref = escape_string(conn, c.instrument_key);
        std::string safe_interval = escape_string(conn, c.interval.empty() ? "day" : c.interval);
        std::string safe_ts = escape_string(conn, c.timestamp_mysql);

        std::string table_name = (c.interval == "day") ? "cpp_historical_daily_candles" : "cpp_historical_intraday_candles";

        std::string query = "INSERT INTO " + table_name + " "
                            "(instrument_key, symbol, interval_name, timestamp, open, high, low, close, volume, open_interest, ingested_at) VALUES ("
                            "'" + safe_ref + "', '" + safe_inst + "', '" + safe_interval + "', '" + safe_ts + "', "
                            + std::to_string(c.open) + ", " + std::to_string(c.high) + ", " + std::to_string(c.low) + ", " + std::to_string(c.close) + ", "
                            + std::to_string(c.volume) + ", " + std::to_string(c.open_interest) + ", NOW(6)) "
                            "ON DUPLICATE KEY UPDATE open=VALUES(open), high=VALUES(high), low=VALUES(low), close=VALUES(close), volume=VALUES(volume), open_interest=VALUES(open_interest);";

        if (mysql_query(conn, query.c_str()) == 0) {
            my_ulonglong affected = mysql_affected_rows(conn);
            if (affected == 1) {
                out_inserted++;
            } else if (affected == 2 || affected == 0) {
                out_duplicates++;
            }
        }
    }

    bool ok = tx.commit();
    release_local(conn);
    return ok;
}

UpstoxBackfillReport RoadmapDbClient::backfill_upstox_historical_data(
    const std::string& symbol,
    const std::string& interval,
    const std::string& to_date,
    const std::string& from_date
) {
    UpstoxBackfillReport report;
    std::string key = UpstoxHistoricalBackfillEngine::get_upstox_instrument_key(symbol);
    auto candles = UpstoxHistoricalBackfillEngine::fetch_historical_candles_api(key, symbol, interval, to_date, from_date, report);

    if (report.api_success && !candles.empty()) {
        save_upstox_historical_candles(candles, report.records_inserted, report.duplicates_prevented);
    }
    return report;
}

std::vector<MarketSnapshotData> RoadmapDbClient::fetch_full_historical_context(
    const std::string& instrument,
    const std::string& decision_timestamp,
    const std::string& from_timestamp
) {
    std::vector<MarketSnapshotData> data;
    MYSQL* conn = acquire_local();
    if (!conn) return data;

    std::string safe_inst = escape_string(conn, instrument);
    std::string safe_decision_ts = escape_string(conn, decision_timestamp.empty() ? "2099-12-31 23:59:59" : decision_timestamp);
    std::string safe_from_ts = escape_string(conn, from_timestamp);

    // Fetch from dedicated C++ historical daily & intraday candle tables
    // Look-ahead bias prevention: WHERE timestamp <= decision_timestamp
    // NO SQL LIMIT imposed by DB; retrieves full historical context up to decision timestamp!
    std::string query = "SELECT symbol, close, volume, open, high, low, close, DATE_FORMAT(timestamp, '%Y-%m-%d %H:%i:%s') "
                        "FROM cpp_historical_daily_candles "
                        "WHERE (symbol = '" + safe_inst + "' OR instrument_key LIKE '%" + safe_inst + "%') "
                        "AND timestamp <= '" + safe_decision_ts + "' ";
    if (!safe_from_ts.empty()) {
        query += "AND timestamp >= '" + safe_from_ts + "' ";
    }
    query += "ORDER BY timestamp ASC;";

    if (mysql_query(conn, query.c_str()) == 0) {
        MYSQL_RES* res = mysql_store_result(conn);
        if (res) {
            MYSQL_ROW row;
            while ((row = mysql_fetch_row(res))) {
                MarketSnapshotData s;
                s.instrument = row[0] ? row[0] : "";
                try {
                    s.price = row[1] ? std::stod(row[1]) : 0.0;
                    s.volume = row[2] ? std::stod(row[2]) : 0.0;
                    if (row[3]) s.open = std::stod(row[3]);
                    if (row[4]) s.high = std::stod(row[4]);
                    if (row[5]) s.low = std::stod(row[5]);
                    if (row[6]) s.close = std::stod(row[6]);
                } catch(...) {}
                s.ts = row[7] ? row[7] : "";
                data.push_back(s);
            }
            mysql_free_result(res);
        }
    }

    release_local(conn);
    return data;
}

std::vector<UpstoxCandleRecord> RoadmapDbClient::fetch_daily_candles_db(const std::string& symbol) {
    std::vector<UpstoxCandleRecord> records;
    MYSQL* conn = acquire_local();
    if (!conn) return records;

    std::string norm_symbol = UpstoxHistoricalBackfillEngine::normalize_symbol_for_db(symbol);
    std::string query = "SELECT timestamp, open, high, low, close, volume, open_interest, symbol, instrument_key "
                        "FROM cpp_historical_daily_candles ";
    if (!norm_symbol.empty()) {
        query += "WHERE symbol = '" + norm_symbol + "' ";
    }
    query += "ORDER BY timestamp ASC";

    if (mysql_query(conn, query.c_str()) == 0) {
        MYSQL_RES* res = mysql_store_result(conn);
        if (res) {
            MYSQL_ROW row;
            while ((row = mysql_fetch_row(res))) {
                UpstoxCandleRecord r;
                r.timestamp_mysql = row[0] ? row[0] : "";
                try {
                    r.open = row[1] ? std::stod(row[1]) : 0.0;
                    r.high = row[2] ? std::stod(row[2]) : 0.0;
                    r.low = row[3] ? std::stod(row[3]) : 0.0;
                    r.close = row[4] ? std::stod(row[4]) : 0.0;
                    r.volume = row[5] ? std::stoll(row[5]) : 0;
                    r.open_interest = row[6] ? std::stoll(row[6]) : 0;
                } catch(...) {}
                r.symbol = row[7] ? row[7] : "";
                r.instrument_key = row[8] ? row[8] : "";
                r.interval = "day";
                records.push_back(r);
            }
            mysql_free_result(res);
        }
    } else {
        std::cerr << "❌ [RoadmapDbClient] fetch_daily_candles_db query error: " << mysql_error(conn) << "\n";
    }

    release_local(conn);
    return records;
}

std::vector<UpstoxCandleRecord> RoadmapDbClient::fetch_intraday_candles_db(const std::string& symbol) {
    std::vector<UpstoxCandleRecord> records;
    MYSQL* conn = acquire_local();
    if (!conn) return records;

    std::string norm_symbol = UpstoxHistoricalBackfillEngine::normalize_symbol_for_db(symbol);
    std::string query = "SELECT timestamp, open, high, low, close, volume, open_interest, symbol, instrument_key "
                        "FROM cpp_historical_intraday_candles ";
    if (!norm_symbol.empty()) {
        query += "WHERE symbol = '" + norm_symbol + "' ";
    }
    query += "ORDER BY timestamp ASC";

    if (mysql_query(conn, query.c_str()) == 0) {
        MYSQL_RES* res = mysql_store_result(conn);
        if (res) {
            MYSQL_ROW row;
            while ((row = mysql_fetch_row(res))) {
                UpstoxCandleRecord r;
                r.timestamp_mysql = row[0] ? row[0] : "";
                try {
                    r.open = row[1] ? std::stod(row[1]) : 0.0;
                    r.high = row[2] ? std::stod(row[2]) : 0.0;
                    r.low = row[3] ? std::stod(row[3]) : 0.0;
                    r.close = row[4] ? std::stod(row[4]) : 0.0;
                    r.volume = row[5] ? std::stoll(row[5]) : 0;
                    r.open_interest = row[6] ? std::stoll(row[6]) : 0;
                } catch(...) {}
                r.symbol = row[7] ? row[7] : "";
                r.instrument_key = row[8] ? row[8] : "";
                r.interval = "1minute";
                records.push_back(r);
            }
            mysql_free_result(res);
        }
    } else {
        std::cerr << "❌ [RoadmapDbClient] fetch_intraday_candles_db query error: " << mysql_error(conn) << "\n";
    }

    release_local(conn);
    return records;
}


