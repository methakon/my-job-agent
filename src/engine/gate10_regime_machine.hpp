#ifndef HERMES_GATE10_REGIME_MACHINE_HPP
#define HERMES_GATE10_REGIME_MACHINE_HPP

#include <string>
#include <vector>
#include <unordered_map>
#include <cstdint>

namespace hermes {

enum class MarketRegime {
    CHOPPY_HIGH_NOISE = 0,
    VOLATILE_BREAKOUT,
    MEAN_REVERTING_RANGE,
    TRENDING_BULL,
    TRENDING_BEAR
};

struct RegimeClassificationResult {
    MarketRegime regime{MarketRegime::CHOPPY_HIGH_NOISE};
    std::string regime_name{"CHOPPY_HIGH_NOISE"};
    double confidence{0.0}; // [0.0, 1.0]
    double atr_ratio{0.0};
    double vwap_slope{0.0};
    double ofi_score{0.0};
    std::string summary_json() const;
};

struct RegimeSkillPerformance {
    MarketRegime regime{MarketRegime::CHOPPY_HIGH_NOISE};
    std::string regime_name{"CHOPPY_HIGH_NOISE"};
    size_t trade_count{0};
    size_t win_count{0};
    double win_rate{0.0};
    double total_pnl{0.0};
    double profit_factor{0.0};
    double max_drawdown_pts{0.0};
};

struct RegimeVetoResult {
    bool veto_active{false};
    bool shadow_mode{true}; // True if sample size < 30 (prevents false veto)
    std::string veto_reason;
    std::string summary_json() const;
};

class RegimeStateMachine {
public:
    explicit RegimeStateMachine(size_t min_samples_for_hard_veto = 30);

    // G10-01: Deterministic regime classification
    RegimeClassificationResult classify_regime(
        double atr_current,
        double atr_14_avg,
        double vwap_slope_5m,
        double ofi_l1,
        double relative_volume
    );

    // G10-02: Record trade outcome for per-regime skill measurement
    void record_trade_outcome(MarketRegime regime, double pnl_points);

    // G10-02: Retrieve per-regime performance report
    RegimeSkillPerformance get_regime_performance(MarketRegime regime) const;

    // G10-03: Evaluate regime veto gate with stability / false-veto protection
    RegimeVetoResult evaluate_regime_veto(MarketRegime regime) const;

    // Reset machine state
    void reset();

private:
    size_t min_samples_for_hard_veto_;
    std::unordered_map<int, std::vector<double>> regime_trade_history_;
};

} // namespace hermes

#endif // HERMES_GATE10_REGIME_MACHINE_HPP
