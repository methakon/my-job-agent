#include "common/env_loader.hpp"
#include "roadmap/db_client.hpp"
#include "roadmap/roadmap_server.hpp"
#include "engine/tick_receiver.hpp"
#include "engine/feature_engine.hpp"
#include "engine/backtest_engine.hpp"
#include "engine/gate11_strategy_taxonomy.hpp"
#include "engine/gate16_risk_limits.hpp"
#include "engine/gate22_seasonality_patterns.hpp"
#include "engine/hardware_config.hpp"
#include <iostream>
#include <memory>
#include <thread>

int main(int argc, char* argv[]) {
    std::cout << "===================================================================\n";
    std::cout << "       ⚡ C++ AUTONOMOUS TRADING AGENT & ROADMAP SERVER ⚡\n";
    std::cout << "===================================================================\n";

    // Load environment configuration from .env file
    EnvLoader::load(".env");

    std::string remote_host = EnvLoader::get("MYSQL_REMOTE_HOST", EnvLoader::get("MYSQL_HOST", "127.0.0.1"));
    int remote_port = EnvLoader::get_int("MYSQL_REMOTE_PORT", EnvLoader::get_int("MYSQL_PORT", 3307));
    std::string remote_user = EnvLoader::get("MYSQL_REMOTE_USER", EnvLoader::get("MYSQL_USER", "mylife"));
    std::string remote_pass = EnvLoader::get("MYSQL_REMOTE_PASSWORD", EnvLoader::get("MYSQL_PASSWORD", ""));
    std::string remote_db = EnvLoader::get("MYSQL_REMOTE_NAME", EnvLoader::get("DATABASE_NAME", "myjob_agent"));

    std::string local_host = EnvLoader::get("MYSQL_LOCAL_HOST", "127.0.0.1");
    int local_port = EnvLoader::get_int("MYSQL_LOCAL_PORT", 3306);
    std::string local_user = EnvLoader::get("MYSQL_LOCAL_USER", "mylife");
    std::string local_pass = EnvLoader::get("MYSQL_LOCAL_PASSWORD", "");
    std::string local_db = EnvLoader::get("MYSQL_LOCAL_NAME", "myjob_agent");

    int server_port = EnvLoader::get_int("ROADMAP_PORT", 8080);

    std::cout << "🌐 [Init] Remote Server DB (Tokens & Accounts): " << remote_host << ":" << remote_port << "/" << remote_db << "\n";
    std::cout << "⚡ [Init] Local Fast DB (Ticks & Historical Candles): " << local_host << ":" << local_port << "/" << local_db << "\n";
    std::cout << "[Init] HTTP Roadmap Server Port: " << server_port << "\n";

    // Launch HTTP Web Portal INSTANTLY at launch
    auto server = std::make_shared<RoadmapServer>(server_port, nullptr);
    std::thread http_thread([server]() {
        server->start();
    });
    http_thread.detach();

    auto db_client = std::make_shared<RoadmapDbClient>(
        remote_host, remote_port, remote_user, remote_pass, remote_db,
        local_host, local_port, local_user, local_pass, local_db
    );
    server->set_db_client(db_client);

    if (db_client->test_connection()) {
        std::cout << "✅ [Remote Database] Remote Server Connection Successful (Tokens & Common Data)!\n";
    } else {
        std::cerr << "⚠️ [Remote Database] Connection check failed. Please verify SSH tunnel at " << remote_host << ":" << remote_port << "\n";
    }

    if (db_client->test_local_connection()) {
        std::cout << "⚡ [Local Database] Local DB Connection Active (High-Frequency Ticks & Historical Candles)!\n";
    }

    // Initialize Step 1: Option Chain Tick Receiver
    OptionTickReceiver receiver;
    receiver.start_receiver();

    // Detect Hardware & Dynamically Size Worker Thread Pool
    HardwareSpec hw_spec = HardwareManager::detect_hardware();
    std::cout << "⚡ [HardwareManager] Core Count: " << hw_spec.total_logical_cores
              << " Threads | Allocated Worker Pool: " << hw_spec.allocated_worker_threads
              << " Threads (I/O Reserved: " << hw_spec.reserved_io_threads
              << " Threads) | Memory Capacity: " << hw_spec.total_memory_mb << " MB\n";

    CpuParallelDecisionBackend cpu_backend;
    SoakTestTelemetryMonitor soak_monitor;
    std::cout << "🧩 [Architecture] Initialized Modular Backend: " << cpu_backend.backend_name() << "\n";

    // Launch Background Token Validation & Live Tick Ingestion Supervisor Thread IMMEDIATELY
    std::thread supervisor_thread([db_client, &receiver, &soak_monitor]() {
        bool last_active_state = false;
        int check_counter = 0;
        size_t total_saved_ticks = 0;
        std::string last_seen_ts = "2026-09-30 00:00:00.000000";
        std::cout << "🛡️ [Supervisor] Token Validation & Ingestion Supervisor Thread Started.\n";

        auto is_exact_canonical_match = [](const std::string& trade_instrument, const CanonicalOptionTick& t) -> bool {
            if (trade_instrument.empty()) return false;
            if (!t.symbol.empty() && trade_instrument == t.symbol) return true;
            if (!t.instrument_key.empty() && trade_instrument == t.instrument_key) return true;
            if (!t.symbol.empty() && !t.instrument_key.empty()) {
                std::string expected_fmt = t.symbol + " (" + t.instrument_key + ")";
                if (trade_instrument == expected_fmt) return true;
            }
            return false;
        };

        MicrostructureFeatureEngine feature_engine;
        hermes::GapFadeP0Strategy p0_strategy;
        hermes::SeasonalityPatternEngine seasonality_engine(20); // 20 session-days gating threshold
        hermes::IndependentRiskEngine risk_engine(
            EnvLoader::get_double("MAX_PER_TRADE_RISK", 2000.0),
            EnvLoader::get_double("MAX_AGGREGATE_CAPITAL", 100000.0),
            EnvLoader::get_double("MAX_SESSION_DRAWDOWN", 5000.0)
        );

        // In-memory hot-path cache for open trades and portfolio state to eliminate DB queries from tick loop
        std::vector<UserTradeData> cached_open_trades;
        UserPortfolioData cached_portfolio = db_client->fetch_user_portfolio("cpp-portfolio-v1");
        uint64_t last_cache_update_ticks = 0;

        auto refresh_trade_cache = [&]() {
            cached_open_trades = db_client->fetch_user_trades("cpp-shadow", 1000);
            cached_portfolio = db_client->fetch_user_portfolio("cpp-portfolio-v1");
        };

        refresh_trade_cache();

        while (true) {
            check_counter++;
            // Periodically analyze archived tick history and update seasonality hypothesis records (every 300 cycles)
            if (check_counter % 300 == 1) {
                auto archived_rows = db_client->fetch_archived_tick_samples(30);
                if (!archived_rows.empty()) {
                    auto patterns = seasonality_engine.analyze_archived_ticks(archived_rows);
                    for (const auto& p : patterns) {
                        db_client->save_seasonality_pattern_record(
                            p.pattern_id, p.underlying, p.time_bucket_15m, p.day_of_week, p.days_to_expiry,
                            p.sample_ticks_count, p.sample_session_days, p.realized_volatility,
                            p.directional_persistence, p.avg_spread_pct, p.avg_oi_buildup_rate,
                            p.min_required_session_days,
                            (p.gating_status == hermes::SeasonalityGatingStatus::VALIDATED_GATED ? "VALIDATED_GATED" : "RESEARCH_ONLY"),
                            p.advisory_confidence_modifier, p.hypothesis_summary
                        );
                    }
                }
            }

            // Poll read-only shared upstox_live_paper_option_quotes table for new live market ticks
            auto new_ticks = db_client->fetch_live_quotes_since(last_seen_ts);
            for (const auto& tick : new_ticks) {
                receiver.ingest_tick(tick);
                if (!tick.raw_timestamp.empty()) {
                    last_seen_ts = tick.raw_timestamp;
                }
            }

            // Periodically refresh in-memory trade/portfolio cache every 2,000 ticks
            if (total_saved_ticks - last_cache_update_ticks >= 2000) {
                refresh_trade_cache();
                last_cache_update_ticks = total_saved_ticks;
            }

            // Drain ring buffer and evaluate ticks across feature engine & risk limits
            CanonicalOptionTick tick;
            while (receiver.get_latest_tick(tick)) {
                total_saved_ticks++;

                // Evaluate OPEN paper positions in RAM memory (0ms DB overhead)
                for (auto& tr : cached_open_trades) {
                    if (tr.status == "OPEN" && tick.ltp > 0) {
                        // Strict exact canonical equality matching check
                        if (!is_exact_canonical_match(tr.instrument, tick)) {
                            continue;
                        }

                        double position_return_pct = (tr.side == "BUY") 
                            ? ((tick.ltp - tr.entryPrice) / (tr.entryPrice > 0 ? tr.entryPrice : 1.0))
                            : ((tr.entryPrice - tick.ltp) / (tr.entryPrice > 0 ? tr.entryPrice : 1.0));

                        if (position_return_pct >= 0.50) {
                            double exit_px = (tr.side == "BUY") ? (tick.bid_price > 0 ? tick.bid_price : tick.ltp) : (tick.ask_price > 0 ? tick.ask_price : tick.ltp);
                            double gross_pnl = (tr.side == "BUY") ? (tr.quantity * (exit_px - tr.entryPrice)) : (tr.quantity * (tr.entryPrice - exit_px));
                            double cost = 40.0;
                            double net_pnl = gross_pnl - cost;
                            db_client->close_paper_trade(tr.id, exit_px, net_pnl, cost);
                            risk_engine.record_trade_result(net_pnl);
                            tr.status = "CLOSED";
                            refresh_trade_cache();
                            std::cout << "🎯 [ExitEngine] TAKE_PROFIT Triggered! Trade " << tr.id << " (" << tr.instrument << ") Closed @ ₹" << exit_px << " | Net PnL: ₹" << net_pnl << "\n";
                        } else if (position_return_pct <= -0.25) {
                            double exit_px = (tr.side == "BUY") ? (tick.bid_price > 0 ? tick.bid_price : tick.ltp) : (tick.ask_price > 0 ? tick.ask_price : tick.ltp);
                            double gross_pnl = (tr.side == "BUY") ? (tr.quantity * (exit_px - tr.entryPrice)) : (tr.quantity * (tr.entryPrice - exit_px));
                            double cost = 40.0;
                            double net_pnl = gross_pnl - cost;
                            db_client->close_paper_trade(tr.id, exit_px, net_pnl, cost);
                            risk_engine.record_trade_result(net_pnl);
                            tr.status = "CLOSED";
                            refresh_trade_cache();
                            std::cout << "🛑 [ExitEngine] STOP_LOSS Triggered! Trade " << tr.id << " (" << tr.instrument << ") Closed @ ₹" << exit_px << " | Net PnL: ₹" << net_pnl << "\n";
                        }
                    }
                }

                auto feat = feature_engine.process_tick(tick);

                static std::atomic<uint64_t> decision_seq{1};

                // OFI Microstructure Option Strategy Trigger (requires high order flow imbalance + volume)
                bool is_option_contract = !tick.symbol.empty() && tick.symbol != "NIFTY" && tick.symbol != "BANKNIFTY" && tick.symbol != "SENSEX";
                bool is_ofi_breakout = is_option_contract && (std::abs(feat.order_flow_imbalance) >= 0.85) && (tick.volume >= 100);

                if (is_ofi_breakout) {
                    std::string side = (feat.order_flow_imbalance > 0.0) ? "BUY" : "SELL";
                    std::string option_kind = (tick.option_type.empty() ? "CE" : tick.option_type);
                    std::string symbol = tick.symbol;
                    std::string inst = tick.instrument_key.empty() ? ("NSE:" + symbol) : tick.instrument_key;
                    std::string canonical_inst = symbol + " (" + inst + ")";

                    double seasonality_advisory_mod = seasonality_engine.get_advisory_confidence_modifier(
                        symbol, 10, 0, 3, 0, "OFI_Microstructure_Breakout"
                    );
                    double final_confidence = 0.85 * seasonality_advisory_mod;

                    int lot_size = 25;
                    if (symbol.find("BANKNIFTY") != std::string::npos || inst.find("BANKNIFTY") != std::string::npos) {
                        lot_size = 15;
                    } else if (symbol.find("SENSEX") != std::string::npos || inst.find("SENSEX") != std::string::npos) {
                        lot_size = 20;
                    }

                    double entry_px = (side == "BUY") ? (tick.ask_price > 0 ? tick.ask_price : tick.ltp)
                                                       : (tick.bid_price > 0 ? tick.bid_price : tick.ltp);
                    double spot_px = (tick.strike > 0.0) ? tick.strike : (symbol.find("SENSEX") != std::string::npos ? 75000.0 : (symbol.find("BANKNIFTY") != std::string::npos ? 54000.0 : 25000.0));
                    
                    double proposed_margin = hermes::IndependentRiskEngine::calculate_short_option_margin(side, lot_size, entry_px, spot_px);

                    double capital_in_hand = cached_portfolio.capital + cached_portfolio.netPnl;
                    std::string current_date_str = tick.raw_timestamp.length() >= 10 ? tick.raw_timestamp.substr(0, 10) : "";
                    risk_engine.update_daily_risk_base(capital_in_hand, current_date_str);

                    auto kelly_result = hermes::IndependentRiskEngine::calculate_kelly_lot_size("OFI_Microstructure_Breakout", symbol, side, entry_px, spot_px, capital_in_hand);

                    size_t open_positions_for_symbol = 0;
                    for (const auto& tr : cached_open_trades) {
                        if (tr.status == "OPEN" && tr.instrument == canonical_inst) {
                            open_positions_for_symbol++;
                        }
                    }

                    auto veto = risk_engine.verify_order_proposal(
                        symbol,
                        proposed_margin,
                        cached_portfolio.deployed,
                        0.0,
                        open_positions_for_symbol,
                        final_confidence,
                        capital_in_hand
                    );

                    auto now_ns = std::chrono::high_resolution_clock::now().time_since_epoch().count();
                    std::string uuid = "dj-" + std::to_string(now_ns) + "-" + std::to_string(decision_seq.fetch_add(1));

                    if (veto.risk_approved) {
                        db_client->log_decision_journal_record(uuid, "live-session", "f8c24c3", "1.0.0", symbol, side + "_" + option_kind, final_confidence, 0.05, "OFI_BULLISH_BREAKOUT_CONFIRMED", "{}");

                        UserTradeData trade;
                        trade.id = "cpp-paper-" + std::to_string(now_ns) + "-" + std::to_string(decision_seq.load());
                        trade.instrument = canonical_inst; // Exact canonical format: "SYMBOL (KEY)"
                        trade.side = side;
                        trade.quantity = lot_size;
                        trade.entryPrice = entry_px;
                        trade.exitPrice = 0.0;
                        trade.netPnl = 0.0;
                        trade.status = "OPEN";
                        trade.executionProvider = "UPSTOX_READONLY";
                        trade.executionMode = "PAPER";
                        trade.onRealData = 1;
                        trade.algoSource = "OFI_Microstructure_Breakout";
                        trade.signal_timestamp = tick.raw_timestamp;

                        db_client->create_paper_trade(trade);
                        refresh_trade_cache();
                    } else {
                        db_client->log_decision_journal_record(uuid, "live-session", "f8c24c3", "1.0.0", symbol, "NO_TRADE", final_confidence, 0.0, "RISK_VETO: " + veto.veto_reason, "{}");
                    }
                } else if (total_saved_ticks % 100 == 0) {
                    // Periodically sample evaluated candidate ticks every 100 ticks
                    auto now_ns = std::chrono::high_resolution_clock::now().time_since_epoch().count();
                    std::string uuid = "dj-" + std::to_string(now_ns) + "-" + std::to_string(decision_seq.fetch_add(1));
                    std::string symbol = tick.symbol.empty() ? "NIFTY" : tick.symbol;
                    db_client->log_decision_journal_record(uuid, "live-session", "f8c24c3", "1.0.0", symbol, "NO_TRADE", 0.0, 0.0, "EVALUATED_NO_ACTION: OFI_BELOW_BREAKOUT_THRESHOLD", "{}");

                }
            }

            if (check_counter % 2 == 0) {
                soak_monitor.log_telemetry_snapshot(total_saved_ticks, 1482);
                db_client->update_external_case_study_ltps();
                int settled = db_client->settle_expired_positions();
                if (settled > 0) {
                    std::cout << "⌛ [ExpiryEngine] Settled " << settled << " expired option positions past market close.\n";
                }
            }

            std::this_thread::sleep_for(std::chrono::seconds(2));
            check_counter++;
        }
    });
    supervisor_thread.detach();

    // Initialize Step 2 & 3: Backtest & SIMD Feature Engine Verification
    try {
        BacktestEngine backtest_engine(db_client);
        std::cout << "⚡ [Engine] Launching Parallel Backtest on " << hw_spec.allocated_worker_threads << " Worker Threads\n";
        BacktestResult b_res = backtest_engine.run_parallel_backtest("NIFTY", hw_spec.allocated_worker_threads);

        std::cout << "-------------------------------------------------------------------\n";
        std::cout << "📊 [Backtest Summary] Ticks Processed: " << b_res.total_ticks_processed << "\n";
        std::cout << "📊 [Backtest Summary] Total Trades: " << b_res.total_trades << " (Win Rate: " << b_res.win_rate_pct << "%)\n";
        std::cout << "📊 [Backtest Summary] Total Net PnL: ₹" << b_res.total_net_pnl << "\n";
        std::cout << "📊 [Backtest Summary] Max Drawdown: " << b_res.max_drawdown_pct << "%\n";
        std::cout << "📊 [Backtest Summary] Avg Decision Latency: " << b_res.avg_decision_latency_micros << " µs\n";
        std::cout << "-------------------------------------------------------------------\n";
    } catch (const std::exception& e) {
        std::cerr << "⚠️ [Engine Warning] Backtest engine deferred: " << e.what() << "\n";
    } catch (...) {
        std::cerr << "⚠️ [Engine Warning] Backtest engine deferred due to DB reconnect\n";
    }

    // Keep server process running persistently
    while (true) {
        std::this_thread::sleep_for(std::chrono::seconds(1));
    }

    return 0;
}

