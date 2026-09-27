#ifndef HERMES_GATE12_ML_PIPELINE_HPP
#define HERMES_GATE12_ML_PIPELINE_HPP

#include <string>
#include <vector>
#include <cstdint>

namespace hermes {

struct MultiHorizonLabel {
    uint64_t timestamp_ms{0};
    double return_5m{0.0};
    double return_15m{0.0};
    double return_30m{0.0};
    
    int label_5m{0};  // +1 (Up > +0.2%), -1 (Down < -0.2%), 0 (Neutral)
    int label_15m{0};
    int label_30m{0};
};

struct BaselineComparisonRecord {
    std::string model_name;
    double simple_baseline_accuracy{0.0}; // e.g. 52.5%
    double tree_model_accuracy{0.0};      // e.g. 61.2%
    double accuracy_lift{0.0};
    
    bool leakage_test_passed{false};
    bool tree_model_approved{false};
    std::string summary_json() const;
};

class MLFeaturePipelineEngine {
public:
    MLFeaturePipelineEngine();

    // G12-01: Reconstruct point-in-time features from journal records
    static bool verify_point_in_time_integrity(
        uint64_t feature_snapshot_time_ms,
        uint64_t data_tick_time_ms
    );

    // G12-02: Compute leakage-controlled multi-horizon labels
    static MultiHorizonLabel compute_multi_horizon_labels(
        const std::vector<std::pair<uint64_t, double>>& price_series,
        size_t current_idx,
        double pct_threshold = 0.002 // 0.2%
    );

    // G12-03 & G12-04: Compare tree model against simple baseline after leakage test
    static BaselineComparisonRecord evaluate_baseline_vs_tree_model(
        bool leakage_test_passed,
        double simple_baseline_acc,
        double tree_model_acc
    );
};

} // namespace hermes

#endif // HERMES_GATE12_ML_PIPELINE_HPP
