#ifndef HERMES_GATE5_OFI_MICROPRICE_HPP
#define HERMES_GATE5_OFI_MICROPRICE_HPP

#include <string>
#include <vector>
#include <array>
#include <cstdint>
#include <cmath>

namespace hermes {

// Max order book levels supported (Upstox/Fyers: L5 depth max, L1 standard)
constexpr size_t MAX_BOOK_LEVELS = 5;

struct LevelSnapshot {
    double bid_price{0.0};
    double bid_qty{0.0};
    double ask_price{0.0};
    double ask_qty{0.0};
};

struct OrderBookSnapshot {
    std::string symbol;
    uint64_t timestamp_ms{0};
    size_t levels_available{0}; // 1 for L1 feed, 5 for L5 depth
    std::array<LevelSnapshot, MAX_BOOK_LEVELS> levels{};
    double last_traded_price{0.0};
    double last_traded_qty{0.0};
};

struct OFIMicropriceResult {
    std::string symbol;
    uint64_t timestamp_ms{0};
    
    // Microprice & degradation state
    double microprice{0.0};
    double mid_price{0.0};
    double spread{0.0};
    bool l1_degradation_active{false};
    
    // Order Flow Imbalance metrics
    double obi_l1{0.0};           // Single level Order Book Imbalance [-1.0, 1.0]
    double ofi_l1{0.0};           // Cont-Stoikov L1 Order Flow Imbalance
    double mlofi{0.0};            // Multi-Level Weighted OFI
    
    // Microstructure dynamics (G5-02)
    double spread_shock_ratio{0.0};     // Current spread / trailing EMA spread
    double bid_cancellation_vol{0.0};  // Cancellation volume at best bid
    double ask_cancellation_vol{0.0};  // Cancellation volume at best ask
    double bid_replenish_vol{0.0};     // Replenishment volume at best bid
    double ask_replenish_vol{0.0};     // Replenishment volume at best ask
    double order_intensity{0.0};        // Updates / sec
    
    // Hypothesis metrics (G5-03)
    double stacked_imbalance_score{0.0}; // [0.0, 1.0] hypothesis score
    double absorption_hypothesis_score{0.0}; // [0.0, 1.0] passive volume absorption score
    
    // Diagnostics
    size_t levels_used{0};
    std::string summary_json() const;
};

class MicrostructureEngine {
public:
    explicit MicrostructureEngine(size_t max_history = 50);
    
    // Process incoming order book snapshot
    OFIMicropriceResult process_snapshot(const OrderBookSnapshot& current);

    // Reset state for test or session change
    void reset();

private:
    size_t max_history_;
    bool has_previous_{false};
    OrderBookSnapshot prev_snapshot_{};
    
    // Trailing metrics for spread shock
    double trailing_spread_ema_{0.0};
    double ema_alpha_{0.1}; // 10-period EMA
    
    // Historical volume tracking for absorption hypothesis
    double absorbed_volume_at_bid_{0.0};
    double absorbed_volume_at_ask_{0.0};
    double prev_bid_price_{0.0};
    double prev_ask_price_{0.0};
    
    // Helper calculators
    static double calculate_level_ofi(const LevelSnapshot& curr, const LevelSnapshot& prev);
    double calculate_stacked_imbalance(const OrderBookSnapshot& snap) const;
    double calculate_absorption_hypothesis(const OrderBookSnapshot& curr, const OrderBookSnapshot& prev);
};

} // namespace hermes

#endif // HERMES_GATE5_OFI_MICROPRICE_HPP
