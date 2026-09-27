#ifndef ENGINE_TICK_RECEIVER_HPP
#define ENGINE_TICK_RECEIVER_HPP

#include <string>
#include <vector>
#include <queue>
#include <mutex>
#include <condition_variable>
#include <atomic>
#include <cstdint>

struct CanonicalOptionTick {
    std::string instrument_key; // e.g. "NSE:NIFTY26SEP24300CE"
    std::string symbol;         // e.g. "NIFTY"
    std::string option_type;    // "CE" or "PE"
    double strike = 0.0;
    double ltp = 0.0;
    double bid_price = 0.0;
    double ask_price = 0.0;
    int bid_qty = 0;
    int ask_qty = 0;
    int volume = 0;
    int open_interest = 0;
    int change_oi = 0;
    double iv = 0.0;
    uint64_t timestamp_ms = 0;
};

class LockFreeTickRingBuffer {
public:
    explicit LockFreeTickRingBuffer(size_t capacity = 65536);
    ~LockFreeTickRingBuffer();

    bool push(const CanonicalOptionTick& tick);
    bool pop(CanonicalOptionTick& tick);
    size_t size() const;
    bool empty() const;

private:
    std::vector<CanonicalOptionTick> buffer_;
    size_t capacity_;
    std::atomic<size_t> head_;
    std::atomic<size_t> tail_;
};

class OptionTickReceiver {
public:
    OptionTickReceiver();
    ~OptionTickReceiver();

    void start_receiver();
    void stop_receiver();
    void ingest_tick(const CanonicalOptionTick& tick);
    bool get_latest_tick(CanonicalOptionTick& out_tick);

    // Parsing methods for broker feeds
    static CanonicalOptionTick parse_fyers_payload(const std::string& raw_json);
    static CanonicalOptionTick parse_upstox_payload(const std::string& raw_json);

    uint64_t total_ticks_received() const { return total_ticks_received_.load(); }

private:
    LockFreeTickRingBuffer ring_buffer_;
    std::atomic<bool> running_;
    std::atomic<uint64_t> total_ticks_received_;
};

#endif // ENGINE_TICK_RECEIVER_HPP
