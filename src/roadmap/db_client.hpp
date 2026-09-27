#ifndef ROADMAP_DB_CLIENT_HPP
#define ROADMAP_DB_CLIENT_HPP

#include <string>
#include <vector>
#include <queue>
#include <mutex>
#include <condition_variable>
#include <memory>
#include <mysql/mysql.h>

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
    double exitPrice = 0.0;
    double netPnl = 0.0;
    std::string status;
    std::string orderedAt;
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
    ~RoadmapDbClient();

    bool test_connection();
    std::vector<ChecklistItem> fetch_all_items();
    RoadmapOverview compute_overview(const std::vector<ChecklistItem>& items);
    std::vector<CppRoadmapItem> fetch_cpp_roadmap_items();
    RoadmapOverview compute_cpp_overview(const std::vector<CppRoadmapItem>& items);
    bool update_item_status(int id, const std::string& status);
    bool update_item_note(int id, const std::string& note);

    UserProfile fetch_user_by_email_or_id(const std::string& identifier);
    UserPortfolioData fetch_user_portfolio(const std::string& user_id);
    std::vector<UserTradeData> fetch_user_trades(const std::string& user_id, int limit = 10);

    UpstoxTokenInfo fetch_upstox_token_status();
    bool save_upstox_access_token(const std::string& token, const std::string& client_id, const std::string& expires_at);

    BrokerTokenInfo fetch_broker_token_status(const std::string& provider);
    bool save_broker_access_token(const std::string& provider, const std::string& token, const std::string& client_id, const std::string& expires_at);

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

private:
    std::shared_ptr<MySQLConnectionPool> pool_;
};

#endif // ROADMAP_DB_CLIENT_HPP
