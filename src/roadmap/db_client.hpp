#ifndef ROADMAP_DB_CLIENT_HPP
#define ROADMAP_DB_CLIENT_HPP

#include <string>
#include <vector>
#include <queue>
#include <mutex>
#include <condition_variable>
#include <memory>
#include <map>
#include <tuple>
#include <unordered_set>
#include <mysql/mysql.h>

struct CanonicalOptionTick;

struct ChecklistItem {
    int id;
    int item_order;
    std::string grp;
    std::string goal;
    std::string item;
    std::string status;
    std::string note;
    std::string instr;
    std::string doneWhen;
};

struct CppRoadmapItem {
    int id;
    int phase_order;
    std::string phase_name;
    std::string item_title;
    std::string status;
    std::string source_guide;
    std::string done_when;
    std::string evidence_note;
};

struct HermesCppStage {
    std::string stage_id;
    std::string stage_label;
    std::string goal;
    int order_index = 0;
    int total_items = 0;
    int done_items = 0;
    int blocked_items = 0;
    int in_progress_items = 0;
    double pct_complete = 0.0;
};

struct HermesCppItem {
    std::string item_id;
    std::string stage_id;
    std::string description;
    std::string instruction;
    std::string done_when;
    std::string status;
    std::string note;
};

struct HermesCppClarification {
    long long clarification_id = 0;
    std::string item_id;
    std::string stage_label;
    std::string question;
    std::string answer;
    std::string status;
    std::string created_at;
    std::string answered_at;
};

struct RoadmapOverview {
    int total = 0;
    int done = 0;
    int in_progress = 0;
    int pending = 0;
    int blocked = 0;
    int pct = 0;
};

struct UserProfile {
    std::string id;
    std::string email;
    std::string name;
    std::string role;
};

struct UserPortfolioData {
    std::string portfolioId;
    std::string userId;
    double capital = 0.0;
    double deployed = 0.0;
    double grossPnl = 0.0;
    double totalCharges = 0.0;
    double netPnl = 0.0;
    double unrealisedPnl = 0.0;
    int autoTradeEnabled = 0;
    int openPositionCount = 0;
    std::string executionProvider;
    std::string executionMode;
};

struct UserTradeData {
    std::string id;
    std::string instrument;
    std::string side;
    int quantity = 0;
    double entryPrice = 0.0;
    double currentLtp = 0.0;
    double exitPrice = 0.0;
    double grossPnl = 0.0;
    double cost = 0.0;
    double netPnl = 0.0;
    double unrealizedPnl = 0.0;
    std::string status;
    std::string orderedAt;
    std::string signal_timestamp;
    std::string closedAt;
    std::string executionProvider = "UPSTOX_PAPER";
    std::string executionMode = "PAPER";
    int onRealData = 1;
    std::string algoSource = "GapFadeP0Strategy";
};

struct MarketSnapshotData {
    std::string instrument;
    double price{0.0};
    double changePct{0.0};
    double volume{0.0};
    double open{0.0};
    double high{0.0};
    double low{0.0};
    double close{0.0};
    std::string ts;
};

struct DecayCalibrationData {
    int weekday{0};
    double decayRate{0.04};
    double windowStartHour{9.5};
    double windowEndHour{15.25};
    int samples{0};
    std::string lastRectifiedAt;
};

struct LearningSummaryData {
    int totalClosed{0};
    int winners{0};
    double winRate{0.0};
    double netPnl{0.0};
    std::map<std::string, std::tuple<int, double, double>> byAlgo; // algo -> <count, winRate, netPnl>
};

struct SandboxLogData {
    std::string id;
    std::string instrument;
    std::string side;
    int quantity{0};
    double entryPrice{0.0};
    double exitPrice{0.0};
    double netPnl{0.0};
    std::string status;
    std::string orderedAt;
    std::string closedAt;
    std::string executionProvider;
};

class MySQLConnectionPool {
public:
    MySQLConnectionPool(std::string host, int port, std::string user, std::string password, std::string db_name, size_t pool_size = 5);
    ~MySQLConnectionPool();

    MYSQL* acquire();
    void release(MYSQL* conn);

private:
    MYSQL* create_connection();

    std::string host_;
    int port_;
    std::string user_;
    std::string password_;
    std::string db_name_;
    size_t pool_size_;

    std::queue<MYSQL*> pool_;
    std::unordered_set<MYSQL*> all_created_connections_;
    std::mutex mutex_;
    std::condition_variable cv_;
};

class TransactionGuard {
public:
    explicit TransactionGuard(MYSQL* conn);
    ~TransactionGuard();

    bool commit();
    void rollback();

private:
    MYSQL* conn_;
    bool committed_;
};

struct UpstoxTokenInfo {
    std::string provider = "upstox";
    std::string client_id;
    std::string status = "EXPIRED";
    std::string expires_at;
    std::string issued_at;
    bool is_valid = false;
};

typedef UpstoxTokenInfo BrokerTokenInfo;

class RoadmapDbClient {
public:
    RoadmapDbClient(std::string host, int port, std::string user, std::string password, std::string db_name);
    RoadmapDbClient(std::string remote_host, int remote_port, std::string remote_user, std::string remote_pass, std::string remote_db,
                    std::string local_host, int local_port, std::string local_user, std::string local_pass, std::string local_db);
    ~RoadmapDbClient();

    bool test_connection();
    bool test_local_connection();
    std::string get_ssl_cipher_status();
    std::vector<ChecklistItem> fetch_all_items();
    RoadmapOverview compute_overview(const std::vector<ChecklistItem>& items);
    std::vector<CppRoadmapItem> fetch_cpp_roadmap_items();
    RoadmapOverview compute_cpp_overview(const std::vector<CppRoadmapItem>& items);
    bool update_item_status(int id, const std::string& status);
    bool update_item_note(int id, const std::string& note);

    UserProfile fetch_user_by_email_or_id(const std::string& identifier);
    UserPortfolioData fetch_user_portfolio(const std::string& user_id);
    std::vector<UserTradeData> fetch_user_trades(const std::string& user_id, int limit = 20, int offset = 0);
    int fetch_user_trade_count(const std::string& user_id);
    bool create_paper_trade(const UserTradeData& trade);
    bool close_paper_trade(const std::string& trade_id, double exit_price, double net_pnl, double cost = 40.0);
    size_t count_open_trades_for_symbol(const std::string& instrument);
    double fetch_today_session_drawdown();
    int settle_expired_positions();
    void update_external_case_study_ltps();

    UpstoxTokenInfo fetch_upstox_token_status();
    bool save_upstox_access_token(const std::string& token, const std::string& client_id, const std::string& expires_at);

    BrokerTokenInfo fetch_broker_token_status(const std::string& provider);
    std::string fetch_active_broker_token_raw(const std::string& provider);
    bool save_broker_access_token(const std::string& provider, const std::string& token, const std::string& client_id, const std::string& expires_at);
    bool save_canonical_market_snapshot(const CanonicalOptionTick& tick);
    std::vector<CanonicalOptionTick> fetch_live_quotes_since(const std::string& since_timestamp);
    std::pair<long long, long long> fetch_stored_tick_counts();

    // FNF Market Data, Decay, Learning, and Internal Sandbox Methods
    std::vector<MarketSnapshotData> fetch_market_snapshots();
    std::vector<DecayCalibrationData> fetch_decay_calibrations();
    LearningSummaryData fetch_learning_summary();
    std::vector<SandboxLogData> fetch_sandbox_logs(int limit = 10);

    // Hermes-CPP Zero-Progress Roadmap & Clarifications Methods
    std::vector<HermesCppStage> fetch_hermes_cpp_stages();
    std::vector<HermesCppItem> fetch_hermes_cpp_items();
    std::vector<HermesCppClarification> fetch_hermes_cpp_clarifications();
    bool update_hermes_cpp_item_status_and_note(const std::string& item_id, const std::string& status, const std::string& note);
    bool add_hermes_cpp_clarification(const std::string& item_id, const std::string& stage_label, const std::string& question);
    bool answer_hermes_cpp_clarification(long long id, const std::string& answer);

    // Gate 1: Decision Journal ACID Methods
    bool log_decision_journal_record(const std::string& uuid, const std::string& session_id, const std::string& git_sha, const std::string& version, const std::string& symbol, const std::string& action, double confidence, double margin, const std::string& reason, const std::string& snapshot_json);
    bool fetch_decision_journal_record(const std::string& uuid, std::string& out_session_id, std::string& out_git_sha, std::string& out_version, std::string& out_symbol, std::string& out_action, double& out_confidence, double& out_margin, std::string& out_reason, std::string& out_snapshot_json);

    // Gate 22: Cyclical / Seasonality Pattern Hypothesis Registry Methods
    bool save_seasonality_pattern_record(const std::string& id, const std::string& underlying, const std::string& time_bucket_15m, int dow, int dte, size_t ticks, size_t session_days, double vol, double persistence, double spread, double oi_buildup, int min_days, const std::string& status, double advisory_mod, const std::string& summary);
    std::vector<std::map<std::string, std::string>> fetch_archived_tick_samples(int limit_days = 30);
    std::vector<std::map<std::string, std::string>> fetch_seasonality_patterns();

    // Upstox Historical Data V3 API Ingestion & Prediction Context Methods
    bool save_upstox_historical_candles(const std::vector<struct UpstoxCandleRecord>& candles, size_t& out_inserted, size_t& out_duplicates);
    struct UpstoxBackfillReport backfill_upstox_historical_data(const std::string& symbol, const std::string& interval, const std::string& to_date, const std::string& from_date);
    std::vector<MarketSnapshotData> fetch_full_historical_context(const std::string& instrument, const std::string& decision_timestamp, const std::string& from_timestamp = "");
    std::vector<struct UpstoxCandleRecord> fetch_daily_candles_db(const std::string& symbol);
    std::vector<struct UpstoxCandleRecord> fetch_intraday_candles_db(const std::string& symbol);

    // Post-session analysis & End-of-day data lifecycle methods (Additive)
    struct SessionDecisionStats {
        uint64_t total_eval{0};
        uint64_t no_action{0};
        uint64_t actionable{0};
        uint64_t risk_vetoes{0};
        double avg_confidence{0.0};
        double max_confidence{0.0};
        int near_miss_count{0};
    };
    SessionDecisionStats fetch_session_decision_stats(const std::string& session_date);
    bool save_post_session_analysis_record(const std::string& id, const std::string& session_date, const std::string& session_phase,
                                          uint64_t total_ticks, uint64_t evaluated_decisions, uint64_t no_action_cnt,
                                          uint64_t actionable_cnt, uint64_t risk_veto_cnt, int trades_executed,
                                          double realized_drawdown, double avg_ofi, double max_ofi, int near_miss_cnt,
                                          const std::string& recommendations_json);
    uint64_t rollup_ticks_to_daily_candles(const std::string& session_date);
    uint64_t archive_market_snapshots_before(const std::string& boundary_date, uint64_t& out_deleted);

    // Test Isolation & Production Defense-in-Depth Guard
    void set_test_isolation(bool enable) { is_test_isolation_ = enable; }
    bool is_test_isolation() const { return is_test_isolation_; }
    bool ensure_test_schema();
    void cleanup_test_schema();

private:
    std::shared_ptr<MySQLConnectionPool> pool_;        // Remote Server pool for common data & tokens
    std::shared_ptr<MySQLConnectionPool> pool_local_;  // Local DB pool for high-frequency ticks & historical candles
    bool is_test_isolation_{false};

    MYSQL* acquire_local();
    void release_local(MYSQL* conn);
};

#endif // ROADMAP_DB_CLIENT_HPP
