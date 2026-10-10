#ifndef PRE_MARKET_READINESS_ANALYZER_HPP
#define PRE_MARKET_READINESS_ANALYZER_HPP

#include <string>
#include <memory>
#include <vector>
#include <map>
#include <cstdint>
#include "roadmap/db_client.hpp"

namespace hermes {

struct PreMarketReadinessReport {
    std::string session_date;
    std::string evaluated_at_ist;
    bool is_trading_weekday{true};

    // System Infrastructure Checks
    bool remote_db_healthy{false};
    bool local_db_healthy{false};
    bool disk_space_healthy{false};
    double free_disk_gb{0.0};
    double min_disk_gb_required{1.0};

    // Data Pipeline & Calibration Checks
    bool prior_candles_available{false};
    uint64_t prior_day_candle_count{0};
    std::string prior_trading_date;

    // Broker Auth & Token Checks
    bool token_valid{false};
    std::string token_provider;
    std::string token_client_id;
    std::string token_status;
    std::string token_expires_at;
    bool token_missing_or_expired{false};

    // Prior Session Post-Session-Analysis Context
    bool prior_psa_found{false};
    std::string prior_psa_date;
    uint64_t prior_psa_ticks{0};
    uint64_t prior_psa_decisions{0};
    std::string prior_psa_recommendation;

    // Strict Safety Invariants
    const bool parameter_mutation_allowed{false}; // INVARIANT: Strictly read-only / advisory

    // Overall Status & Advisory Warnings
    bool overall_readiness_passed{false};
    std::vector<std::string> advisory_warnings;
    std::vector<std::string> critical_blockers;
};

/**
 * @brief PreMarketReadinessAnalyzer
 *
 * Automated in-process pre-market readiness analyzer.
 * Evaluates system health, database connectivity, historical candle coverage,
 * broker OAuth token freshness, and prior PSA recommendations between 09:00 - 09:15 IST.
 *
 * Strictly Read-Only / Advisory:
 * - parameter_mutation_allowed = false
 * - Purely additive; never blocks or mutates risk gates or live execution loop.
 */
class PreMarketReadinessAnalyzer {
public:
    explicit PreMarketReadinessAnalyzer(std::shared_ptr<RoadmapDbClient> db_client);

    // Runs full readiness verification for the given date (defaults to current IST date)
    PreMarketReadinessReport run_pre_market_readiness_check(const std::string& session_date = "");

    // Formats plain-text advisory summary for logs or alerts
    static std::string format_report_text(const PreMarketReadinessReport& report);

    // Formats HTML email/dashboard representation
    static std::string format_report_html(const PreMarketReadinessReport& report);

    // Sends pre-market alert email if critical blockers (e.g. missing/expired token) are detected
    bool send_alert_if_blocked(const PreMarketReadinessReport& report);

private:
    std::shared_ptr<RoadmapDbClient> db_client_;

    // Individual verification helpers
    bool check_disk_space(double& out_free_gb);
    bool check_remote_db();
    bool check_local_db();
    void evaluate_token_status(PreMarketReadinessReport& report);
    void evaluate_prior_session_context(PreMarketReadinessReport& report);
};

} // namespace hermes

#endif // PRE_MARKET_READINESS_ANALYZER_HPP
