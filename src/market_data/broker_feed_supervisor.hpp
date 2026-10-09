#ifndef MARKET_DATA_BROKER_FEED_SUPERVISOR_HPP
#define MARKET_DATA_BROKER_FEED_SUPERVISOR_HPP

#include "market_data/broker_websocket_client.hpp"
#include "market_data/upstox/upstox_websocket_client.hpp"
#include "market_data/fyers/fyers_websocket_client.hpp"
#include "roadmap/db_client.hpp"
#include "engine/tick_receiver.hpp"
#include "engine/market_calendar.hpp"
#include <string>
#include <vector>
#include <memory>
#include <atomic>
#include <thread>
#include <mutex>
#include <queue>
#include <condition_variable>
#include <map>

enum class PaperTradingState {
    IDLE_OFF_HOURS,         // Weekend, holiday, or outside market hours (<09:00 or >=16:00 IST)
    IDLE_WAITING_TOKEN,     // Trading day / session active, but no valid token in provider_tokens
    CONNECTING_FEED,        // Valid token found, establishing WebSocket connection
    FEED_HEALTH_VERIFYING,  // WebSocket connected, waiting for confirmed fresh market data
    ACTIVE_PAPER_TRADING,   // Market Open (09:15–15:30 IST) + Valid Token + Feed Healthy (>0 ticks, <10s fresh)
    SESSION_CLOSED          // Market closed at 15:30 IST, paper trading deactivated
};

struct SupervisorStatus {
    std::string active_provider;
    bool is_connected;
    uint64_t total_ticks_received;
    uint64_t last_tick_timestamp_ms;
    std::string last_error;
    std::string session_phase;
    std::string paper_trading_state;
    bool is_paper_trading_active;
    bool is_trading_day;
};

class BrokerFeedSupervisor {
public:
    BrokerFeedSupervisor(std::shared_ptr<RoadmapDbClient> db_client,
                         OptionTickReceiver& receiver,
                         std::vector<std::string> symbols);
    ~BrokerFeedSupervisor();

    void start();
    void stop();
    bool is_running() const { return running_.load(); }
    SupervisorStatus get_status() const;

    PaperTradingState get_paper_trading_state() const;
    bool is_paper_trading_active() const;
    std::string get_paper_trading_state_string() const;

    // In-Process End-of-Day Analysis & Archival Trigger
    void trigger_eod_analysis_and_archival(const std::string& forced_date = "", bool async = true);
    std::string get_last_eod_completed_date() const;

private:
    void supervisor_loop();
    void update_state_machine();
    void db_persistence_worker();
    void evaluate_and_connect();
    void handle_tick(const CanonicalOptionTick& tick);
    void handle_disconnect(const std::string& reason);

    std::string select_best_provider(BrokerCredentials& out_creds);
    bool is_token_usable(const std::string& provider, BrokerCredentials& out_creds);

    std::shared_ptr<RoadmapDbClient> db_client_;
    OptionTickReceiver& receiver_;
    std::vector<std::string> default_symbols_;

    std::unique_ptr<IBrokerWebSocketClient> active_client_;
    std::string active_provider_name_;
    std::string active_token_hash_;

    std::atomic<bool> running_{false};
    std::atomic<bool> should_reconnect_{false};
    std::thread supervisor_thread_;

    // Async DB persistence queue
    std::queue<CanonicalOptionTick> tick_persist_queue_;
    std::mutex persist_mutex_;
    std::condition_variable persist_cv_;
    std::thread persist_thread_;

    // Failover tracking
    std::map<std::string, int> fail_counts_;
    std::map<std::string, std::string> token_issued_at_;

    // State machine & Telemetry
    mutable std::mutex status_mutex_;
    PaperTradingState paper_state_{PaperTradingState::IDLE_OFF_HOURS};
    hermes::SessionPhase current_phase_{hermes::SessionPhase::CLOSED};
    bool is_trading_day_{false};
    uint64_t total_ticks_{0};
    uint64_t last_tick_ts_{0};
    std::string last_error_;

    // In-process EOD synchronization
    mutable std::mutex eod_mutex_;
    std::string last_eod_completed_date_;
};

#endif // MARKET_DATA_BROKER_FEED_SUPERVISOR_HPP
