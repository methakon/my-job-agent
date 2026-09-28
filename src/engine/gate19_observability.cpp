#include "gate19_observability.hpp"
#include <sstream>

SystemObservabilityEngine::SystemObservabilityEngine(std::shared_ptr<RoadmapDbClient> db_client)
    : db_client_(db_client) {
    current_state_ = {};
}

SystemObservabilityState SystemObservabilityEngine::get_current_state() const {
    return current_state_;
}

void SystemObservabilityEngine::update_state(const SystemObservabilityState& state) {
    current_state_ = state;
}

std::string SystemObservabilityEngine::export_telemetry_json() const {
    std::ostringstream ss;
    ss << "{\n"
       << "  \"status\": \"OK\",\n"
       << "  \"execution_mode\": \"" << current_state_.execution_mode << "\",\n"
       << "  \"live_orders_blocked\": " << (current_state_.live_orders_blocked ? "true" : "false") << ",\n"
       << "  \"data_health\": {\n"
       << "    \"active_feed\": \"" << current_state_.active_broker_feed << "\",\n"
       << "    \"freshness_sec\": " << current_state_.data_freshness_sec << ",\n"
       << "    \"quality_score\": " << current_state_.feed_quality_score << "\n"
       << "  },\n"
       << "  \"portfolio_capital_and_margins\": {\n"
       << "    \"total_capital\": " << current_state_.total_capital << ",\n"
       << "    \"capital_ceiling\": " << current_state_.max_capital_ceiling << ",\n"
       << "    \"deployed_capital\": " << current_state_.deployed_capital << ",\n"
       << "    \"available_margin\": " << current_state_.available_margin << ",\n"
       << "    \"session_net_pnl\": " << current_state_.session_net_pnl << "\n"
       << "  },\n"
       << "  \"decision_metrics\": {\n"
       << "    \"regime\": \"" << current_state_.current_regime << "\",\n"
       << "    \"candidates_evaluated\": " << current_state_.total_candidates_evaluated << ",\n"
       << "    \"trade_proposals\": " << current_state_.total_trade_proposals << ",\n"
       << "    \"risk_vetoes\": " << current_state_.total_risk_vetoes << "\n"
       << "  }\n"
       << "}";
    return ss.str();
}
