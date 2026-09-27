#include "gate14_risk_reflexion.hpp"
#include <sstream>
#include <iomanip>
#include <iostream>

namespace hermes {

RiskReflexionEngine::RiskReflexionEngine() {}

TradeOutcomeTaxonomy RiskReflexionEngine::classify_outcome(
    double pnl_points,
    double slippage_pts,
    uint64_t latency_ms,
    bool regime_mismatched,
    bool catalyst_active
) {
    if (pnl_points > 0.0) {
        return (pnl_points >= 15.0) ? TradeOutcomeTaxonomy::SUCCESS_TARGET_HIT : TradeOutcomeTaxonomy::SUCCESS_PROFIT_TRAILED;
    }

    // Classify failure taxonomy
    if (catalyst_active) {
        return TradeOutcomeTaxonomy::FAIL_CATALYST_JUMP;
    }
    if (regime_mismatched) {
        return TradeOutcomeTaxonomy::FAIL_REGIME_MISMATCH;
    }
    if (slippage_pts >= 2.0) {
        return TradeOutcomeTaxonomy::FAIL_SLIPPAGE_EXCESS;
    }
    if (latency_ms >= 100) {
        return TradeOutcomeTaxonomy::FAIL_LATENCY_DELAY;
    }

    return TradeOutcomeTaxonomy::FAIL_BAD_SENSING;
}

ReflexionRecord RiskReflexionEngine::generate_off_path_reflexion(
    const std::string& trade_id,
    const std::string& symbol,
    TradeOutcomeTaxonomy outcome,
    double pnl_points
) {
    ReflexionRecord rec;
    rec.trade_id = trade_id;
    rec.symbol = symbol;
    rec.outcome = outcome;
    rec.is_off_hot_path = true; // Off-hot-path decoupled execution

    switch (outcome) {
        case TradeOutcomeTaxonomy::SUCCESS_TARGET_HIT: rec.outcome_name = "SUCCESS_TARGET_HIT"; break;
        case TradeOutcomeTaxonomy::SUCCESS_PROFIT_TRAILED: rec.outcome_name = "SUCCESS_PROFIT_TRAILED"; break;
        case TradeOutcomeTaxonomy::FAIL_SLIPPAGE_EXCESS: rec.outcome_name = "FAIL_SLIPPAGE_EXCESS"; break;
        case TradeOutcomeTaxonomy::FAIL_LATENCY_DELAY: rec.outcome_name = "FAIL_LATENCY_DELAY"; break;
        case TradeOutcomeTaxonomy::FAIL_REGIME_MISMATCH: rec.outcome_name = "FAIL_REGIME_MISMATCH"; break;
        case TradeOutcomeTaxonomy::FAIL_CATALYST_JUMP: rec.outcome_name = "FAIL_CATALYST_JUMP"; break;
        default: rec.outcome_name = "FAIL_BAD_SENSING"; break;
    }

    std::ostringstream ss;
    ss << "OFF_HOT_PATH_REFLEXION_V1: Trade " << trade_id << " (" << symbol << ") outcome=" << rec.outcome_name
       << ", PnL=" << std::fixed << std::setprecision(2) << pnl_points << " pts.";
    rec.llm_reflexion_summary = ss.str();

    return rec;
}

KnowledgeRulePipelineRecord RiskReflexionEngine::evaluate_knowledge_rule_promotion(
    const std::string& rule_id,
    const std::string& hypothesis_text,
    size_t sample_trade_count,
    double historical_win_rate
) {
    KnowledgeRulePipelineRecord rec;
    rec.rule_id = rule_id;
    rec.hypothesis_text = hypothesis_text;
    rec.sample_trade_count = sample_trade_count;

    // G14-04 Rule: NO PROMOTION from a single trade or small sample (< 30 trades)
    if (sample_trade_count < 30) {
        rec.stage = KnowledgeLifecycleStage::HYPOTHESIS;
        rec.is_promoted_to_production = false;
        rec.status_reason = "REJECT_INSUFFICIENT_SAMPLE_SIZE_SINGLE_TRADE_PROMOTION_BLOCKED: Sample count (" + std::to_string(sample_trade_count) + ") < 30";
        return rec;
    }

    if (historical_win_rate >= 0.60) {
        rec.stage = KnowledgeLifecycleStage::TESTED_RULE;
        rec.is_promoted_to_production = true;
        rec.status_reason = "APPROVED_PROMOTED_TO_PRODUCTION";
    } else {
        rec.stage = KnowledgeLifecycleStage::REJECTED_RULE;
        rec.is_promoted_to_production = false;
        rec.status_reason = "REJECTED_RULE_POOR_WIN_RATE";
    }

    return rec;
}

std::string ReflexionRecord::summary_json() const {
    std::ostringstream ss;
    ss << "{\"trade_id\":\"" << trade_id << "\",\"symbol\":\"" << symbol
       << "\",\"outcome\":\"" << outcome_name
       << "\",\"off_hot_path\":" << (is_off_hot_path ? "true" : "false")
       << ",\"summary\":\"" << llm_reflexion_summary << "\"}";
    return ss.str();
}

std::string KnowledgeRulePipelineRecord::summary_json() const {
    std::ostringstream ss;
    ss << "{\"rule_id\":\"" << rule_id << "\",\"samples\":" << sample_trade_count
       << ",\"stage\":" << static_cast<int>(stage)
       << ",\"promoted\":" << (is_promoted_to_production ? "true" : "false")
       << ",\"reason\":\"" << status_reason << "\"}";
    return ss.str();
}

} // namespace hermes
