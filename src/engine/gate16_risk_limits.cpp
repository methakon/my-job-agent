#include "gate16_risk_limits.hpp"
#include "gate0_bootstrap.hpp"
#include "../common/env_loader.hpp"
#include <sstream>
#include <iomanip>
#include <iostream>

namespace hermes {

IndependentRiskEngine::IndependentRiskEngine(
    double max_per_trade_risk,
    double max_aggregate_capital,
    double max_session_drawdown
) : max_per_trade_risk_(max_per_trade_risk > 0 ? max_per_trade_risk : EnvLoader::get_double("MAX_PER_TRADE_RISK", 2000.0)),
    max_aggregate_capital_(max_aggregate_capital > 0 ? max_aggregate_capital : EnvLoader::get_double("MAX_AGGREGATE_CAPITAL", 100000.0)),
    max_session_drawdown_(max_session_drawdown > 0 ? max_session_drawdown : EnvLoader::get_double("MAX_SESSION_DRAWDOWN", 1500.0)) {}


ExecutionModeState IndependentRiskEngine::get_execution_mode_state() {
#ifdef HERMES_COMPILE_TIME_PAPER_ONLY
    return ExecutionModeState::PAPER;
#else
    return ExecutionModeState::LIVE_UNREACHABLE;
#endif
}

double IndependentRiskEngine::calculate_short_option_margin(
    const std::string& side,
    int lot_size,
    double entry_price,
    double spot_price
) {
    if (side == "BUY") {
        return lot_size * entry_price;
    }
    // Retail Index Option Writing Margin: 7.6% baseline SPAN+Exposure percentage of notional + premium received (Zerodha published ATM example)
    double effective_spot = (spot_price > 0.0) ? spot_price : 25000.0;
    double notional_margin = 0.076 * lot_size * effective_spot;
    double premium_received = lot_size * entry_price;
    return notional_margin + premium_received;
}

double IndependentRiskEngine::calculate_spread_margin(
    int lot_size,
    double strike_width,
    double net_credit_received
) {
    if (lot_size <= 0 || strike_width <= 0.0) {
        return 0.0;
    }
    double max_risk_per_unit = strike_width - net_credit_received;
    if (max_risk_per_unit < 0.0) {
        max_risk_per_unit = 0.0;
    }
    return max_risk_per_unit * lot_size;
}

KellySizingResult IndependentRiskEngine::calculate_kelly_lot_size(
    const std::string& algo_source,
    const std::string& symbol,
    const std::string& side,
    double entry_price,
    double spot_price,
    double capital_in_hand
) {
    KellySizingResult res;
    int base_lot = 25;
    double default_spot = 25000.0;
    std::string und = "NIFTY";

    if (symbol.find("BANKNIFTY") != std::string::npos) {
        base_lot = 15;
        default_spot = 54000.0;
        und = "BANKNIFTY";
    } else if (symbol.find("SENSEX") != std::string::npos) {
        base_lot = 20;
        default_spot = 75000.0;
        und = "SENSEX";
    }

    double effective_spot = (spot_price > 0.0) ? spot_price : default_spot;
    res.margin_per_lot = calculate_short_option_margin(side, base_lot, entry_price, effective_spot);

    // OOS Walk-Forward Gate Check (N >= 200 samples required)
    // Only SENSEX OFI_Microstructure_Breakout passed G21 gate with N=873 >= 200
    if (algo_source == "OFI_Microstructure_Breakout" && und == "SENSEX") {
        res.oos_gate_passed = true;
        // Historical performance metrics from closed trades: W = 0.5762, R = 1.0174
        // Full Kelly: f* = W - (1-W)/R = 0.5762 - (0.4238 / 1.0174) = 0.1596
        // Conservative Quarter-Kelly multiplier: 0.25 * f* = 0.0399
        res.quarter_kelly_fraction = 0.0399;
        res.bucket_status = "VALIDATED_GATED (Kelly Active)";

        double target_kelly_alloc = res.quarter_kelly_fraction * capital_in_hand;
        if (res.margin_per_lot > 0.0) {
            res.suggested_lots = static_cast<int>(target_kelly_alloc / res.margin_per_lot);
        }
    } else {
        res.oos_gate_passed = false;
        res.quarter_kelly_fraction = 0.0;
        res.bucket_status = "RESEARCH_OBSERVABILITY_ONLY (Fallback Flat lot_size)";
        
        double per_trade_ceiling = 0.02 * capital_in_hand;
        if (res.margin_per_lot <= per_trade_ceiling && per_trade_ceiling > 0.0) {
            res.suggested_lots = 1;
        } else {
            res.suggested_lots = 0;
        }
    }

    return res;
}

IndependentRiskVeto IndependentRiskEngine::verify_order_proposal(
    const std::string& symbol,
    double proposed_risk_inr,
    double current_open_exposure_inr,
    double current_session_drawdown_inr,
    size_t current_open_positions_for_symbol,
    double ai_model_confidence,
    double current_capital_in_hand
) {
    IndependentRiskVeto veto;
    veto.risk_approved = true;
    veto.model_override_attempt_blocked = false;

    double effective_capital = (current_capital_in_hand > 0.0) ? current_capital_in_hand : max_aggregate_capital_;
    double effective_per_trade_risk = (current_capital_in_hand > 0.0) ? (0.02 * effective_capital) : max_per_trade_risk_;
    double effective_drawdown_limit = (current_capital_in_hand > 0.0) ? (0.05 * effective_capital) : max_session_drawdown_;

    // Dynamic 2% Per-Trade Risk Limit derived from CAPITAL_IN_HAND
    if (proposed_risk_inr > effective_per_trade_risk) {
        veto.risk_approved = false;
        veto.model_override_attempt_blocked = (ai_model_confidence >= 0.90);
        std::ostringstream ss;
        ss << "RISK_VETO_PER_TRADE_LIMIT_EXCEEDED: Proposed risk (₹" << std::fixed << std::setprecision(2)
           << proposed_risk_inr << ") > Dynamic 2% Kelly Limit (₹" << effective_per_trade_risk << "). Model confidence ("
           << ai_model_confidence << ") override blocked.";
        veto.veto_reason = ss.str();
        return veto;
    }

    // Aggregate capital ceiling (CAPITAL_IN_HAND = Base Capital + Net Realized PnL)
    if (current_open_exposure_inr + proposed_risk_inr > effective_capital) {
        veto.risk_approved = false;
        veto.veto_reason = "RISK_VETO_AGGREGATE_CAPITAL_CEILING_EXCEEDED";
        return veto;
    }

    // Dynamic 5% Session Drawdown Limit derived from CAPITAL_IN_HAND
    if (current_session_drawdown_inr >= effective_drawdown_limit) {
        veto.risk_approved = false;
        veto.veto_reason = "RISK_VETO_MAX_SESSION_DRAWDOWN_REACHED";
        return veto;
    }

    // Concentration limit (Max 1 position per instrument)
    if (current_open_positions_for_symbol >= 1) {
        veto.risk_approved = false;
        veto.veto_reason = "RISK_VETO_CONCENTRATION_LIMIT_EXCEEDED";
        return veto;
    }

    veto.veto_reason = "RISK_APPROVED";
    return veto;
}

IndependentRiskVeto IndependentRiskEngine::verify_feed_freshness(
    uint64_t tick_timestamp_ms,
    uint64_t current_time_ms,
    uint64_t max_allowed_staleness_ms
) {
    IndependentRiskVeto veto;
    if (tick_timestamp_ms > 0 && current_time_ms > tick_timestamp_ms && (current_time_ms - tick_timestamp_ms) > max_allowed_staleness_ms) {
        veto.risk_approved = false;
        double age_sec = (current_time_ms - tick_timestamp_ms) / 1000.0;
        veto.veto_reason = "STALE_FEED_VETO: Tick age (" + std::to_string(age_sec) + "s) exceeds " + std::to_string(max_allowed_staleness_ms / 1000.0) + "s threshold";
        return veto;
    }
    veto.risk_approved = true;
    veto.veto_reason = "FEED_FRESH";
    return veto;
}

IndependentRiskVeto IndependentRiskEngine::evaluate_circuit_breakers(
    size_t consecutive_losing_trades,
    double feed_quality_score
) {
    IndependentRiskVeto veto;

    if (consecutive_losing_trades >= 3) {
        veto.risk_approved = false;
        veto.veto_reason = "SHUTDOWN_CONSECUTIVE_LOSS_LIMIT: 3 consecutive losing trades triggered engine pause";
        return veto;
    }

    if (feed_quality_score < 70.0) {
        veto.risk_approved = false;
        veto.veto_reason = "SHUTDOWN_FEED_QUALITY_DEGRADED: Feed quality score (" + std::to_string(feed_quality_score) + "%) < 70%";
        return veto;
    }

    veto.risk_approved = true;
    veto.veto_reason = "CIRCUIT_BREAKER_NORMAL";
    return veto;
}

EmergencyKillSwitchResult IndependentRiskEngine::trigger_emergency_kill_switch(
    const std::string& reason,
    size_t active_orders,
    size_t active_positions
) {
    EmergencyKillSwitchResult res;
    res.kill_switch_triggered = true;
    res.cancelled_orders_count = active_orders;
    res.flattened_positions_count = active_positions;
    res.kill_reason = "EMERGENCY_KILL_SWITCH_ACTIVATED: " + reason;
    return res;
}

void IndependentRiskEngine::update_daily_risk_base(double current_capital_in_hand, const std::string& current_date_str, double initial_daily_loss) {
    if (current_date_str.empty() || current_date_str != cached_risk_date_ || cached_daily_risk_base_ <= 0.0) {
        cached_risk_date_ = current_date_str;
        cached_daily_risk_base_ = (current_capital_in_hand > 0.0) ? (0.02 * current_capital_in_hand) : max_per_trade_risk_;
        cumulative_daily_loss_ = (initial_daily_loss > 0.0) ? initial_daily_loss : 0.0;
    }
}

void IndependentRiskEngine::record_trade_result(double net_pnl) {
    if (net_pnl < 0.0) {
        cumulative_daily_loss_ += std::abs(net_pnl);
    }
}

double IndependentRiskEngine::get_remaining_daily_budget() const {
    double remaining = cached_daily_risk_base_ - cumulative_daily_loss_;
    return (remaining > 0.0) ? remaining : 0.0;
}

CostAwareFilterResult IndependentRiskEngine::evaluate_cost_aware_edge_filter(
    const std::string& instrument,
    const std::string& side,
    int quantity,
    double entry_price,
    double expected_take_profit_pct,
    double safety_multiplier
) {
    CostAwareFilterResult res;
    res.gating_status = "RESEARCH_OBSERVABILITY_ONLY";

    if (quantity <= 0 || entry_price <= 0.0) {
        res.passed = false;
        res.status_reason = "INVALID_ORDER_PARAMETERS";
        return res;
    }

    // Expected exit price on target hit (+50% by default for option buying)
    double target_exit_price = (side == "BUY") ? entry_price * (1.0 + expected_take_profit_pct) : entry_price * (1.0 - expected_take_profit_pct);
    if (target_exit_price < 0.0) target_exit_price = 0.0;

    // Expected gross profit on target hit
    res.estimated_gross_edge = quantity * std::abs(target_exit_price - entry_price);

    // Calculate authentic Zerodha charges for the trade
    double entry_turn = quantity * entry_price;
    double exit_turn = quantity * target_exit_price;
    double total_turn = entry_turn + exit_turn;

    double entry_brokerage = 20.0;
    double exit_brokerage = 20.0;
    double stt = (side == "BUY" ? exit_turn : entry_turn) * 0.0015;

    bool is_bse = (instrument.find("BSE_FO") != std::string::npos || instrument.find("SENSEX") != std::string::npos);
    double exchange_rate = is_bse ? 0.000325 : 0.000355;
    double exchange_charges = total_turn * exchange_rate;

    double stamp_duty = (side == "BUY" ? entry_turn : 0.0) * 0.00003;
    double sebi_fee = total_turn * 0.000001;
    double gst = 0.18 * (entry_brokerage + exit_brokerage + exchange_charges + sebi_fee);

    res.estimated_charges = entry_brokerage + exit_brokerage + stt + exchange_charges + stamp_duty + sebi_fee + gst;

    if (res.estimated_charges > 0.0) {
        res.edge_to_cost_ratio = res.estimated_gross_edge / res.estimated_charges;
    } else {
        res.edge_to_cost_ratio = 999.0;
    }

    double required_edge = safety_multiplier * res.estimated_charges;
    if (res.estimated_gross_edge >= required_edge) {
        res.passed = true;
        std::ostringstream ss;
        ss << "COST_FILTER_APPROVED (Gross Edge ₹" << std::fixed << std::setprecision(2) << res.estimated_gross_edge
           << " >= " << safety_multiplier << "x Cost ₹" << res.estimated_charges << ", Ratio: " << res.edge_to_cost_ratio << "x)";
        res.status_reason = ss.str();
    } else {
        res.passed = false;
        std::ostringstream ss;
        ss << "COST_FILTER_REJECTED (Gross Edge ₹" << std::fixed << std::setprecision(2) << res.estimated_gross_edge
           << " < " << safety_multiplier << "x Cost ₹" << res.estimated_charges << ", Ratio: " << res.edge_to_cost_ratio << "x)";
        res.status_reason = ss.str();
    }

    return res;
}

std::string IndependentRiskVeto::summary_json() const {
    std::ostringstream ss;
    ss << "{\"approved\":" << (risk_approved ? "true" : "false")
       << ",\"override_blocked\":" << (model_override_attempt_blocked ? "true" : "false")
       << ",\"reason\":\"" << veto_reason << "\"}";
    return ss.str();
}

std::string EmergencyKillSwitchResult::summary_json() const {
    std::ostringstream ss;
    ss << "{\"triggered\":" << (kill_switch_triggered ? "true" : "false")
       << ",\"orders_cancelled\":" << cancelled_orders_count
       << ",\"positions_flattened\":" << flattened_positions_count
       << ",\"reason\":\"" << kill_reason << "\"}";
    return ss.str();
}

} // namespace hermes

