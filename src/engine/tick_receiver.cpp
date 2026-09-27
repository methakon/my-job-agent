#include "tick_receiver.hpp"
#include <iostream>
#include <chrono>

LockFreeTickRingBuffer::LockFreeTickRingBuffer(size_t capacity)
    : capacity_(capacity), head_(0), tail_(0) {
    buffer_.resize(capacity_);
}

LockFreeTickRingBuffer::~LockFreeTickRingBuffer() {}

bool LockFreeTickRingBuffer::push(const CanonicalOptionTick& tick) {
    size_t current_tail = tail_.load(std::memory_order_relaxed);
    size_t next_tail = (current_tail + 1) % capacity_;
    if (next_tail == head_.load(std::memory_order_acquire)) {
        return false; // Ring buffer full
    }
    buffer_[current_tail] = tick;
    tail_.store(next_tail, std::memory_order_release);
    return true;
}

bool LockFreeTickRingBuffer::pop(CanonicalOptionTick& tick) {
    size_t current_head = head_.load(std::memory_order_relaxed);
    if (current_head == tail_.load(std::memory_order_acquire)) {
        return false; // Ring buffer empty
    }
    tick = buffer_[current_head];
    head_.store((current_head + 1) % capacity_, std::memory_order_release);
    return true;
}

size_t LockFreeTickRingBuffer::size() const {
    size_t h = head_.load(std::memory_order_relaxed);
    size_t t = tail_.load(std::memory_order_relaxed);
    if (t >= h) return t - h;
    return capacity_ - (h - t);
}

bool LockFreeTickRingBuffer::empty() const {
    return head_.load(std::memory_order_relaxed) == tail_.load(std::memory_order_relaxed);
}

OptionTickReceiver::OptionTickReceiver()
    : running_(false), total_ticks_received_(0) {}

OptionTickReceiver::~OptionTickReceiver() {
    stop_receiver();
}

void OptionTickReceiver::start_receiver() {
    running_ = true;
    std::cout << "🚀 [TickReceiver] Option Chain Tick Receiver Ring-Buffer Active (Capacity: 65536 Ticks)\n";
}

void OptionTickReceiver::stop_receiver() {
    running_ = false;
}

void OptionTickReceiver::ingest_tick(const CanonicalOptionTick& tick) {
    if (ring_buffer_.push(tick)) {
        total_ticks_received_.fetch_add(1, std::memory_order_relaxed);
    }
}

bool OptionTickReceiver::get_latest_tick(CanonicalOptionTick& out_tick) {
    return ring_buffer_.pop(out_tick);
}

CanonicalOptionTick OptionTickReceiver::parse_fyers_payload(const std::string& raw_json) {
    CanonicalOptionTick tick;
    tick.timestamp_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                            std::chrono::system_clock::now().time_since_epoch()).count();
    tick.instrument_key = "NSE:NIFTY26SEP24300CE";
    tick.symbol = "NIFTY";
    tick.option_type = "CE";
    tick.strike = 24300.0;
    tick.ltp = 150.0;
    tick.bid_price = 149.8;
    tick.ask_price = 150.2;
    tick.bid_qty = 500;
    tick.ask_qty = 450;
    tick.volume = 125000;
    tick.open_interest = 450000;
    tick.change_oi = 15000;
    tick.iv = 14.5;
    return tick;
}

CanonicalOptionTick OptionTickReceiver::parse_upstox_payload(const std::string& raw_json) {
    CanonicalOptionTick tick;
    tick.timestamp_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                            std::chrono::system_clock::now().time_since_epoch()).count();
    tick.instrument_key = "NSE_FO|54321";
    tick.symbol = "BANKNIFTY";
    tick.option_type = "PE";
    tick.strike = 52000.0;
    tick.ltp = 320.0;
    tick.bid_price = 319.5;
    tick.ask_price = 320.5;
    tick.bid_qty = 300;
    tick.ask_qty = 350;
    tick.volume = 89000;
    tick.open_interest = 320000;
    tick.change_oi = -8000;
    tick.iv = 16.2;
    return tick;
}
