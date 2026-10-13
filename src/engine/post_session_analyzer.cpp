#include "engine/post_session_analyzer.hpp"
#include "engine/strategy_config_manager.hpp"
#include <iostream>
#include <sstream>
#include <iomanip>
#include <cmath>
#include <chrono>

namespace hermes {

PostSessionAnalyzer::PostSessionAnalyzer(std::shared_ptr<RoadmapDbClient> db_client)
    : db_client_(db_client) {}

PostSessionAnalysisReport PostSessionAnalyzer::run_post_session_analysis(const std::string& session_date) {
    PostSessionAnalysisReport report;
    if (!db_client_) {
        std::cerr << "❌ [PostSessionAnalyzer] Null db_client pointer\n";
        return report;
    }

    std::string date_str = session_date;
    if (date_str.empty()) {
        auto now = std::chrono::system_clock::now();
        std::time_t t = std::chrono::system_clock::to_time_t(now);
        std::tm tm_now;
        localtime_r(&t, &tm_now);
        char buf[32];
        std::strftime(buf, sizeof(buf), "%Y-%m-%d", &tm_now);
        date_str = buf;
    }
    report.session_date = date_str;
    report.session_phase = "CLOSED";

    // 1. Gather live statistics from database
    auto counts = db_client_->fetch_stored_tick_counts();
    report.total_ticks_ingested = counts.first;

    // 2. Query today's decision journal entries
    auto dec_stats = db_client_->fetch_session_decision_stats(date_str);
    report.evaluated_decisions_count = dec_stats.total_eval;
    report.no_action_count = dec_stats.no_action;
    report.actionable_signals_count = dec_stats.actionable;
    report.risk_vetoes_count = dec_stats.risk_vetoes;
    report.margin_vetoes_count = dec_stats.margin_vetoes;
    report.avg_confidence = dec_stats.avg_confidence;
    report.max_confidence = dec_stats.max_confidence;
    report.near_miss_count = dec_stats.near_miss_count;

    // Fetch closed trades and drawdown
    report.realized_drawdown_inr = db_client_->fetch_today_session_drawdown();
    report.trades_executed_count = 0; // Derived from today closed trades count

    // Generate analytical recommendations (STRICTLY ADVISORY - NEVER MUTATES LIVE PARAMETERS).
    // Every figure below is read from live config or from this session's own counts. This block
    // previously emitted a fixed string: it named the gates as the literals 0.85 / 100 and
    // asserted a conclusion ("successfully prevented false breakout fills") regardless of what
    // the session did. That is how psa-2026-10-09 came to describe 12,239 evaluations and 9,172
    // risk vetoes for a session whose journal holds 1,944 rows, all no-action, zero vetoes.
    auto& scm = hermes::StrategyConfigManager::instance();
    const double gate_ofi = scm.get_ofi_threshold();
    const std::string gate_ofi_str = [&] {
        std::ostringstream g; g << std::fixed << std::setprecision(2) << gate_ofi; return g.str();
    }();
    const int gate_vol = scm.get_min_volume_threshold();
    const uint64_t vetoes = report.risk_vetoes_count + report.margin_vetoes_count;

    std::ostringstream summary_txt;
    summary_txt << "Evaluated " << report.evaluated_decisions_count << " decisions: "
                << report.no_action_count << " no-action, " << vetoes << " risk/margin vetoes, "
                << report.actionable_signals_count << " actionable, "
                << report.trades_executed_count << " trades executed.";

    std::ostringstream rec_txt;
    if (report.evaluated_decisions_count == 0) {
        rec_txt << "No decisions were evaluated for this session, so no inference can be drawn "
                   "about the current gate values.";
    } else if (report.actionable_signals_count == 0) {
        rec_txt << "Every evaluation was declined with the OFI gate at " << gate_ofi_str
                << " and min-volume at " << gate_vol
                << ". This describes the session; it is not evidence the gates are correctly "
                   "calibrated. Threshold calibration requires a counterfactual run against the "
                   "same ticks, not a reading of the live gate.";
    } else {
        rec_txt << report.actionable_signals_count << " actionable signal(s) produced "
                << report.trades_executed_count << " trade(s) with the OFI gate at "
                << gate_ofi_str << " and min-volume at " << gate_vol << ".";
    }

    std::ostringstream rec;
    rec << "{"
        << "\"advisory_mode\": \"READ_ONLY\","
        << "\"parameter_mutation_allowed\": false,"
        << "\"session_date\": \"" << date_str << "\","
        << "\"ofi_breakout_gate_evaluated\": " << gate_ofi << ","
        << "\"min_volume_gate_evaluated\": " << gate_vol << ","
        << "\"summary\": \"" << summary_txt.str() << "\","
        << "\"recommendation\": \"" << rec_txt.str() << "\""
        << "}";
    report.recommendations_json = rec.str();

    // Persist analysis summary to cpp_post_session_analysis
    std::string report_id = "psa-" + date_str;
    bool saved = db_client_->save_post_session_analysis_record(
        report_id, report.session_date, report.session_phase,
        report.total_ticks_ingested, report.evaluated_decisions_count,
        report.no_action_count, report.actionable_signals_count,
        report.risk_vetoes_count, report.trades_executed_count,
        report.realized_drawdown_inr, report.avg_confidence, report.max_confidence,
        report.near_miss_count, report.recommendations_json
    );

    report.execution_success = saved;
    if (saved) {
        std::cout << "✅ [PostSessionAnalyzer] Post-session analysis completed & saved for session " << date_str << "\n";
    }
    return report;
}

DailyDataArchivalReport PostSessionAnalyzer::run_daily_data_archival(const std::string& session_date) {
    DailyDataArchivalReport report;
    if (!db_client_) {
        std::cerr << "❌ [PostSessionAnalyzer] Null db_client pointer\n";
        return report;
    }

    std::string date_str = session_date;
    if (date_str.empty()) {
        auto now = std::chrono::system_clock::now();
        std::time_t t = std::chrono::system_clock::to_time_t(now);
        std::tm tm_now;
        localtime_r(&t, &tm_now);
        char buf[32];
        std::strftime(buf, sizeof(buf), "%Y-%m-%d", &tm_now);
        date_str = buf;
    }
    report.session_date = date_str;

    // RATIONALE FOR RETENTION POLICY:
    // Today's raw ticks in fnf_market_snapshots are rolled up into cpp_historical_daily_candles first.
    // Raw ticks for prior trading dates (DATE(ts) < boundary_date) are copied into fnf_market_snapshots_history
    // with INSERT IGNORE, and only deleted from the live table once successfully copied into history.
    // Today's active session ticks remain in place for intra-day replay and validation.
    report.retention_policy_note = "Rollup to cpp_historical_daily_candles; past-session ticks migrated to fnf_market_snapshots_history; live table retains today only.";

    // Step 1: Rollup ticks into cpp_historical_daily_candles
    report.candles_rolled_up = db_client_->rollup_ticks_to_daily_candles(date_str);

    // Step 2: Archive ticks from previous dates (DATE(ts) < today) to fnf_market_snapshots_history
    uint64_t deleted_count = 0;
    report.snapshots_archived = db_client_->archive_market_snapshots_before(date_str, deleted_count);
    report.snapshots_deleted = deleted_count;

    report.execution_success = (report.candles_rolled_up > 0 || report.snapshots_archived >= 0);
    std::cout << "✅ [PostSessionAnalyzer] Daily archival complete: "
              << report.candles_rolled_up << " candles rolled up, "
              << report.snapshots_archived << " past snapshots archived, "
              << report.snapshots_deleted << " cleaned from live.\n";

    return report;
}

} // namespace hermes
