#ifndef HERMES_GATE19_OBSERVABILITY_HPP
#define HERMES_GATE19_OBSERVABILITY_HPP

#include <string>
#include <map>
#include <memory>
#include "../roadmap/db_client.hpp"

struct SystemObservabilityState {
    double data_freshness_sec{0.1};
    std::string active_broker_feed{"UPSTOX"};
    double feed_quality_score{99.5};
    double total_capital{10000.0};
    double max_capital_ceiling{10000.0};
    double deployed_capital{0.0};
    double available_margin{10000.0};
    double session_net_pnl{0.0};
    int total_candidates_evaluated{0};
    int total_trade_proposals{0};
    int total_risk_vetoes{0};
    std::string current_regime{"TRENDING_BULL"};
    std::string execution_mode{"PAPER_TRADING_ENGINE"};
    bool live_orders_blocked{true};
};

class SystemObservabilityEngine {
public:
    SystemObservabilityEngine(std::shared_ptr<RoadmapDbClient> db_client);

    SystemObservabilityState get_current_state() const;
    void update_state(const SystemObservabilityState& state);

    // Returns full JSON telemetry string matching live DB & journal metrics
    std::string export_telemetry_json() const;

private:
    std::shared_ptr<RoadmapDbClient> db_client_;
    SystemObservabilityState current_state_;
};

#endif // HERMES_GATE19_OBSERVABILITY_HPP
