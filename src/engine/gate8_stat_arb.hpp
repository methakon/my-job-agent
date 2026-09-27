#ifndef HERMES_GATE8_STAT_ARB_HPP
#define HERMES_GATE8_STAT_ARB_HPP

#include <string>
#include <vector>
#include <cstdint>

namespace hermes {

enum class GapLabel {
    LBL_NO_EDGE = 0,
    LBL_FADE,
    LBL_FOLLOW
};

enum class StatArbSignal {
    HOLD = 0,
    ENTRY_FADE,
    ENTRY_FOLLOW,
    FORCE_EXIT_TIME_EXPIRED,
    FORCE_EXIT_RISK_CAP_EXCEEDED
};

struct HistoricalGapRecord {
    std::string symbol;
    uint64_t date_ms{0};
    double prev_close{0.0};
    double open_price{0.0};
    double gap_points{0.0};
    double gap_atr_ratio{0.0};
    double half_life_minutes{0.0}; // Ornstein-Uhlenbeck mean-reversion parameter
    GapLabel label{GapLabel::LBL_NO_EDGE};
};

struct GapPositionState {
    std::string symbol;
    uint64_t entry_time_ms{0};
    double entry_price{0.0};
    double current_price{0.0};
    double stop_loss_price{0.0};
    double max_risk_amount{2000.0}; // ₹2,000 cap per lot
    uint32_t max_holding_minutes{45};
};

struct StatArbResult {
    std::string symbol;
    uint64_t timestamp_ms{0};
    
    // G8-01 Database metrics
    double historical_fade_prob{0.0};
    double ou_half_life_min{0.0};
    
    // G8-02 Leakage guard
    bool no_future_leakage_verified{true};
    GapLabel leakage_controlled_label{GapLabel::LBL_NO_EDGE};
    
    // G8-03 Execution signal & risk cap
    StatArbSignal signal{StatArbSignal::HOLD};
    std::string signal_reason;
    
    std::string summary_json() const;
};

class StatArbEngine {
public:
    explicit StatArbEngine(bool enabled = true);

    // G8-01: Load historical gap database
    void add_historical_gap(const HistoricalGapRecord& rec);
    
    // G8-02: Compute leakage-controlled label with strict cutoff barrier
    static GapLabel compute_leakage_controlled_label(
        const std::vector<std::pair<uint64_t, double>>& price_series,
        uint64_t open_time_ms,
        double prev_close,
        double open_price,
        double atr_14
    );

    // G8-03: Evaluate position exit conditions (time stop or risk cap)
    StatArbResult evaluate_position(
        const GapPositionState& pos,
        uint64_t current_time_ms,
        double current_price,
        bool is_short_fade
    );

    // Reset component state
    void reset();

private:
    bool enabled_;
    std::vector<HistoricalGapRecord> gap_database_;
};

} // namespace hermes

#endif // HERMES_GATE8_STAT_ARB_HPP
