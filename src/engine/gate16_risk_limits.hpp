#ifndef HERMES_GATE16_RISK_LIMITS_HPP
#define HERMES_GATE16_RISK_LIMITS_HPP

#include <string>
#include <vector>
#include <cstdint>

namespace hermes {

enum class ExecutionModeState {
    PAPER = 0,
    SHADOW,
    MICRO_LIVE_BLOCKED,
    LIVE_UNREACHABLE
};

struct IndependentRiskVeto {
    bool risk_approved{true};
    std::string veto_reason;
    bool model_override_attempt_blocked{false};
    std::string summary_json() const;
};

struct EmergencyKillSwitchResult {
    bool kill_switch_triggered{false};
    size_t cancelled_orders_count{0};
    size_t flattened_positions_count{0};
    std::string kill_reason;
    std::string summary_json() const;
};

class IndependentRiskEngine {
public:
    explicit IndependentRiskEngine(
        double max_per_trade_risk = 2000.0,
        double max_aggregate_capital = 10000.0,
        double max_session_drawdown = 1000.0
    );

    // G16-01 & G16-02: Independent Risk Verification (Model confidence cannot override)
    IndependentRiskVeto verify_order_proposal(
        const std::string& symbol,
        double proposed_risk_inr,
        double current_open_exposure_inr,
        double current_session_drawdown_inr,
        size_t current_open_positions_for_symbol,
        double ai_model_confidence
    );

    // G16-03: Evaluate daily loss, consecutive loss, and data quality shutdowns
    IndependentRiskVeto evaluate_circuit_breakers(
        size_t consecutive_losing_trades,
        double feed_quality_score
    );

    // G16-04: Emergency Kill Switch / Flatten Path (Dormant/Paper)
    EmergencyKillSwitchResult trigger_emergency_kill_switch(
        const std::string& reason,
        size_t active_orders,
        size_t active_positions
    );

    // G16-05: Verify LIVE mode unreachability
    static ExecutionModeState get_execution_mode_state();

private:
    double max_per_trade_risk_;
    double max_aggregate_capital_;
    double max_session_drawdown_;
};

} // namespace hermes

#endif // HERMES_GATE16_RISK_LIMITS_HPP
