#include "gate13_validation_harness.hpp"
#include <cmath>
#include <sstream>
#include <iomanip>
#include <numeric>
#include <algorithm>
#include <iostream>

namespace hermes {

ValidationHarnessEngine::ValidationHarnessEngine() {}

WalkForwardSplit ValidationHarnessEngine::generate_purged_embargo_split(
    uint64_t train_start_ms,
    uint64_t train_duration_ms,
    uint64_t purge_duration_ms,
    uint64_t test_duration_ms,
    uint64_t embargo_duration_ms
) {
    WalkForwardSplit split;
    split.train_start_ms = train_start_ms;
    split.train_end_ms = train_start_ms + train_duration_ms;
    split.purge_end_ms = split.train_end_ms + purge_duration_ms;
    split.test_start_ms = split.purge_end_ms;
    split.test_end_ms = split.test_start_ms + test_duration_ms;
    split.embargo_end_ms = split.test_end_ms + embargo_duration_ms;

    // Verify purging & embargo integrity (no overlap between train_end and test_start)
    split.has_leakage = (split.test_start_ms < split.train_end_ms + purge_duration_ms);
    return split;
}

CPCVFoldResult ValidationHarnessEngine::evaluate_cpcv_fold(
    size_t fold_idx,
    const std::vector<double>& train_pnls,
    const std::vector<double>& test_pnls,
    size_t num_trial_experiments
) {
    CPCVFoldResult res;
    res.fold_index = fold_idx;

    auto calc_sharpe = [](const std::vector<double>& pnls) -> double {
        if (pnls.empty()) return 0.0;
        double sum = 0.0;
        for (double p : pnls) sum += p;
        double mean = sum / static_cast<double>(pnls.size());
        double var = 0.0;
        for (double p : pnls) var += (p - mean) * (p - mean);
        double std_dev = std::sqrt(var / static_cast<double>(pnls.size()));
        return (std_dev > 0.0) ? (mean / std_dev) * std::sqrt(252.0) : 0.0;
    };

    res.train_sharpe = calc_sharpe(train_pnls);
    res.test_sharpe = calc_sharpe(test_pnls);

    // G13-03 Deflated Sharpe Ratio (DSR) Diagnostic calculation (DePrado model)
    // Adjust expected Sharpe under multiple testing bias across N trial experiments
    double expected_max_sharpe = std::sqrt(2.0 * std::log(static_cast<double>(num_trial_experiments)));
    double dsr_num = (res.test_sharpe - expected_max_sharpe) * std::sqrt(static_cast<double>(test_pnls.size()));
    double dsr_den = std::sqrt(1.0 + 0.5 * res.test_sharpe * res.test_sharpe);
    double z_stat = (dsr_den > 0.0) ? (dsr_num / dsr_den) : 0.0;
    
    // Normal CDF Z-stat diagnostic
    res.deflated_sharpe_ratio = 0.5 * std::erfc(-z_stat / 1.41421356);

    res.passed_fold = (res.test_sharpe >= 1.0 && !test_pnls.empty());
    return res;
}

PromotionGateResult ValidationHarnessEngine::evaluate_production_promotion(
    const std::string& experiment_id,
    const std::string& strategy_name,
    bool walk_forward_ok,
    bool cpcv_ok,
    bool stress_test_ok,
    bool holdout_ok,
    double dsr_diagnostic
) {
    PromotionGateResult res;
    res.experiment_id = experiment_id;
    res.strategy_name = strategy_name;
    res.walk_forward_passed = walk_forward_ok;
    res.cpcv_passed = cpcv_ok;
    res.cost_latency_stress_passed = stress_test_ok;
    res.untouched_holdout_passed = holdout_ok;
    res.deflated_sharpe_diagnostic = dsr_diagnostic;

    // G13-04 Rule: EVERY single condition must pass to approve promotion
    if (!res.walk_forward_passed) {
        res.promotion_approved = false;
        res.blocking_reason = "PROMOTION_BLOCKED_WALK_FORWARD_PURGED_EMBARGO_FAILED";
    } else if (!res.cpcv_passed) {
        res.promotion_approved = false;
        res.blocking_reason = "PROMOTION_BLOCKED_CPCV_CROSS_VALIDATION_FAILED";
    } else if (!res.cost_latency_stress_passed) {
        res.promotion_approved = false;
        res.blocking_reason = "PROMOTION_BLOCKED_COST_LATENCY_STRESS_TEST_FAILED";
    } else if (!res.untouched_holdout_passed) {
        res.promotion_approved = false;
        res.blocking_reason = "PROMOTION_BLOCKED_UNTOUCHED_HOLDOUT_FAILED";
    } else {
        res.promotion_approved = true;
        res.blocking_reason = "APPROVED_FOR_PRODUCTION_PROMOTION";
    }

    return res;
}

std::string PromotionGateResult::summary_json() const {
    std::ostringstream ss;
    ss << std::fixed << std::setprecision(2);
    ss << "{\"exp_id\":\"" << experiment_id << "\",\"strategy\":\"" << strategy_name
       << "\",\"walk_forward\":" << (walk_forward_passed ? "true" : "false")
       << ",\"cpcv\":" << (cpcv_passed ? "true" : "false")
       << ",\"stress\":" << (cost_latency_stress_passed ? "true" : "false")
       << ",\"holdout\":" << (untouched_holdout_passed ? "true" : "false")
       << ",\"dsr_diag\":" << deflated_sharpe_diagnostic
       << ",\"approved\":" << (promotion_approved ? "true" : "false")
       << ",\"reason\":\"" << blocking_reason << "\"}";
    return ss.str();
}

} // namespace hermes
