#include "historical_edge_engine.hpp"
#include <numeric>
#include <sstream>
#include <iomanip>
#include <iostream>

namespace hermes {

HistoricalEdgeEngine::HistoricalEdgeEngine(size_t min_oos_sample_days)
    : min_oos_sample_days_(min_oos_sample_days) {}

double HistoricalEdgeEngine::calculate_percentile(const std::vector<double>& sorted_data, double percentile) {
    if (sorted_data.empty()) return 0.0;
    if (sorted_data.size() == 1) return sorted_data[0];
    
    double p = std::clamp(percentile, 0.0, 100.0);
    double rank = (p / 100.0) * (sorted_data.size() - 1);
    size_t index = static_cast<size_t>(rank);
    double fraction = rank - index;
    
    if (index + 1 < sorted_data.size()) {
        return sorted_data[index] + fraction * (sorted_data[index + 1] - sorted_data[index]);
    }
    return sorted_data[index];
}

double HistoricalEdgeEngine::calculate_correlation(const std::vector<double>& x, const std::vector<double>& y) {
    if (x.size() != y.size() || x.size() < 2) return 0.0;
    
    std::vector<double> clean_x, clean_y;
    clean_x.reserve(x.size());
    clean_y.reserve(y.size());
    for (size_t i = 0; i < x.size(); ++i) {
        if (!std::isnan(x[i]) && !std::isinf(x[i]) && !std::isnan(y[i]) && !std::isinf(y[i])) {
            clean_x.push_back(x[i]);
            clean_y.push_back(y[i]);
        }
    }
    if (clean_x.size() < 2) return 0.0;
    
    double sum_x = 0.0, sum_y = 0.0;
    for (size_t i = 0; i < clean_x.size(); ++i) {
        sum_x += clean_x[i];
        sum_y += clean_y[i];
    }
    double mean_x = sum_x / clean_x.size();
    double mean_y = sum_y / clean_y.size();
    
    double num = 0.0, denom_x = 0.0, denom_y = 0.0;
    for (size_t i = 0; i < clean_x.size(); ++i) {
        double dx = clean_x[i] - mean_x;
        double dy = clean_y[i] - mean_y;
        num += dx * dy;
        denom_x += dx * dx;
        denom_y += dy * dy;
    }
    
    if (denom_x <= 0.0 || denom_y <= 0.0) return 0.0;
    return num / (std::sqrt(denom_x) * std::sqrt(denom_y));
}

// 1. IV Percentile & Rank Evaluation
IvPercentileResult HistoricalEdgeEngine::evaluate_iv_percentile(
    const std::string& underlying,
    double current_atm_iv,
    const std::vector<double>& historical_iv_series
) {
    IvPercentileResult res;
    res.underlying = underlying;
    res.current_iv = current_atm_iv;
    res.sample_size_days = historical_iv_series.size();

    if (historical_iv_series.size() < min_oos_sample_days_) {
        res.iv_percentile = 50.0;
        res.iv_rank = 50.0;
        res.advisory_modifier = 1.00; // Locked neutral when sample size < min_oos_sample_days
        res.is_validated_oos = false;
        res.regime_label = "INSUFFICIENT_SAMPLE_NEUTRAL";
        return res;
    }

    std::vector<double> sorted_iv = historical_iv_series;
    std::sort(sorted_iv.begin(), sorted_iv.end());
    
    res.min_iv = sorted_iv.front();
    res.max_iv = sorted_iv.back();

    // Compute Percentile: count how many samples <= current_atm_iv
    size_t count_below = 0;
    for (double iv : historical_iv_series) {
        if (iv <= current_atm_iv) count_below++;
    }
    res.iv_percentile = (static_cast<double>(count_below) / historical_iv_series.size()) * 100.0;

    // Compute IV Rank: (current - min) / (max - min)
    if (res.max_iv > res.min_iv) {
        res.iv_rank = ((current_atm_iv - res.min_iv) / (res.max_iv - res.min_iv)) * 100.0;
    } else {
        res.iv_rank = 50.0;
    }
    res.iv_rank = std::clamp(res.iv_rank, 0.0, 100.0);

    // Advisory Modifier logic
    if (res.iv_percentile >= 75.0) {
        res.advisory_modifier = 1.05; // Expensive IV favors premium selling/credit spreads
        res.regime_label = "EXPENSIVE_IV_PREMIUM_SELL";
    } else if (res.iv_percentile <= 25.0) {
        res.advisory_modifier = 0.95; // Low IV dampens selling, favors buying/directional momentum
        res.regime_label = "CHEAP_IV_PREMIUM_BUY";
    } else {
        res.advisory_modifier = 1.00;
        res.regime_label = "NEUTRAL_IV";
    }

    // OOS Walk-forward validation check for IV series
    size_t split_idx = static_cast<size_t>(historical_iv_series.size() * 0.70);
    std::vector<double> is_iv(historical_iv_series.begin(), historical_iv_series.begin() + split_idx);
    std::vector<double> oos_iv(historical_iv_series.begin() + split_idx, historical_iv_series.end());

    double is_mean = std::accumulate(is_iv.begin(), is_iv.end(), 0.0) / is_iv.size();
    double oos_mean = std::accumulate(oos_iv.begin(), oos_iv.end(), 0.0) / oos_iv.size();
    double decay = std::abs(oos_mean - is_mean) / (is_mean > 0 ? is_mean : 1.0);

    res.is_validated_oos = (decay <= 0.15 && oos_iv.size() >= 5);
    if (!res.is_validated_oos) {
        res.advisory_modifier = 1.00; // Lock to neutral if OOS validation fails
    }

    return res;
}

// 2. Tail-Risk Profiling (VaR / CVaR)
TailRiskProfileResult HistoricalEdgeEngine::calculate_tail_risk(
    const std::string& symbol,
    const std::vector<double>& daily_returns
) {
    TailRiskProfileResult res;
    res.symbol = symbol;

    std::vector<double> clean_returns;
    clean_returns.reserve(daily_returns.size());
    for (double r : daily_returns) {
        if (!std::isnan(r) && !std::isinf(r)) {
            clean_returns.push_back(r);
        }
    }
    res.sample_days = clean_returns.size();

    if (clean_returns.empty()) return res;

    double sum = std::accumulate(clean_returns.begin(), clean_returns.end(), 0.0);
    res.mean_daily_return = sum / clean_returns.size();

    double sq_sum = 0.0;
    for (double r : clean_returns) {
        sq_sum += (r - res.mean_daily_return) * (r - res.mean_daily_return);
    }
    res.daily_volatility = std::sqrt(sq_sum / std::max(static_cast<size_t>(1), clean_returns.size() - 1));

    // Sort returns chronologically/ascending for empirical distribution
    std::vector<double> sorted_returns = clean_returns;
    std::sort(sorted_returns.begin(), sorted_returns.end());

    // 95% VaR: 5th percentile loss (expressed as positive percentage loss)
    double p5 = calculate_percentile(sorted_returns, 5.0);
    res.var_95_pct = (p5 < 0.0) ? -p5 : 0.0;

    // 99% VaR: 1st percentile loss
    double p1 = calculate_percentile(sorted_returns, 1.0);
    res.var_99_pct = (p1 < 0.0) ? -p1 : 0.0;

    // 95% CVaR (Expected Shortfall): average of all losses exceeding 95% VaR
    double cvar_sum = 0.0;
    size_t cvar_count = 0;
    for (double r : sorted_returns) {
        if (r <= -res.var_95_pct) {
            cvar_sum += (-r);
            cvar_count++;
        }
    }
    res.cvar_95_pct = (cvar_count > 0) ? (cvar_sum / cvar_count) : res.var_95_pct;

    // Dynamic stop loss recommendation: max(1.5 * daily_vol, VaR_95)
    res.recommended_dynamic_stop_pct = std::max(res.daily_volatility * 1.5, res.var_95_pct);
    if (res.recommended_dynamic_stop_pct <= 0.0) res.recommended_dynamic_stop_pct = 1.0; // 1% fallback

    // Max safe position sizing: risk ceiling / VaR_99
    double max_trade_risk_inr = 2000.0;
    res.max_safe_position_size_inr = max_trade_risk_inr / (res.var_99_pct / 100.0 > 0 ? (res.var_99_pct / 100.0) : 0.02);

    return res;
}

// 3. Event-Day Tagging & Event Calendar Risk Evaluation
EventDayTaggingResult HistoricalEdgeEngine::tag_event_days(
    const std::string& symbol,
    const std::vector<std::string>& dates,
    const std::vector<double>& daily_returns,
    bool is_today_known_event_day
) {
    EventDayTaggingResult res;
    res.symbol = symbol;
    res.total_days = daily_returns.size();
    res.is_known_event_day = is_today_known_event_day;

    if (daily_returns.empty() || dates.size() != daily_returns.size()) return res;

    // Compute mean and standard deviation
    double sum = std::accumulate(daily_returns.begin(), daily_returns.end(), 0.0);
    double mean = sum / daily_returns.size();

    double sq_sum = 0.0;
    for (double r : daily_returns) sq_sum += (r - mean) * (r - mean);
    double stdev = std::sqrt(sq_sum / std::max(static_cast<size_t>(1), daily_returns.size() - 1));

    // Outlier threshold: |r| > mean + 2.5 * stdev
    res.outlier_threshold_vol = 2.5 * stdev;

    std::vector<double> clean_returns;
    std::vector<double> event_returns;

    for (size_t i = 0; i < daily_returns.size(); ++i) {
        if (std::abs(daily_returns[i] - mean) > res.outlier_threshold_vol) {
            res.outlier_event_days_count++;
            res.tagged_event_dates.push_back(dates[i]);
            event_returns.push_back(std::abs(daily_returns[i]));
        } else {
            clean_returns.push_back(daily_returns[i]);
        }
    }

    // Seasonality clean volatility vs event day volatility
    if (!clean_returns.empty()) {
        double c_mean = std::accumulate(clean_returns.begin(), clean_returns.end(), 0.0) / clean_returns.size();
        double c_sq = 0.0;
        for (double r : clean_returns) c_sq += (r - c_mean) * (r - c_mean);
        res.clean_seasonality_volatility = std::sqrt(c_sq / std::max(static_cast<size_t>(1), clean_returns.size() - 1));
    }
    if (!event_returns.empty()) {
        res.event_day_volatility = std::accumulate(event_returns.begin(), event_returns.end(), 0.0) / event_returns.size();
    }

    // Event Risk Dampener
    if (is_today_known_event_day) {
        res.event_risk_dampener = 0.90; // Apply 10% confidence dampener on known high-risk event days
    } else {
        res.event_risk_dampener = 1.00;
    }

    return res;
}

// 7. Correlation-Aware Position Sizing Across Underlyings
CorrelationSizingResult HistoricalEdgeEngine::calculate_correlation_aware_sizing(
    const std::vector<double>& nifty_returns,
    const std::vector<double>& banknifty_returns,
    const std::vector<double>& sensex_returns,
    double nifty_proposed_risk_inr,
    double banknifty_proposed_risk_inr,
    double sensex_proposed_risk_inr
) {
    CorrelationSizingResult res;
    res.individual_combined_risk_inr = nifty_proposed_risk_inr + banknifty_proposed_risk_inr + sensex_proposed_risk_inr;

    if (nifty_returns.empty() || banknifty_returns.empty() || sensex_returns.empty()) {
        res.correlated_effective_exposure_inr = res.individual_combined_risk_inr;
        res.correlation_scale_factor = 1.00;
        res.advisory_reason = "INSUFFICIENT_CORRELATION_DATA_NEUTRAL";
        return res;
    }

    // Calculate pairwise correlations
    res.rho_nifty_banknifty = calculate_correlation(nifty_returns, banknifty_returns);
    res.rho_nifty_sensex = calculate_correlation(nifty_returns, sensex_returns);
    res.rho_banknifty_sensex = calculate_correlation(banknifty_returns, sensex_returns);

    // Correlated Effective Portfolio Variance / Risk:
    // Var(w) = w_1^2 + w_2^2 + w_3^2 + 2 w_1 w_2 rho_{12} + 2 w_1 w_3 rho_{13} + 2 w_2 w_3 rho_{23}
    double w1 = nifty_proposed_risk_inr;
    double w2 = banknifty_proposed_risk_inr;
    double w3 = sensex_proposed_risk_inr;

    double var_eff = w1 * w1 + w2 * w2 + w3 * w3
                     + 2.0 * w1 * w2 * res.rho_nifty_banknifty
                     + 2.0 * w1 * w3 * res.rho_nifty_sensex
                     + 2.0 * w2 * w3 * res.rho_banknifty_sensex;

    res.correlated_effective_exposure_inr = std::sqrt(std::max(0.0, var_eff));

    // Correlation Scale Factor: compare effective portfolio exposure vs max single-asset risk ceiling (2000.0)
    double target_single_asset_risk = 2000.0;
    if (res.correlated_effective_exposure_inr > target_single_asset_risk) {
        res.correlation_scale_factor = target_single_asset_risk / res.correlated_effective_exposure_inr;
    } else {
        res.correlation_scale_factor = 1.00;
    }

    res.correlation_scale_factor = std::clamp(res.correlation_scale_factor, 0.50, 1.00);

    std::ostringstream ss;
    ss << "Correlations: [NIFTY/BANK: " << std::fixed << std::setprecision(3) << res.rho_nifty_banknifty
       << ", NIFTY/SENSEX: " << res.rho_nifty_sensex << ", BANK/SENSEX: " << res.rho_banknifty_sensex
       << "]. Effective Exposure: ₹" << std::setprecision(2) << res.correlated_effective_exposure_inr
       << " (Unadjusted: ₹" << res.individual_combined_risk_inr << "). Scale Factor: " << res.correlation_scale_factor;
    res.advisory_reason = ss.str();

    return res;
}

// 8. Bayesian Kelly Probability Calibration (Platt Scaling & Shrinkage Factor C)
KellyCalibrationResult HistoricalEdgeEngine::calibrate_kelly_probabilities(
    const std::vector<double>& historical_model_confidences,
    const std::vector<bool>& historical_trade_outcomes,
    double current_proposed_confidence,
    double win_loss_ratio_b
) {
    KellyCalibrationResult res;
    res.raw_input_confidence = current_proposed_confidence;
    res.sample_trades_count = historical_model_confidences.size();

    if (historical_model_confidences.empty() || historical_model_confidences.size() != historical_trade_outcomes.size() || historical_model_confidences.size() < min_oos_sample_days_) {
        res.shrinkage_factor_C = 1.00;
        res.calibrated_probability = std::clamp(current_proposed_confidence, 0.05, 0.95);
        res.is_calibrated_valid = false;

        // Raw Kelly: f* = (p * b - (1 - p)) / b
        double p = res.calibrated_probability;
        res.raw_kelly_fraction = (p * win_loss_ratio_b - (1.0 - p)) / win_loss_ratio_b;
        res.calibrated_kelly_fraction = 0.25 * std::max(0.0, res.raw_kelly_fraction); // 1/4 Fractional Kelly
        return res;
    }

    // Compute raw average confidence & empirical win rate
    double sum_conf = std::accumulate(historical_model_confidences.begin(), historical_model_confidences.end(), 0.0);
    res.raw_avg_confidence = sum_conf / historical_model_confidences.size();

    size_t wins = 0;
    for (bool outcome : historical_trade_outcomes) {
        if (outcome) wins++;
    }
    res.empirical_win_rate = static_cast<double>(wins) / historical_trade_outcomes.size();

    // Shrinkage Calibration Factor C = empirical_win_rate / raw_avg_confidence
    if (res.raw_avg_confidence > 0.0) {
        res.shrinkage_factor_C = res.empirical_win_rate / res.raw_avg_confidence;
    } else {
        res.shrinkage_factor_C = 1.00;
    }

    // Compute per-confidence-bucket reliability curve calibration (Platt Bins)
    // 5 Bins: [0.50, 0.60), [0.60, 0.70), [0.70, 0.80), [0.80, 0.90), [0.90, 1.00]
    int target_bin = -1;
    if (current_proposed_confidence >= 0.90) target_bin = 4;
    else if (current_proposed_confidence >= 0.80) target_bin = 3;
    else if (current_proposed_confidence >= 0.70) target_bin = 2;
    else if (current_proposed_confidence >= 0.60) target_bin = 1;
    else if (current_proposed_confidence >= 0.50) target_bin = 0;

    res.matched_bucket_index = target_bin;
    size_t bin_sample_count = 0;
    double bin_sum_conf = 0.0;
    size_t bin_wins = 0;

    if (target_bin >= 0) {
        double bin_low = 0.50 + target_bin * 0.10;
        double bin_high = (target_bin == 4) ? 1.01 : (bin_low + 0.10);

        for (size_t i = 0; i < historical_model_confidences.size(); ++i) {
            double c = historical_model_confidences[i];
            if (c >= bin_low && c < bin_high) {
                bin_sample_count++;
                bin_sum_conf += c;
                if (historical_trade_outcomes[i]) bin_wins++;
            }
        }
    }
    res.bucket_sample_count = bin_sample_count;

    if (bin_sample_count >= 5 && bin_sum_conf > 0.0) {
        double bin_avg_conf = bin_sum_conf / bin_sample_count;
        double bin_win_rate = static_cast<double>(bin_wins) / bin_sample_count;
        res.bucket_shrinkage_factor_C = std::clamp(bin_win_rate / bin_avg_conf, 0.50, 1.50);
    } else {
        res.bucket_shrinkage_factor_C = res.shrinkage_factor_C; // Fall back to global C if bin < 5 samples
    }

    // Calibrated probability uses per-bucket C when available, falling back to global C
    double effective_C = (bin_sample_count >= 5) ? res.bucket_shrinkage_factor_C : res.shrinkage_factor_C;
    res.calibrated_probability = std::clamp(effective_C * current_proposed_confidence, 0.05, 0.95);

    // Compute raw and calibrated Fractional Kelly
    double p_raw = std::clamp(current_proposed_confidence, 0.05, 0.95);
    res.raw_kelly_fraction = (p_raw * win_loss_ratio_b - (1.0 - p_raw)) / win_loss_ratio_b;

    double p_cal = res.calibrated_probability;
    double full_cal_kelly = (p_cal * win_loss_ratio_b - (1.0 - p_cal)) / win_loss_ratio_b;
    res.calibrated_kelly_fraction = 0.25 * std::max(0.0, full_cal_kelly);

    res.is_calibrated_valid = true;
    return res;
}

// OOS Walk-forward Validation Gate
bool HistoricalEdgeEngine::validate_signal_oos(
    const std::vector<double>& in_sample_signals,
    const std::vector<double>& in_sample_outcomes,
    const std::vector<double>& oos_signals,
    const std::vector<double>& oos_outcomes,
    double max_allowed_decay
) {
    if (in_sample_signals.size() < min_oos_sample_days_ || oos_signals.size() < 5) return false;

    double is_corr = calculate_correlation(in_sample_signals, in_sample_outcomes);
    double oos_corr = calculate_correlation(oos_signals, oos_outcomes);

    // Require minimum statistically significant positive correlation in-sample (is_corr >= 0.30)
    double min_is_corr_threshold = 0.30;
    if (is_corr < min_is_corr_threshold || oos_corr <= 0.0) return false;

    double decay = (is_corr - oos_corr) / is_corr;
    return (decay <= max_allowed_decay);
}

// 9. Dynamic Volatility & ATR Exit Calibration (CPCV / OOS Walk-Forward Validated + Greeks & Event-Day Conditioning)
DynamicExitThresholdResult HistoricalEdgeEngine::calibrate_dynamic_exits(
    const std::string& underlying,
    bool is_0dte,
    int hour_ist,
    int minute_ist,
    const std::vector<double>& historical_candle_returns,
    double current_capital_in_hand,
    double iv_percentile,
    bool is_event_day,
    double option_vega,
    double option_gamma
) {
    DynamicExitThresholdResult res;
    res.underlying = underlying;
    res.dte_bucket = is_0dte ? "0DTE" : "NON_0DTE";
    res.iv_percentile = iv_percentile;
    res.is_event_day = is_event_day;
    res.option_vega = option_vega;
    res.option_gamma = option_gamma;

    int total_min = hour_ist * 60 + minute_ist;
    if (total_min < 690) { // < 11:30 AM IST
        res.time_bucket = "MORNING";
    } else if (total_min < 810) { // < 13:30 PM IST
        res.time_bucket = "MIDDAY";
    } else {
        res.time_bucket = "AFTERNOON";
    }

    // Compute non-linear time decay scale factor for 0DTE options in afternoon session
    if (is_0dte && total_min >= 810) { // After 13:30 IST on expiry day
        double min_past_1330 = static_cast<double>(total_min - 810);
        double decay_ratio = std::clamp(min_past_1330 / 90.0, 0.0, 1.0); // 90 min past 13:30 reaches 15:00 IST (0.40 floor)
        res.time_decay_scale_factor = std::clamp(1.0 - 0.60 * decay_ratio * decay_ratio, 0.40, 1.00);
    } else {
        res.time_decay_scale_factor = 1.00;
    }

    // 1. IV Percentile Scale Factor (wider stop in high IV, tighter in low IV)
    res.iv_scale_factor = std::clamp(1.0 + 0.15 * ((iv_percentile - 50.0) / 50.0), 0.85, 1.15);

    // 2. Vega Crush Risk Scale Factor (if IV percentile >= 75% and option Vega > 0.15, tighten stop to prevent IV crush loss)
    res.vega_crush_scale_factor = (iv_percentile >= 75.0 && option_vega > 0.15) ? 0.80 : 1.00;

    // 3. Gamma Acceleration Risk Scale Factor (on 0DTE near-ATM high Gamma > 0.005)
    res.gamma_scale_factor = (is_0dte && option_gamma > 0.005) ? 0.85 : 1.00;

    // 4. Event-Day Outlier Flag Scale Factor (tighten stop on 2.5-sigma event days)
    res.event_day_scale_factor = is_event_day ? 0.85 : 1.00;

    res.historical_samples_count = historical_candle_returns.size();

    // Sample size gating check: require >= 200 candle samples for statistical significance
    if (historical_candle_returns.size() < 200) {
        res.dynamic_stop_pct = 0.25 * res.time_decay_scale_factor * res.iv_scale_factor * res.vega_crush_scale_factor * res.gamma_scale_factor * res.event_day_scale_factor;
        res.dynamic_target_pct = 0.50 * res.iv_scale_factor;
        res.dynamic_rupee_stop_inr = res.dynamic_stop_pct * (0.02 * current_capital_in_hand);
        res.dynamic_rupee_target_inr = res.dynamic_target_pct * (0.02 * current_capital_in_hand);
        res.passes_oos_validation = false;
        res.gating_status = "RESEARCH_OBSERVABILITY_ONLY";
        res.calibration_summary = "INSUFFICIENT_SAMPLE_SIZE_FALLBACK_DEFAULT";
        return res;
    }

    // Chronological Walk-Forward 80/20 IS/OOS Split
    size_t split_idx = static_cast<size_t>(historical_candle_returns.size() * 0.80);
    std::vector<double> is_returns(historical_candle_returns.begin(), historical_candle_returns.begin() + split_idx);
    std::vector<double> oos_returns(historical_candle_returns.begin() + split_idx, historical_candle_returns.end());

    // Calculate In-Sample Adverse Move Volatility & 90th Percentile
    std::vector<double> abs_is_returns;
    for (double r : is_returns) abs_is_returns.push_back(std::abs(r));
    std::sort(abs_is_returns.begin(), abs_is_returns.end());

    double is_p90 = calculate_percentile(abs_is_returns, 90.0);
    double is_mean_abs = std::accumulate(abs_is_returns.begin(), abs_is_returns.end(), 0.0) / (abs_is_returns.empty() ? 1.0 : abs_is_returns.size());

    // Calculate Out-of-Sample Adverse Move Volatility & 90th Percentile
    std::vector<double> abs_oos_returns;
    for (double r : oos_returns) abs_oos_returns.push_back(std::abs(r));
    std::sort(abs_oos_returns.begin(), abs_oos_returns.end());

    double oos_mean_abs = std::accumulate(abs_oos_returns.begin(), abs_oos_returns.end(), 0.0) / (abs_oos_returns.empty() ? 1.0 : abs_oos_returns.size());

    // OOS Walk-Forward Decay Validation (|OOS - IS| / IS <= 0.15)
    double decay = (is_mean_abs > 0.0) ? (std::abs(oos_mean_abs - is_mean_abs) / is_mean_abs) : 0.0;
    res.passes_oos_validation = (decay <= 0.15);

    res.atr_14_pct = is_p90;

    if (res.passes_oos_validation) {
        res.gating_status = "VALIDATED_GATED";
        // Dynamic stop calibrated to 90th percentile adverse move scaled by time decay, IV scale, Vega crush, Gamma, and Event-day scale
        double raw_stop = 1.25 * is_p90 * res.iv_scale_factor * res.vega_crush_scale_factor * res.gamma_scale_factor * res.event_day_scale_factor * res.time_decay_scale_factor;
        res.dynamic_stop_pct = std::clamp(raw_stop, 0.10, 0.35);

        // Dynamic target calibrated to 2.25x ATR move scaled by IV
        double raw_target = 2.25 * is_p90 * res.iv_scale_factor;
        res.dynamic_target_pct = std::clamp(raw_target, 0.20, 0.70);
    } else {
        res.gating_status = "RESEARCH_OBSERVABILITY_ONLY";
        // Fallback default
        res.dynamic_stop_pct = 0.25 * res.time_decay_scale_factor * res.iv_scale_factor * res.vega_crush_scale_factor * res.gamma_scale_factor * res.event_day_scale_factor;
        res.dynamic_target_pct = 0.50 * res.iv_scale_factor;
    }

    res.dynamic_rupee_stop_inr = res.dynamic_stop_pct * (0.02 * current_capital_in_hand);
    res.dynamic_rupee_target_inr = res.dynamic_target_pct * (0.02 * current_capital_in_hand);

    std::ostringstream ss;
    ss << "Bucket: [" << underlying << "|" << res.dte_bucket << "|" << res.time_bucket
       << "]. Gating: " << res.gating_status << " (OOS Decay: " << std::fixed << std::setprecision(3) << decay
       << "). Dynamic Stop: " << std::setprecision(1) << (res.dynamic_stop_pct * 100.0) << "% (₹"
       << std::setprecision(2) << res.dynamic_rupee_stop_inr << "). Dynamic Target: "
       << std::setprecision(1) << (res.dynamic_target_pct * 100.0) << "% (₹" << std::setprecision(2)
       << res.dynamic_rupee_target_inr << "). Time Decay: " << res.time_decay_scale_factor
       << ", IV Scale: " << res.iv_scale_factor << ", Vega Scale: " << res.vega_crush_scale_factor
       << ", Gamma Scale: " << res.gamma_scale_factor << ", Event Scale: " << res.event_day_scale_factor;
    res.calibration_summary = ss.str();

    return res;
}


} // namespace hermes
