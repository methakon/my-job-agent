#ifndef ENGINE_GATE3_FEATURE_HEALTH_HPP
#define ENGINE_GATE3_FEATURE_HEALTH_HPP

#include <string>
#include <vector>
#include <cmath>
#include <cstdint>
#include "../engine/tick_receiver.hpp"

// Feature Health Missingness Bitmask Flags (G3-05)
enum FeatureHealthBitmask : uint32_t {
    FEATURE_HEALTH_OK               = 0x0000,
    FLAG_MISSING_PREV_CLOSE         = 0x0001,
    FLAG_MISSING_ATR                = 0x0002,
    FLAG_MISSING_HISTORICAL_VOL     = 0x0004,
    FLAG_MISSING_FUTURES_SPOT       = 0x0008,
    FLAG_MISSING_OI_DATA            = 0x0010,
    FLAG_INSUFFICIENT_ORB_WINDOW    = 0x0020,
    FLAG_DIVIDE_BY_ZERO_PREVENTED   = 0x0040
};

struct ExpandedFeatureSet {
    std::string symbol;
    uint64_t timestamp_ms = 0;

    // G3-01: Gap & Volatility Features
    double open_price = 0.0;
    double prev_close = 0.0;
    double atr_14 = 0.0;
    double gap_pct = 0.0;
    double gap_atr = 0.0;
    double vwap = 0.0;

    // G3-02: Opening Range Breakout (ORB-5/15/30) & Opening Impulse
    double orb_5_high = 0.0;
    double orb_5_low = 0.0;
    double orb_15_high = 0.0;
    double orb_15_low = 0.0;
    double orb_30_high = 0.0;
    double orb_30_low = 0.0;
    double opening_impulse = 0.0;

    // G3-03: Relative Volume, Breadth, Futures Basis
    double relative_volume = 0.0;
    double futures_price = 0.0;
    double spot_price = 0.0;
    double futures_basis = 0.0;

    // G3-04: OI Delta, Strike Concentration, PCR Variants
    double total_call_oi = 0.0;
    double total_put_oi = 0.0;
    double total_call_vol = 0.0;
    double total_put_vol = 0.0;
    double oi_delta = 0.0;
    double strike_concentration = 0.0;
    double pcr_volume = 0.0;
    double pcr_oi = 0.0;

    // G3-05: Feature Health Flags
    uint32_t health_bitmask = FEATURE_HEALTH_OK;
    bool is_feature_set_valid = true;
};

class Gate3FeatureHealthEngine {
public:
    static ExpandedFeatureSet compute_expanded_features(
        const std::vector<CanonicalOptionTick>& ticks,
        double open_price,
        double prev_close,
        double atr_14,
        double historical_avg_vol,
        double futures_price,
        double spot_price
    ) {
        ExpandedFeatureSet f;
        if (ticks.empty()) {
            f.is_feature_set_valid = false;
            f.health_bitmask |= FLAG_INSUFFICIENT_ORB_WINDOW;
            return f;
        }

        f.symbol = ticks.back().symbol;
        f.timestamp_ms = ticks.back().timestamp_ms;
        f.open_price = open_price;
        f.prev_close = prev_close;
        f.atr_14 = atr_14;
        f.futures_price = futures_price;
        f.spot_price = spot_price;

        // -----------------------------------------------------------------
        // G3-01: Gap & ATR Features (With Explicit Missingness Flags)
        // -----------------------------------------------------------------
        if (prev_close > 0.0) {
            f.gap_pct = (open_price - prev_close) / prev_close;
        } else {
            f.gap_pct = 0.0;
            f.health_bitmask |= FLAG_MISSING_PREV_CLOSE;
            f.is_feature_set_valid = false;
        }

        if (atr_14 > 0.0 && prev_close > 0.0) {
            f.gap_atr = (open_price - prev_close) / atr_14;
        } else {
            f.gap_atr = 0.0;
            f.health_bitmask |= FLAG_MISSING_ATR;
        }

        // VWAP computation
        double vwap_num = 0.0, vwap_den = 0.0;
        for (const auto& t : ticks) {
            vwap_num += (t.ltp * t.volume);
            vwap_den += t.volume;
        }
        f.vwap = (vwap_den > 0.0) ? (vwap_num / vwap_den) : ticks.back().ltp;

        // -----------------------------------------------------------------
        // G3-02: ORB-5/15/30 + Opening Impulse
        // -----------------------------------------------------------------
        double high_5 = -1e9, low_5 = 1e9;
        double high_15 = -1e9, low_15 = 1e9;
        double high_30 = -1e9, low_30 = 1e9;

        uint64_t start_ms = ticks.front().timestamp_ms;
        for (const auto& t : ticks) {
            uint64_t elapsed_min = (t.timestamp_ms >= start_ms) ? ((t.timestamp_ms - start_ms) / 60000) : 0;
            if (elapsed_min < 5) {
                if (t.ltp > high_5) high_5 = t.ltp;
                if (t.ltp < low_5) low_5 = t.ltp;
            }
            if (elapsed_min < 15) {
                if (t.ltp > high_15) high_15 = t.ltp;
                if (t.ltp < low_15) low_15 = t.ltp;
            }
            if (elapsed_min < 30) {
                if (t.ltp > high_30) high_30 = t.ltp;
                if (t.ltp < low_30) low_30 = t.ltp;
            }
        }

        f.orb_5_high = (high_5 > -1e8) ? high_5 : ticks.back().ltp;
        f.orb_5_low = (low_5 < 1e8) ? low_5 : ticks.back().ltp;
        f.orb_15_high = (high_15 > -1e8) ? high_15 : f.orb_5_high;
        f.orb_15_low = (low_15 < 1e8) ? low_15 : f.orb_5_low;
        f.orb_30_high = (high_30 > -1e8) ? high_30 : f.orb_15_high;
        f.orb_30_low = (low_30 < 1e8) ? low_30 : f.orb_15_low;

        if (atr_14 > 0.0) {
            f.opening_impulse = (ticks.back().ltp - open_price) / atr_14;
        } else {
            f.opening_impulse = 0.0;
        }

        // -----------------------------------------------------------------
        // G3-03: Relative Volume & Futures Basis
        // -----------------------------------------------------------------
        if (historical_avg_vol > 0.0) {
            f.relative_volume = static_cast<double>(vwap_den) / historical_avg_vol;
        } else {
            f.relative_volume = 0.0;
            f.health_bitmask |= FLAG_MISSING_HISTORICAL_VOL;
        }

        if (futures_price > 0.0 && spot_price > 0.0) {
            f.futures_basis = futures_price - spot_price;
        } else {
            f.futures_basis = 0.0;
            f.health_bitmask |= FLAG_MISSING_FUTURES_SPOT;
        }

        // -----------------------------------------------------------------
        // G3-04: OI Delta, PCR Volume/OI, Strike Concentration
        // -----------------------------------------------------------------
        double max_strike_oi = 0.0;
        double total_oi = 0.0;
        for (const auto& t : ticks) {
            if (t.option_type == "CE") {
                f.total_call_oi += t.open_interest;
                f.total_call_vol += t.volume;
            } else if (t.option_type == "PE") {
                f.total_put_oi += t.open_interest;
                f.total_put_vol += t.volume;
            }
            total_oi += t.open_interest;
            if (t.open_interest > max_strike_oi) max_strike_oi = t.open_interest;
        }

        if (ticks.size() >= 2) {
            f.oi_delta = static_cast<double>(ticks.back().open_interest - ticks.front().open_interest);
        } else {
            f.oi_delta = 0.0;
        }

        f.pcr_volume = (f.total_call_vol > 0.0) ? (f.total_put_vol / f.total_call_vol) : 0.0;
        f.pcr_oi = (f.total_call_oi > 0.0) ? (f.total_put_oi / f.total_call_oi) : 0.0;
        f.strike_concentration = (total_oi > 0.0) ? (max_strike_oi / total_oi) : 0.0;

        return f;
    }
};

#endif // ENGINE_GATE3_FEATURE_HEALTH_HPP
