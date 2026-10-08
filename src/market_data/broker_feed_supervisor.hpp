#ifndef MARKET_DATA_BROKER_FEED_SUPERVISOR_HPP
#define MARKET_DATA_BROKER_FEED_SUPERVISOR_HPP

#include "market_data/broker_websocket_client.hpp"
#include "market_data/upstox/upstox_websocket_client.hpp"
#include "market_data/fyers/fyers_websocket_client.hpp"
#include "roadmap/db_client.hpp"
#include "engine/tick_receiver.hpp"
#include <string>
#include <vector>
#include <memory>
#include <atomic>
#include <thread>
#include <mutex>
#include <queue>
#include <condition_variable>
#include <map>

struct SupervisorStatus {
    std::string active_provider;
    bool is_connected;
    uint64_t total_ticks_received;
    uint64_t last_tick_timestamp_ms;
    std::string last_error;
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

private:
    void supervisor_loop();
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

    // Telemetry
    mutable std::mutex status_mutex_;
    uint64_t total_ticks_{0};
    uint64_t last_tick_ts_{0};
    std::string last_error_;
};

#endif // MARKET_DATA_BROKER_FEED_SUPERVISOR_HPP
