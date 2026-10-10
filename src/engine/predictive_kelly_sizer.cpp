#include "predictive_kelly_sizer.hpp"
#include <iostream>

namespace hermes {

PredictiveKellySizingResult PredictiveKellySizer::calculate_sizing(const PredictiveKellyInput& input) {
    PredictiveKellySizingResult res;
    res.bug_guard_threshold = KELLY_SIZING_BUG_GUARD_PCT;

    if (input.capital_in_hand <= 0.0 || input.lot_size <= 0 || input.max_loss_per_spread_unit <= 0.0) {
        res.is_valid = false;
        res.sizing_rationale = "INVALID_INPUT: capital_in_hand, lot_size, or max_loss <= 0";
        return res;
    }

    // 1. Bayesian Platt & Shrinkage Calibration Factor C = empirical_win_rate / avg_confidence
    double c_factor = 1.0;
    if (input.avg_historical_confidence > 0.0 && input.raw_win_rate > 0.0) {
        c_factor = std::clamp(input.raw_win_rate / input.avg_historical_confidence, 0.50, 1.25);
    }
    res.shrinkage_factor_C = c_factor;

    // Calibrated probability p
    double p = std::clamp(input.model_confidence * c_factor, 0.05, 0.95);
    res.calibrated_win_probability = p;

    // 2. Payoff ratio b = avg win / avg loss (clamped to prevent mathematical instability)
    double b = std::clamp(input.payoff_ratio, 0.20, 5.0);

    // 3. Full Kelly Criterion: f* = (p * b - (1 - p)) / b
    double raw_f = (p * b - (1.0 - p)) / b;
    res.raw_kelly_fraction = raw_f;

    if (raw_f <= 0.0) {
        res.is_valid = true;
        res.quarter_kelly_fraction = 0.0;
        res.dynamic_effective_fraction = 0.0;
        res.suggested_lots = 0;
        res.sizing_rationale = "NEGATIVE_OR_ZERO_EDGE: Raw Kelly f* <= 0 (p=" + std::to_string(p) + ", b=" + std::to_string(b) + ")";
        return res;
    }

    // 4. Fractional Kelly Base Fraction (Quarter-Kelly default 0.25 * f*)
    double frac_mult = (input.kelly_fraction_multiplier > 0.0) ? input.kelly_fraction_multiplier : 0.25;
    double base_kelly = frac_mult * raw_f;
    res.quarter_kelly_fraction = base_kelly;

    // 5. Dynamic Volatility & Market Regime Multiplier
    double reg_mult = 1.0;

    // A. Volatility Risk Premium (VRP = IV - RV)
    if (input.vrp_spread >= 2.0) {
        reg_mult *= 1.10; // Favorable rich option premium for credit spreads
    } else if (input.vrp_spread <= -1.0) {
        reg_mult *= 0.75; // Cheap implied volatility / heightened jump risk
    }

    // B. Dealer Net Gamma Exposure Regime
    if (input.is_long_gamma_regime) {
        reg_mult *= 1.05; // Dealers long gamma => mean-reversion & dampening volatility
    } else {
        reg_mult *= 0.80; // Dealers short gamma => trending volatility acceleration
    }

    // C. Anti-Martingale Drawdown Streak Dampener
    if (input.recent_consecutive_losses > 0) {
        double streak_decay = std::pow(0.85, std::min(input.recent_consecutive_losses, 4));
        reg_mult *= streak_decay;
    }
    res.regime_volatility_multiplier = reg_mult;

    // Dynamic unconstrained sizing fraction
    double dynamic_frac = base_kelly * reg_mult;

    // 6. Software Bug Guard Tripwire (Not a business risk limit)
    // Ensures a software bug or corrupted data input cannot allocate near total capital
    if (dynamic_frac > KELLY_SIZING_BUG_GUARD_PCT) {
        res.bug_guard_tripped = true;
        dynamic_frac = KELLY_SIZING_BUG_GUARD_PCT;
        std::cerr << "⚠️ [PredictiveKellySizer] Software bug guard tripped: Dynamic fraction ("
                  << (dynamic_frac * 100.0) << "%) capped at tripwire threshold ("
                  << (KELLY_SIZING_BUG_GUARD_PCT * 100.0) << "%)\n";
    }
    res.dynamic_effective_fraction = dynamic_frac;

    // 7. Sizing to Discrete Option Lots
    double alloc_risk_capital = dynamic_frac * input.capital_in_hand;
    double risk_per_lot = input.max_loss_per_spread_unit * input.lot_size;

    res.allocated_risk_capital = alloc_risk_capital;
    res.risk_per_lot = risk_per_lot;

    if (risk_per_lot > 0.0) {
        res.suggested_lots = static_cast<int>(alloc_risk_capital / risk_per_lot);
    } else {
        res.suggested_lots = 0;
    }

    res.total_contracts = res.suggested_lots * input.lot_size;
    res.total_margin_commitment = res.suggested_lots * risk_per_lot;
    res.is_valid = true;

    std::ostringstream ss;
    ss << "DYNAMIC_KELLY_SIZED: lots=" << res.suggested_lots
       << ", frac=" << std::fixed << std::setprecision(4) << res.dynamic_effective_fraction
       << ", p=" << p << ", b=" << b
       << ", reg_mult=" << reg_mult
       << (res.bug_guard_tripped ? " [BUG_GUARD_TRIPPED]" : "");
    res.sizing_rationale = ss.str();

    return res;
}

} // namespace hermes
