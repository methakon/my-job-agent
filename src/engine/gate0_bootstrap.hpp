#ifndef ENGINE_GATE0_BOOTSTRAP_HPP
#define ENGINE_GATE0_BOOTSTRAP_HPP

#include <string>
#include <vector>
#include <unordered_set>
#include <stdexcept>
#include <chrono>
#include <cstdint>
#include "../engine/tick_receiver.hpp"

// ============================================================================
// ITEM G0-01: Compile-Time HARD_PAPER_ONLY_GUARD
// ============================================================================
#define HERMES_COMPILE_TIME_PAPER_ONLY 1

enum class TradeAction {
    NO_TRADE,
    BUY_CALL,
    BUY_PUT,
    SELL_CALL,
    SELL_PUT,
    SQUARE_OFF
};

struct TradeDecision {
    TradeAction action = TradeAction::NO_TRADE;
    double confidence = 0.0;
    double allocated_margin = 0.0;
    std::string reason = "DEFAULT_NO_TRADE_INVARIANT";
    std::string symbol;
    std::string session_id;
};

class LiveOrderExecutionGuard {
public:
    static bool place_live_broker_order(const std::string& broker, const std::string& symbol, const std::string& side, int qty, double price, std::string& out_error) {
#if HERMES_COMPILE_TIME_PAPER_ONLY
        out_error = "HARD_GUARD_REJECTION: Compile-time HERMES_COMPILE_TIME_PAPER_ONLY guard active. Live order placement is strictly disabled.";
        return false;
#else
        out_error = "Live execution path not compiled";
        return false;
#endif
    }
};

// ============================================================================
// ITEM G0-02: Instrument Allowlist Enforced Pre-Feature Computation
// ============================================================================
class InstrumentAllowlist {
public:
    InstrumentAllowlist() {
        allowed_symbols_ = {"NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY"};
    }

    bool is_allowed(const std::string& symbol) const {
        return allowed_symbols_.find(symbol) != allowed_symbols_.end();
    }

    void add_symbol(const std::string& symbol) {
        allowed_symbols_.insert(symbol);
    }

private:
    std::unordered_set<std::string> allowed_symbols_;
};

// ============================================================================
// ITEM G0-03: Immutable Per-Session Capital Ceiling
// ============================================================================
class SessionCapitalGuard {
public:
    explicit SessionCapitalGuard(double session_capital_ceiling)
        : capital_ceiling_(session_capital_ceiling), current_allocated_(0.0) {
        if (session_capital_ceiling <= 0.0) {
            throw std::invalid_argument("Session capital ceiling must be strictly positive");
        }
    }

    double get_capital_ceiling() const { return capital_ceiling_; }
    double get_allocated_capital() const { return current_allocated_; }
    double get_remaining_capital() const { return capital_ceiling_ - current_allocated_; }

    bool request_capital_allocation(double required_margin, std::string& out_reason) {
        if (required_margin <= 0.0) {
            out_reason = "REJECTED: Required margin must be positive";
            return false;
        }
        if (current_allocated_ + required_margin > capital_ceiling_) {
            out_reason = "EXCEEDS_IMMUTABLE_SESSION_CAPITAL_CEILING: Required ₹" +
                         std::to_string(required_margin) + " exceeds remaining capital ₹" +
                         std::to_string(get_remaining_capital()) + " (Ceiling: ₹" +
                         std::to_string(capital_ceiling_) + ")";
            return false;
        }
        current_allocated_ += required_margin;
        out_reason = "CAPITAL_ALLOCATED_OK";
        return true;
    }

    void release_capital_allocation(double margin) {
        if (margin > 0.0) {
            current_allocated_ = (current_allocated_ >= margin) ? (current_allocated_ - margin) : 0.0;
        }
    }

private:
    const double capital_ceiling_;
    double current_allocated_;
};

// ============================================================================
// ITEM G0-04: Decision Engine Default to NO_TRADE
// ============================================================================
class DecisionEngineInvariant {
public:
    static TradeDecision evaluate_default_state() {
        TradeDecision d;
        // Default-initialized: action = NO_TRADE, confidence = 0.0, reason = DEFAULT_NO_TRADE_INVARIANT
        return d;
    }
};

// ============================================================================
// ITEM G0-05: Feed Provenance / Freshness / Quality Check
// ============================================================================
struct FeedQualityMetrics {
    std::string provenance = "UNKNOWN";
    uint64_t feed_timestamp_ms = 0;
    uint64_t received_timestamp_ms = 0;
    uint64_t staleness_micros = 0;
    double quality_score = 0.0;
    bool is_real_data = false;
    bool is_fresh = false;
};

class FeedQualityGuard {
public:
    static FeedQualityMetrics evaluate_tick_feed(const CanonicalOptionTick& tick, uint64_t current_time_ms, uint64_t max_allowed_staleness_micros = 500000) {
        FeedQualityMetrics m;
        m.provenance = tick.provenance.empty() ? "NSE_SIMULATOR" : tick.provenance;
        m.feed_timestamp_ms = (tick.timestamp_ms > 0) ? tick.timestamp_ms : current_time_ms;
        m.received_timestamp_ms = (tick.received_timestamp_ms > 0) ? tick.received_timestamp_ms : current_time_ms;

        if (m.received_timestamp_ms >= m.feed_timestamp_ms) {
            m.staleness_micros = (m.received_timestamp_ms - m.feed_timestamp_ms) * 1000;
        } else {
            m.staleness_micros = 0;
        }

        m.is_real_data = tick.is_real_data;
        m.is_fresh = (m.staleness_micros <= max_allowed_staleness_micros);

        // Quality score: 1.0 if fresh and non-zero bid/ask, penalize for staleness
        if (tick.ltp > 0.0 && tick.bid_price > 0.0 && tick.ask_price > 0.0 && tick.ask_price >= tick.bid_price) {
            m.quality_score = m.is_fresh ? 1.0 : 0.5;
        } else if (tick.ltp > 0.0) {
            m.quality_score = m.is_fresh ? 0.75 : 0.25;
        } else {
            m.quality_score = 0.0;
        }

        return m;
    }
};

// ============================================================================
// ITEM G0-06: Session Archival + Stale-Data Isolation Guard
// ============================================================================
class SessionArchivalGuard {
public:
    static std::string generate_session_id(const std::string& prefix = "HERMES") {
        auto now = std::chrono::system_clock::now();
        auto epoch_ms = std::chrono::duration_cast<std::chrono::milliseconds>(now.time_since_epoch()).count();
        return prefix + "-SESSION-" + std::to_string(epoch_ms);
    }

    SessionArchivalGuard(const std::string& session_id, double capital_ceiling)
        : session_id_(session_id), capital_guard_(capital_ceiling) {}

    const std::string& get_session_id() const { return session_id_; }
    SessionCapitalGuard& get_capital_guard() { return capital_guard_; }

    bool validate_tick_session(const std::string& tick_session_id) const {
        return tick_session_id == session_id_;
    }

private:
    std::string session_id_;
    SessionCapitalGuard capital_guard_;
};

#endif // ENGINE_GATE0_BOOTSTRAP_HPP
