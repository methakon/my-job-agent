#ifndef POSITION_EXIT_EVALUATOR_HPP
#define POSITION_EXIT_EVALUATOR_HPP

#include <string>
#include <vector>

namespace hermes {

enum class PositionExitCondition {
    HOLD_WITHIN_BOUNDS = 0,
    TAKE_PROFIT_TRIGGERED,
    STOP_LOSS_TRIGGERED,
    CONTRACT_EXPIRED
};

struct PositionExitEvaluation {
    std::string trade_id;
    std::string instrument;
    std::string side;
    int quantity{0};
    double entry_price{0.0};
    std::string entry_date;
    double current_price{0.0};
    double unrealized_pnl_inr{0.0};
    double position_return_pct{0.0}; // e.g. +0.23 = +23.0%

    // Real Engine Exit Thresholds
    double take_profit_threshold_pct{0.50}; // +50% target
    double stop_loss_threshold_pct{-0.25};   // -25% stop

    // Distance / Progress to triggers (as required by specification)
    // e.g. "+23.0% of +50.0% target reached"
    std::string target_progress_str;
    // e.g. "-8.0% of -25.0% stop reached" or "0.0% of -25.0% stop reached"
    std::string stop_progress_str;

    // Comprehensive reason why it hasn't exited yet
    PositionExitCondition condition{PositionExitCondition::HOLD_WITHIN_BOUNDS};
    std::string reason_still_open;
    bool is_exit_triggered{false};
};

/**
 * @brief PositionExitEvaluator
 *
 * Single source of truth for open position exit threshold evaluation.
 * Shared directly between real-time execution in main.cpp and DailyPnLEmailer
 * to guarantee that reported exit progress never drifts from real execution logic.
 */
class PositionExitEvaluator {
public:
    static constexpr double DEFAULT_TAKE_PROFIT_PCT = 0.50; // +50% take profit
    static constexpr double DEFAULT_STOP_LOSS_PCT = -0.25;   // -25% stop loss

    // Evaluates a single position against the engine's real exit rules
    static PositionExitEvaluation evaluate_position_exit(
        const std::string& trade_id,
        const std::string& instrument,
        const std::string& side,
        int quantity,
        double entry_price,
        double current_price,
        const std::string& entry_date = "",
        double take_profit_pct = DEFAULT_TAKE_PROFIT_PCT,
        double stop_loss_pct = DEFAULT_STOP_LOSS_PCT
    );
};

} // namespace hermes

#endif // POSITION_EXIT_EVALUATOR_HPP
