#ifndef HERMES_GATE11_STRATEGY_TAXONOMY_HPP
#define HERMES_GATE11_STRATEGY_TAXONOMY_HPP

#include <string>
#include <vector>
#include <memory>
#include <cstdint>

namespace hermes {

enum class StrategyPriorityLevel {
    P0_CORE_PRODUCTION = 0,
    P1_SHADOW_EXPERIMENTAL,
    P2_PLATEAU_GATED,
    EXCLUDED_MARKET_MAKING
};

enum class StrategyAction {
    NO_ACTION = 0,
    BUY_CALL,
    BUY_PUT,
    SELL_CALL_FADE,
    SELL_PUT_FADE
};

struct StrategyInput {
    std::string symbol;
    uint64_t timestamp_ms{0};
    double spot_price{0.0};
    double open_price{0.0};
    double prev_close{0.0};
    double atr_14{0.0};
    double relative_volume{1.0};
    double ofi_l1{0.0};
    bool is_shadow_execution_mode{false};
};

struct StrategyProposal {
    std::string strategy_name;
    StrategyPriorityLevel priority_level{StrategyPriorityLevel::P0_CORE_PRODUCTION};
    StrategyAction action{StrategyAction::NO_ACTION};
    
    double proposed_strike{0.0};
    double target_price{0.0};
    double stop_loss_price{0.0};
    double expected_ev_pts{0.0};
    double confidence_score{0.0};
    
    bool is_shadow_only{false};
    bool is_gated_pending_evidence{false};
    bool is_excluded_from_v1{false};
    std::string rejection_reason;
    
    std::string summary_json() const;
};

class IStrategy {
public:
    virtual ~IStrategy() = default;
    virtual std::string name() const = 0;
    virtual StrategyPriorityLevel priority_level() const = 0;
    virtual StrategyProposal evaluate(const StrategyInput& input) = 0;
};

class GapFadeP0Strategy : public IStrategy {
public:
    std::string name() const override { return "GapFadeP0Strategy"; }
    StrategyPriorityLevel priority_level() const override { return StrategyPriorityLevel::P0_CORE_PRODUCTION; }
    StrategyProposal evaluate(const StrategyInput& input) override;
};

class GammaScalpP1Strategy : public IStrategy {
public:
    std::string name() const override { return "GammaScalpP1Strategy"; }
    StrategyPriorityLevel priority_level() const override { return StrategyPriorityLevel::P1_SHADOW_EXPERIMENTAL; }
    StrategyProposal evaluate(const StrategyInput& input) override;
};

class CalendarSpreadP2Strategy : public IStrategy {
public:
    explicit CalendarSpreadP2Strategy(bool plateau_evidence_proven = false, const std::string& exp_id = "");
    std::string name() const override { return "CalendarSpreadP2Strategy"; }
    StrategyPriorityLevel priority_level() const override { return StrategyPriorityLevel::P2_PLATEAU_GATED; }
    StrategyProposal evaluate(const StrategyInput& input) override;

private:
    bool plateau_evidence_proven_;
    std::string exp_id_;
};

class HFTMarketMakerStrategy : public IStrategy {
public:
    std::string name() const override { return "HFTMarketMakerStrategy"; }
    StrategyPriorityLevel priority_level() const override { return StrategyPriorityLevel::EXCLUDED_MARKET_MAKING; }
    StrategyProposal evaluate(const StrategyInput& input) override;
};

class StrategyTaxonomyEngine {
public:
    StrategyTaxonomyEngine();

    void register_strategy(std::shared_ptr<IStrategy> strategy);
    
    // Evaluate registered strategies and filter out excluded / gated ones
    std::vector<StrategyProposal> evaluate_all(const StrategyInput& input);

private:
    std::vector<std::shared_ptr<IStrategy>> strategies_;
};

} // namespace hermes

#endif // HERMES_GATE11_STRATEGY_TAXONOMY_HPP
