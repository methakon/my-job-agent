#include "engine/pre_market_readiness_analyzer.hpp"
#include "engine/market_calendar.hpp"
#include "engine/daily_pnl_emailer.hpp"
#include "common/env_loader.hpp"
#include "common/crypto_util.hpp"

#include <iostream>
#include <sstream>
#include <iomanip>
#include <chrono>
#include <ctime>
#include <sys/statvfs.h>

namespace hermes {

PreMarketReadinessAnalyzer::PreMarketReadinessAnalyzer(std::shared_ptr<RoadmapDbClient> db_client)
    : db_client_(db_client) {}

bool PreMarketReadinessAnalyzer::check_disk_space(double& out_free_gb) {
    struct statvfs stat;
    // Check root or workspace filesystem
    if (statvfs(".", &stat) != 0) {
        if (statvfs("/", &stat) != 0) {
            out_free_gb = 0.0;
            return false;
        }
    }
    double free_bytes = static_cast<double>(stat.f_bavail) * static_cast<double>(stat.f_frsize);
    out_free_gb = free_bytes / (1024.0 * 1024.0 * 1024.0);
    return (out_free_gb >= 1.0); // At least 1 GB required
}

bool PreMarketReadinessAnalyzer::check_remote_db() {
    if (!db_client_) return false;
    try {
        return db_client_->execute_raw_sql("SELECT 1;");
    } catch (...) {
        return false;
    }
}

bool PreMarketReadinessAnalyzer::check_local_db() {
    if (!db_client_) return false;
    try {
        // Querying historical candle count verifies local MySQL connection pool
        db_client_->count_historical_candles_for_date("2026-01-01");
        return true;
    } catch (...) {
        return false;
    }
}

void PreMarketReadinessAnalyzer::evaluate_token_status(PreMarketReadinessReport& report) {
    if (!db_client_) {
        report.token_missing_or_expired = true;
        report.critical_blockers.push_back("CRITICAL: Database client is null; unable to query provider_tokens");
        return;
    }

    std::vector<std::string> providers = {"upstox", "fyers"};
    bool found_active = false;

    for (const auto& prov : providers) {
        auto status_info = db_client_->fetch_broker_token_status(prov);
        if (!status_info.client_id.empty() && 
            status_info.client_id.rfind("test_", 0) != 0 && 
            status_info.client_id.rfind("mock_", 0) != 0 && 
            status_info.client_id != "test_client_id") {

            std::string raw_token = db_client_->fetch_active_broker_token_raw(prov);
            if (!raw_token.empty()) {
                std::string secret = EnvLoader::get("ENCRYPTION_KEY", EnvLoader::get("APP_SECRET", ""));
                std::string decrypted = crypto_util::decrypt_token_if_needed(raw_token, secret);

                int64_t jwt_exp = crypto_util::extract_jwt_exp(decrypted);
                int64_t now_sec = std::chrono::duration_cast<std::chrono::seconds>(
                    std::chrono::system_clock::now().time_since_epoch()
                ).count();

                bool expired = (jwt_exp > 0 && jwt_exp <= now_sec);

                if (status_info.is_valid && !expired && !decrypted.empty()) {
                    report.token_valid = true;
                    report.token_provider = prov;
                    report.token_client_id = status_info.client_id;
                    report.token_status = status_info.status;
                    report.token_expires_at = status_info.expires_at;
                    found_active = true;
                    break;
                } else if (expired) {
                    report.advisory_warnings.push_back("Provider [" + prov + "] token has expired JWT exp claim (" + status_info.expires_at + ")");
                }
            }
        }
    }

    if (!found_active) {
        report.token_valid = false;
        report.token_missing_or_expired = true;
        report.critical_blockers.push_back("CRITICAL: No active, unexpired broker token found in provider_tokens table. Action required: Complete OAuth token exchange before 09:15 IST.");
    }
}

void PreMarketReadinessAnalyzer::evaluate_prior_session_context(PreMarketReadinessReport& report) {
    if (!db_client_) return;

    auto psa = db_client_->fetch_latest_post_session_record("");
    if (!psa.empty() && !psa["session_date"].empty()) {
        report.prior_psa_found = true;
        report.prior_psa_date = psa["session_date"];
        try { report.prior_psa_ticks = std::stoull(psa["total_ticks"]); } catch (...) {}
        try { report.prior_psa_decisions = std::stoull(psa["evaluated_decisions"]); } catch (...) {}
        report.prior_psa_recommendation = psa["recommendations_json"];

        // Check if prior day's candles were rolled up
        uint64_t candle_count = db_client_->count_historical_candles_for_date(report.prior_psa_date);
        report.prior_day_candle_count = candle_count;
        if (candle_count > 0) {
            report.prior_candles_available = true;
        } else {
            report.advisory_warnings.push_back("Advisory: Daily candle rollup for prior session (" + report.prior_psa_date + ") has 0 rows in cpp_historical_daily_candles.");
        }
    } else {
        report.advisory_warnings.push_back("Advisory: No prior post-session analysis record found in cpp_post_session_analysis.");
    }
}

PreMarketReadinessReport PreMarketReadinessAnalyzer::run_pre_market_readiness_check(const std::string& session_date) {
    PreMarketReadinessReport report;

    // Current IST Time
    auto ist = MarketCalendar::get_ist_time();
    char time_buf[64];
    snprintf(time_buf, sizeof(time_buf), "%04d-%02d-%02d %02d:%02d:%02d IST",
             ist.year, ist.month, ist.day, ist.hour, ist.minute, ist.second);
    report.evaluated_at_ist = time_buf;

    char date_buf[32];
    snprintf(date_buf, sizeof(date_buf), "%04d-%02d-%02d", ist.year, ist.month, ist.day);
    report.session_date = session_date.empty() ? date_buf : session_date;

    report.is_trading_weekday = MarketCalendar::is_trading_weekday(ist);
    if (!report.is_trading_weekday) {
        report.advisory_warnings.push_back("Notice: Today is a weekend or non-trading weekday according to MarketCalendar.");
    }

    // 1. Check Infrastructure: Remote DB
    report.remote_db_healthy = check_remote_db();
    if (!report.remote_db_healthy) {
        report.critical_blockers.push_back("CRITICAL: Authoritative MySQL Database is unreachable (SELECT 1 failed).");
    }

    // 2. Check Infrastructure: Local DB
    report.local_db_healthy = check_local_db();
    if (!report.local_db_healthy) {
        report.critical_blockers.push_back("CRITICAL: Local MySQL Database pool is unreachable.");
    }

    // 3. Check Disk Free Space
    report.disk_space_healthy = check_disk_space(report.free_disk_gb);
    if (!report.disk_space_healthy) {
        report.critical_blockers.push_back("CRITICAL: Insufficient disk space (" + std::to_string(report.free_disk_gb) + " GB free, >= 1.0 GB required).");
    }

    // 4. Check Prior Session Data & PSA
    evaluate_prior_session_context(report);

    // 5. Check Broker OAuth Token Freshness
    evaluate_token_status(report);

    // Strict Invariant: parameter_mutation_allowed is strictly false
    // (enforced const in PreMarketReadinessReport struct)

    // Compute Overall Readiness Status
    report.overall_readiness_passed = report.remote_db_healthy && 
                                      report.local_db_healthy && 
                                      report.disk_space_healthy && 
                                      report.token_valid;

    return report;
}

std::string PreMarketReadinessAnalyzer::format_report_text(const PreMarketReadinessReport& report) {
    std::ostringstream ss;
    ss << "=================================================================\n"
       << "  🌅 C++ AUTONOMOUS TRADING AGENT — PRE-MARKET READINESS AUDIT\n"
       << "=================================================================\n\n"
       << "Evaluation Time : " << report.evaluated_at_ist << "\n"
       << "Target Session  : " << report.session_date << "\n"
       << "Trading Weekday : " << (report.is_trading_weekday ? "YES (Active Session Expected)" : "NO (Weekend/Holiday)") << "\n"
       << "Overall Status  : " << (report.overall_readiness_passed ? "✅ READY FOR MARKET OPEN" : "⚠️ READINESS CHECKS FAILED / ACTION REQUIRED") << "\n\n"
       << "--- INFRASTRUCTURE & STORAGE ---\n"
       << "• Authoritative MySQL DB : " << (report.remote_db_healthy ? "✅ CONNECTED & HEALTHY" : "❌ UNREACHABLE") << "\n"
       << "• Local Fast MySQL DB   : " << (report.local_db_healthy ? "✅ CONNECTED & HEALTHY" : "❌ UNREACHABLE") << "\n"
       << "• Free Disk Space       : " << std::fixed << std::setprecision(2) << report.free_disk_gb << " GB "
       << (report.disk_space_healthy ? "✅ (>= 1.0 GB limit)" : "❌ (INSUFFICIENT)") << "\n\n"
       << "--- BROKER TOKEN & AUTHENTICATION ---\n"
       << "• Token Freshness       : " << (report.token_valid ? "✅ VALID & ACTIVE" : "❌ EXPIRED OR MISSING") << "\n";
    if (report.token_valid) {
        ss << "  Provider              : " << report.token_provider << "\n"
           << "  Client ID             : " << report.token_client_id << "\n"
           << "  Status / Expires      : " << report.token_status << " (Expires: " << report.token_expires_at << ")\n";
    }
    ss << "\n--- PRIOR SESSION HISTORICAL CONTEXT ---\n";
    if (report.prior_psa_found) {
        ss << "• Prior PSA Session     : " << report.prior_psa_date << "\n"
           << "  Ticks / Decisions     : " << report.prior_psa_ticks << " ticks / " << report.prior_psa_decisions << " decisions evaluated\n"
           << "• Daily Candle Rollup   : " << report.prior_day_candle_count << " candles " 
           << (report.prior_candles_available ? "✅ (Present)" : "⚠️ (Missing)") << "\n"
           << "• Prior Recommendations : " << report.prior_psa_recommendation << "\n";
    } else {
        ss << "• Prior PSA Record      : None found\n";
    }

    if (!report.critical_blockers.empty()) {
        ss << "\n🚨 CRITICAL BLOCKERS:\n";
        for (const auto& blk : report.critical_blockers) {
            ss << "  • " << blk << "\n";
        }
    }

    if (!report.advisory_warnings.empty()) {
        ss << "\n⚠️ ADVISORY WARNINGS:\n";
        for (const auto& w : report.advisory_warnings) {
            ss << "  • " << w << "\n";
        }
    }

    ss << "\nStrict Safety Invariant: parameter_mutation_allowed = FALSE (Read-Only Advisory Analysis)\n"
       << "Autonomous verification complete.\n";

    return ss.str();
}

std::string PreMarketReadinessAnalyzer::format_report_html(const PreMarketReadinessReport& report) {
    std::ostringstream ss;
    ss << "<!DOCTYPE html><html><head><meta charset=\"UTF-8\">"
       << "<style>"
       << "body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;line-height:1.6;color:#1f2328;background:#f6f8fa;padding:20px;}"
       << ".container{max-width:650px;margin:0 auto;background:#ffffff;border:1px solid #d0d7de;border-radius:10px;overflow:hidden;}"
       << ".header{background:#0d1117;color:#ffffff;padding:20px 24px;border-bottom:3px solid " 
       << (report.overall_readiness_passed ? "#238636;" : "#cf222e;") << "}"
       << ".header h2{margin:0;font-size:20px;color:" << (report.overall_readiness_passed ? "#e0a83c;" : "#ff7b72;") << "}"
       << ".header .sub{margin:4px 0 0;font-size:13px;color:#8b949e;}"
       << ".content{padding:24px;}"
       << ".section-title{font-size:15px;font-weight:700;border-bottom:1px solid #d0d7de;padding-bottom:6px;margin:18px 0 10px;color:#24292f;}"
       << ".alert-box{background:#ffebe9;border:1px solid rgba(255,129,130,0.4);border-radius:6px;padding:12px;font-size:13px;color:#cf222e;margin-bottom:14px;}"
       << ".ok-box{background:#dafbe1;border:1px solid rgba(74,194,107,0.4);border-radius:6px;padding:12px;font-size:13px;color:#1a7f37;margin-bottom:14px;}"
       << ".row{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #f0f2f5;font-size:13px;}"
       << ".footer{background:#f6f8fa;padding:14px 24px;font-size:11.5px;color:#57606a;text-align:center;border-top:1px solid #d0d7de;}"
       << "</style></head><body>"
       << "<div class=\"container\">"
       << "  <div class=\"header\">"
       << "    <h2>" << (report.overall_readiness_passed ? "🌅 Pre-Market Readiness: All Systems Normal" : "🚨 Pre-Market Readiness Alert: Attention Needed") << "</h2>"
       << "    <div class=\"sub\">Evaluated: " << report.evaluated_at_ist << " · Target: " << report.session_date << "</div>"
       << "  </div>"
       << "  <div class=\"content\">";

    if (report.overall_readiness_passed) {
        ss << "    <div class=\"ok-box\"><b>✅ ALL SYSTEMS GREEN:</b> Infrastructure, databases, disk space, and broker tokens are verified for market open (09:15 IST).</div>";
    } else {
        ss << "    <div class=\"alert-box\"><b>⚠️ ACTION REQUIRED:</b> One or more pre-market readiness checks failed. Review critical blockers below.</div>";
    }

    ss << "    <div class=\"section-title\">🖥️ Infrastructure &amp; DB Storage</div>"
       << "    <div class=\"row\"><span>Authoritative MySQL DB</span><b>" << (report.remote_db_healthy ? "✅ Online" : "❌ Disconnected") << "</b></div>"
       << "    <div class=\"row\"><span>Local MySQL DB</span><b>" << (report.local_db_healthy ? "✅ Online" : "❌ Disconnected") << "</b></div>"
       << "    <div class=\"row\"><span>Free Disk Space</span><b>" << std::fixed << std::setprecision(2) << report.free_disk_gb << " GB (" 
       << (report.disk_space_healthy ? "✅ OK" : "❌ Low") << ")</b></div>"
       << "    <div class=\"section-title\">🔑 Broker OAuth Credentials</div>"
       << "    <div class=\"row\"><span>Active Token Status</span><b>" << (report.token_valid ? "✅ Active (" + report.token_provider + ")" : "❌ Missing / Expired") << "</b></div>";

    if (report.token_valid) {
        ss << "    <div class=\"row\"><span>Client ID</span><b>" << report.token_client_id << "</b></div>"
           << "    <div class=\"row\"><span>Expiration</span><b>" << report.token_expires_at << "</b></div>";
    }

    if (!report.critical_blockers.empty()) {
        ss << "    <div class=\"section-title\" style=\"color:#cf222e;\">🚨 Critical Blockers</div>";
        for (const auto& blk : report.critical_blockers) {
            ss << "    <div class=\"alert-box\">" << blk << "</div>";
        }
    }

    if (!report.advisory_warnings.empty()) {
        ss << "    <div class=\"section-title\" style=\"color:#9a6700;\">⚠️ Advisory Warnings</div><ul>";
        for (const auto& w : report.advisory_warnings) {
            ss << "    <li style=\"font-size:13px;color:#57606a;\">" << w << "</li>";
        }
        ss << "</ul>";
    }

    ss << "  </div>"
       << "  <div class=\"footer\">"
       << "    C++ Autonomous Trading Engine · Advisory Analysis Only (parameter_mutation_allowed: false) · Zero credentials leaked"
       << "  </div>"
       << "</div></body></html>";

    return ss.str();
}

bool PreMarketReadinessAnalyzer::send_alert_if_blocked(const PreMarketReadinessReport& report) {
    if (report.overall_readiness_passed && report.critical_blockers.empty()) {
        return true; // No blockers to alert about
    }

    DailyPnLEmailer emailer(db_client_);
    EmailConfig cfg = emailer.load_config();
    if (!cfg.enabled || cfg.recipient.empty()) {
        return false;
    }

    std::string subject = "🚨 [ALERT] C++ Trading Agent Pre-Market Readiness Warning — " + report.session_date;
    std::string text_body = format_report_text(report);
    std::string html_body = format_report_html(report);

    return DailyPnLEmailer::send_smtp_message(cfg, subject, text_body, html_body);
}

} // namespace hermes
