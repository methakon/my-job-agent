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

// Final-acceptance report. Every verdict here is derived from evidence the validator actually read.
// A check with no evidence source is reported as NOT verified (and listed in unverified_reasons);
// it is never assumed to pass. The previous implementation returned true from every check, wrote
// the same invented evidence string for each gate, and hardcoded "14 sessions, 0 breaches", so
// "acceptance passed" could not fail and therefore said nothing.
struct Phase1ReleaseReport {
    bool gates_0_to_19_verified_green{false};   // every project-checklist stage is fully done
    bool oos_tested_rule_promoted{false};       // no evidence source yet: false until one exists
    bool minimum_stable_paper_period_passed{false};
    int total_paper_sessions_run{0};            // distinct analysed sessions; 0 when unreadable
    bool paper_sessions_known{false};
    int total_unhandled_risk_breaches{-1};      // -1 = not measured (no breach record exists)
    bool risk_breaches_known{false};
    bool phase1_final_acceptance_unlocked{false};
    std::vector<GateAcceptanceVerification> gate_verifications;   // one per checklist stage read
    std::vector<std::string> unverified_reasons;                  // why acceptance is not unlocked
};

class FinalAcceptanceValidator {
public:
    FinalAcceptanceValidator(std::shared_ptr<RoadmapDbClient> db_client);

    Phase1ReleaseReport evaluate_phase1_acceptance();

    // Reads the project checklist; fills `stages` with one entry per stage. True only when at
    // least one stage exists and every stage is complete with nothing blocked.
    bool verify_all_gates_green(std::vector<GateAcceptanceVerification>* stages = nullptr,
                                std::string* why_not = nullptr);
    // No evidence source for out-of-sample promotion exists yet, so this is false by design.
    bool verify_oos_rule_promotion();
    bool verify_paper_session_stability(int min_sessions, int* sessions_found = nullptr, bool* known = nullptr);

private:
    std::shared_ptr<RoadmapDbClient> db_client_;
};

#endif // HERMES_GATE21_FINAL_ACCEPTANCE_HPP
