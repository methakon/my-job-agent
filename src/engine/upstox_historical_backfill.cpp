#include "engine/upstox_historical_backfill.hpp"
#include <iostream>
#include <sstream>
#include <cstdio>
#include <array>
#include <algorithm>
#include <cmath>
#include <thread>
#include <chrono>

namespace {

// Helper to URL encode instrument keys (e.g., 'NSE_INDEX|Nifty 50' -> 'NSE_INDEX%7CNifty%2050')
std::string url_encode(const std::string& value) {
    std::ostringstream escaped;
    escaped.fill('0');
    escaped << std::hex;

    for (char c : value) {
        if (isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') {
            escaped << c;
        } else {
            escaped << '%' << std::uppercase << (int)(unsigned char)c;
        }
    }
    return escaped.str();
}

} // namespace

UpstoxHistoricalBackfillEngine::UpstoxHistoricalBackfillEngine() {}

std::string UpstoxHistoricalBackfillEngine::get_upstox_instrument_key(const std::string& symbol) {
    std::string s = symbol;
    std::transform(s.begin(), s.end(), s.begin(), ::toupper);

    if (s.find("NIFTY 50") != std::string::npos || s == "NIFTY" || s.find("NSE_INDEX|NIFTY 50") != std::string::npos) {
        return "NSE_INDEX|Nifty 50";
    }
    if (s.find("BANK") != std::string::npos || s.find("NIFTY BANK") != std::string::npos || s.find("NSE_INDEX|NIFTY BANK") != std::string::npos) {
        return "NSE_INDEX|Nifty Bank";
    }
    if (s.find("SENSEX") != std::string::npos || s.find("BSE_INDEX|SENSEX") != std::string::npos) {
        return "BSE_INDEX|SENSEX";
    }

    // Default: return raw symbol as instrument key
    return symbol;
}

std::string UpstoxHistoricalBackfillEngine::normalize_symbol_for_db(const std::string& symbol) {
    std::string s = symbol;
    std::transform(s.begin(), s.end(), s.begin(), ::toupper);

    if (s.find("NIFTY 50") != std::string::npos || s == "NIFTY" || s.find("NIFTY50") != std::string::npos) {
        return "NIFTY50";
    }
    if (s.find("BANK") != std::string::npos || s.find("NIFTYBANK") != std::string::npos) {
        return "NIFTYBANK";
    }
    if (s.find("SENSEX") != std::string::npos) {
        return "SENSEX";
    }

    return symbol;
}

std::string UpstoxHistoricalBackfillEngine::iso_to_mysql_datetime(const std::string& iso_str) {
    if (iso_str.length() < 19) return iso_str;
    std::string dt = iso_str.substr(0, 19);
    std::replace(dt.begin(), dt.end(), 'T', ' ');
    return dt;
}

bool UpstoxHistoricalBackfillEngine::validate_candle_sanity(
    const std::vector<UpstoxCandleRecord>& candles,
    bool& out_ohlc,
    bool& out_vol
) {
    out_ohlc = true;
    out_vol = true;

    if (candles.empty()) return false;

    for (const auto& c : candles) {
        if (c.open <= 0.0 || c.high <= 0.0 || c.low <= 0.0 || c.close <= 0.0) {
            out_ohlc = false;
        }
        if (c.high < c.low || c.high < c.open || c.high < c.close || c.low > c.open || c.low > c.close) {
            out_ohlc = false;
        }
        if (c.volume < 0) {
            out_vol = false;
        }
    }
    return out_ohlc && out_vol;
}

std::vector<UpstoxCandleRecord> UpstoxHistoricalBackfillEngine::fetch_historical_candles_api(
    const std::string& instrument_key,
    const std::string& symbol,
    const std::string& interval,
    const std::string& to_date,
    const std::string& from_date,
    UpstoxBackfillReport& out_report
) {
    std::vector<UpstoxCandleRecord> candles;

    out_report.instrument = symbol.empty() ? instrument_key : symbol;
    out_report.upstox_ref = instrument_key;
    out_report.session_date = to_date;
    out_report.interval = interval;
    out_report.api_success = false;
    out_report.retry_count = 0;
    out_report.data_source = "UPSTOX_HISTORICAL_CANDLE";
    out_report.granularity = "CANDLE";

    std::string encoded_key = url_encode(instrument_key);

    // Date range chunking helper for intraday data to prevent Upstox 1000-candle payload truncation
    std::vector<std::pair<std::string, std::string>> date_chunks;
    if (interval != "day" && from_date.length() >= 10 && to_date.length() >= 10) {
        // Chunk range into 3-day windows
        int from_year = std::stoi(from_date.substr(0, 4));
        int from_month = std::stoi(from_date.substr(5, 2));
        int from_day = std::stoi(from_date.substr(8, 2));

        int to_year = std::stoi(to_date.substr(0, 4));
        int to_month = std::stoi(to_date.substr(5, 2));
        int to_day = std::stoi(to_date.substr(8, 2));

        // Generate 3-day window chunks
        for (int day = from_day; day <= to_day; day += 3) {
            int end_d = std::min(to_day, day + 2);
            char buf1[32], buf2[32];
            snprintf(buf1, sizeof(buf1), "%04d-%02d-%02d", from_year, from_month, day);
            snprintf(buf2, sizeof(buf2), "%04d-%02d-%02d", from_year, from_month, end_d);
            date_chunks.push_back({buf1, buf2});
        }
    } else {
        date_chunks.push_back({from_date, to_date});
    }

    for (const auto& chunk : date_chunks) {
        std::string chunk_from = chunk.first;
        std::string chunk_to = chunk.second;

        std::string url = "https://api.upstox.com/v2/historical-candle/" + encoded_key + "/" + interval + "/" + chunk_to + "/" + chunk_from;
        std::string cmd = "curl -s -m 15 \"" + url + "\" -H \"Accept: application/json\"";

        std::string response;
        bool chunk_ok = false;

        for (int attempt = 0; attempt < 3; ++attempt) {
            out_report.retry_count += attempt;
            std::array<char, 4096> buffer;
            response.clear();

            FILE* pipe = popen(cmd.c_str(), "r");
            if (pipe) {
                while (fgets(buffer.data(), buffer.size(), pipe) != nullptr) {
                    response += buffer.data();
                }
                pclose(pipe);
            }

            if (response.find("\"status\":\"success\"") != std::string::npos && response.find("\"candles\":[") != std::string::npos) {
                chunk_ok = true;
                out_report.api_success = true;
                break;
            }

            std::this_thread::sleep_for(std::chrono::milliseconds(200 * (attempt + 1)));
        }

        if (!chunk_ok) continue;

        size_t pos = response.find("\"candles\":[");
        if (pos == std::string::npos) continue;

        pos += 11;
        while (pos < response.length()) {
            size_t start_arr = response.find('[', pos);
            if (start_arr == std::string::npos) break;
            size_t end_arr = response.find(']', start_arr);
            if (end_arr == std::string::npos) break;

            std::string candle_str = response.substr(start_arr + 1, end_arr - start_arr - 1);
            pos = end_arr + 1;

            std::stringstream ss(candle_str);
            std::string token;
            std::vector<std::string> tokens;

            while (std::getline(ss, token, ',')) {
                token.erase(std::remove(token.begin(), token.end(), '\"'), token.end());
                token.erase(std::remove(token.begin(), token.end(), ' '), token.end());
                tokens.push_back(token);
            }

            if (tokens.size() >= 5) {
                UpstoxCandleRecord c;
                c.timestamp_iso = tokens[0];
                c.timestamp_mysql = iso_to_mysql_datetime(tokens[0]);
                c.instrument_key = instrument_key;
                c.symbol = normalize_symbol_for_db(symbol.empty() ? instrument_key : symbol);
                c.interval = interval;
                c.data_source = "UPSTOX_HISTORICAL_CANDLE";
                c.granularity = "CANDLE";

                try {
                    c.open = std::stod(tokens[1]);
                    c.high = std::stod(tokens[2]);
                    c.low = std::stod(tokens[3]);
                    c.close = std::stod(tokens[4]);
                    if (tokens.size() >= 6) c.volume = std::stoll(tokens[5]);
                    if (tokens.size() >= 7) {
                        c.open_interest = std::stoll(tokens[6]);
                        out_report.oi_available = true;
                    }
                } catch (...) {
                    continue;
                }

                candles.push_back(c);
            }

            if (response[pos] == ']') break;
        }
    }

    out_report.records_retrieved = candles.size();
    if (!candles.empty()) {
        out_report.first_timestamp = candles.back().timestamp_mysql;
        out_report.last_timestamp = candles.front().timestamp_mysql;
    }

    // Evaluate session completeness for intraday bars
    std::map<std::string, size_t> bars_per_day;
    for (const auto& c : candles) {
        if (c.timestamp_mysql.length() >= 10) {
            bars_per_day[c.timestamp_mysql.substr(0, 10)]++;
        }
    }

    for (const auto& kv : bars_per_day) {
        if (interval == "1minute") {
            if (kv.second >= 350) {
                out_report.full_sessions_count++;
            } else if (kv.second >= 100) {
                out_report.partial_sessions_count++;
            } else {
                out_report.degraded_sessions_count++;
            }
        } else {
            out_report.full_sessions_count++;
        }
    }

    validate_candle_sanity(candles, out_report.ohlc_sanity_pass, out_report.volume_sanity_pass);
    return candles;
}
