#include "gate20_shadow_scaffolding.hpp"
#include "gate0_bootstrap.hpp"

ShadowExecutionEngine::ShadowExecutionEngine() {}

bool ShadowExecutionEngine::submit_order(const ShadowOrderProposal& proposal, std::string& out_status) {
    ShadowOrderProposal logged_proposal = proposal;
    
    // Explicit hard guard: live order path disabled
#ifdef HERMES_COMPILE_TIME_PAPER_ONLY
    logged_proposal.is_paper_execution = true;
    logged_proposal.is_live_order_submitted = false;
    out_status = "PAPER_SIMULATED_SUCCESS: Live order submission disabled by HERMES_COMPILE_TIME_PAPER_ONLY guard";
    shadow_logs_.push_back(logged_proposal);
    return true;
#else
    logged_proposal.is_paper_execution = true;
    logged_proposal.is_live_order_submitted = false;
    out_status = "REJECT_LIVE_ORDER_BLOCKED: Gate 20 live order path remains locked until explicit human unlock";
    shadow_logs_.push_back(logged_proposal);
    return false;
#endif
}

bool ShadowExecutionEngine::is_live_execution_allowed() const {
    return false; // Strictly false in V1
}

std::vector<ShadowOrderProposal> ShadowExecutionEngine::get_shadow_execution_logs() const {
    return shadow_logs_;
}
