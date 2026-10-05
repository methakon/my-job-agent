#ifndef HERMES_GATE22_SEASONALITY_PATTERNS_HPP
#define HERMES_GATE22_SEASONALITY_PATTERNS_HPP

#include <string>
#include <vector>
#include <map>
#include <memory>
#include <mutex>
#include <set>

namespace hermes {

// =========================================================================
// READ-ONLY BOUNDARY SPECIFICATION:
// upstox_live_paper_option_quotes is a SHARED, READ-ONLY TABLE owned by
// the TypeScript subsystem. The C++ engine issues SELECT queries ONLY;
// it NEVER performs INSERT, UPDATE, or DELETE queries against this table.
// All C++ hypothesis results are written exclusively to isolated `cpp_*` tables.
// =========================================================================

enum class SeasonalityGatingStatus : int {
    RESEARCH_ONLY = 0, // Insufficient sample size (< MIN_SAMPLE_SESSION_DAYS) or failed OOS validation
    VALIDATED_GATED = 1 // Passed sample size threshold (>= MIN_SAMPLE_SESSION_DAYS) AND verified held-out OOS walk-forward split
};

struct SeasonalityPatternRecord {
    std::string pattern_id;          // e.g. "PAT-SENSEX-15M-0915-WED-DTE0"
    std::string underlying;          // NIFTY, BANKNIFTY, SENSEX, ALL
    std::string time_bucket_15m;     // e.g. "09:15-09:30", "09:30-09:45", ... "15:15-15:30"
    int day_of_week{0};              // 1 (Mon) to 5 (Fri)
    int days_to_expiry{0};           // 0 (Expiry day), 1, 2, 3, 4, 5+

    // Empirical Descriptive Statistics (Measured from clean archived tick data)
    size_t sample_ticks_count{0};
    size_t sample_session_days{0};    // Distinct valid session-days with clean data
    double in_sample_persistence{0.5}; // In-Sample (first 80% sessions) persistence
    double out_of_sample_persistence{0.5}; // Out-of-Sample (held-out 20% sessions) persistence
    double oos_persistence_error{0.0};  // |OOS - IS| persistence error
    double realized_volatility{0.0};  // Standard deviation of tick-to-tick % returns
    double directional_persistence{0.5}; // Total ratio of positive price deltas [0.0 to 1.0]
    double avg_spread_pct{0.0};       // Average bid-ask spread % relative to LTP
    double avg_oi_buildup_rate{0.0};  // Change in Open Interest per minute

    // Gating & Hypothesis State Protocol
    size_t min_required_session_days{20};
    SeasonalityGatingStatus gating_status{SeasonalityGatingStatus::RESEARCH_ONLY};
    double confidence_interval_95{0.0};
    bool out_of_sample_validated{false};
    std::string hypothesis_summary;
    std::string last_updated_ts;

    // Advisory Confidence Modifier Output (Strictly 1.0 when RESEARCH_ONLY; [0.90, 1.10] when VALIDATED_GATED)
    double advisory_confidence_modifier{1.0};
};

class SeasonalityPatternEngine {
public:
    explicit SeasonalityPatternEngine(size_t min_required_session_days = 20);

    // Parse raw timestamp into 15-minute intraday bucket label (e.g., "09:15-09:30")
    static std::string format_15m_bucket(int hour, int minute);

    // Check if timestamp falls within known historical infrastructure outage windows
    static bool is_known_bad_data_window(const std::string& date_str, int hour, int minute);

    // Measure empirical seasonality patterns from DB-fetched tick datasets with bad-data window exclusion & OOS validation
    std::vector<SeasonalityPatternRecord> analyze_archived_ticks(
        const std::vector<std::map<std::string, std::string>>& tick_rows
    );

    // Query advisory confidence modifier for strategy scoring (STRICTLY returns 1.0 if RESEARCH_ONLY)
    double get_advisory_confidence_modifier(
        const std::string& underlying,
        int hour,
        int minute,
        int day_of_week,
        int days_to_expiry,
        const std::string& strategy_name
    ) const;

    // Retrieve all processed pattern records for observability and HTTP API endpoints
    std::vector<SeasonalityPatternRecord> get_all_patterns() const;

    // Retrieve summary overview string / JSON
    std::string get_summary_json() const;

private:
    size_t min_required_session_days_;
    mutable std::mutex mutex_;
    std::map<std::string, SeasonalityPatternRecord> patterns_;
};

} // namespace hermes

#endif // HERMES_GATE22_SEASONALITY_PATTERNS_HPP
