#include "gate17_cross_market.hpp"
#include <cmath>
#include <algorithm>
#include <iostream>

CrossMarketEventEngine::CrossMarketEventEngine() {
    latest_snapshot_ = {};
    latest_snapshot_.timestamp_ms = 0;
    latest_snapshot_.gift_nifty_price = 24300.0;
    latest_snapshot_.gift_nifty_basis = 15.0;
    latest_snapshot_.india_vix = 13.5;
    latest_snapshot_.vix_change_pct = 0.5;
    latest_snapshot_.usdinr = 83.85;
    latest_snapshot_.brent_crude = 75.20;
    latest_snapshot_.us_10y_yield = 4.12;
    latest_snapshot_.market_breadth_ratio = 1.45;
    latest_snapshot_.gift_nifty_valid = true;
    latest_snapshot_.vix_valid = true;
}

void CrossMarketEventEngine::set_component_enabled(bool enabled) {
    enabled_ = enabled;
}

bool CrossMarketEventEngine::is_component_enabled() const {
    return enabled_;
}

void CrossMarketEventEngine::add_scheduled_event(const ScheduledEvent& event) {
    events_.push_back(event);
    std::sort(events_.begin(), events_.end(), [](const ScheduledEvent& a, const ScheduledEvent& b) {
        return a.scheduled_timestamp_ms < b.scheduled_timestamp_ms;
    });
}

void CrossMarketEventEngine::update_cross_market_snapshot(const CrossMarketSnapshot& snapshot) {
    latest_snapshot_ = snapshot;
    historical_snapshots_.push_back(snapshot);
}

CrossMarketSnapshot CrossMarketEventEngine::get_latest_cross_market_snapshot() const {
    return latest_snapshot_;
}

EventDistanceResult CrossMarketEventEngine::compute_event_distance(uint64_t decision_timestamp_ms) const {
    EventDistanceResult result;
    if (!enabled_ || events_.empty()) {
        return result;
    }

    double min_distance_ms = 1e18;
    const ScheduledEvent* nearest_event = nullptr;

    for (const auto& ev : events_) {
        // Look for future or active events
        if (ev.scheduled_timestamp_ms >= decision_timestamp_ms) {
            double diff = static_cast<double>(ev.scheduled_timestamp_ms - decision_timestamp_ms);
            if (diff < min_distance_ms) {
                min_distance_ms = diff;
                nearest_event = &ev;
            }
        }
    }

    if (nearest_event) {
        result.has_upcoming_event = true;
        result.next_event_id = nearest_event->event_id;
        result.next_event_name = nearest_event->name;
        result.distance_minutes = min_distance_ms / (60.0 * 1000.0);
        result.impact_weight = nearest_event->impact_weight;
        result.event_active_window = (result.distance_minutes <= 30.0);
    }

    return result;
}

bool CrossMarketEventEngine::validate_no_lookahead(uint64_t decision_timestamp_ms, uint64_t feature_timestamp_ms, std::string& rejection_reason) const {
    if (feature_timestamp_ms > decision_timestamp_ms) {
        rejection_reason = "REJECT_LOOKAHEAD_FUTURE_EVENT_DATA: Feature timestamp (" + 
                           std::to_string(feature_timestamp_ms) + ") is after decision timestamp (" + 
                           std::to_string(decision_timestamp_ms) + ")";
        return false;
    }
    return true;
}

bool CrossMarketEventEngine::get_aligned_cross_market_features(uint64_t decision_timestamp_ms, CrossMarketSnapshot& out_snapshot) const {
    if (!enabled_) return false;

    // Find the latest snapshot whose timestamp_ms <= decision_timestamp_ms
    const CrossMarketSnapshot* best_match = nullptr;
    for (auto it = historical_snapshots_.rbegin(); it != historical_snapshots_.rend(); ++it) {
        if (it->timestamp_ms <= decision_timestamp_ms) {
            best_match = &(*it);
            break;
        }
    }

    if (best_match) {
        out_snapshot = *best_match;
        return true;
    } else if (latest_snapshot_.timestamp_ms <= decision_timestamp_ms) {
        out_snapshot = latest_snapshot_;
        return true;
    }

    return false;
}
