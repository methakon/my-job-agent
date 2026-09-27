#include "gate10_regime_machine.hpp"
#include <cmath>
#include <sstream>
#include <iomanip>
#include <numeric>
#include <algorithm>
#include <iostream>

namespace hermes {

RegimeStateMachine::RegimeStateMachine(size_t min_samples_for_hard_veto)
    : min_samples_for_hard_veto_(min_samples_for_hard_veto) {}

void RegimeStateMachine::reset() {
    regime_trade_history_.clear();
}

RegimeClassificationResult RegimeStateMachine::classify_regime(
    double atr_current,
    double atr_14_avg,
    double vwap_slope_5m,
    double ofi_l1,
    double relative_volume
) {
    RegimeClassificationResult res;
    res.atr_ratio = (atr_14_avg > 0.0) ? (atr_current / atr_14_avg) : 1.0;
    res.vwap_slope = vwap_slope_5m;
    res.ofi_score = ofi_l1;

    // 1. Volatile Breakout: High ATR ratio (>1.4) AND High RVOL (>1.5)
    if (res.atr_ratio >= 1.4 && relative_volume >= 1.5) {
        res.regime = MarketRegime::VOLATILE_BREAKOUT;
        res.regime_name = "VOLATILE_BREAKOUT";
        res.confidence = std::min(1.0, 0.5 + 0.25 * res.atr_ratio);
    }
    // 2. Trending Bull: Strong positive VWAP slope (>0.05%) AND positive OFI
    else if (vwap_slope_5m >= 0.0005 && ofi_l1 > 10.0) {
        res.regime = MarketRegime::TRENDING_BULL;
        res.regime_name = "TRENDING_BULL";
        res.confidence = std::min(1.0, 0.6 + 100.0 * vwap_slope_5m);
    }
    // 3. Trending Bear: Strong negative VWAP slope (<-0.05%) AND negative OFI
    else if (vwap_slope_5m <= -0.0005 && ofi_l1 < -10.0) {
        res.regime = MarketRegime::TRENDING_BEAR;
        res.regime_name = "TRENDING_BEAR";
        res.confidence = std::min(1.0, 0.6 + 100.0 * std::abs(vwap_slope_5m));
    }
    // 4. Mean Reverting Range: Low ATR ratio (<0.90) AND low VWAP slope
    else if (res.atr_ratio <= 0.90 && std::abs(vwap_slope_5m) < 0.0003) {
        res.regime = MarketRegime::MEAN_REVERTING_RANGE;
        res.regime_name = "MEAN_REVERTING_RANGE";
        res.confidence = 0.80;
    }
    // 5. Fallback: Choppy High Noise
    else {
        res.regime = MarketRegime::CHOPPY_HIGH_NOISE;
        res.regime_name = "CHOPPY_HIGH_NOISE";
        res.confidence = 0.70;
    }

    return res;
}

void RegimeStateMachine::record_trade_outcome(MarketRegime regime, double pnl_points) {
    int k = static_cast<int>(regime);
    regime_trade_history_[k].push_back(pnl_points);
}

RegimeSkillPerformance RegimeStateMachine::get_regime_performance(MarketRegime regime) const {
    RegimeSkillPerformance perf;
    perf.regime = regime;
    
    switch (regime) {
        case MarketRegime::VOLATILE_BREAKOUT: perf.regime_name = "VOLATILE_BREAKOUT"; break;
        case MarketRegime::TRENDING_BULL: perf.regime_name = "TRENDING_BULL"; break;
        case MarketRegime::TRENDING_BEAR: perf.regime_name = "TRENDING_BEAR"; break;
        case MarketRegime::MEAN_REVERTING_RANGE: perf.regime_name = "MEAN_REVERTING_RANGE"; break;
        default: perf.regime_name = "CHOPPY_HIGH_NOISE"; break;
    }

    int k = static_cast<int>(regime);
    auto it = regime_trade_history_.find(k);
    if (it == regime_trade_history_.end() || it->second.empty()) {
        return perf;
    }

    const auto& pnls = it->second;
    perf.trade_count = pnls.size();
    
    double gross_profit = 0.0;
    double gross_loss = 0.0;
    double peak = 0.0;
    double current_cum = 0.0;
    double max_dd = 0.0;

    for (double pnl : pnls) {
        if (pnl > 0.0) {
            perf.win_count++;
            gross_profit += pnl;
        } else {
            gross_loss += std::abs(pnl);
        }

        perf.total_pnl += pnl;
        current_cum += pnl;
        if (current_cum > peak) peak = current_cum;
        double dd = peak - current_cum;
        if (dd > max_dd) max_dd = dd;
    }

    perf.win_rate = static_cast<double>(perf.win_count) / static_cast<double>(perf.trade_count);
    perf.profit_factor = (gross_loss > 0.0) ? (gross_profit / gross_loss) : (gross_profit > 0.0 ? 99.0 : 0.0);
    perf.max_drawdown_pts = max_dd;

    return perf;
}

RegimeVetoResult RegimeStateMachine::evaluate_regime_veto(MarketRegime regime) const {
    RegimeVetoResult res;
    RegimeSkillPerformance perf = get_regime_performance(regime);

    // G10-03 Stability guard: If trade count < min_samples_for_hard_veto_, stay in SHADOW MODE
    if (perf.trade_count < min_samples_for_hard_veto_) {
        res.veto_active = false;
        res.shadow_mode = true;
        std::ostringstream ss;
        ss << "REGIME_VETO_SHADOW_MODE: Sample count (" << perf.trade_count 
           << ") < minimum required (" << min_samples_for_hard_veto_ << ") for hard veto";
        res.veto_reason = ss.str();
        return res;
    }

    // Hard Veto evaluation once stability sample size is satisfied
    res.shadow_mode = false;
    if (perf.win_rate < 0.40 || perf.profit_factor < 0.80) {
        res.veto_active = true;
        std::ostringstream ss;
        ss << "HARD_REGIME_VETO_ACTIVE: Historical win rate (" << std::fixed << std::setprecision(2)
           << perf.win_rate * 100.0 << "%) or Profit Factor (" << perf.profit_factor << ") below threshold";
        res.veto_reason = ss.str();
    } else {
        res.veto_active = false;
        res.veto_reason = "REGIME_PERFORMANCE_APPROVED";
    }

    return res;
}

std::string RegimeClassificationResult::summary_json() const {
    std::ostringstream ss;
    ss << std::fixed << std::setprecision(2);
    ss << "{\"regime\":\"" << regime_name << "\",\"confidence\":" << confidence
       << ",\"atr_ratio\":" << atr_ratio << ",\"vwap_slope\":" << vwap_slope << "}";
    return ss.str();
}

std::string RegimeVetoResult::summary_json() const {
    std::ostringstream ss;
    ss << "{\"veto_active\":" << (veto_active ? "true" : "false")
       << ",\"shadow_mode\":" << (shadow_mode ? "true" : "false")
       << ",\"reason\":\"" << veto_reason << "\"}";
    return ss.str();
}

} // namespace hermes
