#ifndef HERMES_STRATEGY_CONFIG_MANAGER_HPP
#define HERMES_STRATEGY_CONFIG_MANAGER_HPP

#include <string>
#include <atomic>
#include <mutex>
#include <ctime>
#include <sstream>
#include <iomanip>

class RoadmapDbClient;

namespace hermes {

/**
 * @brief StrategyConfigManager (Thread-Safe Hot-Reloadable Strategy & Risk Thresholds)
 *
 * Implements dynamic parameter management loaded from MySQL (cpp_strategy_config).
 * Invariant Guarantees:
 * 1. Thread-safe lock-free atomic reads on the tick evaluation hot path.
 * 2. Safe default fallbacks (0.85, 100, 0.02, 0.05, 0.85) if DB is absent or offline.
 * 3. Human-gated mutation: PostSessionAnalyzer remains advisory only. Every mutation
 *    requires operator approval and writes an entry into cpp_strategy_config_audit.
 */
class StrategyConfigManager {
public:
    static StrategyConfigManager& instance() {
        static StrategyConfigManager inst;
        return inst;
    }

    // Default constants
    static constexpr double DEFAULT_OFI_THRESHOLD = 0.85;
    static constexpr int DEFAULT_MIN_VOLUME_THRESHOLD = 100;
    static constexpr double DEFAULT_PER_TRADE_RISK_PCT = 0.02;
    static constexpr double DEFAULT_SESSION_DRAWDOWN_LIMIT_PCT = 0.05;
    static constexpr double DEFAULT_BASE_CONFIDENCE = 0.85;

    // Hot-path lock-free atomic accessors
    double get_ofi_threshold() const { return ofi_threshold_.load(std::memory_order_relaxed); }
    int get_min_volume_threshold() const { return min_volume_threshold_.load(std::memory_order_relaxed); }
    double get_per_trade_risk_pct() const { return per_trade_risk_pct_.load(std::memory_order_relaxed); }
    double get_session_drawdown_limit_pct() const { return session_drawdown_limit_pct_.load(std::memory_order_relaxed); }
    double get_base_confidence() const { return base_confidence_.load(std::memory_order_relaxed); }

    // Direct atomic setters (for tests & programmatic initialization)
    void set_ofi_threshold(double val) { ofi_threshold_.store(val, std::memory_order_relaxed); }
    void set_min_volume_threshold(int val) { min_volume_threshold_.store(val, std::memory_order_relaxed); }
    void set_per_trade_risk_pct(double val) { per_trade_risk_pct_.store(val, std::memory_order_relaxed); }
    void set_session_drawdown_limit_pct(double val) { session_drawdown_limit_pct_.store(val, std::memory_order_relaxed); }
    void set_base_confidence(double val) { base_confidence_.store(val, std::memory_order_relaxed); }

    // Reset all parameters to hardcoded baselines
    void reset_to_defaults();

    // DB Load and Periodic Hot-Reload
    bool load_from_db(RoadmapDbClient* db_client);
    bool maybe_periodic_reload(RoadmapDbClient* db_client, int interval_seconds = 60);

    // Operator-approved configuration update with audit trail
    bool update_parameter(
        RoadmapDbClient* db_client,
        const std::string& key,
        const std::string& new_value,
        const std::string& approved_by,
        const std::string& reason
    );

    // Serialize current live parameters to JSON
    std::string to_json() const;

private:
    StrategyConfigManager();
    ~StrategyConfigManager() = default;
    StrategyConfigManager(const StrategyConfigManager&) = delete;
    StrategyConfigManager& operator=(const StrategyConfigManager&) = delete;

    std::atomic<double> ofi_threshold_{DEFAULT_OFI_THRESHOLD};
    std::atomic<int> min_volume_threshold_{DEFAULT_MIN_VOLUME_THRESHOLD};
    std::atomic<double> per_trade_risk_pct_{DEFAULT_PER_TRADE_RISK_PCT};
    std::atomic<double> session_drawdown_limit_pct_{DEFAULT_SESSION_DRAWDOWN_LIMIT_PCT};
    std::atomic<double> base_confidence_{DEFAULT_BASE_CONFIDENCE};

    std::atomic<std::time_t> last_reload_time_{0};
    std::mutex reload_mutex_;
};

} // namespace hermes

#endif // HERMES_STRATEGY_CONFIG_MANAGER_HPP
