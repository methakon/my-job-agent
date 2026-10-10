#include "engine/position_exit_evaluator.hpp"
#include <sstream>
#include <iomanip>
#include <cmath>
#include <algorithm>

namespace hermes {

PositionExitEvaluation PositionExitEvaluator::evaluate_position_exit(
    const std::string& trade_id,
    const std::string& instrument,
    const std::string& side,
    int quantity,
    double entry_price,
    double current_price,
    const std::string& entry_date,
    double take_profit_pct,
    double stop_loss_pct
) {
    PositionExitEvaluation eval;
    eval.trade_id = trade_id;
    eval.instrument = instrument;
    eval.side = side.empty() ? "BUY" : side;
    eval.quantity = quantity;
    eval.entry_price = entry_price;
    eval.entry_date = entry_date;
    eval.current_price = current_price > 0.0 ? current_price : entry_price;
    eval.take_profit_threshold_pct = take_profit_pct;
    eval.stop_loss_threshold_pct = stop_loss_pct;

    // Calculate return % and unrealized P&L
    double ret_pct = 0.0;
    if (entry_price > 0.0 && eval.current_price > 0.0) {
        if (eval.side == "BUY") {
            ret_pct = (eval.current_price - entry_price) / entry_price;
            eval.unrealized_pnl_inr = quantity * (eval.current_price - entry_price);
        } else {
            ret_pct = (entry_price - eval.current_price) / entry_price;
            eval.unrealized_pnl_inr = quantity * (entry_price - eval.current_price);
        }
    }
    eval.position_return_pct = ret_pct;

    // Compute progress towards take-profit target (+50% default)
    char tp_buf[64];
    if (ret_pct > 0.0) {
        double reached = ret_pct * 100.0;
        snprintf(tp_buf, sizeof(tp_buf), "+%.1f%% of +%.1f%% target reached", reached, take_profit_pct * 100.0);
    } else {
        snprintf(tp_buf, sizeof(tp_buf), "0.0%% of +%.1f%% target reached", take_profit_pct * 100.0);
    }
    eval.target_progress_str = tp_buf;

    // Compute progress towards stop-loss floor (-25% default)
    char sl_buf[64];
    if (ret_pct < 0.0) {
        double adverse = ret_pct * 100.0;
        snprintf(sl_buf, sizeof(sl_buf), "%.1f%% of %.1f%% stop reached", adverse, stop_loss_pct * 100.0);
    } else {
        snprintf(sl_buf, sizeof(sl_buf), "0.0%% of %.1f%% stop reached", stop_loss_pct * 100.0);
    }
    eval.stop_progress_str = sl_buf;

    // Evaluate trigger condition
    if (ret_pct >= take_profit_pct) {
        eval.condition = PositionExitCondition::TAKE_PROFIT_TRIGGERED;
        eval.is_exit_triggered = true;
        eval.reason_still_open = "Take-profit threshold hit (" + eval.target_progress_str + "). Exit order armed.";
    } else if (ret_pct <= stop_loss_pct) {
        eval.condition = PositionExitCondition::STOP_LOSS_TRIGGERED;
        eval.is_exit_triggered = true;
        eval.reason_still_open = "Stop-loss threshold breached (" + eval.stop_progress_str + "). Exit order armed.";
    } else {
        eval.condition = PositionExitCondition::HOLD_WITHIN_BOUNDS;
        eval.is_exit_triggered = false;
        std::ostringstream ss;
        ss << eval.target_progress_str << " | " << eval.stop_progress_str
           << ". Holding safely between +" << std::fixed << std::setprecision(1) << (take_profit_pct * 100.0)
           << "% target and " << (stop_loss_pct * 100.0) << "% stop triggers.";
        eval.reason_still_open = ss.str();
    }

    return eval;
}

} // namespace hermes
