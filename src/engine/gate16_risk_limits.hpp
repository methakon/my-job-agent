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

struct KellySizingResult {
    int suggested_lots{0};
    double quarter_kelly_fraction{0.0};
    double margin_per_lot{0.0};
    bool oos_gate_passed{false};
    std::string bucket_status;
};

struct CostAwareFilterResult {
    bool passed{true};
    double estimated_charges{0.0};
    double estimated_gross_edge{0.0};
    double edge_to_cost_ratio{0.0};
    std::string gating_status{"RESEARCH_OBSERVABILITY_ONLY"};
    std::string status_reason;
};

class IndependentRiskEngine {
public:
    explicit IndependentRiskEngine(
        double max_per_trade_risk = 2000.0,
        double max_aggregate_capital = 100000.0,
        double max_session_drawdown = 1000.0
    );

    // Cost-Aware Entry Filter (RESEARCH_OBSERVABILITY_ONLY)
    static CostAwareFilterResult evaluate_cost_aware_edge_filter(
        const std::string& instrument,
        const std::string& side,
        int quantity,
        double entry_price,
        double expected_take_profit_pct = 0.50,
        double safety_multiplier = 2.0
    );

    // Defined-Risk Vertical Credit Spread Strike Widths (Researched Exchange/Retail Standards)
    static constexpr double STRIKE_WIDTH_NIFTY = 100.0;     // 2 x 50pt strike gaps
    static constexpr double STRIKE_WIDTH_BANKNIFTY = 200.0; // 2 x 100pt strike gaps
    static constexpr double STRIKE_WIDTH_SENSEX = 200.0;    // 2 x 100pt strike gaps

    // Short-Option Margin Model (7.6% baseline SPAN+Exposure percentage for index option writing)
    static double calculate_short_option_margin(
        const std::string& side,
        int lot_size,
        double entry_price,
        double spot_price
    );

    // Defined-Risk Vertical Credit Spread Margin Model (Exchange Capped Risk = (Width - Credit) * Lot Size)
    static double calculate_spread_margin(
        int lot_size,
        double strike_width,
        double net_credit_received
    );

    // G21 OOS-Gated Kelly Position Sizing
    static KellySizingResult calculate_kelly_lot_size(
        const std::string& algo_source,
        const std::string& symbol,
        const std::string& side,
        double entry_price,
        double spot_price,
        double capital_in_hand
    );

    // G16-01 & G16-02: Independent Risk Verification (Model confidence cannot override)
    IndependentRiskVeto verify_order_proposal(
        const std::string& symbol,
        double proposed_risk_inr,
        double current_open_exposure_inr,
        double current_session_drawdown_inr,
        size_t current_open_positions_for_symbol,
        double ai_model_confidence,
        double current_capital_in_hand = 0.0
    );

    // Separated Independent Margin Sufficiency & Per-Trade Risk Verification
    IndependentRiskVeto verify_order_proposal_with_margin(
        const std::string& symbol,
        double proposed_risk_inr,
        double required_margin_inr,
        double current_open_exposure_inr,
        double current_session_drawdown_inr,
        size_t current_open_positions_for_symbol,
        double ai_model_confidence,
        double current_capital_in_hand = 0.0
    );

    // G16-06: Feed Staleness Verification (STALE_FEED_VETO)
    static IndependentRiskVeto verify_feed_freshness(
        uint64_t tick_timestamp_ms,
        uint64_t current_time_ms,
        uint64_t max_allowed_staleness_ms = 10000
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

    // Daily-Rebased Depleting Risk Budget (Regime A: 0.02 * CAPITAL_IN_HAND shared daily budget, depleted by daily losses)
    void update_daily_risk_base(double current_capital_in_hand, const std::string& current_date_str = "", double initial_daily_loss = 0.0);
    void record_trade_result(double net_pnl);
    double get_daily_risk_base() const { return cached_daily_risk_base_; }
    double get_cumulative_daily_loss() const { return cumulative_daily_loss_; }
    double get_remaining_daily_budget() const;

    // G16-05: Verify LIVE mode unreachability
    static ExecutionModeState get_execution_mode_state();

private:
    double max_per_trade_risk_;
    double max_aggregate_capital_;
    double max_session_drawdown_;
    double cached_daily_risk_base_{0.0};
    double cumulative_daily_loss_{0.0};
    std::string cached_risk_date_{""};
};

} // namespace hermes

#endif // HERMES_GATE16_RISK_LIMITS_HPP
