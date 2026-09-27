#ifndef HERMES_GATE13_VALIDATION_HARNESS_HPP
#define HERMES_GATE13_VALIDATION_HARNESS_HPP

#include <string>
#include <vector>
#include <cstdint>

namespace hermes {

struct WalkForwardSplit {
    uint64_t train_start_ms{0};
    uint64_t train_end_ms{0};
    uint64_t purge_end_ms{0};   // train_end + 30m purge
    uint64_t test_start_ms{0};
    uint64_t test_end_ms{0};
    uint64_t embargo_end_ms{0}; // test_end + 60m embargo
    bool has_leakage{false};
};

struct CPCVFoldResult {
    size_t fold_index{0};
    double train_sharpe{0.0};
    double test_sharpe{0.0};
    double deflated_sharpe_ratio{0.0}; // DSR diagnostic
    bool passed_fold{false};
};

struct PromotionGateResult {
    std::string experiment_id;
    std::string strategy_name;
    
    bool walk_forward_passed{false};
    bool cpcv_passed{false};
    bool cost_latency_stress_passed{false};
    bool untouched_holdout_passed{false};
    
    double deflated_sharpe_diagnostic{0.0};
    bool promotion_approved{false};
    std::string blocking_reason;
    std::string summary_json() const;
};

class ValidationHarnessEngine {
public:
    ValidationHarnessEngine();

    // G13-01: Generate Walk-forward Purged & Embargoed splits
    static WalkForwardSplit generate_purged_embargo_split(
        uint64_t train_start_ms,
        uint64_t train_duration_ms,
        uint64_t purge_duration_ms,
        uint64_t test_duration_ms,
        uint64_t embargo_duration_ms
    );

    // G13-02 & G13-03: Evaluate CPCV folds and compute Deflated Sharpe Ratio (DSR)
    static CPCVFoldResult evaluate_cpcv_fold(
        size_t fold_idx,
        const std::vector<double>& train_pnls,
        const std::vector<double>& test_pnls,
        size_t num_trial_experiments = 10
    );

    // G13-04: Evaluate full promotion gate harness
    static PromotionGateResult evaluate_production_promotion(
        const std::string& experiment_id,
        const std::string& strategy_name,
        bool walk_forward_ok,
        bool cpcv_ok,
        bool stress_test_ok,
        bool holdout_ok,
        double dsr_diagnostic
    );
};

} // namespace hermes

#endif // HERMES_GATE13_VALIDATION_HARNESS_HPP
