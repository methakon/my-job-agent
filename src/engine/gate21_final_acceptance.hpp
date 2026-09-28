#ifndef HERMES_GATE21_FINAL_ACCEPTANCE_HPP
#define HERMES_GATE21_FINAL_ACCEPTANCE_HPP

#include <string>
#include <vector>
#include <map>
#include <memory>
#include "../roadmap/db_client.hpp"

struct GateAcceptanceVerification {
    std::string gate_id;
    bool is_green{false};
    std::string evidence_ref;
    std::string notes;
};

struct Phase1ReleaseReport {
    bool gates_0_to_19_verified_green{false};
    bool oos_tested_rule_promoted{false};
    bool minimum_stable_paper_period_passed{false};
    int total_paper_sessions_run{0};
    int total_unhandled_risk_breaches{0};
    bool phase1_final_acceptance_unlocked{false};
    std::vector<GateAcceptanceVerification> gate_verifications;
};

class FinalAcceptanceValidator {
public:
    FinalAcceptanceValidator(std::shared_ptr<RoadmapDbClient> db_client);

    Phase1ReleaseReport evaluate_phase1_acceptance();

    bool verify_all_gates_green();
    bool verify_oos_rule_promotion();
    bool verify_paper_session_stability(int min_sessions);

private:
    std::shared_ptr<RoadmapDbClient> db_client_;
};

#endif // HERMES_GATE21_FINAL_ACCEPTANCE_HPP
