#ifndef ENGINE_FEED_ARBITER_HPP
#define ENGINE_FEED_ARBITER_HPP

#include <string>
#include <vector>
#include <unordered_map>
#include <memory>
#include <chrono>
#include "../engine/tick_receiver.hpp"
#include "../engine/gate0_bootstrap.hpp"

// ============================================================================
// ITEM G2-01 & G2-02: Concurrent Dual-Broker Ingestion & Feed Arbiter
// ============================================================================
struct BrokerFeedStatus {
    std::string broker_name; // "UPSTOX" or "FYERS"
    bool is_connected = false;
    uint64_t last_tick_timestamp_ms = 0;
    uint64_t total_ticks_received = 0;
    double current_quality_score = 0.0;
    bool is_active_primary = false;
};

class DualBrokerFeedArbiter {
public:
    DualBrokerFeedArbiter() {
        upstox_status_.broker_name = "UPSTOX";
        fyers_status_.broker_name = "FYERS";
        // Default UPSTOX as primary
        upstox_status_.is_active_primary = true;
    }

    void update_feed_status(const std::string& broker, bool connected, uint64_t last_ts, uint64_t total_ticks, double quality) {
        if (broker == "UPSTOX") {
            upstox_status_.is_connected = connected;
            upstox_status_.last_tick_timestamp_ms = last_ts;
            upstox_status_.total_ticks_received = total_ticks;
            upstox_status_.current_quality_score = quality;
        } else if (broker == "FYERS") {
            fyers_status_.is_connected = connected;
            fyers_status_.last_tick_timestamp_ms = last_ts;
            fyers_status_.total_ticks_received = total_ticks;
            fyers_status_.current_quality_score = quality;
        }
    }

    // Evaluate quality & execute instant failover if primary drops or stalls
    std::string select_active_feed(uint64_t current_time_ms, uint64_t max_staleness_ms = 1000, std::string* out_failover_log = nullptr) {
        bool upstox_healthy = upstox_status_.is_connected &&
                              (current_time_ms >= upstox_status_.last_tick_timestamp_ms) &&
                              ((current_time_ms - upstox_status_.last_tick_timestamp_ms) <= max_staleness_ms) &&
                              upstox_status_.current_quality_score > 0.3;

        bool fyers_healthy = fyers_status_.is_connected &&
                             (current_time_ms >= fyers_status_.last_tick_timestamp_ms) &&
                             ((current_time_ms - fyers_status_.last_tick_timestamp_ms) <= max_staleness_ms) &&
                             fyers_status_.current_quality_score > 0.3;

        if (upstox_status_.is_active_primary) {
            if (upstox_healthy) {
                return "UPSTOX";
            } else if (fyers_healthy) {
                // Execute failover to FYERS
                upstox_status_.is_active_primary = false;
                fyers_status_.is_active_primary = true;
                if (out_failover_log) {
                    *out_failover_log = "FEED_FAILOVER_TRIGGERED: Primary UPSTOX feed stalled/disconnected. Failover executed to backup FYERS feed.";
                }
                return "FYERS";
            } else {
                if (out_failover_log) {
                    *out_failover_log = "FEED_DISCONNECT_CRITICAL: Both UPSTOX and FYERS feeds are offline or stale.";
                }
                return "NONE";
            }
        } else {
            if (fyers_healthy) {
                return "FYERS";
            } else if (upstox_healthy) {
                // Failover back to UPSTOX
                fyers_status_.is_active_primary = false;
                upstox_status_.is_active_primary = true;
                if (out_failover_log) {
                    *out_failover_log = "FEED_FAILOVER_TRIGGERED: Backup FYERS feed stalled/disconnected. Failover executed back to primary UPSTOX feed.";
                }
                return "UPSTOX";
            } else {
                if (out_failover_log) {
                    *out_failover_log = "FEED_DISCONNECT_CRITICAL: Both feeds offline.";
                }
                return "NONE";
            }
        }
    }

    BrokerFeedStatus get_upstox_status() const { return upstox_status_; }
    BrokerFeedStatus get_fyers_status() const { return fyers_status_; }

private:
    BrokerFeedStatus upstox_status_;
    BrokerFeedStatus fyers_status_;
};

// ============================================================================
// ITEM G2-03: Pre-Open Order Absorption Index (OAI) Metrics
// ============================================================================
struct PreOpenOAIMetrics {
    double level = 0.0;        // Current OAI level: (Bid_Vol - Ask_Vol) / (Bid_Vol + Ask_Vol)
    double slope = 0.0;        // Rate of change over time (dOAI/dt)
    double acceleration = 0.0; // 2nd derivative (d^2OAI/dt^2)
    double persistence = 0.0;  // Ratio of positive consecutive OAI ticks over window
    uint64_t timestamp_ms = 0;
};

class PreOpenOAIEngine {
public:
    explicit PreOpenOAIEngine(size_t window_size = 20)
        : window_size_(window_size) {}

    PreOpenOAIMetrics compute_oai(const std::vector<CanonicalOptionTick>& ticks) {
        PreOpenOAIMetrics m;
        if (ticks.empty()) return m;

        m.timestamp_ms = ticks.back().timestamp_ms;
        size_t n = ticks.size();
        size_t start = (n > window_size_) ? (n - window_size_) : 0;

        std::vector<double> oai_series;
        oai_series.reserve(n - start);

        int positive_count = 0;
        for (size_t i = start; i < n; ++i) {
            const auto& t = ticks[i];
            double denom = static_cast<double>(t.bid_qty + t.ask_qty);
            double val = (denom > 0.0) ? (static_cast<double>(t.bid_qty - t.ask_qty) / denom) : 0.0;
            oai_series.push_back(val);
            if (val > 0.0) positive_count++;
        }

        m.level = oai_series.back();
        m.persistence = oai_series.empty() ? 0.0 : (static_cast<double>(positive_count) / oai_series.size());

        if (oai_series.size() >= 2) {
            m.slope = oai_series.back() - oai_series[oai_series.size() - 2];
        }
        if (oai_series.size() >= 3) {
            double prev_slope = oai_series[oai_series.size() - 2] - oai_series[oai_series.size() - 3];
            m.acceleration = m.slope - prev_slope;
        }

        return m;
    }

private:
    size_t window_size_;
};

// ============================================================================
// ITEM G2-04 & G2-05: Imbalance Survival (1/5/15 min) & Time-Alignment Guard
// ============================================================================
struct ImbalanceSurvivalMetrics {
    double survival_1min_pct = 0.0;
    double survival_5min_pct = 0.0;
    double survival_15min_pct = 0.0;
    size_t sample_size = 0;
    bool no_look_ahead_leak = true;
};

class ImbalanceSurvivalEngine {
public:
    static ImbalanceSurvivalMetrics evaluate_survival(const std::vector<CanonicalOptionTick>& historical_ticks, uint64_t current_timestamp_ms) {
        ImbalanceSurvivalMetrics res;

        std::vector<CanonicalOptionTick> time_aligned;
        for (const auto& t : historical_ticks) {
            // G2-05 Time-Alignment Guard: STRICTLY FILTER FUTURE TICKS
            if (t.timestamp_ms <= current_timestamp_ms) {
                time_aligned.push_back(t);
            } else {
                res.no_look_ahead_leak = false; // Flag if lookahead tick was supplied
            }
        }

        res.sample_size = time_aligned.size();
        if (res.sample_size == 0) return res;

        // Calculate imbalance survival rate across 1m, 5m, 15m windows
        int count_1m = 0, count_5m = 0, count_15m = 0;
        uint64_t ms_1m = 60000, ms_5m = 300000, ms_15m = 900000;

        for (const auto& t : time_aligned) {
            uint64_t age = current_timestamp_ms - t.timestamp_ms;
            if (age <= ms_1m && t.bid_qty > t.ask_qty) count_1m++;
            if (age <= ms_5m && t.bid_qty > t.ask_qty) count_5m++;
            if (age <= ms_15m && t.bid_qty > t.ask_qty) count_15m++;
        }

        res.survival_1min_pct = (res.sample_size > 0) ? (count_1m * 100.0 / res.sample_size) : 0.0;
        res.survival_5min_pct = (res.sample_size > 0) ? (count_5m * 100.0 / res.sample_size) : 0.0;
        res.survival_15min_pct = (res.sample_size > 0) ? (count_15m * 100.0 / res.sample_size) : 0.0;

        return res;
    }
};

#endif // ENGINE_FEED_ARBITER_HPP
