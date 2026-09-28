#ifndef HERMES_GATE20_SHADOW_SCAFFOLDING_HPP
#define HERMES_GATE20_SHADOW_SCAFFOLDING_HPP

#include <string>
#include <vector>
#include <cstdint>

struct ShadowOrderProposal {
    std::string order_id;
    std::string symbol;
    std::string side; // BUY/SELL
    int quantity;
    double limit_price;
    uint64_t timestamp_ms;
    std::string strategy_id;
    bool is_paper_execution{true};
    bool is_live_order_submitted{false};
};

class ShadowExecutionEngine {
public:
    ShadowExecutionEngine();

    // Enforces compile-time and runtime guard blocking live order submission
    bool submit_order(const ShadowOrderProposal& proposal, std::string& out_status);

    bool is_live_execution_allowed() const;
    std::vector<ShadowOrderProposal> get_shadow_execution_logs() const;

private:
    std::vector<ShadowOrderProposal> shadow_logs_;
};

#endif // HERMES_GATE20_SHADOW_SCAFFOLDING_HPP
