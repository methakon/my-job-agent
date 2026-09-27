#include "gate12_ml_pipeline.hpp"
#include <sstream>
#include <iomanip>
#include <cmath>
#include <algorithm>
#include <cassert>
#include <iostream>

namespace hermes {

MLFeaturePipelineEngine::MLFeaturePipelineEngine() {}

bool MLFeaturePipelineEngine::verify_point_in_time_integrity(
    uint64_t feature_snapshot_time_ms,
    uint64_t data_tick_time_ms
) {
    // Point-in-time invariant: Data tick timestamp MUST NOT exceed feature snapshot barrier
    return (data_tick_time_ms <= feature_snapshot_time_ms);
}

MultiHorizonLabel MLFeaturePipelineEngine::compute_multi_horizon_labels(
    const std::vector<std::pair<uint64_t, double>>& price_series,
    size_t current_idx,
    double pct_threshold
) {
    MultiHorizonLabel lbl;
    if (current_idx >= price_series.size()) return lbl;

    uint64_t base_time = price_series[current_idx].first;
    double base_price = price_series[current_idx].second;
    lbl.timestamp_ms = base_time;

    uint64_t t_5m  = base_time + (5 * 60 * 1000);
    uint64_t t_15m = base_time + (15 * 60 * 1000);
    uint64_t t_30m = base_time + (30 * 60 * 1000);

    double p_5m = base_price;
    double p_15m = base_price;
    double p_30m = base_price;

    for (size_t i = current_idx + 1; i < price_series.size(); ++i) {
        uint64_t ts = price_series[i].first;
        double px = price_series[i].second;

        if (ts <= t_5m) p_5m = px;
        if (ts <= t_15m) p_15m = px;
        if (ts <= t_30m) p_30m = px;
        if (ts > t_30m) break;
    }

    if (base_price > 0.0) {
        lbl.return_5m  = (p_5m - base_price) / base_price;
        lbl.return_15m = (p_15m - base_price) / base_price;
        lbl.return_30m = (p_30m - base_price) / base_price;
    }

    lbl.label_5m  = (lbl.return_5m >= pct_threshold) ? 1 : ((lbl.return_5m <= -pct_threshold) ? -1 : 0);
    lbl.label_15m = (lbl.return_15m >= pct_threshold) ? 1 : ((lbl.return_15m <= -pct_threshold) ? -1 : 0);
    lbl.label_30m = (lbl.return_30m >= pct_threshold) ? 1 : ((lbl.return_30m <= -pct_threshold) ? -1 : 0);

    return lbl;
}

BaselineComparisonRecord MLFeaturePipelineEngine::evaluate_baseline_vs_tree_model(
    bool leakage_test_passed,
    double simple_baseline_acc,
    double tree_model_acc
) {
    BaselineComparisonRecord rec;
    rec.model_name = "LightGBM_Proxy_Tree_Model";
    rec.leakage_test_passed = leakage_test_passed;
    rec.simple_baseline_accuracy = simple_baseline_acc;
    rec.tree_model_accuracy = tree_model_acc;
    rec.accuracy_lift = tree_model_acc - simple_baseline_acc;

    // G12-04 Rule: Tree models are approved ONLY IF leakage tests pass AND accuracy lift >= +5.0%
    if (rec.leakage_test_passed && rec.accuracy_lift >= 0.05) {
        rec.tree_model_approved = true;
    } else {
        rec.tree_model_approved = false;
    }

    return rec;
}

std::string BaselineComparisonRecord::summary_json() const {
    std::ostringstream ss;
    ss << std::fixed << std::setprecision(2);
    ss << "{\"model\":\"" << model_name
       << "\",\"baseline_acc\":" << simple_baseline_accuracy * 100.0
       << ",\"tree_acc\":" << tree_model_accuracy * 100.0
       << ",\"accuracy_lift\":" << accuracy_lift * 100.0
       << ",\"approved\":" << (tree_model_approved ? "true" : "false") << "}";
    return ss.str();
}

} // namespace hermes
