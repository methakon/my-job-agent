#ifndef DAILY_PNL_EMAILER_HPP
#define DAILY_PNL_EMAILER_HPP

#include <string>
#include <memory>
#include <vector>
#include <map>
#include "roadmap/db_client.hpp"
#include "engine/post_session_analyzer.hpp"
#include "engine/position_exit_evaluator.hpp"

namespace hermes {

struct EmailConfig {
    bool enabled{false};
    std::string smtp_host;
    int smtp_port{465};
    std::string smtp_user;
    std::string smtp_password;
    bool use_ssl{true};
    std::string sender;
    std::string recipient;
};

struct DailyPnLSummaryData {
    std::string session_date;
    double starting_capital{100000.0};
    double final_capital_in_hand{100000.0};
    double today_realized_pnl{0.0};
    double today_realized_drawdown{0.0};
    double drawdown_limit_inr{5000.0}; // 5% of starting capital
    int trades_closed_today{0};
    std::vector<std::map<std::string, std::string>> closed_trades;
    int open_positions_count{0};
    std::vector<PositionExitEvaluation> open_positions;
    
    // PostSessionAnalyzer metrics for zero-trade explanations
    uint64_t total_ticks_ingested{0};
    uint64_t evaluated_decisions{0};
    uint64_t ofi_below_threshold_count{0};
    uint64_t risk_vetoes_count{0};
    uint64_t actionable_signals_count{0};
    double avg_ofi{0.0};
    double max_ofi{0.0};
    int near_miss_count{0};
    std::string recommendation_summary;
};

/**
 * @brief DailyPnLEmailer (SOLID Single-Responsibility Principle)
 *
 * Formats and transmits daily P&L session summaries via libcurl SMTP/SMTPS.
 * Guaranteed failure isolation: network or SMTP failures are non-fatal.
 * Strictly config-driven: credentials and recipient come from DB or .env.
 */
class DailyPnLEmailer {
public:
    explicit DailyPnLEmailer(std::shared_ptr<RoadmapDbClient> db_client);

    // Collects real metrics and dispatches email if configured
    bool send_daily_summary_email(const std::string& session_date, const PostSessionAnalysisReport& psa_report);

    // Formats plain-text and HTML email body
    static std::string format_email_body(const DailyPnLSummaryData& data, bool html_format);

    // Transmits via libcurl SMTPS
    static bool send_smtp_message(const EmailConfig& cfg, const std::string& subject, const std::string& body_text, const std::string& body_html);

    // Loads config from StrategyConfigManager / DB falling back to EnvLoader
    EmailConfig load_config();

private:
    std::shared_ptr<RoadmapDbClient> db_client_;
};

} // namespace hermes

#endif // DAILY_PNL_EMAILER_HPP
