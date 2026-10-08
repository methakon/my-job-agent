#ifndef COMMON_INTERFACES_HPP
#define COMMON_INTERFACES_HPP

#include "../engine/tick_receiver.hpp"
#include "../engine/feature_engine.hpp"
#include "../roadmap/db_client.hpp"
#include <vector>
#include <string>
#include <memory>

// SOLID Interface Segregation & Dependency Inversion

// 1. ITickStream Interface (Single Responsibility: Tick Streaming)
class ITickStream {
public:
    virtual ~ITickStream() = default;
    virtual void start() = 0;
    virtual void stop() = 0;
    virtual bool get_next_tick(CanonicalOptionTick& out_tick) = 0;
};

// 2. IFeatureCalculator Interface (Single Responsibility: Microstructure & Quant Math)
class IFeatureCalculator {
public:
    virtual ~IFeatureCalculator() = default;
    virtual MicrostructureFeatures process_tick(const CanonicalOptionTick& tick) = 0;
    virtual std::vector<OrderBookHeatmapLevel> compute_heatmap(const std::vector<CanonicalOptionTick>& ticks) = 0;
};

// 3. IDbClient Interface (Single Responsibility: Database Transactions & Data Access)
class IDbClient {
public:
    virtual ~IDbClient() = default;
    virtual bool test_connection() = 0;
    virtual std::vector<ChecklistItem> fetch_all_items() = 0;
    virtual bool update_item_status(int id, const std::string& status) = 0;
    virtual UserProfile fetch_user_by_email_or_id(const std::string& identifier) = 0;
    virtual UserPortfolioData fetch_user_portfolio(const std::string& user_id) = 0;
    virtual std::vector<UserTradeData> fetch_user_trades(const std::string& user_id, int limit = 20, int offset = 0) = 0;
    virtual int fetch_user_trade_count(const std::string& user_id) = 0;
    virtual UpstoxTokenInfo fetch_upstox_token_status() = 0;
    virtual bool save_upstox_access_token(const std::string& token, const std::string& client_id, const std::string& expires_at) = 0;
};

#endif // COMMON_INTERFACES_HPP
