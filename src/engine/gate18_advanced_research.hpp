#ifndef HERMES_GATE18_ADVANCED_RESEARCH_HPP
#define HERMES_GATE18_ADVANCED_RESEARCH_HPP

#include <string>
#include <map>
#include <vector>

enum class AdvancedModelType {
    HMM_REGIME,
    GARCH_VOLATILITY,
    KALMAN_PAIR_SPREAD,
    HAWKES_POINT_PROCESS,
    DEEPLOB_NEURAL_NETWORK
};

struct AdvancedBaselineComparisonRecord {
    std::string model_id;
    AdvancedModelType type;
    std::string simpler_baseline_name;
    double baseline_sharpe{0.0};
    double advanced_model_sharpe{0.0};
    double perf_lift_pct{0.0};
    bool baseline_plateau_proven{false};
    bool off_box_trained{true};
    bool is_enabled_for_production{false};
};

class AdvancedResearchFramework {
public:
    AdvancedResearchFramework();

    void register_baseline_comparison(const AdvancedBaselineComparisonRecord& record);
    bool is_model_approved_for_production(const std::string& model_id, std::string& out_reason) const;
    AdvancedBaselineComparisonRecord get_record(const std::string& model_id) const;

private:
    std::map<std::string, AdvancedBaselineComparisonRecord> comparisons_;
};

#endif // HERMES_GATE18_ADVANCED_RESEARCH_HPP
