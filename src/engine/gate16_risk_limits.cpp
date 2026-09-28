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
    max_aggregate_capital_(max_aggregate_capital > 0 ? max_aggregate_capital : EnvLoader::get_double("MAX_AGGREGATE_CAPITAL", 10000.0)),
    max_session_drawdown_(max_session_drawdown > 0 ? max_session_drawdown : EnvLoader::get_double("MAX_SESSION_DRAWDOWN", 1500.0)) {}


ExecutionModeState IndependentRiskEngine::get_execution_mode_state() {
#ifdef HERMES_COMPILE_TIME_PAPER_ONLY
    return ExecutionModeState::PAPER;
#else
    return ExecutionModeState::LIVE_UNREACHABLE;
#endif
}

IndependentRiskVeto IndependentRiskEngine::verify_order_proposal(
    const std::string& symbol,
    double proposed_risk_inr,
    double current_open_exposure_inr,
    double current_session_drawdown_inr,
    size_t current_open_positions_for_symbol,
    double ai_model_confidence
) {
    IndependentRiskVeto veto;
    veto.risk_approved = true;
    veto.model_override_attempt_blocked = false;

    // G16-01 Negative Test: If proposed risk exceeds ₹2,000, even 1.0 (100%) AI confidence CANNOT override
    if (proposed_risk_inr > max_per_trade_risk_) {
        veto.risk_approved = false;
        veto.model_override_attempt_blocked = (ai_model_confidence >= 0.90);
        std::ostringstream ss;
        ss << "RISK_VETO_PER_TRADE_LIMIT_EXCEEDED: Proposed risk (₹" << std::fixed << std::setprecision(2)
           << proposed_risk_inr << ") > Limit (₹" << max_per_trade_risk_ << "). Model confidence ("
           << ai_model_confidence << ") override blocked.";
        veto.veto_reason = ss.str();
        return veto;
    }

    // Aggregate capital ceiling (₹10,000)
    if (current_open_exposure_inr + proposed_risk_inr > max_aggregate_capital_) {
        veto.risk_approved = false;
        veto.veto_reason = "RISK_VETO_AGGREGATE_CAPITAL_CEILING_EXCEEDED";
        return veto;
    }

    // Session Drawdown limit (₹1,000)
    if (current_session_drawdown_inr >= max_session_drawdown_) {
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
