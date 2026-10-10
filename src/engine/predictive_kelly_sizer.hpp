#ifndef HERMES_PREDICTIVE_KELLY_SIZER_HPP
#define HERMES_PREDICTIVE_KELLY_SIZER_HPP

#include <string>
#include <vector>
#include <cmath>
#include <algorithm>
#include <sstream>
#include <iomanip>

namespace hermes {

struct PredictiveKellyInput {
    double capital_in_hand{100000.0};
    double raw_win_rate{0.60};              // Empirical win rate from past trades [0.0, 1.0]
    double payoff_ratio{1.0};               // Avg win / Avg loss ratio (b)
    double model_confidence{0.75};          // Bayesian predictive confidence score [0.0, 1.0]
    double avg_historical_confidence{0.75}; // Average confidence over past trades
    double kelly_fraction_multiplier{0.25}; // Fractional Kelly multiplier (Quarter-Kelly default)
    double vrp_spread{0.0};                 // Implied Volatility - Realized Volatility spread
    bool is_long_gamma_regime{true};        // True if market is long gamma (dampening)
    int recent_consecutive_losses{0};       // Drawdown streak dampener
    double max_loss_per_spread_unit{0.0};   // Defined maximum loss per single contract
    int lot_size{25};                       // Underlying lot size
};

struct PredictiveKellySizingResult {
    bool is_valid{false};
    double calibrated_win_probability{0.0};
    double shrinkage_factor_C{1.0};
    double raw_kelly_fraction{0.0};
    double quarter_kelly_fraction{0.0};
    double regime_volatility_multiplier{1.0};
    double dynamic_effective_fraction{0.0};
    
    // Software Bug Guard Tripwire (Not a business risk limit)
    bool bug_guard_tripped{false};
    double bug_guard_threshold{0.40};       // kelly_sizing_bug_guard_pct = 40%

    double allocated_risk_capital{0.0};     // INR risk allocated to this trade
    double risk_per_lot{0.0};               // Defined max loss per lot
    int suggested_lots{0};                  // Integer lots to trade
    int total_contracts{0};                 // suggested_lots * lot_size
    double total_margin_commitment{0.0};    // suggested_lots * risk_per_lot

    std::string sizing_rationale;
};

class PredictiveKellySizer {
public:
    // Software Bug Guard Tripwire: Never binds under normal operations or genuine market edges.
    // Exists purely to prevent division-by-near-zero or corrupted data inputs from sizing near total capital.
    static constexpr double KELLY_SIZING_BUG_GUARD_PCT = 0.40;

    /**
     * @brief Computes dynamic position sizing using Quarter-Kelly with Bayesian Platt calibration,
     *        regime/VRP volatility scaling, streak dampeners, and software bug guard protection.
     */
    static PredictiveKellySizingResult calculate_sizing(const PredictiveKellyInput& input);
};

} // namespace hermes

#endif // HERMES_PREDICTIVE_KELLY_SIZER_HPP
