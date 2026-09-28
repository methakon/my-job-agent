#include "gate18_advanced_research.hpp"

AdvancedResearchFramework::AdvancedResearchFramework() {}

void AdvancedResearchFramework::register_baseline_comparison(const AdvancedBaselineComparisonRecord& record) {
    comparisons_[record.model_id] = record;
}

bool AdvancedResearchFramework::is_model_approved_for_production(const std::string& model_id, std::string& out_reason) const {
    auto it = comparisons_.find(model_id);
    if (it == comparisons_.end()) {
        out_reason = "REJECT_UNREGISTERED_MODEL: Model " + model_id + " has no baseline comparison record stored.";
        return false;
    }

    const auto& rec = it->second;
    if (!rec.baseline_plateau_proven) {
        out_reason = "REJECT_BASELINE_NOT_PLATEAUED: Simpler baseline " + rec.simpler_baseline_name + " has not hit a performance plateau.";
        return false;
    }

    if (!rec.off_box_trained) {
        out_reason = "REJECT_ON_BOX_HEAVY_TRAINING: Advanced model must be trained off-box, not on the Oracle free-tier VM.";
        return false;
    }

    if (rec.perf_lift_pct < 5.0) {
        out_reason = "REJECT_INSUFFICIENT_LIFT: Advanced model lift (" + std::to_string(rec.perf_lift_pct) + "%) is below the 5% threshold over " + rec.simpler_baseline_name;
        return false;
    }

    if (!rec.is_enabled_for_production) {
        out_reason = "REJECT_SHADOW_ONLY_MODE: Advanced model " + model_id + " is kept in shadow/research mode.";
        return false;
    }

    return true;
}

AdvancedBaselineComparisonRecord AdvancedResearchFramework::get_record(const std::string& model_id) const {
    auto it = comparisons_.find(model_id);
    if (it != comparisons_.end()) return it->second;
    return {};
}
