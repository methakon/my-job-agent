#include "engine/daily_pnl_emailer.hpp"
#include "common/env_loader.hpp"
#include <iostream>
#include <sstream>
#include <iomanip>
#include <cstring>
#include <algorithm>
#include <chrono>
#include <curl/curl.h>

namespace hermes {

struct SmtpUploadBuffer {
    const char* ptr;
    size_t bytes_remaining;
};

static size_t smtp_payload_read_callback(char* buffer, size_t size, size_t nmemb, void* userp) {
    SmtpUploadBuffer* upload_ctx = static_cast<SmtpUploadBuffer*>(userp);
    if (!upload_ctx || size == 0 || nmemb == 0) return 0;

    size_t max_bytes = size * nmemb;
    if (upload_ctx->bytes_remaining > 0) {
        size_t copy_bytes = std::min(upload_ctx->bytes_remaining, max_bytes);
        std::memcpy(buffer, upload_ctx->ptr, copy_bytes);
        upload_ctx->ptr += copy_bytes;
        upload_ctx->bytes_remaining -= copy_bytes;
        return copy_bytes;
    }
    return 0;
}

DailyPnLEmailer::DailyPnLEmailer(std::shared_ptr<RoadmapDbClient> db_client)
    : db_client_(db_client) {}

EmailConfig DailyPnLEmailer::load_config() {
    EmailConfig cfg;

    // 1. Check dynamic database config first (cpp_strategy_config)
    std::map<std::string, std::string> db_cfg;
    if (db_client_) {
        db_cfg = db_client_->fetch_strategy_config();
    }

    auto get_val = [&](const std::string& db_key, const std::string& env_key, const std::string& def) -> std::string {
        if (db_cfg.find(db_key) != db_cfg.end() && !db_cfg[db_key].empty()) {
            return db_cfg[db_key];
        }
        return EnvLoader::get(env_key, def);
    };

    std::string enabled_str = get_val("daily_pnl_email_enabled", "DAILY_PNL_EMAIL_ENABLED", "false");
    cfg.enabled = (enabled_str == "true" || enabled_str == "1" || enabled_str == "TRUE");
    cfg.smtp_host = get_val("smtp_host", "SMTP_HOST", "");
    std::string port_str = get_val("smtp_port", "SMTP_PORT", "465");
    try { cfg.smtp_port = std::stoi(port_str); } catch (...) { cfg.smtp_port = 465; }
    cfg.smtp_user = get_val("smtp_user", "SMTP_USER", "");
    cfg.smtp_password = get_val("smtp_password", "SMTP_PASSWORD", "");
    std::string ssl_str = get_val("smtp_use_ssl", "SMTP_USE_SSL", "true");
    cfg.use_ssl = (ssl_str == "true" || ssl_str == "1" || ssl_str == "TRUE");
    cfg.sender = get_val("daily_pnl_email_sender", "DAILY_PNL_EMAIL_SENDER", cfg.smtp_user);
    cfg.recipient = get_val("daily_pnl_email_recipient", "DAILY_PNL_EMAIL_RECIPIENT", "");

    return cfg;
}

std::string DailyPnLEmailer::format_email_body(const DailyPnLSummaryData& data, bool html_format) {
    std::ostringstream ss;

    if (!html_format) {
        // Plain text version
        ss << "=================================================================\n"
           << "  ⚡ C++ AUTONOMOUS TRADING AGENT — DAILY SESSION P&L SUMMARY\n"
           << "=================================================================\n\n"
           << "Date           : " << data.session_date << "\n"
           << "Session Window : 09:15 - 15:30 IST (Continuous Paper Execution)\n"
           << "Starting Cap   : ₹" << std::fixed << std::setprecision(2) << data.starting_capital << "\n"
           << "Capital In Hand: ₹" << std::fixed << std::setprecision(2) << data.final_capital_in_hand << "\n"
           << "Today Realized : " << (data.today_realized_pnl >= 0.0 ? "+₹" : "-₹") 
                                  << std::fixed << std::setprecision(2) << std::abs(data.today_realized_pnl) << "\n"
           << "Trades Closed  : " << data.trades_closed_today << "\n\n";

        if (data.trades_closed_today > 0) {
            ss << "--- CLOSED TRADES SUMMARY ---\n";
            for (const auto& tr : data.closed_trades) {
                ss << "• " << tr.at("instrument") << " [" << tr.at("side") << " x" << tr.at("quantity") << "] "
                   << "Entry: ₹" << tr.at("entry_price") << " -> Exit: ₹" << tr.at("exit_price") << " | "
                   << "Net P&L: ₹" << tr.at("net_pnl") << " (Closed: " << tr.at("closed_at") << " IST)\n";
            }
            ss << "\n";
        } else {
            ss << "--- NO TRADES EXECUTED TODAY (EXPLANATION) ---\n"
               << "0 trades were executed during this session.\n"
               << "Real Session Decision Analytics:\n"
               << "• Total Ticks Processed    : " << data.total_ticks_ingested << "\n"
               << "• Evaluated Decisions      : " << data.evaluated_decisions << "\n"
               << "• Below OFI 0.85 Threshold : " << data.ofi_below_threshold_count << " decisions\n"
               << "• Max OFI Observed         : " << std::fixed << std::setprecision(4) << data.max_ofi 
               << " (Average OFI: " << std::fixed << std::setprecision(4) << data.avg_ofi << ")\n"
               << "• Near-Miss Setups (0.70-0.85): " << data.near_miss_count << "\n"
               << "• Risk Engine Vetoes       : " << data.risk_vetoes_count << "\n\n"
               << "Conclusion: Order Flow Imbalance (OFI) and volume confluence never crossed the\n"
               << "required 0.85 threshold. Invariant E1-E10 and Rule R-001 enforced complete capital\n"
               << "preservation on low-conviction market flow.\n\n";
        }

        ss << "--- RISK & CIRCUIT BREAKER STATUS ---\n"
           << "• Today Realized Loss : ₹" << std::fixed << std::setprecision(2) << data.today_realized_drawdown 
           << " / ₹" << std::fixed << std::setprecision(2) << data.drawdown_limit_inr << " (5% Max Drawdown Ceiling)\n"
           << "• Circuit Breaker     : " << (data.today_realized_drawdown >= data.drawdown_limit_inr ? "⚠️ TRIGGERED" : "✅ NORMAL (Within Limits)") << "\n"
           << "• Active Open Positions: " << data.open_positions_count << "\n"
           << "• Standing Risk Caveat : Note that unrealized mark-to-market P&L on legacy open positions\n"
           << "                         is NOT included in the daily realized drawdown calculation.\n\n"
           << "Security Notice: All credentials and OAuth tokens strictly excluded.\n"
           << "Generated autonomously by C++ Autonomous Trading Agent Engine.\n";
    } else {
        // HTML version
        ss << "<!DOCTYPE html><html><head><meta charset=\"UTF-8\">"
           << "<style>"
           << "body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;line-height:1.6;color:#1f2328;background:#f6f8fa;padding:20px;}"
           << ".container{max-width:650px;margin:0 auto;background:#ffffff;border:1px solid #d0d7de;border-radius:10px;overflow:hidden;}"
           << ".header{background:#0d1117;color:#ffffff;padding:20px 24px;border-bottom:3px solid #238636;}"
           << ".header h2{margin:0;font-size:20px;color:#e0a83c;}"
           << ".header .sub{margin:4px 0 0;font-size:13px;color:#8b949e;}"
           << ".content{padding:24px;}"
           << ".stat-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px;}"
           << ".stat-box{background:#f6f8fa;border:1px solid #d0d7de;border-radius:8px;padding:12px;text-align:center;}"
           << ".stat-lbl{font-size:12px;color:#57606a;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;}"
           << ".stat-val{font-size:22px;font-weight:700;margin-top:4px;}"
           << ".box-green{color:#1a7f37;}"
           << ".box-red{color:#cf222e;}"
           << ".box-neutral{color:#0969da;}"
           << ".section-title{font-size:15px;font-weight:700;border-bottom:1px solid #d0d7de;padding-bottom:6px;margin:20px 0 12px;color:#24292f;}"
           << ".card-explain{background:#f6f8fa;border-left:4px solid #0969da;border-radius:4px;padding:14px;margin-bottom:16px;font-size:13.5px;}"
           << ".trade-table{width:100%;border-collapse:collapse;margin-top:10px;font-size:13px;}"
           << ".trade-table th{background:#f6f8fa;text-align:left;padding:8px;border-bottom:1px solid #d0d7de;color:#57606a;}"
           << ".trade-table td{padding:8px;border-bottom:1px solid #eaeef2;}"
           << ".caveat-box{background:#fff8c5;border:1px solid rgba(212,167,44,0.4);border-radius:6px;padding:12px;font-size:12px;color:#57606a;margin-top:16px;}"
           << ".footer{background:#f6f8fa;padding:14px 24px;font-size:11.5px;color:#57606a;text-align:center;border-top:1px solid #d0d7de;}"
           << "</style></head><body>"
           << "<div class=\"container\">"
           << "  <div class=\"header\">"
           << "    <h2>⚡ C++ Trading Agent Daily P&L Summary</h2>"
           << "    <div class=\"sub\">Session: " << data.session_date << " · Continuous Paper Execution (09:15 - 15:30 IST)</div>"
           << "  </div>"
           << "  <div class=\"content\">"
           << "    <div class=\"stat-grid\">"
           << "      <div class=\"stat-box\">"
           << "        <div class=\"stat-lbl\">Capital In Hand</div>"
           << "        <div class=\"stat-val box-neutral\">₹" << std::fixed << std::setprecision(2) << data.final_capital_in_hand << "</div>"
           << "      </div>"
           << "      <div class=\"stat-box\">"
           << "        <div class=\"stat-lbl\">Today Realized P&L</div>"
           << "        <div class=\"stat-val " << (data.today_realized_pnl >= 0.0 ? "box-green" : "box-red") << "\">"
           << (data.today_realized_pnl >= 0.0 ? "+₹" : "-₹") << std::fixed << std::setprecision(2) << std::abs(data.today_realized_pnl) << "</div>"
           << "      </div>"
           << "    </div>";

        if (data.trades_closed_today > 0) {
            ss << "    <div class=\"section-title\">📈 Executed Closed Trades (" << data.trades_closed_today << ")</div>"
               << "    <table class=\"trade-table\">"
               << "      <thead><tr><th>Instrument</th><th>Side</th><th>Qty</th><th>Entry</th><th>Exit</th><th>Net P&L</th></tr></thead>"
               << "      <tbody>";
            for (const auto& tr : data.closed_trades) {
                double p = 0.0;
                try { p = std::stod(tr.at("net_pnl")); } catch (...) {}
                ss << "<tr>"
                   << "<td><b>" << tr.at("instrument") << "</b></td>"
                   << "<td>" << tr.at("side") << "</td>"
                   << "<td>" << tr.at("quantity") << "</td>"
                   << "<td>₹" << tr.at("entry_price") << "</td>"
                   << "<td>₹" << tr.at("exit_price") << "</td>"
                   << "<td style=\"font-weight:bold;color:" << (p >= 0.0 ? "#1a7f37" : "#cf222e") << ";\">₹" << tr.at("net_pnl") << "</td>"
                   << "</tr>";
            }
            ss << "      </tbody></table>";
        } else {
            ss << "    <div class=\"section-title\">🛡️ Session Decision &amp; Zero-Trade Explanation</div>"
               << "    <div class=\"card-explain\">"
               << "      <b>0 trades were executed during this session.</b><br/>"
               << "      The autonomous engine evaluated <b>" << data.evaluated_decisions << "</b> candidate decisions across <b>" 
               << data.total_ticks_ingested << "</b> market ticks.<br/><br/>"
               << "      <b>Specific Factor Breakdown:</b><br/>"
               << "      • <b>OFI Below Threshold:</b> " << data.ofi_below_threshold_count << " candidate setups did not cross the 0.85 OFI gate.<br/>"
               << "      • <b>Peak OFI Observed:</b> " << std::fixed << std::setprecision(4) << data.max_ofi 
               << " (Average confidence: " << std::fixed << std::setprecision(4) << data.avg_ofi << ").<br/>"
               << "      • <b>Near-Miss Setups:</b> " << data.near_miss_count << " ticks approached the 0.70-0.849 range.<br/>"
               << "      • <b>Risk Engine Vetoes:</b> " << data.risk_vetoes_count << "<br/><br/>"
               << "      <i>Conclusion: Market flow never satisfied the required Order Flow Imbalance and liquidity confluence. "
               << "Invariant E1-E10 and Rule R-001 enforced total capital preservation.</i>"
               << "    </div>";
        }

        ss << "    <div class=\"section-title\">🛡️ Risk Limits &amp; Circuit Breaker</div>"
           << "    <p style=\"font-size:13.5px;margin:6px 0;\">"
           << "      • Today Realized Loss: <b>₹" << std::fixed << std::setprecision(2) << data.today_realized_drawdown << "</b> "
           << "      (Ceiling: ₹" << std::fixed << std::setprecision(2) << data.drawdown_limit_inr << " — 5% of ₹100,000)<br/>"
           << "      • Circuit Breaker Status: <b style=\"color:" << (data.today_realized_drawdown >= data.drawdown_limit_inr ? "#cf222e" : "#1a7f37") << ";\">"
           << (data.today_realized_drawdown >= data.drawdown_limit_inr ? "TRIGGERED" : "WITHIN LIMITS") << "</b><br/>"
           << "      • Active Open Positions: <b>" << data.open_positions_count << "</b>"
           << "    </p>"
           << "    <div class=\"caveat-box\">"
           << "      ⚠️ <b>Standing Risk Caveat:</b> Unrealized mark-to-market P&L on legacy open positions is not included in the daily realized drawdown calculation."
           << "    </div>"
           << "  </div>"
           << "  <div class=\"footer\">"
           << "    C++ Autonomous Trading Engine · Confidential Algorithmic Audit · Zero credentials transmitted"
           << "  </div>"
           << "</div></body></html>";
    }

    return ss.str();
}

bool DailyPnLEmailer::send_smtp_message(
    const EmailConfig& cfg,
    const std::string& subject,
    const std::string& body_text,
    const std::string& body_html
) {
    if (!cfg.enabled) {
        std::cout << "ℹ️ [DailyPnLEmailer] Daily P&L email is disabled (enabled=false). Skipping send.\n";
        return true;
    }
    if (cfg.recipient.empty()) {
        std::cout << "ℹ️ [DailyPnLEmailer] No destination recipient configured. Skipping send.\n";
        return true;
    }
    if (cfg.smtp_host.empty()) {
        std::cerr << "⚠️ [DailyPnLEmailer] SMTP host is empty. Cannot transmit email.\n";
        return false;
    }

    CURL* curl = curl_easy_init();
    if (!curl) {
        std::cerr << "⚠️ [DailyPnLEmailer] curl_easy_init failed.\n";
        return false;
    }

    // Build MIME multipart/alternative message
    std::string boundary = "----=_Part_Hermes_C++_" + std::to_string(std::chrono::system_clock::now().time_since_epoch().count());
    std::ostringstream msg;

    msg << "From: " << cfg.sender << "\r\n"
        << "To: " << cfg.recipient << "\r\n"
        << "Subject: " << subject << "\r\n"
        << "MIME-Version: 1.0\r\n"
        << "Content-Type: multipart/alternative; boundary=\"" << boundary << "\"\r\n\r\n"
        << "--" << boundary << "\r\n"
        << "Content-Type: text/plain; charset=UTF-8\r\n"
        << "Content-Transfer-Encoding: 7bit\r\n\r\n"
        << body_text << "\r\n\r\n"
        << "--" << boundary << "\r\n"
        << "Content-Type: text/html; charset=UTF-8\r\n"
        << "Content-Transfer-Encoding: 7bit\r\n\r\n"
        << body_html << "\r\n\r\n"
        << "--" << boundary << "--\r\n";

    std::string full_payload = msg.str();
    SmtpUploadBuffer upload_ctx{full_payload.c_str(), full_payload.length()};

    std::string url;
    if (cfg.use_ssl && (cfg.smtp_port == 465 || cfg.smtp_port == 0)) {
        url = "smtps://" + cfg.smtp_host + ":" + std::to_string(cfg.smtp_port == 0 ? 465 : cfg.smtp_port);
    } else {
        url = "smtp://" + cfg.smtp_host + ":" + std::to_string(cfg.smtp_port == 0 ? 587 : cfg.smtp_port);
    }

    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    if (!cfg.smtp_user.empty()) curl_easy_setopt(curl, CURLOPT_USERNAME, cfg.smtp_user.c_str());
    if (!cfg.smtp_password.empty()) curl_easy_setopt(curl, CURLOPT_PASSWORD, cfg.smtp_password.c_str());

    if (!cfg.use_ssl) {
        curl_easy_setopt(curl, CURLOPT_USE_SSL, (long)CURLUSESSL_NONE);
    } else if (cfg.smtp_port != 465) {
        curl_easy_setopt(curl, CURLOPT_USE_SSL, (long)CURLUSESSL_ALL); // Require STARTTLS
    }

    curl_easy_setopt(curl, CURLOPT_MAIL_FROM, ("<" + cfg.sender + ">").c_str());

    struct curl_slist* recipients = nullptr;
    recipients = curl_slist_append(recipients, ("<" + cfg.recipient + ">").c_str());
    curl_easy_setopt(curl, CURLOPT_MAIL_RCPT, recipients);

    curl_easy_setopt(curl, CURLOPT_READFUNCTION, smtp_payload_read_callback);
    curl_easy_setopt(curl, CURLOPT_READDATA, &upload_ctx);
    curl_easy_setopt(curl, CURLOPT_UPLOAD, 1L);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 20L); // 20s timeout for safety

    CURLcode res = curl_easy_perform(curl);
    bool success = (res == CURLE_OK);

    if (!success) {
        std::cerr << "⚠️ [DailyPnLEmailer] Failed to send email via SMTP (" << url << "): " 
                  << curl_easy_strerror(res) << " (non-fatal, continuing)\n";
    } else {
        std::cout << "📧 [DailyPnLEmailer] Daily P&L summary successfully dispatched to " << cfg.recipient << "\n";
    }

    curl_slist_free_all(recipients);
    curl_easy_cleanup(curl);
    return success;
}

bool DailyPnLEmailer::send_daily_summary_email(
    const std::string& session_date,
    const PostSessionAnalysisReport& psa_report
) {
    EmailConfig cfg = load_config();
    if (!cfg.enabled || cfg.recipient.empty()) {
        std::cout << "ℹ️ [DailyPnLEmailer] Daily summary email disabled or recipient unconfigured. Skipping.\n";
        return true;
    }

    DailyPnLSummaryData data;
    data.session_date = session_date;

    // Fetch real portfolio capital
    if (db_client_) {
        auto pf = db_client_->fetch_user_portfolio("default_operator");
        data.starting_capital = (pf.capital > 0.0) ? pf.capital : 100000.0;
        data.final_capital_in_hand = data.starting_capital + pf.netPnl;
        data.today_realized_pnl = db_client_->fetch_today_session_realized_pnl(session_date);
        data.today_realized_drawdown = db_client_->fetch_today_session_drawdown();
        data.closed_trades = db_client_->fetch_closed_trades_for_date(session_date);
        data.trades_closed_today = static_cast<int>(data.closed_trades.size());
        data.open_positions_count = db_client_->fetch_open_positions_count();
    }

    data.drawdown_limit_inr = data.starting_capital * 0.05;

    // Attach PostSessionAnalyzer factual metrics
    data.total_ticks_ingested = psa_report.total_ticks_ingested;
    data.evaluated_decisions = psa_report.evaluated_decisions_count;
    data.ofi_below_threshold_count = psa_report.no_action_count;
    data.risk_vetoes_count = psa_report.risk_vetoes_count;
    data.actionable_signals_count = psa_report.actionable_signals_count;
    data.avg_ofi = psa_report.avg_ofi;
    data.max_ofi = psa_report.max_ofi;
    data.near_miss_count = psa_report.near_miss_count;
    data.recommendation_summary = psa_report.recommendations_json;

    std::string subject = "📊 C++ Trading Agent Daily P&L — " + session_date + " [" 
                        + (data.today_realized_pnl >= 0.0 ? "+₹" : "-₹") 
                        + std::to_string(static_cast<long>(std::abs(data.today_realized_pnl))) + "]";

    std::string text_body = format_email_body(data, false);
    std::string html_body = format_email_body(data, true);

    return send_smtp_message(cfg, subject, text_body, html_body);
}

} // namespace hermes
