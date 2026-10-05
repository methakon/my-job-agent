#ifndef ENGINE_FEATURE_ENGINE_HPP
#define ENGINE_FEATURE_ENGINE_HPP

#include "tick_receiver.hpp"
#include <string>
#include <vector>
#include <map>
#include <cmath>
#include <cstdint>

struct MicrostructureFeatures {
    std::string instrument_key;
    double order_flow_imbalance = 0.0;
    double vwap = 0.0;
    double microprice = 0.0;
    double vpin = 0.0;
    double iv_skew = 0.0;
    double iv_rank = 0.0;             // Multi-day IV rank/percentile
    double multi_day_oi_trend = 0.0;  // Multi-day OI buildup trend
    double rv_percentile = 0.0;       // Realized volatility percentile
    double gamma_flip_level = 0.0;
    double max_pain_strike = 0.0;
    uint64_t latency_micros = 0;
};

struct OrderBookHeatmapLevel {
    double strike = 0.0;
    std::string option_type;
    double call_oi = 0.0;
    double put_oi = 0.0;
    double call_vol = 0.0;
    double put_vol = 0.0;
    double call_bid_qty = 0.0;
    double call_ask_qty = 0.0;
    double put_bid_qty = 0.0;
    double put_ask_qty = 0.0;
    double liquidity_intensity = 0.0;
};

class MicrostructureFeatureEngine {
public:
    MicrostructureFeatureEngine();
    ~MicrostructureFeatureEngine();

    MicrostructureFeatures process_tick(const CanonicalOptionTick& tick);
    std::vector<OrderBookHeatmapLevel> compute_orderbook_heatmap(const std::vector<CanonicalOptionTick>& ticks);

    // Fast SIMD / Vectorized VWAP and OFI computation
    static double compute_vectorized_vwap(const double* prices, const double* volumes, size_t count);
    static double compute_ofi(double bid_qty_curr, double bid_qty_prev, double ask_qty_curr, double ask_qty_prev);

private:
    std::map<std::string, CanonicalOptionTick> prev_ticks_;
    std::map<std::string, double> vwap_num_accum_;
    std::map<std::string, double> vwap_den_accum_;
};

#endif // ENGINE_FEATURE_ENGINE_HPP
