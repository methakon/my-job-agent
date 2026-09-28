#ifndef HERMES_GATE_CONST_INVARIANTS_HPP
#define HERMES_GATE_CONST_INVARIANTS_HPP

#include <string>
#include <vector>
#include <map>

enum class PositionHealthState {
    GREEN,
    YELLOW,
    ORANGE,
    RED,
    BLACK
};

struct EntryGateEvaluationContext {
    bool data_fresh{true};
    double tick_age_sec{0.05};
    bool regime_aligned{true};
    bool underlying_confirmed{true};
    double bid_ask_spread{1.0};
    double max_allowed_spread{3.0};
    double expected_slippage{0.5};
    double max_allowed_slippage{2.0};
    double expected_move_pts{120.0};
    double trap_score{10.0}; // 0-100, >50 triggers veto
    double gross_ev{35.0};
    double transaction_cost{15.0};
    double min_required_edge{10.0};
    double remaining_risk_budget{2000.0};
    double required_risk{1000.0};
    bool shadow_benchmark_logged{true};
    bool is_real_data{false}; // R-015
    bool multi_factor_confirmed{true}; // R-001
    bool is_averaging_down{false}; // R-004
    bool is_auto_reversal{false}; // R-005
    bool system_halted{false}; // R-014
};

struct EntryGateResult {
    bool passed_all{false};
    std::string failed_gate_id;
    std::string rejection_reason;
    double net_ev{0.0};
    PositionHealthState initial_health{PositionHealthState::GREEN};
};

class ConstInvariantsEngine {
public:
    ConstInvariantsEngine();

    // Evaluates E1 through E10 and R-001 through R-015
    EntryGateResult evaluate_entry_gates(const EntryGateEvaluationContext& ctx);

    // Position health state machine transitions
    PositionHealthState transition_health_state(PositionHealthState current, double current_drawdown_pct, double duration_min);

    // Recovery expectancy evaluator (R-010)
    bool is_recovery_allowed(double recovery_ev, double remaining_risk_budget, std::string& out_reason);

    // Surveillance hypothesis builder (R-011)
    std::string build_surveillance_hypothesis(const std::string& anomaly_type, double severity);
};

#endif // HERMES_GATE_CONST_INVARIANTS_HPP
