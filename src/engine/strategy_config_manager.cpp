#include "strategy_config_manager.hpp"
#include "roadmap/db_client.hpp"
#include <iostream>
#include <cmath>
#include <chrono>

namespace hermes {

StrategyConfigManager::StrategyConfigManager() {
    reset_to_defaults();
}

void StrategyConfigManager::reset_to_defaults() {
    ofi_threshold_.store(DEFAULT_OFI_THRESHOLD, std::memory_order_relaxed);
    min_volume_threshold_.store(DEFAULT_MIN_VOLUME_THRESHOLD, std::memory_order_relaxed);
    per_trade_risk_pct_.store(DEFAULT_PER_TRADE_RISK_PCT, std::memory_order_relaxed);
    session_drawdown_limit_pct_.store(DEFAULT_SESSION_DRAWDOWN_LIMIT_PCT, std::memory_order_relaxed);
    base_confidence_.store(DEFAULT_BASE_CONFIDENCE, std::memory_order_relaxed);
}

bool StrategyConfigManager::load_from_db(RoadmapDbClient* db_client) {
    if (!db_client) {
        std::cerr << "⚠️ [Config] Database client unavailable. Using hardcoded defaults.\n";
        return false;
    }

    try {
        db_client->ensure_strategy_config_schema();
        auto configs = db_client->fetch_strategy_config();
        if (configs.empty()) {
            std::cout << "ℹ️ [Config] No strategy config records found. Retaining defaults.\n";
            return false;
        }

        std::lock_guard<std::mutex> lock(reload_mutex_);

        auto it_ofi = configs.find("ofi_threshold");
        if (it_ofi != configs.end()) {
            try {
                double val = std::stod(it_ofi->second);
                double old = ofi_threshold_.exchange(val, std::memory_order_relaxed);
                if (std::abs(old - val) > 1e-6) {
                    std::cout << "⚙️ [Config] Parameter 'ofi_threshold' updated: " << old << " -> " << val << "\n";
                }
            } catch (...) {}
        }

        auto it_vol = configs.find("min_volume_threshold");
        if (it_vol != configs.end()) {
            try {
                int val = std::stoi(it_vol->second);
                int old = min_volume_threshold_.exchange(val, std::memory_order_relaxed);
                if (old != val) {
                    std::cout << "⚙️ [Config] Parameter 'min_volume_threshold' updated: " << old << " -> " << val << "\n";
                }
            } catch (...) {}
        }

        auto it_ptr = configs.find("per_trade_risk_pct");
        if (it_ptr != configs.end()) {
            try {
                double val = std::stod(it_ptr->second);
                double old = per_trade_risk_pct_.exchange(val, std::memory_order_relaxed);
                if (std::abs(old - val) > 1e-6) {
                    std::cout << "⚙️ [Config] Parameter 'per_trade_risk_pct' updated: " << old << " -> " << val << "\n";
                }
            } catch (...) {}
        }

        auto it_dd = configs.find("session_drawdown_limit_pct");
        if (it_dd != configs.end()) {
            try {
                double val = std::stod(it_dd->second);
                double old = session_drawdown_limit_pct_.exchange(val, std::memory_order_relaxed);
                if (std::abs(old - val) > 1e-6) {
                    std::cout << "⚙️ [Config] Parameter 'session_drawdown_limit_pct' updated: " << old << " -> " << val << "\n";
                }
            } catch (...) {}
        }

        auto it_bc = configs.find("base_confidence");
        if (it_bc != configs.end()) {
            try {
                double val = std::stod(it_bc->second);
                double old = base_confidence_.exchange(val, std::memory_order_relaxed);
                if (std::abs(old - val) > 1e-6) {
                    std::cout << "⚙️ [Config] Parameter 'base_confidence' updated: " << old << " -> " << val << "\n";
                }
            } catch (...) {}
        }

        last_reload_time_.store(std::time(nullptr), std::memory_order_relaxed);
        return true;
    } catch (const std::exception& e) {
        std::cerr << "❌ [Config] Exception during configuration load: " << e.what() << "\n";
        return false;
    }
}

bool StrategyConfigManager::maybe_periodic_reload(RoadmapDbClient* db_client, int interval_seconds) {
    if (!db_client) return false;
    std::time_t now = std::time(nullptr);
    std::time_t last = last_reload_time_.load(std::memory_order_relaxed);
    if (now - last < interval_seconds) {
        return false;
    }
    return load_from_db(db_client);
}

bool StrategyConfigManager::update_parameter(
    RoadmapDbClient* db_client,
    const std::string& key,
    const std::string& new_value,
    const std::string& approved_by,
    const std::string& reason
) {
    if (!db_client) return false;
    bool ok = db_client->update_strategy_config_param(key, new_value, approved_by, reason);
    if (ok) {
        load_from_db(db_client);
    }
    return ok;
}

std::string StrategyConfigManager::to_json() const {
    std::ostringstream ss;
    ss << std::fixed << std::setprecision(4);
    ss << "{"
       << "\"ofi_threshold\":" << get_ofi_threshold() << ","
       << "\"min_volume_threshold\":" << get_min_volume_threshold() << ","
       << "\"per_trade_risk_pct\":" << get_per_trade_risk_pct() << ","
       << "\"session_drawdown_limit_pct\":" << get_session_drawdown_limit_pct() << ","
       << "\"base_confidence\":" << get_base_confidence()
       << "}";
    return ss.str();
}

} // namespace hermes
