#ifndef POST_SESSION_ANALYZER_HPP
#define POST_SESSION_ANALYZER_HPP

#include <string>
#include <vector>
#include <memory>
#include <map>
#include "roadmap/db_client.hpp"

namespace hermes {

struct PostSessionAnalysisReport {
    std::string session_date;
    std::string session_phase;
    uint64_t total_ticks_ingested{0};
    uint64_t evaluated_decisions_count{0};
    uint64_t no_action_count{0};
    uint64_t actionable_signals_count{0};
    uint64_t risk_vetoes_count{0};
    int trades_executed_count{0};
    double realized_drawdown_inr{0.0};
    double avg_ofi{0.0};
    double max_ofi{0.0};
    int near_miss_count{0}; // Signals with OFI between 0.70 and 0.849
    std::string recommendations_json;
    bool execution_success{false};
};

struct DailyDataArchivalReport {
    std::string session_date;
    uint64_t candles_rolled_up{0};
    uint64_t snapshots_archived{0};
    uint64_t snapshots_deleted{0};
    bool execution_success{false};
    std::string retention_policy_note;
};

/**
 * @brief PostSessionAnalyzer (SOLID Single-Responsibility Principle)
 *
 * Runs strictly isolated post-market-close analytics & end-of-day data lifecycle.
 * STRICT SAFETY INVARIANTS:
 * 1. Read-only on live trading state. Does not alter live parameters or risk gates.
 * 2. Self-learning is strictly advisory/analytical: emits human-readable recommendations only.
 * 3. Never touches the hot path or market hours execution.
 */
class PostSessionAnalyzer {
public:
    explicit PostSessionAnalyzer(std::shared_ptr<RoadmapDbClient> db_client);

    // Part A: Post-session statistical summary & recommendation analysis
    PostSessionAnalysisReport run_post_session_analysis(const std::string& session_date = "");

    // Part B: End-of-day tick rollup into cpp_historical_daily_candles and safe archival
    DailyDataArchivalReport run_daily_data_archival(const std::string& session_date = "");

private:
    std::shared_ptr<RoadmapDbClient> db_client_;
};

} // namespace hermes

#endif // POST_SESSION_ANALYZER_HPP
