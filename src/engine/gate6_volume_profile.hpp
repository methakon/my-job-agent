#ifndef HERMES_GATE6_VOLUME_PROFILE_HPP
#define HERMES_GATE6_VOLUME_PROFILE_HPP

#include <string>
#include <vector>
#include <map>
#include <cstdint>

namespace hermes {

enum class ValueMigrationState {
    INSIDE = 0,
    MIGRATING_HIGHER,
    MIGRATING_LOWER,
    OVERLAPPING_HIGH,
    OVERLAPPING_LOW
};

enum class FailedAuctionType {
    NONE = 0,
    FAILED_BREAKOUT_ABOVE_VAH,
    FAILED_BREAKOUT_BELOW_VAL
};

struct VolumeNode {
    double price_bin{0.0};
    double volume{0.0};
    bool is_hvn{false}; // High Volume Node
    bool is_lvn{false}; // Low Volume Node
};

struct VolumeProfileMetrics {
    std::string symbol;
    uint64_t timestamp_ms{0};
    std::string va_method_version{"VA_METHOD_V1_70_PERCENT"};
    
    double poc{0.0};          // Point of Control price
    double vah{0.0};          // Value Area High price
    double val{0.0};          // Value Area Low price
    double total_volume{0.0};
    double value_area_volume{0.0};
    
    std::vector<VolumeNode> hvn_nodes;
    std::vector<VolumeNode> lvn_nodes;
    
    // G6-02: Value Migration & Failed Auction Metrics
    ValueMigrationState migration_state{ValueMigrationState::INSIDE};
    FailedAuctionType failed_auction_type{FailedAuctionType::NONE};
    double failed_auction_confidence{0.0}; // [0.0, 1.0]
    
    std::string summary_json() const;
};

class VolumeProfileEngine {
public:
    explicit VolumeProfileEngine(double tick_size = 5.0, double va_percentage = 0.70);
    
    // Add trade tick to active session volume profile
    void add_trade(double price, double volume);
    
    // Compute current volume profile & Auction Market Theory metrics
    VolumeProfileMetrics compute_profile(
        const std::string& symbol,
        uint64_t timestamp_ms,
        double prev_vah = 0.0,
        double prev_val = 0.0
    );

    // Reset profile for new session or replay test
    void reset();

private:
    double tick_size_;
    double va_percentage_;
    std::map<int64_t, double> volume_bins_; // price_key -> volume
    
    int64_t price_to_key(double price) const;
    double key_to_price(int64_t key) const;
};

} // namespace hermes

#endif // HERMES_GATE6_VOLUME_PROFILE_HPP
