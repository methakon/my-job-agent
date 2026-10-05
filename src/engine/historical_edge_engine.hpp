#ifndef HERMES_HISTORICAL_EDGE_ENGINE_HPP
#define HERMES_HISTORICAL_EDGE_ENGINE_HPP

#include <string>
#include <vector>
#include <map>
#include <memory>
#include <cmath>
#include <algorithm>

namespace hermes {

// 1. IV Percentile & Rank Result
struct IvPercentileResult {
    std::string underlying;
    double current_iv{0.0};
    double min_iv{0.0};
    double max_iv{0.0};
    double iv_percentile{50.0}; // 0 to 100
    double iv_rank{50.0};       // 0 to 100
    double advisory_modifier{1.00}; // Clamped [0.90, 1.10]
    size_t sample_size_days{0};
    bool is_validated_oos{false};
    std::string regime_label; // EXPENSIVE_IV_PREMIUM_SELL, CHEAP_IV_PREMIUM_BUY, NEUTRAL_IV
};

// 2. Historical Tail-Risk (VaR / CVaR) Profile Result
struct TailRiskProfileResult {
    std::string symbol;
    size_t sample_days{0};
    double mean_daily_return{0.0};
    double daily_volatility{0.0};
    double var_95_pct{0.0};   // 95% 1-day Value at Risk (positive percentage loss)
    double var_99_pct{0.0};   // 99% 1-day Value at Risk
    double cvar_95_pct{0.0};  // 95% Conditional VaR / Expected Shortfall
    double recommended_dynamic_stop_pct{0.0};
    double max_safe_position_size_inr{0.0};
};

// 3. Event-Day Tagging & Event Calendar Result
struct EventDayTaggingResult {
    std::string symbol;
    size_t total_days{0};
    size_t outlier_event_days_count{0};
    double outlier_threshold_vol{0.0};
    double clean_seasonality_volatility{0.0};
    double event_day_volatility{0.0};
    bool is_known_event_day{false};
    double event_risk_dampener{1.00}; // Advisory modifier [0.90, 1.00]
    std::vector<std::string> tagged_event_dates;
};

// 7. Correlation-Aware Position Sizing Result
struct CorrelationSizingResult {
    double rho_nifty_banknifty{0.0};
    double rho_nifty_sensex{0.0};
    double rho_banknifty_sensex{0.0};
    double individual_combined_risk_inr{0.0};
    double correlated_effective_exposure_inr{0.0};
    double correlation_scale_factor{1.00}; // Clamped [0.50, 1.00]
    std::string advisory_reason;
};

// 8. Bayesian Kelly Calibration Result
struct KellyCalibrationResult {
    size_t sample_trades_count{0};
    double raw_avg_confidence{0.0};
    double empirical_win_rate{0.0};
    double shrinkage_factor_C{1.00}; // Global C = empirical_win_rate / raw_avg_confidence
    double bucket_shrinkage_factor_C{1.00}; // Per-confidence-bucket C (Platt reliability curve)
    int matched_bucket_index{-1};
    size_t bucket_sample_count{0};
    double raw_input_confidence{0.0};
    double calibrated_probability{0.50};
    double raw_kelly_fraction{0.0};
    double calibrated_kelly_fraction{0.0};
    bool is_calibrated_valid{false};
};

// 9. Dynamic Volatility & ATR Calibrated Exit Threshold Result
struct DynamicExitThresholdResult {
    std::string underlying;             // NIFTY, BANKNIFTY, SENSEX
    std::string dte_bucket;             // "0DTE", "NON_0DTE"
    std::string time_bucket;            // "MORNING", "MIDDAY", "AFTERNOON"
    double dynamic_stop_pct{0.25};      // Dynamic stop loss % (e.g. 0.18, 0.12)
    double dynamic_target_pct{0.50};    // Dynamic take profit % (e.g. 0.40, 0.30)
    double dynamic_rupee_stop_inr{0.0}; // Dynamic rupee stop floor scaled off CAPITAL_IN_HAND
    double dynamic_rupee_target_inr{0.0};
    double atr_14_pct{0.0};             // Local ATR(14) percentage
    double time_decay_scale_factor{1.0}; // Time decay scale (1.00 down to 0.40 near 15:30 on 0DTE)
    double iv_percentile{50.0};         // IV Percentile / Rank
    bool is_event_day{false};           // 2.5-sigma event day flag
    double option_vega{0.0};            // Black-Scholes Vega
    double option_gamma{0.0};           // Black-Scholes Gamma
    double iv_scale_factor{1.0};
    double vega_crush_scale_factor{1.0};
    double gamma_scale_factor{1.0};
    double event_day_scale_factor{1.0};
    bool passes_oos_validation{false};
    size_t historical_samples_count{0};
    std::string gating_status;          // "VALIDATED_GATED" or "RESEARCH_OBSERVABILITY_ONLY"
    std::string calibration_summary;
};

// Comprehensive Historical Edge Evaluation Package
struct HistoricalEdgeEvaluationPackage {
    IvPercentileResult iv_result;
    TailRiskProfileResult tail_risk;
    EventDayTaggingResult event_tagging;
    CorrelationSizingResult correlation_sizing;
    KellyCalibrationResult kelly_calibration;
    DynamicExitThresholdResult dynamic_exits;
    double composite_advisory_modifier{1.00}; // Dynamic product of validated advisory modifiers clamped to [0.90, 1.10]
    bool passes_oos_validation{false};
    std::string evaluation_summary;
};

class HistoricalEdgeEngine {
public:
    explicit HistoricalEdgeEngine(size_t min_oos_sample_days = 20);

    // 9. Dynamic Volatility & ATR Exit Calibration (CPCV / OOS Walk-Forward Validated + Greeks & Event-Day Conditioning)
    DynamicExitThresholdResult calibrate_dynamic_exits(
        const std::string& underlying,
        bool is_0dte,
        int hour_ist,
        int minute_ist,
        const std::vector<double>& historical_candle_returns,
        double current_capital_in_hand = 932642.58,
        double iv_percentile = 50.0,
        bool is_event_day = false,
        double option_vega = 0.0,
        double option_gamma = 0.0
    );


    // 1. IV Percentile / Rank Evaluation
    IvPercentileResult evaluate_iv_percentile(
        const std::string& underlying,
        double current_atm_iv,
        const std::vector<double>& historical_iv_series
    );

    // 2. Tail-Risk Profiling (VaR / CVaR)
    TailRiskProfileResult calculate_tail_risk(
        const std::string& symbol,
        const std::vector<double>& daily_returns
    );

    // 3. Event-Day Tagging & Calendar Risk Evaluation
    EventDayTaggingResult tag_event_days(
        const std::string& symbol,
        const std::vector<std::string>& dates,
        const std::vector<double>& daily_returns,
        bool is_today_known_event_day = false
    );

    // 7. Correlation-Aware Position Sizing Across Underlyings
    CorrelationSizingResult calculate_correlation_aware_sizing(
        const std::vector<double>& nifty_returns,
        const std::vector<double>& banknifty_returns,
        const std::vector<double>& sensex_returns,
        double nifty_proposed_risk_inr,
        double banknifty_proposed_risk_inr,
        double sensex_proposed_risk_inr
    );

    // 8. Bayesian Kelly Probability Calibration (Platt Scaling & Shrinkage Factor C)
    KellyCalibrationResult calibrate_kelly_probabilities(
        const std::vector<double>& historical_model_confidences,
        const std::vector<bool>& historical_trade_outcomes,
        double current_proposed_confidence,
        double win_loss_ratio_b = 1.5
    );

    // Out-of-Sample (OOS) Walk-Forward Validation Gate
    bool validate_signal_oos(
        const std::vector<double>& in_sample_signals,
        const std::vector<double>& in_sample_outcomes,
        const std::vector<double>& oos_signals,
        const std::vector<double>& oos_outcomes,
        double max_allowed_decay = 0.15
    );

    static double calculate_correlation(const std::vector<double>& x, const std::vector<double>& y);
    static double calculate_percentile(const std::vector<double>& sorted_data, double percentile);

private:
    size_t min_oos_sample_days_;
};

} // namespace hermes

#endif // HERMES_HISTORICAL_EDGE_ENGINE_HPP
