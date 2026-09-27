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

private:
    std::shared_ptr<MySQLConnectionPool> pool_;
};

#endif // ROADMAP_DB_CLIENT_HPP
