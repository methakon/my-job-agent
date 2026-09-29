#include "common/env_loader.hpp"
#include "roadmap/db_client.hpp"
#include "roadmap/roadmap_server.hpp"
#include "engine/tick_receiver.hpp"
#include "engine/feature_engine.hpp"
#include "engine/backtest_engine.hpp"
#include "engine/gate11_strategy_taxonomy.hpp"
#include "engine/gate16_risk_limits.hpp"
#include <iostream>
#include <memory>
#include <thread>

int main(int argc, char* argv[]) {
    std::cout << "===================================================================\n";
    std::cout << "       ⚡ C++ AUTONOMOUS TRADING AGENT & ROADMAP SERVER ⚡\n";
    std::cout << "===================================================================\n";

    // Load environment configuration from .env file
    EnvLoader::load(".env");

    std::string db_host = EnvLoader::get("MYSQL_HOST", "127.0.0.1");
    int db_port = EnvLoader::get_int("MYSQL_PORT", 3307);
    std::string db_user = EnvLoader::get("MYSQL_USER", "mylife");
    std::string db_pass = EnvLoader::get("MYSQL_PASSWORD", "");
    std::string db_name = EnvLoader::get("DATABASE_NAME", "myjob_agent");

    int server_port = EnvLoader::get_int("ROADMAP_PORT", 8080);

    std::cout << "[Init] Target DB: " << db_host << ":" << db_port << "/" << db_name << "\n";
    std::cout << "[Init] HTTP Roadmap Server Port: " << server_port << "\n";

    // Launch HTTP Web Portal INSTANTLY at launch
    auto server = std::make_shared<RoadmapServer>(server_port, nullptr);
    std::thread http_thread([server]() {
        server->start();
    });
    http_thread.detach();

    auto db_client = std::make_shared<RoadmapDbClient>(db_host, db_port, db_user, db_pass, db_name);
    server->set_db_client(db_client);

    if (db_client->test_connection()) {
        std::cout << "✅ [Database] Oracle Cloud MySQL Connection Successful!\n";
    } else {
        std::cerr << "⚠️ [Database] Connection check failed. Please verify SSH tunnel at " << db_host << ":" << db_port << "\n";
    }

    // Initialize Step 1: Option Chain Tick Receiver
    OptionTickReceiver receiver;
    receiver.start_receiver();

    // Initialize Step 2 & 3: Backtest & SIMD Feature Engine Verification
    try {
        BacktestEngine backtest_engine(db_client);
        unsigned int threads = std::thread::hardware_concurrency();
        if (threads == 0) threads = 4;

        std::cout << "⚡ [Engine] Hardware Thread Concurrency: " << threads << " Cores\n";
        BacktestResult b_res = backtest_engine.run_parallel_backtest("NIFTY", threads);

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

    // Launch Background Token Validation & Live Tick Ingestion Supervisor Thread
    std::thread supervisor_thread([db_client, &receiver]() {
        bool last_active_state = false;
        int check_counter = 0;
        std::cout << "🛡️ [Supervisor] Token Validation & Ingestion Supervisor Thread Started.\n";

        while (true) {
            std::this_thread::sleep_for(std::chrono::seconds(5));
            check_counter++;

            BrokerTokenInfo upstox_tok = db_client->fetch_broker_token_status("upstox");
            BrokerTokenInfo fyers_tok = db_client->fetch_broker_token_status("fyers");

            bool is_upstox_active = upstox_tok.is_valid && !db_client->fetch_active_broker_token_raw("upstox").empty();
            bool is_fyers_active = fyers_tok.is_valid && !db_client->fetch_active_broker_token_raw("fyers").empty();

            bool is_active = is_upstox_active || is_fyers_active;

            if (is_active) {
                if (!last_active_state) {
                    std::string active_provider = is_upstox_active ? "upstox" : "fyers";
                    std::cout << "✅ [TokenSupervisor] Active valid token detected for provider: " << active_provider
                              << ". Live market tick ingestion & paper trading supervisor ENABLED.\n";
                    last_active_state = true;
                }

                // Drain ring buffer ticks, evaluate P0 Gap Fade Strategy & Independent Risk Engine, execute paper trades
                MicrostructureFeatureEngine feature_engine;
                hermes::GapFadeP0Strategy p0_strategy;
                hermes::IndependentRiskEngine risk_engine(
                    EnvLoader::get_double("MAX_PER_TRADE_RISK", 25000.0),
                    EnvLoader::get_double("MAX_AGGREGATE_CAPITAL", 100000.0),
                    EnvLoader::get_double("MAX_SESSION_DRAWDOWN", 25000.0)
                );

                CanonicalOptionTick tick;
                size_t saved_ticks = 0;
                while (receiver.get_latest_tick(tick)) {
                    if (db_client->save_canonical_market_snapshot(tick)) {
                        saved_ticks++;

                        auto feat = feature_engine.process_tick(tick);
                        
                        hermes::StrategyInput strat_input;
                        strat_input.spot_price = tick.ltp > 0 ? tick.ltp : 100.0;
                        strat_input.open_price = tick.ltp > 0 ? tick.ltp : 100.0;
                        strat_input.prev_close = (tick.ltp > 0 ? tick.ltp : 100.0) - (feat.order_flow_imbalance * 0.3);
                        strat_input.relative_volume = std::max(1.0, (double)tick.volume / 1000.0);
                        strat_input.atr_14 = 50.0;

                        hermes::StrategyProposal prop = p0_strategy.evaluate(strat_input);
                        if (prop.action != hermes::StrategyAction::NO_ACTION) {
                            int lot_size = 25;
                            if (tick.symbol.find("BANKNIFTY") != std::string::npos || tick.instrument_key.find("BANKNIFTY") != std::string::npos) {
                                lot_size = 15;
                            } else if (tick.symbol.find("SENSEX") != std::string::npos || tick.instrument_key.find("SENSEX") != std::string::npos) {
                                lot_size = 20;
                            }

                            double proposed_risk = lot_size * (0.5 * strat_input.atr_14);
                            auto veto = risk_engine.verify_order_proposal(tick.symbol, proposed_risk, 0.0, 0.0, 0, prop.confidence_score);

                            if (veto.risk_approved) {
                                std::string side = (prop.action == hermes::StrategyAction::SELL_CALL_FADE) ? "SELL" : "BUY";
                                std::string symbol = tick.symbol.empty() ? "NIFTY" : tick.symbol;
                                std::string inst = tick.instrument_key.empty() ? ("NSE:" + symbol) : tick.instrument_key;

                                std::string uuid = "dj-" + std::to_string(tick.timestamp_ms);
                                db_client->log_decision_journal_record(uuid, "live-session", "f8c24c3", "1.0.0", symbol, side + "_CALL", prop.confidence_score, 0.05, prop.strategy_name + " triggered", "{}");

                                UserTradeData trade;
                                trade.id = "cpp-paper-" + std::to_string(tick.timestamp_ms);
                                trade.instrument = inst;
                                trade.side = side;
                                trade.quantity = lot_size;
                                trade.entryPrice = tick.ask_price > 0 ? tick.ask_price : (tick.ltp > 0 ? tick.ltp : 100.0);
                                trade.exitPrice = 0.0;
                                trade.netPnl = 0.0;
                                trade.status = "OPEN";
                                trade.executionProvider = is_upstox_active ? "UPSTOX" : "FYERS";
                                trade.executionMode = "PAPER";
                                trade.onRealData = 1;
                                trade.algoSource = prop.strategy_name;

                                if (db_client->create_paper_trade(trade)) {
                                    std::cout << "🚀 [TokenSupervisor] " << prop.strategy_name << " Executed Paper Trade & Persisted to fnf_trades: "
                                              << trade.id << " (" << trade.instrument << " " << trade.side << " @ ₹" << trade.entryPrice << ")\n";
                                }
                            }
                        }
                    }
                }
                if (saved_ticks > 0) {
                    std::cout << "📥 [TokenSupervisor] Ingested and saved " << saved_ticks << " live ticks to fnf_market_snapshots.\n";
                }
            } else {
                if (last_active_state || check_counter % 12 == 1) { // Log status every 60s or on state transition
                    std::cout << "⏳ [TokenSupervisor] No active provider token found in database. Waiting for external or web portal token generation...\n";
                    last_active_state = false;
                }
            }
        }
    });
    supervisor_thread.detach();

    // Keep server process running persistently
    while (true) {
        std::this_thread::sleep_for(std::chrono::seconds(1));
    }

    return 0;
}

