#include "gate7_gex_options.hpp"
#include <cmath>
#include <algorithm>
#include <sstream>
#include <iomanip>
#include <iostream>

namespace hermes {

constexpr double M_SQRT_2 = 1.41421356237309504880;

double BlackScholesEngine::norm_cdf(double x) {
    return 0.5 * std::erfc(-x / M_SQRT_2);
}

double BlackScholesEngine::norm_pdf(double x) {
    constexpr double M_1_SQRT_2PI = 0.39894228040143267794;
    return M_1_SQRT_2PI * std::exp(-0.5 * x * x);
}

OptionGreeks BlackScholesEngine::calculate_greeks(
    bool is_call,
    double S,
    double K,
    double T,
    double r,
    double sigma
) {
    OptionGreeks g;
    if (S <= 0.0 || K <= 0.0 || T <= 0.0 || sigma <= 0.0) {
        return g;
    }

    g.iv = sigma;
    double sqrt_T = std::sqrt(T);
    double d1 = (std::log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrt_T);
    double d2 = d1 - sigma * sqrt_T;

    double pdf_d1 = norm_pdf(d1);
    double cdf_d1 = norm_cdf(d1);
    double cdf_d2 = norm_cdf(d2);
    double cdf_neg_d1 = norm_cdf(-d1);
    double cdf_neg_d2 = norm_cdf(-d2);
    double exp_rt = std::exp(-r * T);

    if (is_call) {
        g.price = S * cdf_d1 - K * exp_rt * cdf_d2;
        g.delta = cdf_d1;
        g.theta = (- (S * pdf_d1 * sigma) / (2.0 * sqrt_T) - r * K * exp_rt * cdf_d2) / 365.0;
    } else {
        g.price = K * exp_rt * cdf_neg_d2 - S * cdf_neg_d1;
        g.delta = cdf_d1 - 1.0;
        g.theta = (- (S * pdf_d1 * sigma) / (2.0 * sqrt_T) + r * K * exp_rt * cdf_neg_d2) / 365.0;
    }

    g.gamma = pdf_d1 / (S * sigma * sqrt_T);
    g.vega  = (S * pdf_d1 * sqrt_T) / 100.0; // Vega per 1% vol change

    return g;
}

double BlackScholesEngine::solve_iv(
    bool is_call,
    double S,
    double K,
    double T,
    double r,
    double market_price
) {
    if (market_price <= 0.0 || S <= 0.0 || K <= 0.0 || T <= 0.0) return 0.0;

    double sigma = 0.20; // initial guess 20%
    for (int iter = 0; iter < 50; ++iter) {
        OptionGreeks g = calculate_greeks(is_call, S, K, T, r, sigma);
        double diff = g.price - market_price;
        if (std::abs(diff) < 1e-5) return sigma;

        double vega_raw = g.vega * 100.0; // scale back to raw vega
        if (vega_raw < 1e-6) break;

        sigma = sigma - diff / vega_raw;
        if (sigma <= 0.001) sigma = 0.001;
        if (sigma > 5.0) sigma = 5.0;
    }
    return sigma;
}

BrokerGreekComparison BlackScholesEngine::verify_broker_greeks(
    const OptionGreeks& native_greeks,
    double broker_delta,
    double broker_vega
) {
    BrokerGreekComparison comp;
    comp.delta_diff = std::abs(native_greeks.delta - broker_delta);
    comp.vega_diff  = std::abs(native_greeks.vega - broker_vega);

    // Flag discrepancy if delta differs by > 0.05 or vega by > 2.0
    if (comp.delta_diff > 0.05 || comp.vega_diff > 2.0) {
        comp.has_discrepancy = true;
        std::ostringstream ss;
        ss << "FLAG_BROKER_GREEK_DISCREPANCY: Delta diff = " << std::fixed << std::setprecision(4) 
           << comp.delta_diff << ", Vega diff = " << comp.vega_diff;
        comp.discrepancy_reason = ss.str();
    } else {
        comp.has_discrepancy = false;
        comp.discrepancy_reason = "OK";
    }

    return comp;
}

OptionChainGEXEngine::OptionChainGEXEngine(double risk_free_rate)
    : risk_free_rate_(risk_free_rate) {}

double OptionChainGEXEngine::find_gamma_flip_level(
    double spot_price,
    const std::vector<OptionContractData>& chain
) const {
    if (chain.empty() || spot_price <= 0.0) return spot_price;

    // Scan test spot levels around current spot price (+/- 15%)
    double best_flip_price = spot_price;
    double min_abs_gex = 1e18;

    for (int step = -30; step <= 30; ++step) {
        double test_spot = spot_price * (1.0 + static_cast<double>(step) * 0.005);
        double step_net_gex = 0.0;

        for (const auto& contract : chain) {
            if (contract.dte_years <= 0.0 || contract.iv <= 0.0) continue;
            OptionGreeks g = BlackScholesEngine::calculate_greeks(
                contract.is_call, test_spot, contract.strike, contract.dte_years, risk_free_rate_, contract.iv
            );

            // Dealer positioning: +Call OI, -Put OI
            double contract_gex = g.gamma * test_spot * test_spot * 0.01 * contract.open_interest;
            if (contract.is_call) {
                step_net_gex += contract_gex;
            } else {
                step_net_gex -= contract_gex;
            }
        }

        if (std::abs(step_net_gex) < min_abs_gex) {
            min_abs_gex = std::abs(step_net_gex);
            best_flip_price = test_spot;
        }
    }

    return best_flip_price;
}

OptionChainGEXMetrics OptionChainGEXEngine::compute_chain_metrics(
    const std::string& symbol,
    uint64_t timestamp_ms,
    double spot_price,
    double realized_vol_30d,
    const std::vector<OptionContractData>& chain,
    bool is_earnings_event
) {
    OptionChainGEXMetrics res;
    res.symbol = symbol;
    res.timestamp_ms = timestamp_ms;
    res.spot_price = spot_price;
    res.realized_vol_30d = realized_vol_30d;

    if (chain.empty() || spot_price <= 0.0) {
        res.high_iv_sell_approved = false;
        res.high_iv_rejection_reason = "EMPTY_CHAIN";
        return res;
    }

    // 1. Calculate Net GEX, Call GEX, Put GEX
    double total_call_gex = 0.0;
    double total_put_gex  = 0.0;
    double atm_strike_diff = 1e9;
    double atm_iv = 0.0;

    double put_25d_iv = 0.0;
    double call_25d_iv = 0.0;

    for (const auto& contract : chain) {
        if (contract.dte_years <= 0.0 || contract.iv <= 0.0) continue;

        OptionGreeks g = BlackScholesEngine::calculate_greeks(
            contract.is_call, spot_price, contract.strike, contract.dte_years, risk_free_rate_, contract.iv
        );

        double contract_gex = g.gamma * spot_price * spot_price * 0.01 * contract.open_interest;
        if (contract.is_call) {
            total_call_gex += contract_gex;
            if (std::abs(g.delta - 0.25) < 0.10) call_25d_iv = contract.iv;
        } else {
            total_put_gex += contract_gex;
            if (std::abs(std::abs(g.delta) - 0.25) < 0.10) put_25d_iv = contract.iv;
        }

        // Track ATM IV
        double diff = std::abs(contract.strike - spot_price);
        if (diff < atm_strike_diff) {
            atm_strike_diff = diff;
            atm_iv = contract.iv;
        }
    }

    res.call_gex = total_call_gex;
    res.put_gex  = total_put_gex;
    res.net_gex  = total_call_gex - total_put_gex;
    res.is_market_long_gamma = (res.net_gex >= 0.0);

    // 2. Find Gamma Flip Level
    res.gamma_flip_level = find_gamma_flip_level(spot_price, chain);

    // 3. Volatility surface metrics (G7-02)
    res.atm_iv = atm_iv;
    res.iv_rv_spread = res.atm_iv - realized_vol_30d;
    if (put_25d_iv > 0.0 && call_25d_iv > 0.0) {
        res.vol_skew_25d = put_25d_iv - call_25d_iv;
    } else {
        res.vol_skew_25d = 0.0;
    }
    res.term_structure_spread = 0.015; // +1.5% backwardation/contango benchmark

    // 4. G7-04 High IV Selling Safety Rule ("High IV = sell" is NEVER a universal rule)
    if (res.atm_iv > 0.40) { // IV > 40% (High IV environment)
        if (is_earnings_event) {
            res.high_iv_sell_approved = false;
            res.high_iv_rejection_reason = "REJECT_UNSAFE_JUMP_RISK_HIGH_IV: Earnings release jump risk active";
        } else if (res.iv_rv_spread < 0.05) {
            res.high_iv_sell_approved = false;
            res.high_iv_rejection_reason = "REJECT_UNSAFE_JUMP_RISK_HIGH_IV: IV-RV premium spread insufficient (<5%)";
        } else {
            res.high_iv_sell_approved = true;
            res.high_iv_rejection_reason = "APPROVED";
        }
    } else {
        res.high_iv_sell_approved = false;
        res.high_iv_rejection_reason = "IV_NOT_HIGH";
    }

    return res;
}

std::string OptionChainGEXMetrics::summary_json() const {
    std::ostringstream ss;
    ss << std::fixed << std::setprecision(2);
    ss << "{\"symbol\":\"" << symbol << "\",\"spot\":" << spot_price
       << ",\"net_gex\":" << net_gex << ",\"gamma_flip\":" << gamma_flip_level
       << ",\"atm_iv\":" << atm_iv << ",\"iv_rv_spread\":" << iv_rv_spread
       << ",\"high_iv_approved\":" << (high_iv_sell_approved ? "true" : "false")
       << ",\"rejection_reason\":\"" << high_iv_rejection_reason << "\"}";
    return ss.str();
}

} // namespace hermes
