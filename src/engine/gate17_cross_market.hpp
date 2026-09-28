#ifndef HERMES_GATE17_CROSS_MARKET_HPP
#define HERMES_GATE17_CROSS_MARKET_HPP

#include <string>
#include <vector>
#include <chrono>
#include <map>
#include <memory>

enum class EventType {
    RBI_POLICY,
    FED_FOMC,
    CPI_INFLATION,
    UNION_BUDGET,
    MAJOR_EARNINGS,
    ELECTIONS,
    CUSTOM_MACRO
};

struct ScheduledEvent {
    std::string event_id;
    EventType type;
    std::string name;
    uint64_t scheduled_timestamp_ms; // Unix epoch ms of event occurrence
    double impact_weight;            // 0.0 to 1.0
};

struct CrossMarketSnapshot {
    uint64_t timestamp_ms;
    double gift_nifty_price;
    double gift_nifty_basis; // gift_nifty - nse_spot
    double india_vix;
    double vix_change_pct;
    double usdinr;
    double brent_crude;
    double us_10y_yield;
    double market_breadth_ratio; // advances / declines
    bool gift_nifty_valid{true};
    bool vix_valid{true};
};

struct EventDistanceResult {
    bool has_upcoming_event{false};
    std::string next_event_id;
    std::string next_event_name;
    double distance_minutes{0.0};
    double impact_weight{0.0};
    bool event_active_window{false}; // e.g. within 30 mins before/after
};

class CrossMarketEventEngine {
public:
    CrossMarketEventEngine();

    void set_component_enabled(bool enabled);
    bool is_component_enabled() const;

    void add_scheduled_event(const ScheduledEvent& event);
    void update_cross_market_snapshot(const CrossMarketSnapshot& snapshot);

    CrossMarketSnapshot get_latest_cross_market_snapshot() const;
    
    // Evaluates event distance relative to decision timestamp
    EventDistanceResult compute_event_distance(uint64_t decision_timestamp_ms) const;

    // Look-ahead prevention check: decision timestamp MUST be >= feature timestamp
    bool validate_no_lookahead(uint64_t decision_timestamp_ms, uint64_t feature_timestamp_ms, std::string& rejection_reason) const;

    // Time-aligned feature extraction
    bool get_aligned_cross_market_features(uint64_t decision_timestamp_ms, CrossMarketSnapshot& out_snapshot) const;

private:
    bool enabled_{true};
    CrossMarketSnapshot latest_snapshot_;
    std::vector<ScheduledEvent> events_;
    std::vector<CrossMarketSnapshot> historical_snapshots_;
};

#endif // HERMES_GATE17_CROSS_MARKET_HPP
