#include "backtest_engine.hpp"
#include <iostream>
#include <chrono>
#include <thread>
#include <future>
#include <cmath>
#include <algorithm>

BacktestEngine::BacktestEngine(std::shared_ptr<RoadmapDbClient> db_client)
    : db_client_(db_client) {}

BacktestEngine::~BacktestEngine() {}

BacktestResult BacktestEngine::run_historical_replay(const std::vector<CanonicalOptionTick>& ticks) {
    auto start_time = std::chrono::high_resolution_clock::now();
    BacktestResult res;
    res.total_ticks_processed = ticks.size();
    res.initial_capital = 10000.0;

    MicrostructureFeatureEngine feature_engine;
    double current_capital = res.initial_capital;
    double peak_capital = current_capital;
    double max_dd = 0.0;
    uint64_t total_latency = 0;

    int open_pos = 0;
    double entry_price = 0.0;

    for (const auto& tick : ticks) {
        auto feat = feature_engine.process_tick(tick);
        total_latency += feat.latency_micros;

        // Simple Mean Reversion Strategy Trigger based on Order Flow Imbalance (OFI) & Microprice
        if (open_pos == 0 && feat.order_flow_imbalance > 100.0) {
            // BUY Signal
            open_pos = 1;
            entry_price = tick.ask_price > 0 ? tick.ask_price : tick.ltp;
        } else if (open_pos == 1 && (feat.order_flow_imbalance < -50.0 || tick.ltp >= entry_price * 1.05 || tick.ltp <= entry_price * 0.97)) {
            // SELL / Exit Signal
            double exit_price = tick.bid_price > 0 ? tick.bid_price : tick.ltp;
            double trade_pnl = (exit_price - entry_price) * 50; // NIFTY Lot size 50
            current_capital += trade_pnl;

            res.total_trades++;
            if (trade_pnl > 0) res.winning_trades++;
            else res.losing_trades++;

            open_pos = 0;
        }

        if (current_capital > peak_capital) peak_capital = current_capital;
        double dd = (peak_capital - current_capital) / peak_capital * 100.0;
        if (dd > max_dd) max_dd = dd;
    }

    auto end_time = std::chrono::high_resolution_clock::now();
    res.elapsed_time_seconds = std::chrono::duration<double>(end_time - start_time).count();

    res.final_capital = current_capital;
    res.total_net_pnl = current_capital - res.initial_capital;
    res.win_rate_pct = (res.total_trades > 0) ? ((double)res.winning_trades / res.total_trades * 100.0) : 0.0;
    res.max_drawdown_pct = max_dd;
    res.avg_decision_latency_micros = (res.total_ticks_processed > 0) ? ((double)total_latency / res.total_ticks_processed) : 0.0;
    res.sharpe_ratio = (res.total_trades > 0 && res.total_net_pnl != 0) ? (res.total_net_pnl / (res.initial_capital * 0.05 + 1.0)) : 0.0;

    return res;
}

BacktestResult BacktestEngine::run_parallel_backtest(const std::string& symbol, size_t num_threads) {
    std::cout << "⚡ [BacktestEngine] Launching Parallel Multi-Threaded Backtest (" << num_threads << " Worker Threads)\n";

    // Create synthetic canonical ticks for demonstration replay
    std::vector<CanonicalOptionTick> sample_ticks;
    for (int i = 0; i < 10000; ++i) {
        CanonicalOptionTick t;
        t.instrument_key = "NSE:" + symbol + "26SEP24300CE";
        t.symbol = symbol;
        t.option_type = "CE";
        t.strike = 24300.0;
        t.ltp = 150.0 + (i % 20) * 0.5 - (i % 13) * 0.3;
        t.bid_price = t.ltp - 0.2;
        t.ask_price = t.ltp + 0.2;
        t.bid_qty = 500 + (i % 7) * 50;
        t.ask_qty = 450 + (i % 5) * 60;
        t.volume = 1000 + i * 10;
        t.open_interest = 500000 + i * 100;
        t.timestamp_ms = 1727000000000 + i * 100;
        sample_ticks.push_back(t);
    }

    size_t chunk_size = sample_ticks.size() / num_threads;
    std::vector<std::future<BacktestResult>> futures;

    for (size_t t = 0; t < num_threads; ++t) {
        size_t start_idx = t * chunk_size;
        size_t end_idx = (t == num_threads - 1) ? sample_ticks.size() : (start_idx + chunk_size);
        std::vector<CanonicalOptionTick> chunk(sample_ticks.begin() + start_idx, sample_ticks.begin() + end_idx);

        futures.push_back(std::async(std::launch::async, [this, chunk]() {
            return this->run_historical_replay(chunk);
        }));
    }

    BacktestResult combined;
    for (auto& f : futures) {
        BacktestResult res = f.get();
        combined.total_ticks_processed += res.total_ticks_processed;
        combined.total_trades += res.total_trades;
        combined.winning_trades += res.winning_trades;
        combined.losing_trades += res.losing_trades;
        combined.total_net_pnl += res.total_net_pnl;
        combined.avg_decision_latency_micros += res.avg_decision_latency_micros;
        if (res.max_drawdown_pct > combined.max_drawdown_pct) {
            combined.max_drawdown_pct = res.max_drawdown_pct;
        }
    }

    combined.final_capital = combined.initial_capital + combined.total_net_pnl;
    combined.win_rate_pct = (combined.total_trades > 0) ? ((double)combined.winning_trades / combined.total_trades * 100.0) : 0.0;
    combined.avg_decision_latency_micros /= num_threads;

    return combined;
}
