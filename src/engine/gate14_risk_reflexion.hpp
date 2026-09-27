#ifndef HERMES_GATE14_RISK_REFLEXION_HPP
#define HERMES_GATE14_RISK_REFLEXION_HPP

#include <string>
#include <vector>
#include <cstdint>

namespace hermes {

enum class TradeOutcomeTaxonomy {
    SUCCESS_TARGET_HIT = 0,
    SUCCESS_PROFIT_TRAILED,
    FAIL_SLIPPAGE_EXCESS,
    FAIL_LATENCY_DELAY,
    FAIL_REGIME_MISMATCH,
    FAIL_CATALYST_JUMP,
    FAIL_BAD_SENSING
};

enum class KnowledgeLifecycleStage {
    OBSERVATION = 0,
    HYPOTHESIS,
    TESTED_RULE,
    REJECTED_RULE
};

struct ReflexionRecord {
    std::string trade_id;
    std::string symbol;
    TradeOutcomeTaxonomy outcome{TradeOutcomeTaxonomy::SUCCESS_TARGET_HIT};
    std::string outcome_name;
    
    bool is_off_hot_path{true}; // Runs strictly decoupled from 100us C++ hot path
    std::string llm_reflexion_summary;
    std::string summary_json() const;
};

struct KnowledgeRulePipelineRecord {
    std::string rule_id;
    std::string hypothesis_text;
    KnowledgeLifecycleStage stage{KnowledgeLifecycleStage::OBSERVATION};
    
    size_t sample_trade_count{0};
    bool is_promoted_to_production{false};
    std::string status_reason;
    std::string summary_json() const;
};

class RiskReflexionEngine {
public:
    RiskReflexionEngine();

    // G14-01: Classify trade outcome into failure/success taxonomy
    static TradeOutcomeTaxonomy classify_outcome(
        double pnl_points,
        double slippage_pts,
        uint64_t latency_ms,
        bool regime_mismatched,
        bool catalyst_active
    );

    // G14-02: Generate off-hot-path LLM reflexion summary
    static ReflexionRecord generate_off_path_reflexion(
        const std::string& trade_id,
        const std::string& symbol,
        TradeOutcomeTaxonomy outcome,
        double pnl_points
    );

    // G14-03 & G14-04: Evaluate knowledge lifecycle pipeline & enforce single-trade promotion block
    static KnowledgeRulePipelineRecord evaluate_knowledge_rule_promotion(
        const std::string& rule_id,
        const std::string& hypothesis_text,
        size_t sample_trade_count,
        double historical_win_rate
    );
};

} // namespace hermes

#endif // HERMES_GATE14_RISK_REFLEXION_HPP
