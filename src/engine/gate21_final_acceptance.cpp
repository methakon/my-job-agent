#include "gate21_final_acceptance.hpp"
#include <iostream>

namespace {
constexpr int kMinimumStablePaperSessions = 14;
}

FinalAcceptanceValidator::FinalAcceptanceValidator(std::shared_ptr<RoadmapDbClient> db_client)
    : db_client_(db_client) {}

bool FinalAcceptanceValidator::verify_all_gates_green(std::vector<GateAcceptanceVerification>* stages,
                                                      std::string* why_not) {
    auto fail = [&](const std::string& why) {
        if (why_not) *why_not = why;
        return false;
    };
    if (!db_client_) return fail("NO_DB_CLIENT");

    const std::vector<HermesCppStage> rows = db_client_->fetch_hermes_cpp_stages();
    if (rows.empty()) {
        // An unreadable or empty checklist is the absence of evidence, which is not a pass.
        return fail("NO_CHECKLIST_STAGES_READABLE");
    }

    bool all_complete = true;
    std::string first_incomplete;
    for (const HermesCppStage& st : rows) {
        const bool complete = st.total_items > 0 && st.done_items == st.total_items && st.blocked_items == 0;
        if (!complete) {
            all_complete = false;
            if (first_incomplete.empty()) first_incomplete = st.stage_id;
        }
        if (stages) {
            GateAcceptanceVerification v;
            v.gate_id = st.stage_id;
            v.is_green = complete;
            v.evidence_ref = "hermes_cpp_stage_progress:" + st.stage_id;
            v.notes = std::to_string(st.done_items) + "/" + std::to_string(st.total_items) + " items done, " +
                      std::to_string(st.blocked_items) + " blocked";
            stages->push_back(v);
        }
    }
    if (!all_complete) return fail("STAGE_INCOMPLETE:" + first_incomplete);
    return true;
}

bool FinalAcceptanceValidator::verify_oos_rule_promotion() {
    // Nothing records an out-of-sample test or a rule promotion, so there is nothing to verify.
    // This stays false until a real record exists; returning true here would restore exactly the
    // unconditional acceptance this class used to give.
    return false;
}

bool FinalAcceptanceValidator::verify_paper_session_stability(int min_sessions, int* sessions_found, bool* known) {
    if (sessions_found) *sessions_found = 0;
    if (known) *known = false;
    if (!db_client_) return false;

    uint64_t count = 0;
    if (!db_client_->count_analysed_sessions(count)) return false;   // could not look: not a pass
    if (sessions_found) *sessions_found = static_cast<int>(count);
    if (known) *known = true;
    return min_sessions >= 0 && count >= static_cast<uint64_t>(min_sessions);
}

Phase1ReleaseReport FinalAcceptanceValidator::evaluate_phase1_acceptance() {
    Phase1ReleaseReport report;

    std::string gates_why;
    report.gates_0_to_19_verified_green = verify_all_gates_green(&report.gate_verifications, &gates_why);
    if (!report.gates_0_to_19_verified_green) {
        report.unverified_reasons.push_back("GATES_NOT_GREEN:" + gates_why);
    }

    report.oos_tested_rule_promoted = verify_oos_rule_promotion();
    if (!report.oos_tested_rule_promoted) {
        report.unverified_reasons.push_back("OOS_RULE_PROMOTION_NOT_EVIDENCED");
    }

    int sessions = 0;
    bool known = false;
    report.minimum_stable_paper_period_passed =
        verify_paper_session_stability(kMinimumStablePaperSessions, &sessions, &known);
    report.total_paper_sessions_run = sessions;
    report.paper_sessions_known = known;
    if (!report.minimum_stable_paper_period_passed) {
        report.unverified_reasons.push_back(known
            ? "PAPER_SESSIONS_BELOW_MINIMUM:" + std::to_string(sessions) + "<" + std::to_string(kMinimumStablePaperSessions)
            : std::string("PAPER_SESSION_COUNT_UNREADABLE"));
    }

    // No record of risk breaches exists to count, so the figure is "not measured", not zero.
    report.total_unhandled_risk_breaches = -1;
    report.risk_breaches_known = false;
    report.unverified_reasons.push_back("RISK_BREACH_COUNT_NOT_MEASURED");

    report.phase1_final_acceptance_unlocked =
        report.gates_0_to_19_verified_green &&
        report.oos_tested_rule_promoted &&
        report.minimum_stable_paper_period_passed &&
        report.risk_breaches_known &&
        report.total_unhandled_risk_breaches == 0;

    if (!report.phase1_final_acceptance_unlocked) {
        std::cerr << "⛔ [Gate21] Phase-1 acceptance NOT unlocked:";
        for (const std::string& r : report.unverified_reasons) std::cerr << " " << r;
        std::cerr << "\n";
    }
    return report;
}
