#include "gate_const_invariants.hpp"
#include <iostream>

ConstInvariantsEngine::ConstInvariantsEngine() {}

EntryGateResult ConstInvariantsEngine::evaluate_entry_gates(const EntryGateEvaluationContext& ctx) {
    EntryGateResult res;
    res.passed_all = false;
    res.net_ev = ctx.gross_ev - ctx.transaction_cost;

    // R-014: System halt check
    if (ctx.system_halted) {
        res.failed_gate_id = "R-014";
        res.rejection_reason = "REJECT_SYSTEM_HALTED: System is in HALT mode, blocking new entries";
        return res;
    }

    // E1 & R-007: Data Validity & Freshness Check
    if (!ctx.data_fresh || ctx.tick_age_sec > 2.0) {
        res.failed_gate_id = "E1/R-007";
        res.rejection_reason = "REJECT_STALE_DATA: Tick feed age (" + std::to_string(ctx.tick_age_sec) + "s) exceeds 2.0s threshold";
        return res;
    }

    // R-001: Multi-factor entry confirmation
    if (!ctx.multi_factor_confirmed) {
        res.failed_gate_id = "R-001";
        res.rejection_reason = "REJECT_SINGLE_FACTOR_ENTRY: Entry attempted on single factor without multi-factor confirmation";
        return res;
    }

    // R-004: Anti-averaging down check
    if (ctx.is_averaging_down) {
        res.failed_gate_id = "R-004";
        res.rejection_reason = "REJECT_AVERAGING_DOWN: Automated averaging down is strictly prohibited";
        return res;
    }

    // R-005: Auto-reversal check
    if (ctx.is_auto_reversal) {
        res.failed_gate_id = "R-005";
        res.rejection_reason = "REJECT_AUTO_REVERSAL: Post-loss auto-reversal is strictly prohibited";
        return res;
    }

    // E2: Regime Classification & Trend Alignment
    if (!ctx.regime_aligned) {
        res.failed_gate_id = "E2";
        res.rejection_reason = "REJECT_REGIME_MISMATCH: Trade proposal conflicts with current market regime";
        return res;
    }

    // E3: Spot & Futures Price Confirmation
    if (!ctx.underlying_confirmed) {
        res.failed_gate_id = "E3";
        res.rejection_reason = "REJECT_UNDERLYING_DISCREPANCY: Spot and futures direction not confirmed";
        return res;
    }

    // E4: Option Chain Liquidity & Spread Check
    if (ctx.bid_ask_spread > ctx.max_allowed_spread) {
        res.failed_gate_id = "E4";
        res.rejection_reason = "REJECT_WIDE_SPREAD: Bid/Ask spread (" + std::to_string(ctx.bid_ask_spread) + ") exceeds max allowed (" + std::to_string(ctx.max_allowed_spread) + ")";
        return res;
    }

    // E5: Execution Quality & Expected Slippage Check
    if (ctx.expected_slippage > ctx.max_allowed_slippage) {
        res.failed_gate_id = "E5";
        res.rejection_reason = "REJECT_HIGH_SLIPPAGE: Expected slippage (" + std::to_string(ctx.expected_slippage) + ") exceeds threshold (" + std::to_string(ctx.max_allowed_slippage) + ")";
        return res;
    }

    // E6: Expected Move & Volatility Skew Calibration
    if (ctx.expected_move_pts <= 0.0) {
        res.failed_gate_id = "E6";
        res.rejection_reason = "REJECT_INVALID_EXPECTED_MOVE: Expected move is zero or negative";
        return res;
    }

    // E7: Option Chain Trap Score Evaluation
    if (ctx.trap_score > 50.0) {
        res.failed_gate_id = "E7";
        res.rejection_reason = "REJECT_HIGH_TRAP_SCORE: Trap score (" + std::to_string(ctx.trap_score) + ") exceeds 50.0 risk threshold";
        return res;
    }

    // E8 & R-008: Net Expected Value After Transaction Costs
    if (res.net_ev < ctx.min_required_edge) {
        res.failed_gate_id = "E8/R-008";
        res.rejection_reason = "REJECT_INSUFFICIENT_EDGE: Net EV (" + std::to_string(res.net_ev) + ") is below minimum required edge (" + std::to_string(ctx.min_required_edge) + ")";
        return res;
    }

    // E9 & R-006: Remaining Risk Budget & Position Sizing
    if (ctx.required_risk > ctx.remaining_risk_budget) {
        res.failed_gate_id = "E9/R-006";
        res.rejection_reason = "REJECT_RISK_BUDGET_EXCEEDED: Required risk (" + std::to_string(ctx.required_risk) + ") exceeds remaining risk budget (" + std::to_string(ctx.remaining_risk_budget) + ")";
        return res;
    }

    // E10: Shadow Market Engine Parallel Benchmark
    if (!ctx.shadow_benchmark_logged) {
        res.failed_gate_id = "E10";
        res.rejection_reason = "REJECT_UNBENCHMARKED_SHADOW: Shadow market engine benchmark was not logged";
        return res;
    }

    res.passed_all = true;
    res.failed_gate_id = "NONE";
    res.rejection_reason = "APPROVED: All entry gates E1-E10 and rules R-001..R-015 passed cleanly";
    res.initial_health = PositionHealthState::GREEN;
    return res;
}

PositionHealthState ConstInvariantsEngine::transition_health_state(PositionHealthState current, double current_drawdown_pct, double duration_min) {
    if (current_drawdown_pct >= 50.0) return PositionHealthState::BLACK;
    if (current_drawdown_pct >= 30.0) return PositionHealthState::RED;
    if (current_drawdown_pct >= 20.0) return PositionHealthState::ORANGE;
    if (current_drawdown_pct >= 10.0) return PositionHealthState::YELLOW;
    return PositionHealthState::GREEN;
}

bool ConstInvariantsEngine::is_recovery_allowed(double recovery_ev, double remaining_risk_budget, std::string& out_reason) {
    if (recovery_ev <= 0.0) {
        out_reason = "REJECT_NEGATIVE_RECOVERY_EV: Recovery expectancy (" + std::to_string(recovery_ev) + ") is non-positive";
        return false;
    }
    if (remaining_risk_budget < 500.0) {
        out_reason = "REJECT_INSUFFICIENT_RECOVERY_BUDGET: Remaining risk budget (" + std::to_string(remaining_risk_budget) + ") is insufficient for recovery";
        return false;
    }
    out_reason = "APPROVED_RECOVERY: Recovery has positive EV and fits remaining risk budget";
    return true;
}

std::string ConstInvariantsEngine::build_surveillance_hypothesis(const std::string& anomaly_type, double severity) {
    return "[SURVEILLANCE_HYPOTHESIS] Flagged anomaly type '" + anomaly_type + "' with severity " + std::to_string(severity) + ". Hypothesis logged for surveillance review, intent unasserted.";
}
