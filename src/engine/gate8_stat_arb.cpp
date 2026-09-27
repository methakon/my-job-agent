#include "gate8_stat_arb.hpp"
#include <sstream>
#include <iomanip>
#include <cmath>
#include <algorithm>
#include <cassert>
#include <iostream>

namespace hermes {

StatArbEngine::StatArbEngine(bool enabled) : enabled_(enabled) {}

void StatArbEngine::reset() {
    gap_database_.clear();
}

void StatArbEngine::add_historical_gap(const HistoricalGapRecord& rec) {
    if (!enabled_) return;
    gap_database_.push_back(rec);
}

GapLabel StatArbEngine::compute_leakage_controlled_label(
    const std::vector<std::pair<uint64_t, double>>& price_series,
    uint64_t open_time_ms,
    double prev_close,
    double open_price,
    double atr_14
) {
    if (price_series.empty() || atr_14 <= 0.0) return GapLabel::LBL_NO_EDGE;

    uint64_t cutoff_ms = open_time_ms + (45 * 60 * 1000); // 45-minute window
    double gap_size = open_price - prev_close;

    bool fade_target_hit = false;
    bool follow_target_hit = false;

    for (const auto& [ts, px] : price_series) {
        // G8-02 Leakage assertion: Do not evaluate data beyond the 45-minute window for labeling
        if (ts > cutoff_ms) break;

        if (gap_size > 0.0) { // Gap Up
            // Fade target: price retraces 80% of gap towards prev_close
            if (px <= open_price - (0.80 * gap_size)) {
                fade_target_hit = true;
                break;
            }
            // Follow target: price expands 1.0x ATR above open_price
            if (px >= open_price + (1.0 * atr_14)) {
                follow_target_hit = true;
                break;
            }
        } else if (gap_size < 0.0) { // Gap Down
            double abs_gap = std::abs(gap_size);
            // Fade target: price retraces 80% of gap towards prev_close
            if (px >= open_price + (0.80 * abs_gap)) {
                fade_target_hit = true;
                break;
            }
            // Follow target: price expands 1.0x ATR below open_price
            if (px <= open_price - (1.0 * atr_14)) {
                follow_target_hit = true;
                break;
            }
        }
    }

    if (fade_target_hit) return GapLabel::LBL_FADE;
    if (follow_target_hit) return GapLabel::LBL_FOLLOW;
    return GapLabel::LBL_NO_EDGE;
}

StatArbResult StatArbEngine::evaluate_position(
    const GapPositionState& pos,
    uint64_t current_time_ms,
    double current_price,
    bool is_short_fade
) {
    StatArbResult res;
    res.symbol = pos.symbol;
    res.timestamp_ms = current_time_ms;

    // Calculate historical statistics if database populated
    if (!gap_database_.empty()) {
        size_t fade_cnt = 0;
        double total_hl = 0.0;
        for (const auto& r : gap_database_) {
            if (r.label == GapLabel::LBL_FADE) fade_cnt++;
            total_hl += r.half_life_minutes;
        }
        res.historical_fade_prob = static_cast<double>(fade_cnt) / static_cast<double>(gap_database_.size());
        res.ou_half_life_min = total_hl / static_cast<double>(gap_database_.size());
    } else {
        res.historical_fade_prob = 0.65; // default benchmark
        res.ou_half_life_min = 22.5;     // 22.5 minutes half-life
    }

    // Check G8-03 Hard Holding & Risk Limits
    uint64_t elapsed_ms = (current_time_ms >= pos.entry_time_ms) ? (current_time_ms - pos.entry_time_ms) : 0;
    uint32_t elapsed_min = static_cast<uint32_t>(elapsed_ms / (60 * 1000));

    // Calculate PnL / Loss
    double pnl_points = is_short_fade ? (pos.entry_price - current_price) : (current_price - pos.entry_price);
    // Assuming lot size = 65 for NIFTY
    double pnl_inr = pnl_points * 65.0;

    // Hard Risk Cap check (-₹2,000 ceiling per lot or hit stop loss)
    if (pnl_inr <= -pos.max_risk_amount || (is_short_fade && current_price >= pos.stop_loss_price) || (!is_short_fade && current_price <= pos.stop_loss_price)) {
        res.signal = StatArbSignal::FORCE_EXIT_RISK_CAP_EXCEEDED;
        res.signal_reason = "FORCE_EXIT_RISK_CAP_EXCEEDED: Loss reached ₹2,000 risk cap or stop loss level";
        return res;
    }

    // Max Holding Period check (45 minutes)
    if (elapsed_min >= pos.max_holding_minutes) {
        res.signal = StatArbSignal::FORCE_EXIT_TIME_EXPIRED;
        res.signal_reason = "FORCE_EXIT_TIME_EXPIRED: Max holding duration (45 mins) reached";
        return res;
    }

    res.signal = StatArbSignal::HOLD;
    res.signal_reason = "POSITION_ACTIVE_WITHIN_RISK_LIMITS";
    return res;
}

std::string StatArbResult::summary_json() const {
    std::ostringstream ss;
    ss << std::fixed << std::setprecision(2);
    ss << "{\"symbol\":\"" << symbol << "\",\"fade_prob\":" << historical_fade_prob
       << ",\"ou_half_life\":" << ou_half_life_min
       << ",\"signal\":" << static_cast<int>(signal)
       << ",\"reason\":\"" << signal_reason << "\"}";
    return ss.str();
}

} // namespace hermes
