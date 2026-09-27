#ifndef HERMES_GATE9_FILL_SIM_STRESS_HPP
#define HERMES_GATE9_FILL_SIM_STRESS_HPP

#include <string>
#include <vector>
#include <cstdint>

namespace hermes {

enum class OrderSide {
    BUY = 0,
    SELL
};

struct SimulatedFillResult {
    std::string order_id;
    std::string symbol;
    OrderSide side{OrderSide::BUY};
    double requested_qty{0.0};
    double filled_qty{0.0};
    double avg_fill_price{0.0};
    double slippage_points{0.0};
    uint64_t total_latency_ms{0};
    
    bool is_full_fill{true};
    bool ltp_fallback_used{false}; // MUST BE FALSE for realistic fills
    std::string calibration_source{"ARCHIVED_QUOTES_2026_Q3"};
    std::string summary_json() const;
};

struct CostStressTestResult {
    std::string experiment_id;
    std::string strategy_name;
    
    double baseline_net_pnl{0.0};
    double stressed_net_pnl{0.0};      // PnL under 2.0x slippage & 3.0x latency
    double stressed_sharpe_ratio{0.0};
    
    bool passed_stress_test{false};
    std::string rejection_reason;
    std::string summary_json() const;
};

class FillSimulationEngine {
public:
    explicit FillSimulationEngine(
        double base_latency_ms = 25.0,
        double base_slippage_pts = 0.50
    );

    // G9-01 & G9-02: Simulate order fill against bid/ask order book depth with latency
    SimulatedFillResult simulate_order_fill(
        const std::string& order_id,
        const std::string& symbol,
        OrderSide side,
        double requested_qty,
        double best_bid,
        double best_bid_qty,
        double best_ask,
        double best_ask_qty,
        double ltp
    );

    // G9-03: Execute cost & latency stress test on strategy backtest results
    CostStressTestResult run_cost_latency_stress_test(
        const std::string& experiment_id,
        const std::string& strategy_name,
        const std::vector<double>& trade_pnls,
        double trade_friction_pts = 2.0
    );

private:
    double base_latency_ms_;
    double base_slippage_pts_;
};

} // namespace hermes

#endif // HERMES_GATE9_FILL_SIM_STRESS_HPP
