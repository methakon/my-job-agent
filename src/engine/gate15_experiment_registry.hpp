#ifndef HERMES_GATE15_EXPERIMENT_REGISTRY_HPP
#define HERMES_GATE15_EXPERIMENT_REGISTRY_HPP

#include <string>
#include <vector>
#include <cstdint>

namespace hermes {

enum class ExperimentStatus {
    PRE_REGISTERED = 0,
    ACTIVE_TESTING,
    PROMOTED_CHAMPION,
    REJECTED_CHALLENGER,
    ROLLED_BACK
};

struct ExperimentRecord {
    std::string experiment_id;
    std::string strategy_name;
    std::string hypothesis_description;
    uint64_t registered_time_ms{0};
    
    double min_sharpe_threshold{1.2};
    double pnl_improvement_pct_threshold{0.10}; // 10% lift over champion
    
    ExperimentStatus status{ExperimentStatus::PRE_REGISTERED};
    std::string champion_id;
    std::string summary_json() const;
};

struct ChampionChallengerResult {
    std::string challenger_id;
    std::string champion_id;
    
    double champion_sharpe{0.0};
    double challenger_sharpe{0.0};
    double champion_pnl{0.0};
    double challenger_pnl{0.0};
    
    bool promotion_approved{false};
    std::string promotion_reason;
    std::string summary_json() const;
};

struct RollbackResult {
    std::string failed_champion_id;
    std::string restored_champion_id;
    double current_drawdown_pct{0.0};
    bool rollback_executed{false};
    std::string rollback_reason;
    std::string summary_json() const;
};

class ExperimentRegistryEngine {
public:
    ExperimentRegistryEngine();

    // G15-01: Pre-register hypothesis and assumptions
    static ExperimentRecord pre_register_experiment(
        const std::string& experiment_id,
        const std::string& strategy_name,
        const std::string& hypothesis,
        uint64_t registered_time_ms
    );

    // G15-02: Champion vs Challenger promotion protocol
    static ChampionChallengerResult evaluate_champion_challenger(
        const ExperimentRecord& challenger_rec,
        double champion_sharpe,
        double champion_pnl,
        double challenger_sharpe,
        double challenger_pnl
    );

    // G15-03: Rollback engine for post-deployment performance decay
    static RollbackResult evaluate_champion_rollback(
        const std::string& current_champion_id,
        const std::string& previous_stable_champion_id,
        double post_deploy_drawdown_pct,
        size_t consecutive_losing_sessions
    );
};

} // namespace hermes

#endif // HERMES_GATE15_EXPERIMENT_REGISTRY_HPP
