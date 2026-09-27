#include "gate6_volume_profile.hpp"
#include <cmath>
#include <algorithm>
#include <sstream>
#include <iomanip>
#include <iostream>

namespace hermes {

VolumeProfileEngine::VolumeProfileEngine(double tick_size, double va_percentage)
    : tick_size_(tick_size), va_percentage_(va_percentage) {}

void VolumeProfileEngine::reset() {
    volume_bins_.clear();
}

int64_t VolumeProfileEngine::price_to_key(double price) const {
    return static_cast<int64_t>(std::round(price / tick_size_));
}

double VolumeProfileEngine::key_to_price(int64_t key) const {
    return static_cast<double>(key) * tick_size_;
}

void VolumeProfileEngine::add_trade(double price, double volume) {
    if (price <= 0.0 || volume <= 0.0) return;
    int64_t key = price_to_key(price);
    volume_bins_[key] += volume;
}

VolumeProfileMetrics VolumeProfileEngine::compute_profile(
    const std::string& symbol,
    uint64_t timestamp_ms,
    double prev_vah,
    double prev_val
) {
    VolumeProfileMetrics res;
    res.symbol = symbol;
    res.timestamp_ms = timestamp_ms;
    res.va_method_version = "VA_METHOD_V1_70_PERCENT";

    if (volume_bins_.empty()) {
        return res;
    }

    // 1. Calculate Total Volume and Find Point of Control (POC)
    double total_vol = 0.0;
    int64_t poc_key = volume_bins_.begin()->first;
    double max_vol = 0.0;

    std::vector<std::pair<int64_t, double>> sorted_bins;
    sorted_bins.reserve(volume_bins_.size());

    for (const auto& [key, vol] : volume_bins_) {
        total_vol += vol;
        sorted_bins.push_back({key, vol});
        if (vol > max_vol) {
            max_vol = vol;
            poc_key = key;
        }
    }

    res.total_volume = total_vol;
    res.poc = key_to_price(poc_key);

    // 2. Calculate 70% Value Area (VAH and VAL) using standard dual-expansion algorithm
    double target_va_vol = total_vol * va_percentage_;
    double accumulated_va_vol = max_vol;

    // Find index of POC key in sorted_bins
    auto poc_it = std::find_if(sorted_bins.begin(), sorted_bins.end(),
        [poc_key](const auto& pair) { return pair.first == poc_key; });
    
    size_t poc_idx = std::distance(sorted_bins.begin(), poc_it);
    size_t up_idx = poc_idx;
    size_t dn_idx = poc_idx;

    while (accumulated_va_vol < target_va_vol && (up_idx + 1 < sorted_bins.size() || dn_idx > 0)) {
        double up_vol = (up_idx + 1 < sorted_bins.size()) ? sorted_bins[up_idx + 1].second : 0.0;
        double dn_vol = (dn_idx > 0) ? sorted_bins[dn_idx - 1].second : 0.0;

        if (up_vol >= dn_vol && up_idx + 1 < sorted_bins.size()) {
            up_idx++;
            accumulated_va_vol += sorted_bins[up_idx].second;
        } else if (dn_idx > 0) {
            dn_idx--;
            accumulated_va_vol += sorted_bins[dn_idx].second;
        } else if (up_idx + 1 < sorted_bins.size()) {
            up_idx++;
            accumulated_va_vol += sorted_bins[up_idx].second;
        } else {
            break;
        }
    }

    res.val = key_to_price(sorted_bins[dn_idx].first);
    res.vah = key_to_price(sorted_bins[up_idx].first);
    res.value_area_volume = accumulated_va_vol;

    // 3. Classify HVNs and LVNs relative to average bin volume
    double avg_bin_vol = total_vol / static_cast<double>(sorted_bins.size());
    for (const auto& [key, vol] : sorted_bins) {
        double p = key_to_price(key);
        if (vol >= 1.5 * avg_bin_vol) {
            res.hvn_nodes.push_back({p, vol, true, false});
        } else if (vol <= 0.3 * avg_bin_vol) {
            res.lvn_nodes.push_back({p, vol, false, true});
        }
    }

    // 4. G6-02: Value Migration State relative to prev_vah / prev_val
    if (prev_vah > 0.0 && prev_val > 0.0) {
        double min_price = key_to_price(sorted_bins.front().first);
        double max_price = key_to_price(sorted_bins.back().first);

        if (res.val > prev_vah) {
            res.migration_state = ValueMigrationState::MIGRATING_HIGHER;
        } else if (res.vah < prev_val) {
            res.migration_state = ValueMigrationState::MIGRATING_LOWER;
        } else if (res.vah > prev_vah && res.val >= prev_val) {
            res.migration_state = ValueMigrationState::OVERLAPPING_HIGH;
        } else if (res.val < prev_val || min_price < prev_val) {
            res.migration_state = ValueMigrationState::OVERLAPPING_LOW;
        } else {
            res.migration_state = ValueMigrationState::INSIDE;
        }

        // Failed Auction Detection: Session probed beyond prev VA boundary but POC rejected back inside
        if (min_price < prev_val && res.poc >= prev_val) {
            res.failed_auction_type = FailedAuctionType::FAILED_BREAKOUT_BELOW_VAL;
            res.failed_auction_confidence = 0.85;
        } else if (max_price > prev_vah && res.poc <= prev_vah) {
            res.failed_auction_type = FailedAuctionType::FAILED_BREAKOUT_ABOVE_VAH;
            res.failed_auction_confidence = 0.85;
        }
    }

    return res;
}

std::string VolumeProfileMetrics::summary_json() const {
    std::ostringstream ss;
    ss << std::fixed << std::setprecision(2);
    ss << "{\"symbol\":\"" << symbol << "\",\"poc\":" << poc
       << ",\"vah\":" << vah << ",\"val\":" << val
       << ",\"total_volume\":" << total_volume
       << ",\"hvn_count\":" << hvn_nodes.size()
       << ",\"lvn_count\":" << lvn_nodes.size()
       << ",\"failed_auction\":" << static_cast<int>(failed_auction_type) << "}";
    return ss.str();
}

} // namespace hermes
