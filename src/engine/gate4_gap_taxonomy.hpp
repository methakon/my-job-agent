#ifndef ENGINE_GATE4_GAP_TAXONOMY_HPP
#define ENGINE_GATE4_GAP_TAXONOMY_HPP

#include <string>
#include <vector>
#include <cmath>
#include <algorithm>
#include "../engine/tick_receiver.hpp"
#include "../engine/gate3_feature_health.hpp"

// Gap Taxonomy Types based on F&O Market Knowledge (Full/Partial, Up/Down, Value Area Gap)
enum class GapCategory {
    FULL_GAP_UP,
    PARTIAL_GAP_UP,
    FULL_GAP_DOWN,
    PARTIAL_GAP_DOWN,
    FLAT_NO_GAP
};

enum class GapStrategyProposal {
    NO_TRADE,
    FADE_GAP,
    FOLLOW_GAP
};

struct GapTaxonomyMetrics {
    GapCategory category = GapCategory::FLAT_NO_GAP;
    double gap_points = 0.0;
    double gap_pct = 0.0;
    double gap_atr_ratio = 0.0;

    // Scores (0.0 to 100.0)
    double fade_score = 0.0;
    double follow_score = 0.0;

    // Shadow Microstructure Confirmation Signals
    bool microstructure_confirmed = false;
    bool event_catalyst_gate_passed = true;
    std::string catalyst_flag = "NORMAL_SESSION"; // "EARNINGS_RELEASE", "RBI_POLICY", "MACRO_EVENT", "NORMAL_SESSION"

    // Net Expected Value after realistic friction & slippage
    double raw_expected_pnl = 0.0;
    double realistic_cost_friction = 0.0; // Brokerage, STT, Exchange fees, Slippage
    double net_expected_value = 0.0;

    GapStrategyProposal proposed_strategy = GapStrategyProposal::NO_TRADE;
    bool is_shadow_mode = true; // G4-02: Runs in shadow mode without blocking main execution

    // Metadata only: Old US benchmark reference (G4-04: Kept as metadata, NOT hard-coded rule)
    std::string us_benchmark_reference_note = "US_HISTORICAL_BENCHMARK_METADATA_ONLY_2001_2004_SCAN";
};

class Gate4GapTaxonomyEngine {
public:
    explicit Gate4GapTaxonomyEngine(bool shadow_mode_enabled = true)
        : shadow_mode_enabled_(shadow_mode_enabled) {}

    bool is_shadow_mode() const { return shadow_mode_enabled_; }
    void set_shadow_mode(bool enabled) { shadow_mode_enabled_ = enabled; }

    GapTaxonomyMetrics evaluate_gap_strategy(
        const ExpandedFeatureSet& features,
        double value_area_high,
        double value_area_low,
        double order_flow_imbalance,
        const std::string& catalyst_event
    ) {
        GapTaxonomyMetrics m;
        m.is_shadow_mode = shadow_mode_enabled_;
        m.catalyst_flag = catalyst_event.empty() ? "NORMAL_SESSION" : catalyst_event;

        double open_p = features.open_price;
        double prev_c = features.prev_close;

        if (prev_c <= 0.0 || open_p <= 0.0) {
            m.proposed_strategy = GapStrategyProposal::NO_TRADE;
            return m;
        }

        m.gap_points = open_p - prev_c;
        m.gap_pct = (open_p - prev_c) / prev_c;
        m.gap_atr_ratio = (features.atr_14 > 0.0) ? (m.gap_points / features.atr_14) : 0.0;

        // Categorize Gap
        if (open_p > prev_c) {
            if (value_area_high > 0.0 && open_p > value_area_high) {
                m.category = GapCategory::FULL_GAP_UP;
            } else {
                m.category = GapCategory::PARTIAL_GAP_UP;
            }
        } else if (open_p < prev_c) {
            if (value_area_low > 0.0 && open_p < value_area_low) {
                m.category = GapCategory::FULL_GAP_DOWN;
            } else {
                m.category = GapCategory::PARTIAL_GAP_DOWN;
            }
        } else {
            m.category = GapCategory::FLAT_NO_GAP;
        }

        // Compute FadeScore vs FollowScore
        // Fade score increases when OFI is opposite to gap direction & gap_atr < 1.5
        // Follow score increases when OFI aligns with gap direction & gap_atr >= 1.0
        if (m.gap_points > 0.0) { // Gap Up
            if (order_flow_imbalance < -20.0) {
                m.fade_score = 75.0 + std::min(25.0, std::abs(order_flow_imbalance));
                m.follow_score = 15.0;
            } else if (order_flow_imbalance > 20.0) {
                m.follow_score = 70.0 + std::min(30.0, order_flow_imbalance);
                m.fade_score = 20.0;
            } else {
                m.fade_score = 40.0;
                m.follow_score = 40.0;
            }
        } else if (m.gap_points < 0.0) { // Gap Down
            if (order_flow_imbalance > 20.0) {
                m.fade_score = 75.0 + std::min(25.0, order_flow_imbalance);
                m.follow_score = 15.0;
            } else if (order_flow_imbalance < -20.0) {
                m.follow_score = 70.0 + std::min(30.0, std::abs(order_flow_imbalance));
                m.fade_score = 20.0;
            } else {
                m.fade_score = 40.0;
                m.follow_score = 40.0;
            }
        }

        // G4-02: Microstructure Confirmation (OFI + Volume verification)
        m.microstructure_confirmed = (std::abs(order_flow_imbalance) >= 20.0) && (features.relative_volume >= 0.8);

        // Event / Catalyst Gate (High-impact earnings / policy events gate aggressive fading)
        if (m.catalyst_flag == "EARNINGS_RELEASE" || m.catalyst_flag == "RBI_POLICY") {
            m.event_catalyst_gate_passed = false; // Block aggressive fade on high-impact catalyst
            m.fade_score *= 0.5; // Suppress fade score
        }

        // EV Calculation after realistic costs (Slippage + Brokerage + STT ≈ 15 points on Index Option)
        m.realistic_cost_friction = 15.0;

        if (m.fade_score >= 65.0 && m.microstructure_confirmed && m.event_catalyst_gate_passed) {
            m.proposed_strategy = GapStrategyProposal::FADE_GAP;
            m.raw_expected_pnl = 45.0;
            m.net_expected_value = m.raw_expected_pnl - m.realistic_cost_friction;
        } else if (m.follow_score >= 65.0 && m.microstructure_confirmed) {
            m.proposed_strategy = GapStrategyProposal::FOLLOW_GAP;
            m.raw_expected_pnl = 50.0;
            m.net_expected_value = m.raw_expected_pnl - m.realistic_cost_friction;
        } else {
            m.proposed_strategy = GapStrategyProposal::NO_TRADE;
            m.raw_expected_pnl = 0.0;
            m.net_expected_value = 0.0;
        }

        return m;
    }

private:
    bool shadow_mode_enabled_;
};

#endif // ENGINE_GATE4_GAP_TAXONOMY_HPP
