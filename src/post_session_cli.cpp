#include "engine/post_session_analyzer.hpp"
#include "roadmap/db_client.hpp"
#include "common/env_loader.hpp"
#include <iostream>
#include <string>
#include <memory>

int main(int argc, char** argv) {
    std::string date = "";
    std::string mode = "all";

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--date" && i + 1 < argc) {
            date = argv[++i];
        } else if (arg == "--mode" && i + 1 < argc) {
            mode = argv[++i];
        }
    }

    std::cout << "=========================================================\n";
    std::cout << "📊 HERMES POST-SESSION ANALYZER & DATA LIFECYCLE CLI\n";
    std::cout << "=========================================================\n";

    EnvLoader::load(".env");

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

    auto db = std::make_shared<RoadmapDbClient>(
        remote_host, remote_port, remote_user, remote_pass, remote_db,
        local_host, local_port, local_user, local_pass, local_db
    );

    hermes::PostSessionAnalyzer analyzer(db);

    if (mode == "all" || mode == "analyze") {
        std::cout << "\n[1/2] Executing Post-Session Statistical Analysis...\n";
        auto report = analyzer.run_post_session_analysis(date);
        std::cout << "Session Date:               " << report.session_date << "\n";
        std::cout << "Session Phase:              " << report.session_phase << "\n";
        std::cout << "Total Ticks Ingested:       " << report.total_ticks_ingested << "\n";
        std::cout << "Total Decisions Evaluated:  " << report.evaluated_decisions_count << "\n";
        std::cout << "No-Action Decisions:        " << report.no_action_count << "\n";
        std::cout << "Actionable Signals:         " << report.actionable_signals_count << "\n";
        std::cout << "Risk Vetoes:                " << report.risk_vetoes_count << "\n";
        std::cout << "Margin Vetoes:              " << report.margin_vetoes_count << "\n";
        std::cout << "Trades Executed:            " << report.trades_executed_count << "\n";
        std::cout << "Realized Drawdown (INR):    ₹" << report.realized_drawdown_inr << "\n";
        std::cout << "Average OFI Confidence:     " << report.avg_ofi << "\n";
        std::cout << "Max OFI Confidence:         " << report.max_ofi << "\n";
        std::cout << "Near-Miss Threshold Count:  " << report.near_miss_count << "\n";
        std::cout << "Recommendations (Advisory): " << report.recommendations_json << "\n";
        std::cout << "Analysis Status:            " << (report.execution_success ? "✅ SAVED" : "❌ FAILED") << "\n";
    }

    if (mode == "all" || mode == "archive") {
        std::cout << "\n[2/2] Executing Daily Data Lifecycle & Archival...\n";
        auto report = analyzer.run_daily_data_archival(date);
        std::cout << "Candles Rolled Up:          " << report.candles_rolled_up << "\n";
        std::cout << "Past Snapshots Archived:    " << report.snapshots_archived << "\n";
        std::cout << "Live Snapshots Purged:      " << report.snapshots_deleted << "\n";
        std::cout << "Retention Policy:           " << report.retention_policy_note << "\n";
        std::cout << "Archival Status:            " << (report.execution_success ? "✅ SUCCESS" : "❌ FAILED") << "\n";
    }

    std::cout << "=========================================================\n";
    return 0;
}
