#ifndef ENGINE_BACKTEST_ENGINE_HPP
#define ENGINE_BACKTEST_ENGINE_HPP

#include "tick_receiver.hpp"
#include "feature_engine.hpp"
#include "../roadmap/db_client.hpp"
#include <string>
#include <vector>
#include <memory>

struct BacktestResult {
    uint64_t total_ticks_processed = 0;
    int total_trades = 0;
    int winning_trades = 0;
    int losing_trades = 0;
    double initial_capital = 10000.0;
    double final_capital = 10000.0;
    double total_net_pnl = 0.0;
    double win_rate_pct = 0.0;
    double max_drawdown_pct = 0.0;
    // Per-trade Sharpe ratio: mean(trade P&L) / sample std-dev(trade P&L). NOT annualised: a
    // backtest over synthetic or short data has no meaningful trades-per-year to scale by. 0 when
    // there are fewer than two trades or the P&L has no dispersion.
    double sharpe_ratio = 0.0;
    // Net P&L divided by 5% of initial capital (+1). This is what `sharpe_ratio` used to hold: a
    // return-on-risk-capital figure with no volatility in it, so it was never a Sharpe ratio.
    double pnl_over_risk_capital = 0.0;
    std::vector<double> trade_pnls;   // realised P&L of each closed trade, in order
    double avg_decision_latency_micros = 0.0;
    double elapsed_time_seconds = 0.0;
};

// mean / sample standard deviation of `pnls`. 0 for fewer than two values or zero dispersion.
double per_trade_sharpe(const std::vector<double>& pnls);

class BacktestEngine {
public:
    explicit BacktestEngine(std::shared_ptr<RoadmapDbClient> db_client);
    ~BacktestEngine();

    BacktestResult run_parallel_backtest(const std::string& symbol = "NIFTY", size_t num_threads = 4);
    BacktestResult run_historical_replay(const std::vector<CanonicalOptionTick>& ticks);

private:
    std::shared_ptr<RoadmapDbClient> db_client_;
};

#endif // ENGINE_BACKTEST_ENGINE_HPP
