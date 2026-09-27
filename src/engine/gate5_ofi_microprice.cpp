#include "gate5_ofi_microprice.hpp"
#include <sstream>
#include <iomanip>
#include <algorithm>
#include <iostream>

namespace hermes {

MicrostructureEngine::MicrostructureEngine(size_t max_history)
    : max_history_(max_history) {}

void MicrostructureEngine::reset() {
    has_previous_ = false;
    prev_snapshot_ = OrderBookSnapshot{};
    trailing_spread_ema_ = 0.0;
    absorbed_volume_at_bid_ = 0.0;
    absorbed_volume_at_ask_ = 0.0;
    prev_bid_price_ = 0.0;
    prev_ask_price_ = 0.0;
}

double MicrostructureEngine::calculate_level_ofi(const LevelSnapshot& curr, const LevelSnapshot& prev) {
    // Cont-Stoikov OFI formula per level k
    // Bid component
    double delta_vb = 0.0;
    if (curr.bid_price > prev.bid_price) {
        delta_vb = curr.bid_qty;
    } else if (curr.bid_price == prev.bid_price) {
        delta_vb = curr.bid_qty - prev.bid_qty;
    } else {
        delta_vb = -prev.bid_qty;
    }

    // Ask component
    double delta_va = 0.0;
    if (curr.ask_price < prev.ask_price) {
        delta_va = curr.ask_qty;
    } else if (curr.ask_price == prev.ask_price) {
        delta_va = curr.ask_qty - prev.ask_qty;
    } else {
        delta_va = -prev.ask_qty;
    }

    return delta_vb - delta_va;
}

double MicrostructureEngine::calculate_stacked_imbalance(const OrderBookSnapshot& snap) const {
    if (snap.levels_available == 0) return 0.0;
    
    size_t valid_levels = std::min(snap.levels_available, MAX_BOOK_LEVELS);
    size_t bid_heavy_count = 0;
    size_t ask_heavy_count = 0;

    for (size_t i = 0; i < valid_levels; ++i) {
        double bq = snap.levels[i].bid_qty;
        double aq = snap.levels[i].ask_qty;
        if (bq + aq <= 0.0) continue;

        double ratio = (bq + 1e-6) / (aq + 1e-6);
        if (ratio >= 3.0) {
            bid_heavy_count++;
        } else if (ratio <= 0.3333) {
            ask_heavy_count++;
        }
    }

    // Score hypothesis between -1.0 (strong ask stack) and +1.0 (strong bid stack)
    double score = static_cast<double>(bid_heavy_count) - static_cast<double>(ask_heavy_count);
    return std::clamp(score / static_cast<double>(valid_levels), -1.0, 1.0);
}

double MicrostructureEngine::calculate_absorption_hypothesis(const OrderBookSnapshot& curr, const OrderBookSnapshot& prev) {
    if (!has_previous_) return 0.0;

    // Passive Absorption: High trade volume occurs at the best bid/ask without price breaking through
    double bid_p = curr.levels[0].bid_price;
    double ask_p = curr.levels[0].ask_price;
    double prev_bid_p = prev.levels[0].bid_price;
    double prev_ask_p = prev.levels[0].ask_price;

    double trade_vol = curr.last_traded_qty;

    // If bid price is held fixed despite heavy trades
    if (bid_p == prev_bid_p && curr.last_traded_price == bid_p && trade_vol > 0.0) {
        absorbed_volume_at_bid_ += trade_vol;
    } else if (bid_p != prev_bid_p) {
        absorbed_volume_at_bid_ = 0.0; // reset on price move
    }

    // If ask price is held fixed despite heavy trades
    if (ask_p == prev_ask_p && curr.last_traded_price == ask_p && trade_vol > 0.0) {
        absorbed_volume_at_ask_ += trade_vol;
    } else if (ask_p != prev_ask_p) {
        absorbed_volume_at_ask_ = 0.0; // reset on price move
    }

    double total_absorbed = absorbed_volume_at_bid_ + absorbed_volume_at_ask_;
    if (total_absorbed <= 0.0) return 0.0;

    // Normalize hypothesis score between 0.0 and 1.0
    // e.g. 500+ contracts absorbed yields strong hypothesis (>0.8)
    double score = 1.0 - std::exp(-total_absorbed / 500.0);
    return std::clamp(score, 0.0, 1.0);
}

OFIMicropriceResult MicrostructureEngine::process_snapshot(const OrderBookSnapshot& current) {
    OFIMicropriceResult res;
    res.symbol = current.symbol;
    res.timestamp_ms = current.timestamp_ms;
    res.levels_used = std::min(current.levels_available, MAX_BOOK_LEVELS);
    if (res.levels_used == 0) res.levels_used = 1; // Fallback to L1 minimum

    res.l1_degradation_active = (current.levels_available < 5);

    double b1_price = current.levels[0].bid_price;
    double b1_qty   = current.levels[0].bid_qty;
    double a1_price = current.levels[0].ask_price;
    double a1_qty   = current.levels[0].ask_qty;

    // Calculate Mid Price
    if (b1_price > 0.0 && a1_price > 0.0) {
        res.mid_price = (b1_price + a1_price) * 0.5;
        res.spread = a1_price - b1_price;
    } else {
        res.mid_price = current.last_traded_price;
        res.spread = 0.0;
    }

    // Calculate Microprice with graceful fallback
    if (b1_qty + a1_qty > 0.0 && b1_price > 0.0 && a1_price > 0.0) {
        res.microprice = (b1_price * a1_qty + a1_price * b1_qty) / (b1_qty + a1_qty);
    } else {
        res.microprice = (res.mid_price > 0.0) ? res.mid_price : current.last_traded_price;
    }

    // Single-level Order Book Imbalance (OBI) [-1.0, +1.0]
    if (b1_qty + a1_qty > 0.0) {
        res.obi_l1 = (b1_qty - a1_qty) / (b1_qty + a1_qty);
    } else {
        res.obi_l1 = 0.0;
    }

    // Spread shock tracking (G5-02)
    if (trailing_spread_ema_ == 0.0) {
        trailing_spread_ema_ = res.spread;
        res.spread_shock_ratio = 1.0;
    } else {
        trailing_spread_ema_ = (ema_alpha_ * res.spread) + ((1.0 - ema_alpha_) * trailing_spread_ema_);
        if (trailing_spread_ema_ > 0.0) {
            res.spread_shock_ratio = res.spread / trailing_spread_ema_;
        } else {
            res.spread_shock_ratio = 1.0;
        }
    }

    // OFI and dynamic tracking against previous snapshot
    if (has_previous_) {
        res.ofi_l1 = calculate_level_ofi(current.levels[0], prev_snapshot_.levels[0]);

        // Multi-level OFI (MLOFI) weighted by 1/k
        double weighted_mlofi = 0.0;
        size_t levels_to_calc = std::min(current.levels_available, MAX_BOOK_LEVELS);
        for (size_t k = 0; k < levels_to_calc; ++k) {
            double weight = 1.0 / static_cast<double>(k + 1);
            weighted_mlofi += weight * calculate_level_ofi(current.levels[k], prev_snapshot_.levels[k]);
        }
        res.mlofi = weighted_mlofi;

        // Cancellations & Replenishments at best bid/ask (G5-02)
        if (current.levels[0].bid_price == prev_snapshot_.levels[0].bid_price) {
            double delta_b = current.levels[0].bid_qty - prev_snapshot_.levels[0].bid_qty;
            if (delta_b < 0.0) res.bid_cancellation_vol = std::abs(delta_b);
            else if (delta_b > 0.0) res.bid_replenish_vol = delta_b;
        }

        if (current.levels[0].ask_price == prev_snapshot_.levels[0].ask_price) {
            double delta_a = current.levels[0].ask_qty - prev_snapshot_.levels[0].ask_qty;
            if (delta_a < 0.0) res.ask_cancellation_vol = std::abs(delta_a);
            else if (delta_a > 0.0) res.ask_replenish_vol = delta_a;
        }

        // Order update intensity per second
        double time_diff_sec = static_cast<double>(current.timestamp_ms - prev_snapshot_.timestamp_ms) / 1000.0;
        if (time_diff_sec > 0.0) {
            res.order_intensity = 1.0 / time_diff_sec;
        }
    } else {
        res.ofi_l1 = 0.0;
        res.mlofi = 0.0;
    }

    // Hypotheses calculations (G5-03)
    res.stacked_imbalance_score = calculate_stacked_imbalance(current);
    res.absorption_hypothesis_score = calculate_absorption_hypothesis(current, prev_snapshot_);

    // Update state for next call
    prev_snapshot_ = current;
    has_previous_ = true;

    return res;
}

std::string OFIMicropriceResult::summary_json() const {
    std::ostringstream ss;
    ss << std::fixed << std::setprecision(2);
    ss << "{\"symbol\":\"" << symbol << "\",\"microprice\":" << microprice
       << ",\"mid_price\":" << mid_price << ",\"spread\":" << spread
       << ",\"l1_degraded\":" << (l1_degradation_active ? "true" : "false")
       << ",\"obi_l1\":" << obi_l1 << ",\"ofi_l1\":" << ofi_l1
       << ",\"mlofi\":" << mlofi << ",\"spread_shock\":" << spread_shock_ratio
       << ",\"stacked_score\":" << stacked_imbalance_score
       << ",\"absorption_score\":" << absorption_hypothesis_score << "}";
    return ss.str();
}

} // namespace hermes
