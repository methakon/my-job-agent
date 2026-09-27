#include "gate15_experiment_registry.hpp"
#include <sstream>
#include <iomanip>
#include <iostream>

namespace hermes {

ExperimentRegistryEngine::ExperimentRegistryEngine() {}

ExperimentRecord ExperimentRegistryEngine::pre_register_experiment(
    const std::string& experiment_id,
    const std::string& strategy_name,
    const std::string& hypothesis,
    uint64_t registered_time_ms
) {
    ExperimentRecord rec;
    rec.experiment_id = experiment_id;
    rec.strategy_name = strategy_name;
    rec.hypothesis_description = hypothesis;
    rec.registered_time_ms = registered_time_ms;
    rec.status = ExperimentStatus::PRE_REGISTERED;
    return rec;
}

ChampionChallengerResult ExperimentRegistryEngine::evaluate_champion_challenger(
    const ExperimentRecord& challenger_rec,
    double champion_sharpe,
    double champion_pnl,
    double challenger_sharpe,
    double challenger_pnl
) {
    ChampionChallengerResult res;
    res.challenger_id = challenger_rec.experiment_id;
    res.champion_id = challenger_rec.champion_id.empty() ? "CHAMPION-BASE-V1" : challenger_rec.champion_id;
    res.champion_sharpe = champion_sharpe;
    res.challenger_sharpe = challenger_sharpe;
    res.champion_pnl = champion_pnl;
    res.challenger_pnl = challenger_pnl;

    // Challenger MUST beat Champion by > 10% PnL AND have Sharpe >= 1.2
    double pnl_lift = (champion_pnl > 0.0) ? ((challenger_pnl - champion_pnl) / champion_pnl) : 1.0;

    if (challenger_sharpe >= challenger_rec.min_sharpe_threshold && pnl_lift >= challenger_rec.pnl_improvement_pct_threshold) {
        res.promotion_approved = true;
        res.promotion_reason = "APPROVED_PROMOTED_CHALLENGER_TO_NEW_CHAMPION";
    } else {
        res.promotion_approved = false;
        std::ostringstream ss;
        ss << "PROMOTION_BLOCKED_CHALLENGER_UNDERPERFORMS_CHAMPION: PnL lift = " 
           << std::fixed << std::setprecision(2) << (pnl_lift * 100.0)
           << "%, Challenger Sharpe = " << challenger_sharpe;
        res.promotion_reason = ss.str();
    }

    return res;
}

RollbackResult ExperimentRegistryEngine::evaluate_champion_rollback(
    const std::string& current_champion_id,
    const std::string& previous_stable_champion_id,
    double post_deploy_drawdown_pct,
    size_t consecutive_losing_sessions
) {
    RollbackResult res;
    res.failed_champion_id = current_champion_id;
    res.restored_champion_id = previous_stable_champion_id;
    res.current_drawdown_pct = post_deploy_drawdown_pct;

    // Rollback rule: Drawdown > 15% OR 3 consecutive losing sessions
    if (post_deploy_drawdown_pct >= 0.15 || consecutive_losing_sessions >= 3) {
        res.rollback_executed = true;
        std::ostringstream ss;
        ss << "ROLLBACK_EXECUTED_TO_PREVIOUS_STABLE_CHAMPION: Drawdown = " 
           << std::fixed << std::setprecision(2) << (post_deploy_drawdown_pct * 100.0)
           << "%, Consecutive Losing Sessions = " << consecutive_losing_sessions;
        res.rollback_reason = ss.str();
    } else {
        res.rollback_executed = false;
        res.rollback_reason = "CHAMPION_HEALTHY_NO_ROLLBACK_REQUIRED";
    }

    return res;
}

std::string ExperimentRecord::summary_json() const {
    std::ostringstream ss;
    ss << "{\"exp_id\":\"" << experiment_id << "\",\"strategy\":\"" << strategy_name
       << "\",\"status\":" << static_cast<int>(status)
       << ",\"hypothesis\":\"" << hypothesis_description << "\"}";
    return ss.str();
}

std::string ChampionChallengerResult::summary_json() const {
    std::ostringstream ss;
    ss << std::fixed << std::setprecision(2);
    ss << "{\"challenger\":\"" << challenger_id << "\",\"champion\":\"" << champion_id
       << "\",\"chall_sharpe\":" << challenger_sharpe
       << "\",\"approved\":" << (promotion_approved ? "true" : "false")
       << ",\"reason\":\"" << promotion_reason << "\"}";
    return ss.str();
}

std::string RollbackResult::summary_json() const {
    std::ostringstream ss;
    ss << std::fixed << std::setprecision(2);
    ss << "{\"failed\":\"" << failed_champion_id << "\",\"restored\":\"" << restored_champion_id
       << "\",\"drawdown_pct\":" << current_drawdown_pct * 100.0
       << ",\"rolled_back\":" << (rollback_executed ? "true" : "false")
       << ",\"reason\":\"" << rollback_reason << "\"}";
    return ss.str();
}

} // namespace hermes
