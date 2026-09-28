#include "common/env_loader.hpp"
#include "roadmap/db_client.hpp"
#include "roadmap/roadmap_server.hpp"
#include "engine/tick_receiver.hpp"
#include "engine/feature_engine.hpp"
#include "engine/backtest_engine.hpp"
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

                // Drain ring buffer ticks and persist to fnf_market_snapshots
                CanonicalOptionTick tick;
                size_t saved_ticks = 0;
                while (receiver.get_latest_tick(tick)) {
                    if (db_client->save_canonical_market_snapshot(tick)) {
                        saved_ticks++;
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

