#include "gate11_strategy_taxonomy.hpp"
#include <sstream>
#include <iomanip>
#include <cmath>
#include <iostream>

namespace hermes {

// P0 Gap Fade Strategy Evaluation
StrategyProposal GapFadeP0Strategy::evaluate(const StrategyInput& input) {
    StrategyProposal prop;
    prop.strategy_name = name();
    prop.priority_level = priority_level();
    prop.is_shadow_only = false;
    prop.is_gated_pending_evidence = false;
    prop.is_excluded_from_v1 = false;

    double gap_pts = input.open_price - input.prev_close;
    if (std::abs(gap_pts) >= 50.0 && input.relative_volume >= 1.0) {
        if (gap_pts > 0.0) { // Gap Up -> Sell Call Fade
            prop.action = StrategyAction::SELL_CALL_FADE;
            prop.proposed_strike = input.open_price;
            prop.target_price = input.prev_close;
            prop.stop_loss_price = input.open_price + (0.5 * input.atr_14);
            prop.expected_ev_pts = std::abs(gap_pts) * 0.70;
            prop.confidence_score = 0.85;
        } else { // Gap Down -> Sell Put Fade
            prop.action = StrategyAction::SELL_PUT_FADE;
            prop.proposed_strike = input.open_price;
            prop.target_price = input.prev_close;
            prop.stop_loss_price = input.open_price - (0.5 * input.atr_14);
            prop.expected_ev_pts = std::abs(gap_pts) * 0.70;
            prop.confidence_score = 0.85;
        }
    } else {
        prop.action = StrategyAction::NO_ACTION;
        prop.rejection_reason = "GAP_SIZE_TOO_SMALL_OR_LOW_VOLUME";
    }

    return prop;
}

// P1 Gamma Scalp Strategy (SHADOW MODE ONLY)
StrategyProposal GammaScalpP1Strategy::evaluate(const StrategyInput& input) {
    StrategyProposal prop;
    prop.strategy_name = name();
    prop.priority_level = priority_level();
    prop.is_shadow_only = true; // MANDATORY P1 FLAG
    prop.is_gated_pending_evidence = false;
    prop.is_excluded_from_v1 = false;

    prop.action = StrategyAction::BUY_CALL;
    prop.proposed_strike = input.spot_price;
    prop.confidence_score = 0.75;
    prop.rejection_reason = "P1_STRATEGY_SHADOW_MODE_ONLY";
    return prop;
}

// P2 Calendar Spread Strategy (GATED BEHIND EVIDENCE)
CalendarSpreadP2Strategy::CalendarSpreadP2Strategy(bool plateau_evidence_proven, const std::string& exp_id)
    : plateau_evidence_proven_(plateau_evidence_proven), exp_id_(exp_id) {}

StrategyProposal CalendarSpreadP2Strategy::evaluate(const StrategyInput& input) {
    StrategyProposal prop;
    prop.strategy_name = name();
    prop.priority_level = priority_level();

    if (!plateau_evidence_proven_ || exp_id_.empty()) {
        prop.action = StrategyAction::NO_ACTION;
        prop.is_gated_pending_evidence = true; // MANDATORY P2 GATE
        prop.rejection_reason = "REJECT_P2_GATED_WITHOUT_BASELINE_PLATEAU_EVIDENCE";
    } else {
        prop.action = StrategyAction::BUY_CALL;
        prop.is_gated_pending_evidence = false;
        prop.confidence_score = 0.80;
        prop.rejection_reason = "APPROVED_WITH_PLATEAU_EVIDENCE: " + exp_id_;
    }

    return prop;
}

// Market Maker Strategy (EXCLUDED FROM V1)
StrategyProposal HFTMarketMakerStrategy::evaluate(const StrategyInput& input) {
    StrategyProposal prop;
    prop.strategy_name = name();
    prop.priority_level = priority_level();
    prop.action = StrategyAction::NO_ACTION;
    prop.is_excluded_from_v1 = true; // MANDATORY EXCLUSION FLAG
    prop.rejection_reason = "REJECT_MARKET_MAKING_EXCLUDED_FROM_V1";
    return prop;
}

StrategyTaxonomyEngine::StrategyTaxonomyEngine() {}

void StrategyTaxonomyEngine::register_strategy(std::shared_ptr<IStrategy> strategy) {
    if (strategy) strategies_.push_back(strategy);
}

std::vector<StrategyProposal> StrategyTaxonomyEngine::evaluate_all(const StrategyInput& input) {
    std::vector<StrategyProposal> proposals;
    proposals.reserve(strategies_.size());

    for (const auto& strat : strategies_) {
        StrategyProposal prop = strat->evaluate(input);
        proposals.push_back(prop);
    }

    return proposals;
}

std::string StrategyProposal::summary_json() const {
    std::ostringstream ss;
    ss << std::fixed << std::setprecision(2);
    ss << "{\"strategy\":\"" << strategy_name << "\",\"action\":" << static_cast<int>(action)
       << ",\"shadow_only\":" << (is_shadow_only ? "true" : "false")
       << ",\"gated\":" << (is_gated_pending_evidence ? "true" : "false")
       << ",\"excluded_v1\":" << (is_excluded_from_v1 ? "true" : "false")
       << ",\"reason\":\"" << rejection_reason << "\"}";
    return ss.str();
}

} // namespace hermes
