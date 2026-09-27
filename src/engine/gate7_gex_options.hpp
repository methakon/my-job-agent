#ifndef HERMES_GATE7_GEX_OPTIONS_HPP
#define HERMES_GATE7_GEX_OPTIONS_HPP

#include <string>
#include <vector>
#include <cstdint>
#include <cmath>

namespace hermes {

struct OptionGreeks {
    double price{0.0};
    double iv{0.0};
    double delta{0.0};
    double gamma{0.0};
    double vega{0.0};
    double theta{0.0};
};

struct BrokerGreekComparison {
    bool has_discrepancy{false};
    double delta_diff{0.0};
    double vega_diff{0.0};
    std::string discrepancy_reason;
};

struct GEXAssumptionRecord {
    std::string dealer_positioning_assumption{"DEALERS_LONG_CALLS_SHORT_PUTS"};
    double risk_free_rate{0.065}; // 6.5% RBI repo benchmark
    std::string vol_smoothing_method{"CUBIC_SPLINE_ATM_PINNED"};
    double confidence_score{0.85}; // [0.0, 1.0]
};

struct OptionChainGEXMetrics {
    std::string symbol;
    uint64_t timestamp_ms{0};
    
    double spot_price{0.0};
    double net_gex{0.0};            // Total Gamma Exposure in INR
    double call_gex{0.0};
    double put_gex{0.0};
    double gamma_flip_level{0.0};   // Price level where Net GEX crosses 0
    bool is_market_long_gamma{true};// Net GEX > 0 => Market Maker volatility dampening
    
    // G7-02 Volatility surface metrics
    double atm_iv{0.0};
    double realized_vol_30d{0.0};
    double iv_rv_spread{0.0};       // ATM IV - RV
    double vol_skew_25d{0.0};       // 25D Put IV - 25D Call IV
    double term_structure_spread{0.0}; // Next Expiry IV - Current Expiry IV
    
    // G7-03 Explicit assumptions
    GEXAssumptionRecord assumption_record;
    
    // G7-04 High IV selling safety check result
    bool high_iv_sell_approved{false};
    std::string high_iv_rejection_reason;
    
    std::string summary_json() const;
};

class BlackScholesEngine {
public:
    // Standard normal CDF N(x)
    static double norm_cdf(double x);
    
    // Standard normal PDF N'(x)
    static double norm_pdf(double x);

    // Compute analytical Black-Scholes price & Greeks
    static OptionGreeks calculate_greeks(
        bool is_call,
        double S,
        double K,
        double T,
        double r,
        double sigma
    );

    // Implied volatility solver using Newton-Raphson
    static double solve_iv(
        bool is_call,
        double S,
        double K,
        double T,
        double r,
        double market_price
    );

    // G7-01: Compare native computed Greeks against broker Greeks
    static BrokerGreekComparison verify_broker_greeks(
        const OptionGreeks& native_greeks,
        double broker_delta,
        double broker_vega
    );
};

struct OptionContractData {
    double strike{0.0};
    bool is_call{true};
    double price{0.0};
    double open_interest{0.0};
    double iv{0.0};
    double dte_years{0.0};
};

class OptionChainGEXEngine {
public:
    explicit OptionChainGEXEngine(double risk_free_rate = 0.065);

    // Compute full chain GEX, Gamma Flip, and Vol Surface
    OptionChainGEXMetrics compute_chain_metrics(
        const std::string& symbol,
        uint64_t timestamp_ms,
        double spot_price,
        double realized_vol_30d,
        const std::vector<OptionContractData>& chain,
        bool is_earnings_event = false
    );

private:
    double risk_free_rate_;
    
    double find_gamma_flip_level(
        double spot_price,
        const std::vector<OptionContractData>& chain
    ) const;
};

} // namespace hermes

#endif // HERMES_GATE7_GEX_OPTIONS_HPP
