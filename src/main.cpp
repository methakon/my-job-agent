#include "common/env_loader.hpp"
#include "roadmap/db_client.hpp"
#include "roadmap/roadmap_server.hpp"
#include "engine/tick_receiver.hpp"
#include "engine/feature_engine.hpp"
#include "engine/backtest_engine.hpp"
#include "engine/gate11_strategy_taxonomy.hpp"
#include "engine/gate16_risk_limits.hpp"
#include "engine/gate22_seasonality_patterns.hpp"
#include "engine/strategy_config_manager.hpp"
#include "engine/hardware_config.hpp"
#include "engine/position_exit_evaluator.hpp"
#include "engine/market_calendar.hpp"
#include "engine/daily_pnl_emailer.hpp"
#include "engine/post_session_analyzer.hpp"
#include "engine/pre_market_readiness_analyzer.hpp"
#include "market_data/broker_feed_supervisor.hpp"
#include <iostream>
#include <memory>
#include <thread>

#include <fcntl.h>
#include <unistd.h>
#include <csignal>

// Build revision, injected by CMake (see CMakeLists.txt). The fallback means a build outside a
// git tree reports "unknown" instead of silently claiming a revision it does not have.
#ifndef HERMES_BUILD_GIT_SHA
#define HERMES_BUILD_GIT_SHA "unknown"
#endif
static constexpr const char* kBuildGitSha = HERMES_BUILD_GIT_SHA;

int main(int argc, char* argv[]) {
    std::cout.setf(std::ios::unitbuf);
    std::cerr.setf(std::ios::unitbuf);

    std::cout << "===================================================================\n";
    std::cout << "       ⚡ C++ AUTONOMOUS TRADING AGENT & ROADMAP SERVER ⚡\n";
    std::cout << "===================================================================\n";

    // Load environment configuration from .env file
    EnvLoader::load(".env");

    // Optional Manual Operator CLI Trigger: Dispatch Test Daily P&L Email
    if (argc > 1 && (std::string(argv[1]) == "--test-email" || std::string(argv[1]) == "--send-test-summary-email")) {
        std::string remote_host = EnvLoader::get("MYSQL_REMOTE_HOST", EnvLoader::get("MYSQL_HOST", "10.0.0.99"));
        int remote_port = EnvLoader::get_int("MYSQL_REMOTE_PORT", EnvLoader::get_int("MYSQL_PORT", 3306));
        std::string remote_user = EnvLoader::get("MYSQL_REMOTE_USER", EnvLoader::get("MYSQL_USER", "mylife"));
        std::string remote_pass = EnvLoader::get("MYSQL_REMOTE_PASSWORD", EnvLoader::get("MYSQL_PASSWORD", ""));
        std::string remote_db = EnvLoader::get("MYSQL_REMOTE_NAME", EnvLoader::get("DATABASE_NAME", "myjob_agent"));
        auto test_db = std::make_shared<RoadmapDbClient>(remote_host, remote_port, remote_user, remote_pass, remote_db);

        std::cout << "\n📧 [Manual Test Trigger] Initializing DailyPnLEmailer for test dispatch...\n";
        hermes::DailyPnLEmailer emailer(test_db);
        auto cfg = emailer.load_config();
        std::cout << "• SMTP Host     : " << cfg.smtp_host << ":" << cfg.smtp_port << " (SSL: " << (cfg.use_ssl ? "true" : "false") << ")\n";
        std::cout << "• SMTP User     : " << (cfg.smtp_user.empty() ? "(EMPTY - set SMTP_USER in .env)" : cfg.smtp_user) << "\n";
        std::cout << "• SMTP Password : " << (cfg.smtp_password.empty() ? "(EMPTY - set SMTP_PASSWORD in .env)" : "[CONFIGURED - length " + std::to_string(cfg.smtp_password.length()) + "]") << "\n";
        std::cout << "• Sender        : " << cfg.sender << "\n";
        std::cout << "• Recipient     : " << (cfg.recipient.empty() ? "(EMPTY - set DAILY_PNL_EMAIL_RECIPIENT in .env)" : cfg.recipient) << "\n";
        std::cout << "• Config Enabled: " << (cfg.enabled ? "true" : "false") << "\n\n";

        hermes::PostSessionAnalysisReport test_report;
        test_report.total_ticks_ingested = 125000;
        test_report.evaluated_decisions_count = 1420;
        test_report.no_action_count = 1410;
        test_report.avg_confidence = 0.1284;
        test_report.max_confidence = 0.7420;
        test_report.near_miss_count = 10;
        test_report.risk_vetoes_count = 0;
        test_report.margin_vetoes_count = 0;

        char buf[32];
        auto now = std::chrono::system_clock::now();
        std::time_t t = std::chrono::system_clock::to_time_t(now);
        std::tm tm_now;
        localtime_r(&t, &tm_now);
        std::strftime(buf, sizeof(buf), "%Y-%m-%d", &tm_now);

        bool ok = emailer.send_daily_summary_email(buf, test_report);
        if (ok) {
            std::cout << "✅ [Manual Test Trigger] Email dispatch SUCCESSFUL.\n";
            return 0;
        } else {
            std::cerr << "❌ [Manual Test Trigger] Email dispatch FAILED or SKIPPED. Verify credentials in .env and network connection.\n";
            return 1;
        }
    }

    // Optional Manual Operator CLI Trigger: Dispatch Test Pre-Market Blocked Readiness Alert
    if (argc > 1 && (std::string(argv[1]) == "--test-alert" || std::string(argv[1]) == "--test-premarket-alert")) {
        std::string remote_host = EnvLoader::get("MYSQL_REMOTE_HOST", EnvLoader::get("MYSQL_HOST", "10.0.0.99"));
        int remote_port = EnvLoader::get_int("MYSQL_REMOTE_PORT", EnvLoader::get_int("MYSQL_PORT", 3306));
        std::string remote_user = EnvLoader::get("MYSQL_REMOTE_USER", EnvLoader::get("MYSQL_USER", "mylife"));
        std::string remote_pass = EnvLoader::get("MYSQL_REMOTE_PASSWORD", EnvLoader::get("MYSQL_PASSWORD", ""));
        std::string remote_db = EnvLoader::get("MYSQL_REMOTE_NAME", EnvLoader::get("DATABASE_NAME", "myjob_agent"));
        auto test_db = std::make_shared<RoadmapDbClient>(remote_host, remote_port, remote_user, remote_pass, remote_db);

        std::cout << "\n🚨 [Manual Test Trigger] Initializing PreMarketReadinessAnalyzer for blocked-readiness alert dispatch...\n";
        hermes::PreMarketReadinessAnalyzer analyzer(test_db);

        // Evaluate against specified session date (defaults to tomorrow 2026-10-13 to trigger stale token cutoff blocker)
        std::string target_session = (argc > 2) ? argv[2] : "2026-10-13";
        auto report = analyzer.run_pre_market_readiness_check(target_session);

        std::cout << "• Target Session : " << report.session_date << "\n";
        std::cout << "• Readiness Pass : " << (report.overall_readiness_passed ? "TRUE" : "FALSE") << "\n";
        std::cout << "• Token Stale Cut: " << (report.token_stale_before_cutoff ? "TRUE" : "FALSE") << "\n";
        std::cout << "• Blockers Count : " << report.critical_blockers.size() << "\n";
        for (const auto& blk : report.critical_blockers) {
            std::cout << "  🚨 " << blk << "\n";
        }

        std::cout << "\n📡 Transmitting pre-market readiness blocked alert email via SMTP (verbose transcript enabled)...\n";
        bool ok = analyzer.send_alert_if_blocked(report, true /* verbose */);
        if (ok) {
            std::cout << "✅ [Manual Test Trigger] Pre-Market Blocked Readiness Alert SUCCESSFUL.\n";
            return 0;
        } else {
            std::cerr << "❌ [Manual Test Trigger] Pre-Market Alert dispatch FAILED.\n";
            return 1;
        }
    }

    // Single Instance Process Lock Guard (Strict Fatal Exit on Duplicate Instance)
    int lock_fd = open("/tmp/cpp_trading_agent.lock", O_RDWR | O_CREAT, 0666);
    if (lock_fd < 0) {
        std::cerr << "❌ [Main] Fatal: Unable to open lock file /tmp/cpp_trading_agent.lock\n";
        return 1;
    }
    if (lockf(lock_fd, F_TLOCK, 0) < 0) {
        std::cerr << "❌ [Main] Fatal: Another instance of cpp-trading-agent is already running (lock file /tmp/cpp_trading_agent.lock active). Exiting to enforce single-instance safety.\n";
        return 1;
    }

    std::string remote_host = EnvLoader::get("MYSQL_REMOTE_HOST", EnvLoader::get("MYSQL_HOST", "10.0.0.99"));
    int remote_port = EnvLoader::get_int("MYSQL_REMOTE_PORT", EnvLoader::get_int("MYSQL_PORT", 3306));
    std::string remote_user = EnvLoader::get("MYSQL_REMOTE_USER", EnvLoader::get("MYSQL_USER", "mylife"));
    std::string remote_pass = EnvLoader::get("MYSQL_REMOTE_PASSWORD", EnvLoader::get("MYSQL_PASSWORD", ""));
    std::string remote_db = EnvLoader::get("MYSQL_REMOTE_NAME", EnvLoader::get("DATABASE_NAME", "myjob_agent"));

    std::string local_host = EnvLoader::get("MYSQL_LOCAL_HOST", EnvLoader::get("MYSQL_HOST", "10.0.0.99"));
    int local_port = EnvLoader::get_int("MYSQL_LOCAL_PORT", EnvLoader::get_int("MYSQL_PORT", 3306));
    std::string local_user = EnvLoader::get("MYSQL_LOCAL_USER", EnvLoader::get("MYSQL_USER", "mylife"));
    std::string local_pass = EnvLoader::get("MYSQL_LOCAL_PASSWORD", EnvLoader::get("MYSQL_PASSWORD", ""));
    std::string local_db = EnvLoader::get("MYSQL_LOCAL_NAME", "myjob_agent");

    int server_port = EnvLoader::get_int("ROADMAP_PORT", 8080);

    signal(SIGPIPE, SIG_IGN);

    std::cout << "🌐 [Init] Remote Server DB (Tokens & Accounts): " << remote_host << ":" << remote_port << "/" << remote_db << "\n";
    std::cout << "⚡ [Init] Local Fast DB (Ticks & Historical Candles): " << local_host << ":" << local_port << "/" << local_db << "\n";
    std::cout << "[Init] HTTP Roadmap Server Port: " << server_port << "\n";

    auto db_client = std::make_shared<RoadmapDbClient>(
        remote_host, remote_port, remote_user, remote_pass, remote_db,
        local_host, local_port, local_user, local_pass, local_db
    );

    // Launch HTTP Web Portal with fully initialized db_client
    auto server = std::make_shared<RoadmapServer>(server_port, db_client);
    std::thread http_thread([server]() {
        server->start();
    });
    http_thread.detach();

    if (db_client->test_connection()) {
        std::cout << "✅ [Remote Database] Remote Server Connection Successful (Tokens & Common Data)!\n";
    } else {
        std::cerr << "⚠️ [Remote Database] Connection check failed. Please verify SSH tunnel at " << remote_host << ":" << remote_port << "\n";
    }

    if (db_client->test_local_connection()) {
        std::cout << "⚡ [Local Database] Local DB Connection Active (High-Frequency Ticks & Historical Candles)!\n";
    }

    hermes::StrategyConfigManager::instance().load_from_db(db_client.get());
    std::cout << "⚙️ [Config] Dynamic Strategy Configuration Active: OFI="
              << hermes::StrategyConfigManager::instance().get_ofi_threshold()
              << ", MinVol=" << hermes::StrategyConfigManager::instance().get_min_volume_threshold()
              << ", RiskPct=" << (hermes::StrategyConfigManager::instance().get_per_trade_risk_pct() * 100.0)
              << "%, MaxDD=" << (hermes::StrategyConfigManager::instance().get_session_drawdown_limit_pct() * 100.0)
              << "%, BaseConfidence=" << hermes::StrategyConfigManager::instance().get_base_confidence() << "\n";

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

    // Launch Native C++ Broker Feed Supervisor (Upstox / FYERS direct WebSocket)
    std::vector<std::string> feed_symbols = {
        "NSE_INDEX|Nifty 50",
        "NSE_INDEX|Nifty Bank",
        "BSE_INDEX|SENSEX"
    };
    auto feed_supervisor = std::make_shared<BrokerFeedSupervisor>(db_client, receiver, feed_symbols);
    feed_supervisor->start();

    // Launch Background Token Validation & Live Tick Ingestion Supervisor Thread IMMEDIATELY
    std::thread supervisor_thread([db_client, &receiver, &soak_monitor, feed_supervisor]() {
        bool last_active_state = false;
        int check_counter = 0;
        size_t total_saved_ticks = 0;
        size_t expired_contract_ticks_skipped = 0;
        // Counts consecutive cycles with no live feed, for rate-limited logging.
        // Replaces last_seen_ts, whose hardcoded "2026-09-30" floor existed only to seed
        // the stale-data replay that has been removed below.
        size_t feed_down_cycles = 0;
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
        double cached_today_drawdown = db_client->fetch_today_session_drawdown();
        uint64_t last_cache_update_ticks = 0;

        auto refresh_trade_cache = [&]() {
            cached_open_trades = db_client->fetch_user_trades("cpp-shadow", 1000);
            cached_portfolio = db_client->fetch_user_portfolio("cpp-portfolio-v1");
            cached_today_drawdown = db_client->fetch_today_session_drawdown();
        };

        refresh_trade_cache();

        while (true) {
            check_counter++;

            // Periodically check and hot-reload dynamic strategy configuration (every 60s)
            hermes::StrategyConfigManager::instance().maybe_periodic_reload(db_client.get(), 60);

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

            // Gated Market Hours Check: continuous trading occurs strictly 09:15 - 15:30 IST on trading weekdays
            auto ist_now = hermes::MarketCalendar::get_ist_time();
            bool is_trading_day = hermes::MarketCalendar::is_trading_weekday(ist_now);
            auto session_phase = hermes::MarketCalendar::get_session_phase();

            // Feed-down during continuous market hours is FAIL-CLOSED: no substitute source, ever.
            //
            // Removed 2026-10-14. This branch fell back to shared DB polling via
            // fetch_live_quotes_since(), which read upstox_live_paper_option_quotes - a table whose
            // only writer is a stopped, separately-owned subsystem, and whose newest row was a week
            // old. During that morning's feed outage it replayed rows stamped 2026-09-30 as if they
            // were live (the reader set provenance = "UPSTOX_LIVE_READONLY" and is_real_data = true
            // on them), and 23 positions were opened on two-week-old prices.
            //
            // A fail-closed invariant with a side path around it is not fail-closed. No feed means
            // no decisions - not stale ones.
            auto sup_status = feed_supervisor->get_status();
            if (!sup_status.is_connected) {
                if (is_trading_day && session_phase == hermes::SessionPhase::MARKET_OPEN) {
                    ++feed_down_cycles;
                    if (feed_down_cycles == 1 || feed_down_cycles % 600 == 0) {
                        std::cerr << "🛑 [FeedGuard] No live feed for " << feed_down_cycles
                                  << " cycle(s) during market hours - refusing stale-data fallback;"
                                  << " no decisions will be taken until the feed returns.\n";
                    }
                }
                // Sleep so an unconnected feed cannot spin the loop.
                std::this_thread::sleep_for(std::chrono::milliseconds(500));
            } else {
                feed_down_cycles = 0;
                if (!is_trading_day || session_phase != hermes::SessionPhase::MARKET_OPEN) {
                    // Outside continuous trading, sleep to avoid busy polling and synthetic decision generation
                    std::this_thread::sleep_for(std::chrono::milliseconds(500));
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

                        auto exit_eval = hermes::PositionExitEvaluator::evaluate_position_exit(
                            tr.id, tr.instrument, tr.side, tr.quantity, tr.entryPrice, tick.ltp, tr.orderedAt
                        );

                        if (exit_eval.condition == hermes::PositionExitCondition::TAKE_PROFIT_TRIGGERED) {
                            double exit_px = (tr.side == "BUY") ? (tick.bid_price > 0 ? tick.bid_price : tick.ltp) : (tick.ask_price > 0 ? tick.ask_price : tick.ltp);
                            double gross_pnl = (tr.side == "BUY") ? (tr.quantity * (exit_px - tr.entryPrice)) : (tr.quantity * (tr.entryPrice - exit_px));
                            double cost = 40.0;
                            double net_pnl = gross_pnl - cost;
                            db_client->close_paper_trade(tr.id, exit_px, net_pnl, cost);
                            risk_engine.record_trade_result(net_pnl);
                            tr.status = "CLOSED";
                            refresh_trade_cache();
                            std::cout << "🎯 [ExitEngine] TAKE_PROFIT Triggered! Trade " << tr.id << " (" << tr.instrument << ") Closed @ ₹" << exit_px << " | Net PnL: ₹" << net_pnl << "\n";
                        } else if (exit_eval.condition == hermes::PositionExitCondition::STOP_LOSS_TRIGGERED) {
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

                // Expired contracts are dropped before any work is done on them.
                //
                // Previously they were evaluated in full -- features computed, a decision
                // journal row written -- and only rejected by the insert-time guard in
                // create_paper_trade, which runs after all of that. The result was a journal
                // padded with rows for contracts that could never trade: on 2026-10-14 a
                // single contract that expired on 2026-10-01 still held 2,754 journal rows.
                // They also stayed subscribed on the feed. Skipping here is the earliest
                // point in the path that still has the symbol to test.
                if (hermes::MarketCalendar::is_contract_expired(tick.symbol)) {
                    ++expired_contract_ticks_skipped;
                    // Coarse interval on purpose: a per-tick line here would recreate the
                    // unbounded-log problem this project has already been bitten by.
                    if (expired_contract_ticks_skipped % 5000 == 0) {
                        std::cout << "⏭️  [Engine] Skipped " << expired_contract_ticks_skipped
                                  << " ticks for already-expired contracts (latest: "
                                  << tick.symbol << ")\n";
                    }
                    continue;
                }

                auto feat = feature_engine.process_tick(tick);

                static std::atomic<uint64_t> decision_seq{1};

                // OFI Microstructure Option Strategy Trigger (requires dynamic order flow imbalance + volume thresholds)
                double ofi_threshold = hermes::StrategyConfigManager::instance().get_ofi_threshold();
                int min_vol = hermes::StrategyConfigManager::instance().get_min_volume_threshold();
                double base_conf = hermes::StrategyConfigManager::instance().get_base_confidence();

                // Index quotes are not tradable options: they arrive in an _INDEX segment
                // (NSE_INDEX|Nifty 50, NSE_INDEX|Nifty Bank, BSE_INDEX|SENSEX) while tradable
                // contracts sit in an _FO segment (e.g. BSE_FO|887080). The previous test
                // compared tick.symbol against the bare literals "NIFTY" / "BANKNIFTY" /
                // "SENSEX", which never occur in either broker's real symbol format - so it was
                // always true and depth-less index quotes were admitted as option candidates,
                // mislabelling index rows as "OFI below breakout threshold".
                const bool is_index_quote =
                    tick.instrument_key.find("_INDEX|") != std::string::npos ||
                    tick.symbol.rfind("NSE_INDEX|", 0) == 0 ||
                    tick.symbol.rfind("BSE_INDEX|", 0) == 0;
                bool is_option_contract = !tick.symbol.empty() && !is_index_quote;
                bool is_ofi_breakout = is_option_contract && (std::abs(feat.order_flow_imbalance) >= ofi_threshold) && (tick.volume >= min_vol);

                if (is_ofi_breakout) {
                    std::string side = (feat.order_flow_imbalance > 0.0) ? "BUY" : "SELL";
                    std::string option_kind = (tick.option_type.empty() ? "CE" : tick.option_type);
                    std::string symbol = tick.symbol;
                    std::string inst = tick.instrument_key.empty() ? ("NSE:" + symbol) : tick.instrument_key;
                    std::string canonical_inst = symbol + " (" + inst + ")";

                    double seasonality_advisory_mod = seasonality_engine.get_advisory_confidence_modifier(
                        symbol, 10, 0, 3, 0, "OFI_Microstructure_Breakout"
                    );
                    double final_confidence = base_conf * seasonality_advisory_mod;

                    int lot_size = 25;
                    if (symbol.find("BANKNIFTY") != std::string::npos || inst.find("BANKNIFTY") != std::string::npos) {
                        lot_size = 15;
                    } else if (symbol.find("SENSEX") != std::string::npos || inst.find("SENSEX") != std::string::npos) {
                        lot_size = 20;
                    }

                    double entry_px = (side == "BUY") ? (tick.ask_price > 0 ? tick.ask_price : tick.ltp)
                                                       : (tick.bid_price > 0 ? tick.bid_price : tick.ltp);
                    double spot_px = (tick.strike > 0.0) ? tick.strike : (symbol.find("SENSEX") != std::string::npos ? 75000.0 : (symbol.find("BANKNIFTY") != std::string::npos ? 54000.0 : 25000.0));
                    
                    double required_margin = hermes::IndependentRiskEngine::calculate_short_option_margin(side, lot_size, entry_px, spot_px);
                    double proposed_risk = (side == "BUY") ? (lot_size * entry_px) : (lot_size * entry_px * 0.50);

                    double capital_in_hand = cached_portfolio.capital + cached_portfolio.netPnl;
                    std::string current_date_str = tick.raw_timestamp.length() >= 10 ? tick.raw_timestamp.substr(0, 10) : "";
                    risk_engine.update_daily_risk_base(capital_in_hand, current_date_str, cached_today_drawdown);

                    auto kelly_result = hermes::IndependentRiskEngine::calculate_kelly_lot_size("OFI_Microstructure_Breakout", symbol, side, entry_px, spot_px, capital_in_hand);

                    size_t open_positions_for_symbol = 0;
                    for (const auto& tr : cached_open_trades) {
                        if (tr.status == "OPEN" && tr.instrument == canonical_inst) {
                            open_positions_for_symbol++;
                        }
                    }

                    double current_session_drawdown = std::max(cached_today_drawdown, risk_engine.get_cumulative_daily_loss());

                    auto veto = risk_engine.verify_order_proposal_with_margin(
                        symbol,
                        proposed_risk,
                        required_margin,
                        cached_portfolio.deployed,
                        current_session_drawdown,
                        open_positions_for_symbol,
                        final_confidence,
                        capital_in_hand
                    );

                    uint64_t current_time_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                        std::chrono::system_clock::now().time_since_epoch()
                    ).count();
                    uint64_t tick_ts_ms = (tick.timestamp_ms > 0) ? tick.timestamp_ms : tick.received_timestamp_ms;
                    auto feed_freshness = hermes::IndependentRiskEngine::verify_feed_freshness(tick_ts_ms, current_time_ms, 10000);
                    if (!feed_freshness.risk_approved) {
                        veto = feed_freshness;
                    }

                    // Strict State Machine & Session Gate:
                    // Paper trading activates only when:
                    // 1. Valid trading day & continuous market hours (09:15 - 15:30 IST)
                    // 2. Active broker token exists & is verified in provider_tokens
                    // 3. Broker WebSocket is connected & transmitting fresh market ticks
                    if (!feed_supervisor->is_paper_trading_active()) {
                        std::string state_str = feed_supervisor->get_paper_trading_state_string();
                        veto.risk_approved = false;
                        veto.veto_reason = "PAPER_TRADING_INACTIVE (State: " + state_str + ")";
                    }

                    auto now_ns = std::chrono::high_resolution_clock::now().time_since_epoch().count();
                    std::string uuid = "dj-" + std::to_string(now_ns) + "-" + std::to_string(decision_seq.fetch_add(1));

                    if (veto.risk_approved) {
                        db_client->log_decision_journal_record(uuid, "live-session", kBuildGitSha, "1.0.0", symbol, side + "_" + option_kind, final_confidence, 0.05, "OFI_BULLISH_BREAKOUT_CONFIRMED", "{}");

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
                        std::string prefix = (veto.veto_reason.find("MARGIN_INSUFFICIENT") != std::string::npos) ? "MARGIN_VETO: " : "RISK_VETO: ";
                        db_client->log_decision_journal_record(uuid, "live-session", kBuildGitSha, "1.0.0", symbol, "NO_TRADE", final_confidence, 0.0, prefix + veto.veto_reason, "{}");
                    }
                } else if (total_saved_ticks % 100 == 0) {
                    // Periodically sample evaluated candidate ticks every 100 ticks
                    auto now_ns = std::chrono::high_resolution_clock::now().time_since_epoch().count();
                    std::string uuid = "dj-" + std::to_string(now_ns) + "-" + std::to_string(decision_seq.fetch_add(1));
                    std::string symbol = tick.symbol.empty() ? "NIFTY" : tick.symbol;
                    db_client->log_decision_journal_record(uuid, "live-session", kBuildGitSha, "1.0.0", symbol, "NO_TRADE", 0.0, 0.0, "EVALUATED_NO_ACTION: OFI_BELOW_BREAKOUT_THRESHOLD", "{}");

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

