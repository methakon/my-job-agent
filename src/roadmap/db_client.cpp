#include "db_client.hpp"
#include "../engine/tick_receiver.hpp"
#include "../engine/upstox_historical_backfill.hpp"
#include "../engine/position_exit_evaluator.hpp"
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
        all_created_connections_.erase(conn);
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

std::string RoadmapDbClient::get_ssl_cipher_status() {
    MYSQL* conn = pool_->acquire();
    if (!conn) return "NO_CONNECTION";

    std::string cipher = "NONE";
    if (mysql_query(conn, "SHOW STATUS LIKE 'Ssl_cipher';") == 0) {
        MYSQL_RES* res = mysql_store_result(conn);
        if (res) {
            MYSQL_ROW row = mysql_fetch_row(res);
            if (row && row[1]) {
                cipher = row[1];
            }
            mysql_free_result(res);
        }
    }
    pool_->release(conn);
    return cipher;
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

bool RoadmapDbClient::ensure_test_schema() {
    MYSQL* conn = pool_->acquire();
    if (!conn) return false;
    std::string q = "CREATE TABLE IF NOT EXISTS hermes_cpp_decision_journal_test LIKE hermes_cpp_decision_journal;";
    int r1 = mysql_query(conn, q.c_str());
    std::string q2 = "CREATE TABLE IF NOT EXISTS cpp_post_session_analysis_test LIKE cpp_post_session_analysis;";
    int r2 = mysql_query(conn, q2.c_str());
    pool_->release(conn);
    return (r1 == 0 && r2 == 0);
}

void RoadmapDbClient::cleanup_test_schema() {
    MYSQL* conn = pool_->acquire();
    if (!conn) return;
    mysql_query(conn, "TRUNCATE TABLE hermes_cpp_decision_journal_test;");
    mysql_query(conn, "TRUNCATE TABLE cpp_post_session_analysis_test;");
    pool_->release(conn);
}

bool RoadmapDbClient::log_decision_journal_record(const std::string& uuid, const std::string& session_id, const std::string& git_sha, const std::string& version, const std::string& symbol, const std::string& action, double confidence, double margin, const std::string& reason, const std::string& snapshot_json) {
    MYSQL* conn = pool_->acquire();
    if (!conn) return false;

    std::string safe_uuid = (uuid.empty() || uuid == "dj-0") ? ("dj-" + std::to_string(std::chrono::high_resolution_clock::now().time_since_epoch().count())) : uuid;

    // Defense-in-depth Invariant Guard: Prevent test record leakage into production table
    if (!is_test_isolation_) {
        if (safe_uuid.rfind("TEST-", 0) == 0 || safe_uuid.rfind("DEC-TEST", 0) == 0 ||
            safe_uuid.rfind("DEC-TRANSACT", 0) == 0 || safe_uuid.rfind("dj-test", 0) == 0 ||
            session_id.find("TEST") != std::string::npos || session_id.find("test") != std::string::npos) {
            std::cerr << "🛡️ [RoadmapDbClient] Invariant Violation Blocked: Test record rejected from production table: " << safe_uuid << "\n";
            pool_->release(conn);
            return false;
        }
    }

    TransactionGuard tx(conn);
    std::string table = is_test_isolation_ ? "hermes_cpp_decision_journal_test" : "hermes_cpp_decision_journal";
    std::string s_uuid = escape_string(conn, safe_uuid);
    std::string s_sess = escape_string(conn, session_id);
    std::string s_git  = escape_string(conn, git_sha);
    std::string s_ver  = escape_string(conn, version);
    std::string s_sym  = escape_string(conn, symbol);
    std::string s_act  = escape_string(conn, action);
    std::string s_rsn  = escape_string(conn, reason);
    std::string s_json = escape_string(conn, snapshot_json);

    std::string query = "INSERT INTO " + table + " (decision_uuid, session_id, git_commit_sha, engine_version, symbol, action, confidence, allocated_margin, reason, feature_snapshot_json, created_at) "
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

    std::string table = is_test_isolation_ ? "hermes_cpp_decision_journal_test" : "hermes_cpp_decision_journal";
    std::string s_uuid = escape_string(conn, uuid);
    std::string query = "SELECT session_id, git_commit_sha, engine_version, symbol, action, confidence, allocated_margin, reason, feature_snapshot_json FROM " + table + " WHERE decision_uuid = '" + s_uuid + "';";

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
RoadmapDbClient::SessionDecisionStats RoadmapDbClient::fetch_session_decision_stats(const std::string& session_date) {
    SessionDecisionStats stats;
    MYSQL* conn = pool_->acquire();
    if (!conn) return stats;

    std::string dj_table = is_test_isolation_ ? "hermes_cpp_decision_journal_test" : "hermes_cpp_decision_journal";
    std::string safe_date = session_date.empty() ? "CURRENT_DATE()" : ("'" + escape_string(conn, session_date) + "'");
    std::string q = "SELECT "
                    "  COUNT(*) as total_eval, "
                    "  SUM(CASE WHEN reason LIKE '%OFI_BELOW_BREAKOUT_THRESHOLD%' THEN 1 ELSE 0 END) as no_action, "
                    "  SUM(CASE WHEN action != 'NO_TRADE' AND decision_uuid NOT LIKE 'DEC-TEST%' THEN 1 ELSE 0 END) as actionable, "
                    "  SUM(CASE WHEN reason LIKE '%RISK_VETO%' THEN 1 ELSE 0 END) as risk_vetoes, "
                    "  IFNULL(AVG(confidence), 0.0) as avg_conf, "
                    "  IFNULL(MAX(confidence), 0.0) as max_conf, "
                    "  SUM(CASE WHEN confidence >= 0.70 AND confidence < 0.85 THEN 1 ELSE 0 END) as near_miss "
                    "FROM " + dj_table + " "
                    "WHERE DATE(created_at) = " + safe_date + ";";

    if (mysql_query(conn, q.c_str()) == 0) {
        MYSQL_RES* res = mysql_store_result(conn);
        if (res) {
            MYSQL_ROW row = mysql_fetch_row(res);
            if (row) {
                if (row[0]) stats.total_eval = std::stoull(row[0]);
                if (row[1]) stats.no_action = std::stoull(row[1]);
                if (row[2]) stats.actionable = std::stoull(row[2]);
                if (row[3]) stats.risk_vetoes = std::stoull(row[3]);
                if (row[4]) stats.avg_confidence = std::stod(row[4]);
                if (row[5]) stats.max_confidence = std::stod(row[5]);
                if (row[6]) stats.near_miss_count = std::stoi(row[6]);
            }
            mysql_free_result(res);
        }
    }
    pool_->release(conn);
    return stats;
}

bool RoadmapDbClient::save_post_session_analysis_record(
    const std::string& id, const std::string& session_date, const std::string& session_phase,
    uint64_t total_ticks, uint64_t evaluated_decisions, uint64_t no_action_cnt,
    uint64_t actionable_cnt, uint64_t risk_veto_cnt, int trades_executed,
    double realized_drawdown, double avg_ofi, double max_ofi, int near_miss_cnt,
    const std::string& recommendations_json
) {
    MYSQL* conn = pool_->acquire();
    if (!conn) return false;

    std::string table = is_test_isolation_ ? "cpp_post_session_analysis_test" : "cpp_post_session_analysis";

    TransactionGuard tx(conn);
    std::string safe_id = escape_string(conn, id);
    std::string safe_date = escape_string(conn, session_date);
    std::string safe_phase = escape_string(conn, session_phase);
    std::string safe_rec = escape_string(conn, recommendations_json);

    std::string query = "INSERT INTO " + table + " "
                        "(id, session_date, session_phase, total_ticks_ingested, evaluated_decisions_count, "
                        "no_action_count, actionable_signals_count, risk_vetoes_count, trades_executed_count, "
                        "realized_drawdown_inr, avg_ofi, max_ofi, near_miss_count, recommendations_json, created_at) VALUES ('"
                        + safe_id + "', '" + safe_date + "', '" + safe_phase + "', "
                        + std::to_string(total_ticks) + ", " + std::to_string(evaluated_decisions) + ", "
                        + std::to_string(no_action_cnt) + ", " + std::to_string(actionable_cnt) + ", "
                        + std::to_string(risk_veto_cnt) + ", " + std::to_string(trades_executed) + ", "
                        + std::to_string(realized_drawdown) + ", " + std::to_string(avg_ofi) + ", "
                        + std::to_string(max_ofi) + ", " + std::to_string(near_miss_cnt) + ", '"
                        + safe_rec + "', NOW()) "
                        "ON DUPLICATE KEY UPDATE total_ticks_ingested=VALUES(total_ticks_ingested), "
                        "evaluated_decisions_count=VALUES(evaluated_decisions_count), "
                        "no_action_count=VALUES(no_action_count), actionable_signals_count=VALUES(actionable_signals_count), "
                        "risk_vetoes_count=VALUES(risk_vetoes_count), trades_executed_count=VALUES(trades_executed_count), "
                        "realized_drawdown_inr=VALUES(realized_drawdown_inr), avg_ofi=VALUES(avg_ofi), max_ofi=VALUES(max_ofi), "
                        "near_miss_count=VALUES(near_miss_count), recommendations_json=VALUES(recommendations_json);";

    bool ok = (mysql_query(conn, query.c_str()) == 0);
    if (!ok) {
        std::cerr << "❌ [RoadmapDbClient] save_post_session_analysis_record error: " << mysql_error(conn) << "\n";
        pool_->release(conn);
        return false;
    }
    tx.commit();
    pool_->release(conn);
    return true;
}

uint64_t RoadmapDbClient::rollup_ticks_to_daily_candles(const std::string& session_date) {
    if (is_test_isolation_) {
        // Under test isolation, do not pollute production daily candles table
        return 0;
    }
    MYSQL* conn = pool_->acquire();
    if (!conn) return 0;

    std::string safe_date = session_date.empty() ? "CURRENT_DATE()" : ("'" + escape_string(conn, session_date) + "'");

    std::string rollup_sql = 
        "INSERT INTO cpp_historical_daily_candles "
        "(instrument_key, symbol, interval_name, timestamp, open, high, low, close, volume, open_interest, ingested_at) "
        "SELECT "
        "  t.instrument AS instrument_key, "
        "  SUBSTRING_INDEX(t.instrument, '|', -1) AS symbol, "
        "  'day' AS interval_name, "
        "  DATE_FORMAT(MIN(t.ts), '%Y-%m-%d 00:00:00') AS timestamp, "
        "  (SELECT price FROM fnf_market_snapshots WHERE instrument = t.instrument AND DATE(ts) = " + safe_date + " AND price > 0 ORDER BY ts ASC LIMIT 1) AS open, "
        "  MAX(t.price) AS high, "
        "  MIN(t.price) AS low, "
        "  (SELECT price FROM fnf_market_snapshots WHERE instrument = t.instrument AND DATE(ts) = " + safe_date + " AND price > 0 ORDER BY ts DESC LIMIT 1) AS close, "
        "  0 AS volume, "
        "  0 AS open_interest, "
        "  NOW(6) AS ingested_at "
        "FROM fnf_market_snapshots t "
        "WHERE DATE(t.ts) = " + safe_date + " AND t.price > 0 "
        "GROUP BY t.instrument "
        "ON DUPLICATE KEY UPDATE "
        "  open=VALUES(open), high=VALUES(high), low=VALUES(low), close=VALUES(close), ingested_at=NOW(6);";

    uint64_t affected = 0;
    if (mysql_query(conn, rollup_sql.c_str()) == 0) {
        affected = mysql_affected_rows(conn);
        std::cout << "✅ [RoadmapDbClient] Daily candle rollup succeeded. Affected/Upserted candles: " << affected << "\n";
    } else {
        std::cerr << "❌ [RoadmapDbClient] rollup_ticks_to_daily_candles error: " << mysql_error(conn) << "\n";
    }

    pool_->release(conn);
    return affected;
}

uint64_t RoadmapDbClient::archive_market_snapshots_before(const std::string& boundary_date, uint64_t& out_deleted) {
    out_deleted = 0;
    MYSQL* conn = pool_->acquire();
    if (!conn) return 0;

    std::string safe_date = boundary_date.empty() ? "CURRENT_DATE()" : ("'" + escape_string(conn, boundary_date) + "'");

    std::string copy_sql = 
        "INSERT IGNORE INTO fnf_market_snapshots_history "
        "(id, instrument, price, volume, open, high, low, close, ts, source, createdAt, archivedAt) "
        "SELECT id, instrument, price, volume, open, high, low, close, ts, source, createdAt, NOW() "
        "FROM fnf_market_snapshots "
        "WHERE DATE(ts) < " + safe_date + ";";

    uint64_t copied = 0;
    if (mysql_query(conn, copy_sql.c_str()) == 0) {
        copied = mysql_affected_rows(conn);
        std::cout << "✅ [RoadmapDbClient] Market snapshots archived: " << copied << " row(s) moved to history.\n";
    } else {
        std::cerr << "❌ [RoadmapDbClient] archive copy error: " << mysql_error(conn) << "\n";
        pool_->release(conn);
        return 0;
    }

    std::string delete_sql = "DELETE FROM fnf_market_snapshots WHERE DATE(ts) < " + safe_date + ";";
    if (mysql_query(conn, delete_sql.c_str()) == 0) {
        out_deleted = mysql_affected_rows(conn);
        std::cout << "✅ [RoadmapDbClient] Cleaned live snapshots: " << out_deleted << " row(s) purged from live table.\n";
    } else {
        std::cerr << "❌ [RoadmapDbClient] archive purge error: " << mysql_error(conn) << "\n";
    }

    pool_->release(conn);
    return copied;
}

bool RoadmapDbClient::ensure_strategy_config_schema() {
    MYSQL* conn = pool_->acquire();
    if (!conn) return false;

    const char* schema_sql =
        "CREATE TABLE IF NOT EXISTS cpp_strategy_config ("
        "  config_key VARCHAR(64) PRIMARY KEY,"
        "  config_value VARCHAR(64) NOT NULL,"
        "  description VARCHAR(255),"
        "  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,"
        "  updated_by VARCHAR(64) DEFAULT 'SYSTEM'"
        ");";
    if (mysql_query(conn, schema_sql) != 0) {
        std::cerr << "❌ [RoadmapDbClient] Failed to ensure cpp_strategy_config: " << mysql_error(conn) << "\n";
        pool_->release(conn);
        return false;
    }

    const char* audit_sql =
        "CREATE TABLE IF NOT EXISTS cpp_strategy_config_audit ("
        "  id BIGINT AUTO_INCREMENT PRIMARY KEY,"
        "  config_key VARCHAR(64) NOT NULL,"
        "  old_value VARCHAR(64),"
        "  new_value VARCHAR(64) NOT NULL,"
        "  approved_by VARCHAR(64) NOT NULL,"
        "  reason TEXT,"
        "  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP"
        ");";
    if (mysql_query(conn, audit_sql) != 0) {
        std::cerr << "❌ [RoadmapDbClient] Failed to ensure cpp_strategy_config_audit: " << mysql_error(conn) << "\n";
        pool_->release(conn);
        return false;
    }

    const char* seed_sql =
        "INSERT IGNORE INTO cpp_strategy_config (config_key, config_value, description, updated_by) VALUES "
        "('ofi_threshold', '0.85', 'Threshold for Order Flow Imbalance breakout trigger', 'SYSTEM_BASELINE'), "
        "('min_volume_threshold', '100', 'Minimum option contract tick volume for trade trigger', 'SYSTEM_BASELINE'), "
        "('per_trade_risk_pct', '0.02', 'Dynamic per-trade risk ceiling percentage (Regime A / Kelly)', 'SYSTEM_BASELINE'), "
        "('session_drawdown_limit_pct', '0.05', 'Dynamic session drawdown limit percentage', 'SYSTEM_BASELINE'), "
        "('base_confidence', '0.85', 'Base confidence score for confirmed signals', 'SYSTEM_BASELINE'), "
        "('parallel_strategy_enabled', 'false', 'Enable parallel predictive multi-leg strategy engine', 'SYSTEM_BASELINE');";
    mysql_query(conn, seed_sql);

    // Ensure database trigger exists for immutable, autonomous auditing of all parameter updates
    const char* drop_trg_sql = "DROP TRIGGER IF EXISTS trg_cpp_strategy_config_audit;";
    mysql_query(conn, drop_trg_sql);

    const char* trigger_sql =
        "CREATE TRIGGER trg_cpp_strategy_config_audit "
        "AFTER UPDATE ON cpp_strategy_config "
        "FOR EACH ROW "
        "BEGIN "
        "  IF OLD.config_value <> NEW.config_value THEN "
        "    INSERT INTO cpp_strategy_config_audit ("
        "      config_key, old_value, new_value, approved_by, reason, created_at"
        "    ) VALUES ("
        "      NEW.config_key, OLD.config_value, NEW.config_value, NEW.updated_by,"
        "      CONCAT('Trigger-enforced audit: value updated from ', OLD.config_value, ' to ', NEW.config_value),"
        "      NOW()"
        "    ); "
        "  END IF; "
        "END;";
    if (mysql_query(conn, trigger_sql) != 0) {
        std::cerr << "⚠️ [RoadmapDbClient] Failed to install trg_cpp_strategy_config_audit trigger: " << mysql_error(conn) << "\n";
    }

    pool_->release(conn);
    return true;
}

std::map<std::string, std::string> RoadmapDbClient::fetch_strategy_config() {
    std::map<std::string, std::string> configs;
    MYSQL* conn = pool_->acquire();
    if (!conn) return configs;

    const char* q = "SELECT config_key, config_value FROM cpp_strategy_config;";
    if (mysql_query(conn, q) == 0) {
        MYSQL_RES* res = mysql_store_result(conn);
        if (res) {
            MYSQL_ROW row;
            while ((row = mysql_fetch_row(res))) {
                if (row[0] && row[1]) {
                    configs[row[0]] = row[1];
                }
            }
            mysql_free_result(res);
        }
    } else {
        std::cerr << "❌ [RoadmapDbClient] fetch_strategy_config error: " << mysql_error(conn) << "\n";
    }
    pool_->release(conn);
    return configs;
}

bool RoadmapDbClient::update_strategy_config_param(
    const std::string& key,
    const std::string& new_value,
    const std::string& approved_by,
    const std::string& reason
) {
    MYSQL* conn = pool_->acquire();
    if (!conn) return false;

    TransactionGuard tx(conn);
    std::string safe_key = escape_string(conn, key);
    std::string safe_val = escape_string(conn, new_value);
    std::string safe_by  = escape_string(conn, approved_by.empty() ? "OPERATOR" : approved_by);

    // Upsert config. The MySQL AFTER UPDATE trigger (trg_cpp_strategy_config_audit) guarantees
    // an audit row is autonomously inserted into cpp_strategy_config_audit whenever config_value changes.
    std::string upsert = "INSERT INTO cpp_strategy_config (config_key, config_value, updated_by) VALUES ('"
                       + safe_key + "', '" + safe_val + "', '" + safe_by + "') "
                       + "ON DUPLICATE KEY UPDATE config_value = VALUES(config_value), updated_by = VALUES(updated_by);";
    if (mysql_query(conn, upsert.c_str()) != 0) {
        std::cerr << "❌ [RoadmapDbClient] update_strategy_config_param upsert error: " << mysql_error(conn) << "\n";
        pool_->release(conn);
        return false;
    }

    bool ok = tx.commit();
    pool_->release(conn);
    return ok;
}

std::vector<std::map<std::string, std::string>> RoadmapDbClient::fetch_strategy_config_audit(int limit) {
    std::vector<std::map<std::string, std::string>> records;
    MYSQL* conn = pool_->acquire();
    if (!conn) return records;

    std::string q = "SELECT id, config_key, IFNULL(old_value, ''), new_value, approved_by, IFNULL(reason, ''), DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') "
                    "FROM cpp_strategy_config_audit ORDER BY id DESC LIMIT " + std::to_string(limit) + ";";
    if (mysql_query(conn, q.c_str()) == 0) {
        MYSQL_RES* res = mysql_store_result(conn);
        if (res) {
            MYSQL_ROW row;
            while ((row = mysql_fetch_row(res))) {
                std::map<std::string, std::string> r;
                r["id"] = row[0] ? row[0] : "";
                r["config_key"] = row[1] ? row[1] : "";
                r["old_value"] = row[2] ? row[2] : "";
                r["new_value"] = row[3] ? row[3] : "";
                r["approved_by"] = row[4] ? row[4] : "";
                r["reason"] = row[5] ? row[5] : "";
                r["created_at"] = row[6] ? row[6] : "";
                records.push_back(r);
            }
            mysql_free_result(res);
        }
    }
    pool_->release(conn);
    return records;
}

bool RoadmapDbClient::execute_raw_sql(const std::string& sql) {
    MYSQL* conn = pool_->acquire();
    if (!conn) return false;
    bool ok = (mysql_query(conn, sql.c_str()) == 0);
    if (!ok) {
        std::cerr << "❌ [RoadmapDbClient] execute_raw_sql error: " << mysql_error(conn) << "\n";
    }
    pool_->release(conn);
    return ok;
}

// ============================================================================
// Cookie-Less Privacy-Conscious Visitor Analytics Engine Implementation (v8)
// ============================================================================
#include "../analytics/visitor_tracker.hpp"
#include <openssl/hmac.h>
#include <openssl/sha.h>
#include <openssl/rand.h>

static std::string hmac_sha256_hex(const std::string& secret, const std::string& data) {
    unsigned char hash[SHA256_DIGEST_LENGTH];
    unsigned int len = SHA256_DIGEST_LENGTH;
    HMAC(EVP_sha256(), secret.data(), secret.size(),
         reinterpret_cast<const unsigned char*>(data.data()), data.size(),
         hash, &len);
    std::ostringstream ss;
    for (unsigned int i = 0; i < len; ++i) {
        ss << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(hash[i]);
    }
    return ss.str();
}

static std::string generate_random_cid() {
    unsigned char buf[24];
    RAND_bytes(buf, sizeof(buf));
    std::ostringstream ss;
    ss << "cid_";
    for (size_t i = 0; i < sizeof(buf); ++i) {
        ss << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(buf[i]);
    }
    return ss.str();
}

static std::string escape_sql_string(MYSQL* conn, const std::string& str) {
    std::vector<char> buf(str.length() * 2 + 1);
    mysql_real_escape_string(conn, buf.data(), str.c_str(), str.length());
    return std::string(buf.data());
}

bool RoadmapDbClient::record_analytics_event(const analytics::AnalyticsEvent& event, 
                                             const analytics::GeoLocationResult& geo, 
                                             const std::string& secret) {
    MYSQL* conn = pool_->acquire();
    if (!conn) return false;

    // Begin database transaction for strict atomicity & persistence gating
    mysql_query(conn, "SET TRANSACTION ISOLATION LEVEL READ COMMITTED;");
    if (mysql_query(conn, "START TRANSACTION;") != 0) {
        pool_->release(conn);
        return false;
    }

    try {
        std::string active_lookup_hash = hmac_sha256_hex(secret, event.canonical_ip);
        std::string visitor_id;
        bool is_new_visitor = false;

        // 1. Resolve Active Visitor Identity
        std::string q_vis = "SELECT id FROM analytics_visitors WHERE active_lookup_hash = '" + 
                            escape_sql_string(conn, active_lookup_hash) + "' AND is_redacted = 0 LIMIT 1;";
        if (mysql_query(conn, q_vis.c_str()) == 0) {
            MYSQL_RES* res = mysql_store_result(conn);
            if (res) {
                MYSQL_ROW row = mysql_fetch_row(res);
                if (row && row[0]) {
                    visitor_id = row[0];
                }
                mysql_free_result(res);
            }
        }

        if (visitor_id.empty()) {
            visitor_id = generate_random_cid();
            is_new_visitor = true;
            std::ostringstream ins_vis;
            ins_vis << "INSERT INTO analytics_visitors (id, active_lookup_hash, ip_address, ip_version, identity_generation, is_redacted, "
                    << "first_seen_at, last_seen_at, total_visits, total_page_views, first_user_agent, latest_user_agent, "
                    << "browser_name, browser_version, operating_system, os_version, device_type, device_family, "
                    << "referrer_first, referrer_latest, is_bot, bot_name, identity_confidence) VALUES ("
                    << "'" << visitor_id << "', "
                    << "'" << escape_sql_string(conn, active_lookup_hash) << "', "
                    << "'" << escape_sql_string(conn, event.canonical_ip) << "', "
                    << "'" << event.ip_version << "', 1, 0, NOW(), NOW(), 0, 0, "
                    << "'" << escape_sql_string(conn, event.user_agent.substr(0, 512)) << "', "
                    << "'" << escape_sql_string(conn, event.user_agent.substr(0, 512)) << "', "
                    << "'" << escape_sql_string(conn, event.browser_name) << "', "
                    << "'" << escape_sql_string(conn, event.browser_version) << "', "
                    << "'" << escape_sql_string(conn, event.os_name) << "', "
                    << "'" << escape_sql_string(conn, event.os_version) << "', "
                    << "'" << escape_sql_string(conn, event.device_type) << "', "
                    << "'" << escape_sql_string(conn, event.device_family) << "', "
                    << "'" << escape_sql_string(conn, event.referer.substr(0, 512)) << "', "
                    << "'" << escape_sql_string(conn, event.referer.substr(0, 512)) << "', "
                    << (event.is_bot ? 1 : 0) << ", "
                    << "'" << escape_sql_string(conn, event.bot_name) << "', 'MEDIUM');";

            if (mysql_query(conn, ins_vis.str().c_str()) != 0) {
                // Duplicate key race check on uq_active_lookup_hash
                if (mysql_errno(conn) == 1062) {
                    visitor_id.clear();
                    std::string q_retry = "SELECT id FROM analytics_visitors WHERE active_lookup_hash = '" + 
                                          escape_sql_string(conn, active_lookup_hash) + "' AND is_redacted = 0 LIMIT 1;";
                    for (int attempt = 0; attempt < 15 && visitor_id.empty(); ++attempt) {
                        if (mysql_query(conn, q_retry.c_str()) == 0) {
                            MYSQL_RES* res = mysql_store_result(conn);
                            if (res) {
                                MYSQL_ROW row = mysql_fetch_row(res);
                                if (row && row[0]) {
                                    visitor_id = row[0];
                                    is_new_visitor = false;
                                }
                                mysql_free_result(res);
                            }
                        }
                        if (visitor_id.empty()) {
                            std::this_thread::sleep_for(std::chrono::milliseconds(20));
                        }
                    }
                } else {
                    std::cerr << "❌ [Analytics] Visitor Insert Failed: " << mysql_error(conn) << "\n";
                    mysql_query(conn, "ROLLBACK;");
                    pool_->release(conn);
                    return false;
                }
            }
        }

        // 2. Resolve Device (Deduplicated by device_signature)
        long long device_id = 0;
        std::ostringstream ins_dev;
        ins_dev << "INSERT INTO analytics_devices (visitor_id, device_signature, device_type, device_family, "
                << "operating_system, operating_system_version, browser, browser_version, user_agent, "
                << "language, accepted_languages, first_seen_at, last_seen_at, seen_count) VALUES ("
                << "'" << visitor_id << "', "
                << "'" << escape_sql_string(conn, event.device_signature) << "', "
                << "'" << escape_sql_string(conn, event.device_type) << "', "
                << "'" << escape_sql_string(conn, event.device_family) << "', "
                << "'" << escape_sql_string(conn, event.os_name) << "', "
                << "'" << escape_sql_string(conn, event.os_version) << "', "
                << "'" << escape_sql_string(conn, event.browser_name) << "', "
                << "'" << escape_sql_string(conn, event.browser_version) << "', "
                << "'" << escape_sql_string(conn, event.user_agent.substr(0, 512)) << "', "
                << "'" << escape_sql_string(conn, event.accept_language.substr(0, 32)) << "', "
                << "'" << escape_sql_string(conn, event.accept_language.substr(0, 255)) << "', "
                << "NOW(), NOW(), 1) "
                << "ON DUPLICATE KEY UPDATE last_seen_at = NOW(), seen_count = seen_count + 1, "
                << "user_agent = VALUES(user_agent), id = LAST_INSERT_ID(id);";
        if (mysql_query(conn, ins_dev.str().c_str()) == 0) {
            device_id = mysql_insert_id(conn);
        }

        // 3. Resolve Location (One approximate location record per visitor)
        long long location_id = 0;
        std::ostringstream ins_loc;
        ins_loc << "INSERT INTO analytics_locations (visitor_id, country, country_code, region, city, "
                << "postal_code, latitude, longitude, timezone, continent, isp, asn, source, disclaimer, looked_up_at) VALUES ("
                << "'" << visitor_id << "', "
                << "'" << escape_sql_string(conn, geo.country) << "', "
                << "'" << escape_sql_string(conn, geo.country_code) << "', "
                << "'" << escape_sql_string(conn, geo.region) << "', "
                << "'" << escape_sql_string(conn, geo.city) << "', "
                << "'" << escape_sql_string(conn, geo.postal_code) << "', "
                << geo.latitude << ", " << geo.longitude << ", "
                << "'" << escape_sql_string(conn, geo.timezone) << "', "
                << "'" << escape_sql_string(conn, geo.continent) << "', "
                << "'" << escape_sql_string(conn, geo.isp) << "', "
                << "'" << escape_sql_string(conn, geo.asn) << "', "
                << "'" << escape_sql_string(conn, geo.source) << "', "
                << "'" << escape_sql_string(conn, geo.disclaimer) << "', NOW()) "
                << "ON DUPLICATE KEY UPDATE looked_up_at = NOW(), id = LAST_INSERT_ID(id);";
        if (mysql_query(conn, ins_loc.str().c_str()) == 0) {
            location_id = mysql_insert_id(conn);
        }

        // 4. Resolve Session (Authoritative Multi-Process Concurrency & 30-min Inactivity Window)
        long long session_id = 0;
        int new_session_increment = 0;
        std::string q_sess = "SELECT id, last_seen_at, TIMESTAMPDIFF(SECOND, last_seen_at, NOW()) "
                             "FROM analytics_sessions WHERE visitor_id = '" + visitor_id + "' AND is_active = 1;";
        bool has_active_session = false;
        long long active_sess_id = 0;
        long long inactivity_gap = 999999;

        if (mysql_query(conn, q_sess.c_str()) == 0) {
            MYSQL_RES* res = mysql_store_result(conn);
            if (res) {
                MYSQL_ROW row = mysql_fetch_row(res);
                if (row && row[0]) {
                    has_active_session = true;
                    active_sess_id = std::stoll(row[0]);
                    if (row[2]) inactivity_gap = std::stoll(row[2]);
                }
                mysql_free_result(res);
            }
        }

        if (has_active_session && inactivity_gap < 1800) {
            // Inactivity gap < 30 minutes: Continue active session
            session_id = active_sess_id;
            std::ostringstream upd_sess;
            upd_sess << "UPDATE analytics_sessions SET "
                     << "last_seen_at = NOW(), "
                     << "duration_seconds = TIMESTAMPDIFF(SECOND, first_seen_at, NOW()), "
                     << "page_count = page_count + 1, "
                     << "exit_page = '" << escape_sql_string(conn, event.path) << "' "
                     << "WHERE id = " << session_id << " AND is_active = 1;";
            mysql_query(conn, upd_sess.str().c_str());
        } else {
            // Inactivity gap >= 30 minutes or no active session: Finalize previous if exists
            if (has_active_session) {
                std::string q_close = "UPDATE analytics_sessions SET is_active = NULL WHERE id = " + std::to_string(active_sess_id) + ";";
                mysql_query(conn, q_close.c_str());
            }

            // Create brand new session
            new_session_increment = 1;
            auto epoch_sec = std::chrono::duration_cast<std::chrono::seconds>(event.captured_timestamp.time_since_epoch()).count();
            std::string session_key = hmac_sha256_hex(secret, visitor_id + ":" + std::to_string(epoch_sec));

            std::ostringstream ins_sess;
            ins_sess << "INSERT INTO analytics_sessions (visitor_id, session_key, is_active, first_seen_at, last_seen_at, "
                     << "page_count, duration_seconds, entry_page, exit_page, referrer, device_id, location_id, is_bot) VALUES ("
                     << "'" << visitor_id << "', "
                     << "'" << session_key << "', 1, NOW(), NOW(), 1, 0, "
                     << "'" << escape_sql_string(conn, event.path) << "', "
                     << "'" << escape_sql_string(conn, event.path) << "', "
                     << "'" << escape_sql_string(conn, event.referer.substr(0, 512)) << "', "
                     << (device_id > 0 ? std::to_string(device_id) : "NULL") << ", "
                     << (location_id > 0 ? std::to_string(location_id) : "NULL") << ", "
                     << (event.is_bot ? 1 : 0) << ");";

            if (mysql_query(conn, ins_sess.str().c_str()) == 0) {
                session_id = mysql_insert_id(conn);
            } else if (mysql_errno(conn) == 1062) {
                // Handled race condition: Another process just inserted active session
                session_id = 0;
                std::string q_retry_sess = "SELECT id FROM analytics_sessions WHERE visitor_id = '" + visitor_id + "' AND is_active = 1;";
                for (int attempt = 0; attempt < 15 && session_id == 0; ++attempt) {
                    if (mysql_query(conn, q_retry_sess.c_str()) == 0) {
                        MYSQL_RES* res = mysql_store_result(conn);
                        if (res) {
                            MYSQL_ROW row = mysql_fetch_row(res);
                            if (row && row[0]) {
                                session_id = std::stoll(row[0]);
                                new_session_increment = 0;
                            }
                            mysql_free_result(res);
                        }
                    }
                    if (session_id == 0) {
                        std::this_thread::sleep_for(std::chrono::milliseconds(20));
                    }
                }
                if (session_id > 0) {
                    // Update it
                    std::string upd = "UPDATE analytics_sessions SET page_count = page_count + 1, last_seen_at = NOW(), "
                                      "exit_page = '" + escape_sql_string(conn, event.path) + "' WHERE id = " + std::to_string(session_id) + ";";
                    mysql_query(conn, upd.c_str());
                }
            }
        }

        if (session_id <= 0) {
            std::cerr << "❌ [Analytics] Missing session_id before page visit insert\n";
            mysql_query(conn, "ROLLBACK;");
            pool_->release(conn);
            return false;
        }

        // 5. Insert Page Visit Record
        std::ostringstream ins_pv;
        ins_pv << "INSERT INTO analytics_page_visits (visitor_id, session_id, request_id, page_url, path, query_string, "
               << "page_title, referrer_url, http_method, status_code, visited_at, response_time_ms, user_agent, "
               << "browser_name, os_name, device_type, is_bot) VALUES ("
               << "'" << visitor_id << "', "
               << session_id << ", "
               << "'" << escape_sql_string(conn, event.request_id) << "', "
               << "'" << escape_sql_string(conn, event.full_url.substr(0, 1024)) << "', "
               << "'" << escape_sql_string(conn, event.path.substr(0, 255)) << "', "
               << "'" << escape_sql_string(conn, event.sanitized_query_string.substr(0, 512)) << "', "
               << "'" << escape_sql_string(conn, event.page_title.substr(0, 255)) << "', "
               << "'" << escape_sql_string(conn, event.referer.substr(0, 512)) << "', "
               << "'" << escape_sql_string(conn, event.http_method) << "', "
               << event.status_code << ", NOW(), "
               << event.response_time_ms << ", "
               << "'" << escape_sql_string(conn, event.user_agent.substr(0, 512)) << "', "
               << "'" << escape_sql_string(conn, event.browser_name) << "', "
               << "'" << escape_sql_string(conn, event.os_name) << "', "
               << "'" << escape_sql_string(conn, event.device_type) << "', "
               << (event.is_bot ? 1 : 0) << ");";

        if (mysql_query(conn, ins_pv.str().c_str()) != 0) {
            std::cerr << "❌ [Analytics] Page Visit Insert Failed: " << mysql_error(conn) << "\n";
            mysql_query(conn, "ROLLBACK;");
            pool_->release(conn);
            return false;
        }

        // 6. Persistence-Gated Lifetime Counter Increment
        std::ostringstream upd_vis;
        upd_vis << "UPDATE analytics_visitors SET "
                << "total_page_views = total_page_views + 1, "
                << "total_visits = total_visits + " << new_session_increment << ", "
                << "last_seen_at = NOW(), "
                << "latest_user_agent = '" << escape_sql_string(conn, event.user_agent.substr(0, 512)) << "', "
                << "referrer_latest = '" << escape_sql_string(conn, event.referer.substr(0, 512)) << "' "
                << "WHERE id = '" << visitor_id << "';";
        mysql_query(conn, upd_vis.str().c_str());

        // Commit transaction
        if (mysql_query(conn, "COMMIT;") != 0) {
            std::cerr << "❌ [Analytics] Commit Failed: " << mysql_error(conn) << "\n";
            mysql_query(conn, "ROLLBACK;");
            pool_->release(conn);
            return false;
        }

        pool_->release(conn);
        return true;
    } catch (const std::exception& e) {
        std::cerr << "❌ [Analytics] Exception: " << e.what() << "\n";
        mysql_query(conn, "ROLLBACK;");
        pool_->release(conn);
        return false;
    } catch (...) {
        std::cerr << "❌ [Analytics] Unknown Exception\n";
        mysql_query(conn, "ROLLBACK;");
        pool_->release(conn);
        return false;
    }
}

void RoadmapDbClient::run_analytics_retention_purge(int raw_ip_days, int pv_days, int sess_days, int loc_days) {
    MYSQL* conn = pool_->acquire();
    if (!conn) return;

    // Invariant: sess_days >= pv_days
    if (sess_days < pv_days) {
        sess_days = pv_days;
    }

    std::cout << "🧹 [AnalyticsRetention] Running purge (raw_ip=" << raw_ip_days << "d, pv=" << pv_days 
              << "d, sess=" << sess_days << "d, loc=" << loc_days << "d)...\n";

    // 1. Redact Raw IP & sever active lookup key
    std::string q_redact = "UPDATE analytics_visitors SET ip_address = NULL, active_lookup_hash = NULL, is_redacted = 1, updated_at = NOW() "
                           "WHERE is_redacted = 0 AND last_seen_at < NOW() - INTERVAL " + std::to_string(raw_ip_days) + " DAY;";
    mysql_query(conn, q_redact.c_str());

    // 2. Prune detailed page visit event rows
    std::string q_pv = "DELETE FROM analytics_page_visits WHERE visited_at < NOW() - INTERVAL " + std::to_string(pv_days) + " DAY;";
    mysql_query(conn, q_pv.c_str());

    // 3. Prune closed session rows
    std::string q_sess = "DELETE FROM analytics_sessions WHERE is_active IS NULL AND last_seen_at < NOW() - INTERVAL " + std::to_string(sess_days) + " DAY;";
    mysql_query(conn, q_sess.c_str());

    // 4. Prune orphaned/stale location records
    std::string q_loc = "DELETE FROM analytics_locations WHERE looked_up_at < NOW() - INTERVAL " + std::to_string(loc_days) + " DAY;";
    mysql_query(conn, q_loc.c_str());

    std::cout << "✅ [AnalyticsRetention] Purge cycle completed.\n";
    pool_->release(conn);
}

std::map<std::string, std::string> RoadmapDbClient::fetch_analytics_summary_stats() {
    std::map<std::string, std::string> stats;
    stats["total_visitors"] = "0";
    stats["total_page_views"] = "0";
    stats["total_visits"] = "0";
    stats["lifetime_page_views"] = "0";
    stats["lifetime_visits"] = "0";
    stats["unique_estimated_visitors"] = "0";
    stats["retained_page_views"] = "0";
    stats["retained_sessions"] = "0";
    stats["bounce_rate_pct"] = "0.0";
    stats["visitors_today"] = "0";
    stats["visitors_week"] = "0";
    stats["page_views_today"] = "0";
    stats["page_views_week"] = "0";
    stats["bot_page_views"] = "0";

    MYSQL* conn = pool_->acquire();
    if (!conn) return stats;

    std::string q = "SELECT "
                    "(SELECT COUNT(*) FROM analytics_visitors) AS total_visitors, "
                    "(SELECT IFNULL(SUM(total_page_views), 0) FROM analytics_visitors) AS lifetime_pvs, "
                    "(SELECT IFNULL(SUM(total_visits), 0) FROM analytics_visitors) AS lifetime_visits, "
                    "(SELECT COUNT(*) FROM analytics_page_visits) AS retained_pvs, "
                    "(SELECT COUNT(*) FROM analytics_sessions) AS retained_sessions, "
                    "(SELECT COUNT(DISTINCT visitor_id) FROM analytics_page_visits WHERE visited_at >= CURDATE()) AS visitors_today, "
                    "(SELECT COUNT(*) FROM analytics_page_visits WHERE visited_at >= CURDATE()) AS pvs_today, "
                    "(SELECT COUNT(*) FROM analytics_page_visits WHERE is_bot = 1) AS bot_pvs, "
                    "(SELECT COUNT(*) FROM analytics_visitors WHERE is_redacted = 0) AS active_visitors;";

    if (mysql_query(conn, q.c_str()) == 0) {
        MYSQL_RES* res = mysql_store_result(conn);
        if (res) {
            MYSQL_ROW row = mysql_fetch_row(res);
            if (row) {
                stats["total_visitors"] = row[0] ? row[0] : "0";
                stats["lifetime_page_views"] = row[1] ? row[1] : "0";
                stats["total_page_views"] = stats["lifetime_page_views"];
                stats["lifetime_visits"] = row[2] ? row[2] : "0";
                stats["total_visits"] = stats["lifetime_visits"];
                stats["retained_page_views"] = row[3] ? row[3] : "0";
                stats["retained_sessions"] = row[4] ? row[4] : "0";
                stats["visitors_today"] = row[5] ? row[5] : "0";
                stats["page_views_today"] = row[6] ? row[6] : "0";
                stats["bot_page_views"] = row[7] ? row[7] : "0";
                stats["unique_estimated_visitors"] = row[8] ? row[8] : "0";
            }
            mysql_free_result(res);
        }
    }

    std::string q_bounce = "SELECT "
                           "(SELECT COUNT(*) FROM analytics_sessions WHERE page_count = 1) * 100.0 / "
                           "NULLIF((SELECT COUNT(*) FROM analytics_sessions), 0);";
    if (mysql_query(conn, q_bounce.c_str()) == 0) {
        MYSQL_RES* res = mysql_store_result(conn);
        if (res) {
            MYSQL_ROW row = mysql_fetch_row(res);
            if (row && row[0]) {
                try {
                    double b = std::stod(row[0]);
                    std::ostringstream bss;
                    bss << std::fixed << std::setprecision(1) << b;
                    stats["bounce_rate_pct"] = bss.str();
                } catch (...) {}
            }
            mysql_free_result(res);
        }
    }

    pool_->release(conn);
    return stats;
}

std::vector<std::map<std::string, std::string>> RoadmapDbClient::fetch_analytics_popular_pages(int limit) {
    std::vector<std::map<std::string, std::string>> pages;
    MYSQL* conn = pool_->acquire();
    if (!conn) return pages;

    std::string q = "SELECT path, COUNT(*) as cnt FROM analytics_page_visits WHERE is_bot = 0 GROUP BY path ORDER BY cnt DESC LIMIT " + std::to_string(limit) + ";";
    if (mysql_query(conn, q.c_str()) == 0) {
        MYSQL_RES* res = mysql_store_result(conn);
        if (res) {
            MYSQL_ROW row;
            while ((row = mysql_fetch_row(res))) {
                std::map<std::string, std::string> m;
                m["path"] = row[0] ? row[0] : "/";
                m["count"] = row[1] ? row[1] : "0";
                m["views"] = m["count"];
                m["visitors"] = m["count"];
                pages.push_back(m);
            }
            mysql_free_result(res);
        }
    }
    pool_->release(conn);
    return pages;
}

std::vector<std::map<std::string, std::string>> RoadmapDbClient::fetch_analytics_countries(int limit) {
    std::vector<std::map<std::string, std::string>> countries;
    MYSQL* conn = pool_->acquire();
    if (!conn) return countries;

    std::string q = "SELECT country, country_code, COUNT(*) as cnt FROM analytics_locations GROUP BY country, country_code ORDER BY cnt DESC LIMIT " + std::to_string(limit) + ";";
    if (mysql_query(conn, q.c_str()) == 0) {
        MYSQL_RES* res = mysql_store_result(conn);
        if (res) {
            MYSQL_ROW row;
            while ((row = mysql_fetch_row(res))) {
                std::map<std::string, std::string> m;
                m["country"] = row[0] ? row[0] : "Unknown";
                m["country_code"] = row[1] ? row[1] : "XX";
                m["count"] = row[2] ? row[2] : "0";
                m["views"] = m["count"];
                countries.push_back(m);
            }
            mysql_free_result(res);
        }
    }
    pool_->release(conn);
    return countries;
}

std::vector<std::map<std::string, std::string>> RoadmapDbClient::fetch_analytics_browsers() {
    std::vector<std::map<std::string, std::string>> items;
    MYSQL* conn = pool_->acquire();
    if (!conn) return items;

    std::string q = "SELECT browser, COUNT(*) as cnt FROM analytics_devices GROUP BY browser ORDER BY cnt DESC LIMIT 6;";
    if (mysql_query(conn, q.c_str()) == 0) {
        MYSQL_RES* res = mysql_store_result(conn);
        if (res) {
            MYSQL_ROW row;
            while ((row = mysql_fetch_row(res))) {
                std::map<std::string, std::string> m;
                m["browser"] = row[0] ? row[0] : "Other";
                m["browser_name"] = m["browser"];
                m["count"] = row[1] ? row[1] : "0";
                m["views"] = m["count"];
                items.push_back(m);
            }
            mysql_free_result(res);
        }
    }
    pool_->release(conn);
    return items;
}

std::vector<std::map<std::string, std::string>> RoadmapDbClient::fetch_analytics_os() {
    std::vector<std::map<std::string, std::string>> items;
    MYSQL* conn = pool_->acquire();
    if (!conn) return items;

    std::string q = "SELECT operating_system, COUNT(*) as cnt FROM analytics_devices GROUP BY operating_system ORDER BY cnt DESC LIMIT 6;";
    if (mysql_query(conn, q.c_str()) == 0) {
        MYSQL_RES* res = mysql_store_result(conn);
        if (res) {
            MYSQL_ROW row;
            while ((row = mysql_fetch_row(res))) {
                std::map<std::string, std::string> m;
                m["os"] = row[0] ? row[0] : "Other";
                m["os_name"] = m["os"];
                m["count"] = row[1] ? row[1] : "0";
                m["views"] = m["count"];
                items.push_back(m);
            }
            mysql_free_result(res);
        }
    }
    pool_->release(conn);
    return items;
}

std::vector<std::map<std::string, std::string>> RoadmapDbClient::fetch_analytics_devices() {
    std::vector<std::map<std::string, std::string>> items;
    MYSQL* conn = pool_->acquire();
    if (!conn) return items;

    std::string q = "SELECT device_type, COUNT(*) as cnt FROM analytics_devices GROUP BY device_type ORDER BY cnt DESC LIMIT 5;";
    if (mysql_query(conn, q.c_str()) == 0) {
        MYSQL_RES* res = mysql_store_result(conn);
        if (res) {
            MYSQL_ROW row;
            while ((row = mysql_fetch_row(res))) {
                std::map<std::string, std::string> m;
                m["device_type"] = row[0] ? row[0] : "desktop";
                m["count"] = row[1] ? row[1] : "0";
                m["views"] = m["count"];
                items.push_back(m);
            }
            mysql_free_result(res);
        }
    }
    pool_->release(conn);
    return items;
}

std::pair<int, std::vector<std::map<std::string, std::string>>> RoadmapDbClient::fetch_admin_visitors(
    int page, int limit, const std::string& search_ip, const std::string& country_filter, int bot_filter) {
    std::vector<std::map<std::string, std::string>> records;
    int total_count = 0;

    MYSQL* conn = pool_->acquire();
    if (!conn) return {0, records};

    if (page < 1) page = 1;
    if (limit < 1 || limit > 100) limit = 25;
    int offset = (page - 1) * limit;

    std::string where = "WHERE 1=1 ";
    if (!search_ip.empty()) {
        where += "AND v.ip_address LIKE '%" + escape_sql_string(conn, search_ip) + "%' ";
    }
    if (!country_filter.empty()) {
        where += "AND l.country = '" + escape_sql_string(conn, country_filter) + "' ";
    }
    if (bot_filter >= 0) {
        where += "AND v.is_bot = " + std::to_string(bot_filter) + " ";
    }

    std::string count_q = "SELECT COUNT(*) FROM analytics_visitors v LEFT JOIN analytics_locations l ON v.id = l.visitor_id " + where + ";";
    if (mysql_query(conn, count_q.c_str()) == 0) {
        MYSQL_RES* res = mysql_store_result(conn);
        if (res) {
            MYSQL_ROW row = mysql_fetch_row(res);
            if (row && row[0]) total_count = std::stoi(row[0]);
            mysql_free_result(res);
        }
    }

    std::string q = "SELECT v.id, IFNULL(v.ip_address, 'Redacted'), v.ip_version, v.total_visits, v.total_page_views, "
                    "v.browser_name, v.operating_system, v.device_type, v.is_bot, v.identity_confidence, "
                    "DATE_FORMAT(v.first_seen_at, '%Y-%m-%d %H:%i:%s'), DATE_FORMAT(v.last_seen_at, '%Y-%m-%d %H:%i:%s'), "
                    "IFNULL(l.country, 'Unknown'), IFNULL(l.city, 'Unknown'), v.is_redacted "
                    "FROM analytics_visitors v LEFT JOIN analytics_locations l ON v.id = l.visitor_id "
                    + where + " ORDER BY v.last_seen_at DESC LIMIT " + std::to_string(limit) + " OFFSET " + std::to_string(offset) + ";";

    if (mysql_query(conn, q.c_str()) == 0) {
        MYSQL_RES* res = mysql_store_result(conn);
        if (res) {
            MYSQL_ROW row;
            while ((row = mysql_fetch_row(res))) {
                std::map<std::string, std::string> r;
                r["id"] = row[0] ? row[0] : "";
                r["visitor_id"] = r["id"];
                r["ip_address"] = row[1] ? row[1] : "Redacted";
                r["ip_version"] = row[2] ? row[2] : "IPv4";
                r["total_visits"] = row[3] ? row[3] : "0";
                r["total_page_views"] = row[4] ? row[4] : "0";
                r["browser"] = row[5] ? row[5] : "Other";
                r["browser_name"] = r["browser"];
                r["os"] = row[6] ? row[6] : "Other";
                r["os_name"] = r["os"];
                r["device_type"] = row[7] ? row[7] : "desktop";
                r["is_bot"] = row[8] ? row[8] : "0";
                r["confidence"] = row[9] ? row[9] : "MEDIUM";
                r["first_seen_at"] = row[10] ? row[10] : "";
                r["last_seen_at"] = row[11] ? row[11] : "";
                r["country"] = row[12] ? row[12] : "Unknown";
                r["city"] = row[13] ? row[13] : "Unknown";
                r["is_redacted"] = row[14] ? row[14] : "0";
                records.push_back(r);
            }
            mysql_free_result(res);
        }
    }

    pool_->release(conn);
    return {total_count, records};
}

std::map<std::string, std::string> RoadmapDbClient::fetch_admin_visitor_detail(const std::string& visitor_id) {
    std::map<std::string, std::string> d;
    MYSQL* conn = pool_->acquire();
    if (!conn) return d;

    std::string q = "SELECT v.id, IFNULL(v.ip_address, 'Redacted'), v.ip_version, v.identity_generation, v.is_redacted, "
                    "v.total_visits, v.total_page_views, v.browser_name, v.browser_version, v.operating_system, v.os_version, "
                    "v.device_type, v.device_family, v.is_bot, IFNULL(v.bot_name, ''), v.identity_confidence, "
                    "DATE_FORMAT(v.first_seen_at, '%Y-%m-%d %H:%i:%s'), DATE_FORMAT(v.last_seen_at, '%Y-%m-%d %H:%i:%s'), "
                    "IFNULL(v.first_user_agent, ''), IFNULL(v.latest_user_agent, ''), "
                    "IFNULL(l.country, 'Unknown'), IFNULL(l.region, 'Unknown'), IFNULL(l.city, 'Unknown'), "
                    "IFNULL(l.timezone, 'UTC'), IFNULL(l.isp, 'Unknown'), IFNULL(l.asn, 'Unknown') "
                    "FROM analytics_visitors v LEFT JOIN analytics_locations l ON v.id = l.visitor_id "
                    "WHERE v.id = '" + escape_sql_string(conn, visitor_id) + "' LIMIT 1;";

    if (mysql_query(conn, q.c_str()) == 0) {
        MYSQL_RES* res = mysql_store_result(conn);
        if (res) {
            MYSQL_ROW row = mysql_fetch_row(res);
            if (row) {
                d["id"] = row[0] ? row[0] : "";
                d["visitor_id"] = d["id"];
                d["ip_address"] = row[1] ? row[1] : "Redacted";
                d["ip_version"] = row[2] ? row[2] : "IPv4";
                d["identity_generation"] = row[3] ? row[3] : "1";
                d["is_redacted"] = row[4] ? row[4] : "0";
                d["total_visits"] = row[5] ? row[5] : "0";
                d["total_page_views"] = row[6] ? row[6] : "0";
                d["browser_name"] = row[7] ? row[7] : "";
                d["browser_version"] = row[8] ? row[8] : "";
                d["os_name"] = row[9] ? row[9] : "";
                d["os_version"] = row[10] ? row[10] : "";
                d["device_type"] = row[11] ? row[11] : "desktop";
                d["device_family"] = row[12] ? row[12] : "PC";
                d["is_bot"] = row[13] ? row[13] : "0";
                d["bot_name"] = row[14] ? row[14] : "";
                d["confidence"] = row[15] ? row[15] : "MEDIUM";
                d["first_seen_at"] = row[16] ? row[16] : "";
                d["last_seen_at"] = row[17] ? row[17] : "";
                d["first_user_agent"] = row[18] ? row[18] : "";
                d["latest_user_agent"] = row[19] ? row[19] : "";
                d["country"] = row[20] ? row[20] : "Unknown";
                d["region"] = row[21] ? row[21] : "Unknown";
                d["city"] = row[22] ? row[22] : "Unknown";
                d["timezone"] = row[23] ? row[23] : "UTC";
                d["isp"] = row[24] ? row[24] : "Unknown";
                d["asn"] = row[25] ? row[25] : "Unknown";
            }
            mysql_free_result(res);
        }
    }
    pool_->release(conn);
    return d;
}

std::vector<std::map<std::string, std::string>> RoadmapDbClient::fetch_admin_visitor_page_history(const std::string& visitor_id, int limit) {
    std::vector<std::map<std::string, std::string>> records;
    MYSQL* conn = pool_->acquire();
    if (!conn) return records;

    std::string q = "SELECT path, http_method, status_code, DATE_FORMAT(visited_at, '%Y-%m-%d %H:%i:%s'), "
                    "response_time_ms, IFNULL(referrer_url, ''), session_id "
                    "FROM analytics_page_visits WHERE visitor_id = '" + escape_sql_string(conn, visitor_id) + "' "
                    "ORDER BY visited_at DESC LIMIT " + std::to_string(limit) + ";";

    if (mysql_query(conn, q.c_str()) == 0) {
        MYSQL_RES* res = mysql_store_result(conn);
        if (res) {
            MYSQL_ROW row;
            while ((row = mysql_fetch_row(res))) {
                std::map<std::string, std::string> r;
                r["path"] = row[0] ? row[0] : "";
                r["http_method"] = row[1] ? row[1] : "GET";
                r["status_code"] = row[2] ? row[2] : "200";
                r["visited_at"] = row[3] ? row[3] : "";
                r["response_time_ms"] = row[4] ? row[4] : "0";
                r["referrer"] = row[5] ? row[5] : "";
                r["referer"] = r["referrer"];
                r["session_id"] = row[6] ? row[6] : "0";
                records.push_back(r);
            }
            mysql_free_result(res);
        }
    }
    pool_->release(conn);
    return records;
}

std::vector<std::map<std::string, std::string>> RoadmapDbClient::fetch_admin_visitor_sessions(const std::string& visitor_id, int limit) {
    std::vector<std::map<std::string, std::string>> records;
    MYSQL* conn = pool_->acquire();
    if (!conn) return records;

    std::string q = "SELECT id, session_key, DATE_FORMAT(first_seen_at, '%Y-%m-%d %H:%i:%s'), "
                    "DATE_FORMAT(last_seen_at, '%Y-%m-%d %H:%i:%s'), page_count, duration_seconds, "
                    "IFNULL(entry_page, ''), IFNULL(exit_page, ''), IFNULL(is_active, 0) "
                    "FROM analytics_sessions WHERE visitor_id = '" + escape_sql_string(conn, visitor_id) + "' "
                    "ORDER BY first_seen_at DESC LIMIT " + std::to_string(limit) + ";";

    if (mysql_query(conn, q.c_str()) == 0) {
        MYSQL_RES* res = mysql_store_result(conn);
        if (res) {
            MYSQL_ROW row;
            while ((row = mysql_fetch_row(res))) {
                std::map<std::string, std::string> r;
                r["id"] = row[0] ? row[0] : "";
                r["session_id"] = r["id"];
                r["session_key"] = row[1] ? row[1] : "";
                r["first_seen_at"] = row[2] ? row[2] : "";
                r["started_at"] = r["first_seen_at"];
                r["last_seen_at"] = row[3] ? row[3] : "";
                r["ended_at"] = r["last_seen_at"];
                r["page_count"] = row[4] ? row[4] : "1";
                r["page_views"] = r["page_count"];
                r["duration_seconds"] = row[5] ? row[5] : "0";
                r["duration_sec"] = r["duration_seconds"];
                r["entry_page"] = row[6] ? row[6] : "";
                r["exit_page"] = row[7] ? row[7] : "";
                r["is_active"] = (row[8] && std::string(row[8]) == "1") ? "1" : "0";
                records.push_back(r);
            }
            mysql_free_result(res);
        }
    }
    pool_->release(conn);
    return records;
}

std::vector<std::map<std::string, std::string>> RoadmapDbClient::fetch_closed_trades_for_date(const std::string& session_date) {
    std::vector<std::map<std::string, std::string>> trades;
    MYSQL* conn = pool_->acquire();
    if (!conn) return trades;

    std::string safe_date = session_date.empty() ? "CURRENT_DATE()" : ("'" + escape_string(conn, session_date) + "'");
    std::string q = "SELECT instrument, side, quantity, entryPrice, exitPrice, netPnl, "
                    "DATE_FORMAT(orderedAt, '%H:%i:%s'), DATE_FORMAT(closedAt, '%H:%i:%s') "
                    "FROM cpp_trade_reports WHERE status = 'CLOSED' AND DATE(closedAt) = " + safe_date + " "
                    "ORDER BY closedAt ASC;";

    if (mysql_query(conn, q.c_str()) == 0) {
        MYSQL_RES* res = mysql_store_result(conn);
        if (res) {
            MYSQL_ROW row;
            while ((row = mysql_fetch_row(res))) {
                std::map<std::string, std::string> t;
                t["instrument"] = row[0] ? row[0] : "";
                t["side"] = row[1] ? row[1] : "";
                t["quantity"] = row[2] ? row[2] : "0";
                t["entry_price"] = row[3] ? row[3] : "0.0";
                t["exit_price"] = row[4] ? row[4] : "0.0";
                t["net_pnl"] = row[5] ? row[5] : "0.0";
                t["ordered_at"] = row[6] ? row[6] : "";
                t["closed_at"] = row[7] ? row[7] : "";
                trades.push_back(t);
            }
            mysql_free_result(res);
        }
    }
    pool_->release(conn);
    return trades;
}

int RoadmapDbClient::fetch_open_positions_count() {
    int count = 0;
    MYSQL* conn = pool_->acquire();
    if (!conn) return 0;

    std::string q = "SELECT COUNT(*) FROM cpp_trade_reports WHERE status = 'OPEN';";
    if (mysql_query(conn, q.c_str()) == 0) {
        MYSQL_RES* res = mysql_store_result(conn);
        if (res) {
            MYSQL_ROW row = mysql_fetch_row(res);
            if (row && row[0]) {
                try { count = std::stoi(row[0]); } catch (...) {}
            }
            mysql_free_result(res);
        }
    }
    pool_->release(conn);
    return count;
}

std::vector<hermes::PositionExitEvaluation> RoadmapDbClient::fetch_open_positions_with_exit_evaluation() {
    std::vector<hermes::PositionExitEvaluation> results;
    MYSQL* conn = pool_->acquire();
    if (!conn) return results;

    std::string query = "SELECT id, instrument, side, quantity, entryPrice, DATE_FORMAT(orderedAt, '%Y-%m-%d %H:%i:%s') "
                        "FROM cpp_trade_reports WHERE status = 'OPEN' ORDER BY orderedAt ASC;";

    struct TempOpenTrade {
        std::string id;
        std::string inst;
        std::string side;
        int qty{0};
        double entry{0.0};
        std::string ordered_at;
    };
    std::vector<TempOpenTrade> open_list;

    if (mysql_query(conn, query.c_str()) == 0) {
        MYSQL_RES* res = mysql_store_result(conn);
        if (res) {
            MYSQL_ROW row;
            while ((row = mysql_fetch_row(res))) {
                TempOpenTrade t;
                t.id = row[0] ? row[0] : "";
                t.inst = row[1] ? row[1] : "";
                t.side = row[2] ? row[2] : "BUY";
                try {
                    t.qty = row[3] ? std::stoi(row[3]) : 0;
                    t.entry = row[4] ? std::stod(row[4]) : 0.0;
                } catch (...) {}
                t.ordered_at = row[5] ? row[5] : "";
                open_list.push_back(t);
            }
            mysql_free_result(res);
        }
    }

    auto quote_map = fetch_latest_quotes_map(conn);
    pool_->release(conn);

    for (const auto& t : open_list) {
        double cur_ltp = lookup_ltp_from_map(quote_map, t.inst, t.entry);
        auto eval = hermes::PositionExitEvaluator::evaluate_position_exit(
            t.id, t.inst, t.side, t.qty, t.entry, cur_ltp, t.ordered_at
        );
        results.push_back(eval);
    }

    return results;
}

double RoadmapDbClient::fetch_today_session_realized_pnl(const std::string& session_date) {
    double pnl = 0.0;
    MYSQL* conn = pool_->acquire();
    if (!conn) return 0.0;

    std::string safe_date = session_date.empty() ? "CURRENT_DATE()" : ("'" + escape_string(conn, session_date) + "'");
    std::string q = "SELECT IFNULL(SUM(netPnl), 0.0) FROM cpp_trade_reports WHERE status = 'CLOSED' AND DATE(closedAt) = " + safe_date + ";";
    if (mysql_query(conn, q.c_str()) == 0) {
        MYSQL_RES* res = mysql_store_result(conn);
        if (res) {
            MYSQL_ROW row = mysql_fetch_row(res);
            if (row && row[0]) {
                try { pnl = std::stod(row[0]); } catch (...) {}
            }
            mysql_free_result(res);
        }
    }
    pool_->release(conn);
    return pnl;
}

std::map<std::string, std::string> RoadmapDbClient::fetch_latest_post_session_record(const std::string& session_date) {
    std::map<std::string, std::string> record;
    MYSQL* conn = pool_->acquire();
    if (!conn) return record;

    std::string where = session_date.empty() ? "ORDER BY session_date DESC LIMIT 1"
                                             : ("WHERE session_date = '" + escape_string(conn, session_date) + "' LIMIT 1");
    std::string q = "SELECT session_date, total_ticks, evaluated_decisions, no_action_count, actionable_count, "
                    "risk_veto_count, trades_executed, realized_drawdown, avg_ofi, max_ofi, near_miss_count, "
                    "recommendations_json, DATE_FORMAT(analyzed_at, '%Y-%m-%d %H:%i:%s') "
                    "FROM cpp_post_session_analysis " + where + ";";

    if (mysql_query(conn, q.c_str()) == 0) {
        MYSQL_RES* res = mysql_store_result(conn);
        if (res) {
            MYSQL_ROW row = mysql_fetch_row(res);
            if (row) {
                record["session_date"] = row[0] ? row[0] : "";
                record["total_ticks"] = row[1] ? row[1] : "0";
                record["evaluated_decisions"] = row[2] ? row[2] : "0";
                record["no_action_count"] = row[3] ? row[3] : "0";
                record["actionable_count"] = row[4] ? row[4] : "0";
                record["risk_veto_count"] = row[5] ? row[5] : "0";
                record["trades_executed"] = row[6] ? row[6] : "0";
                record["realized_drawdown"] = row[7] ? row[7] : "0.0";
                record["avg_ofi"] = row[8] ? row[8] : "0.0";
                record["max_ofi"] = row[9] ? row[9] : "0.0";
                record["near_miss_count"] = row[10] ? row[10] : "0";
                record["recommendations_json"] = row[11] ? row[11] : "{}";
                record["analyzed_at"] = row[12] ? row[12] : "";
            }
            mysql_free_result(res);
        }
    }
    pool_->release(conn);
    return record;
}

uint64_t RoadmapDbClient::count_historical_candles_for_date(const std::string& session_date) {
    uint64_t count = 0;
    MYSQL* conn = pool_local_->acquire();
    if (!conn) return 0;

    std::string safe_date = session_date.empty() ? "CURRENT_DATE()" : ("'" + escape_string(conn, session_date) + "'");
    std::string q = "SELECT COUNT(*) FROM cpp_historical_daily_candles WHERE candle_date = " + safe_date + ";";
    if (mysql_query(conn, q.c_str()) == 0) {
        MYSQL_RES* res = mysql_store_result(conn);
        if (res) {
            MYSQL_ROW row = mysql_fetch_row(res);
            if (row && row[0]) {
                try { count = std::stoull(row[0]); } catch (...) {}
            }
            mysql_free_result(res);
        }
    }
    release_local(conn);
    return count;
}


