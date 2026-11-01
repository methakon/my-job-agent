#include "engine/upstox_historical_backfill.hpp"
#include "common/http_client.hpp"
#include <iostream>
#include <sstream>
#include <cstdio>
#include <algorithm>
#include <cmath>
#include <thread>
#include <chrono>
#include <cstdint>
#include <iomanip>
#include <cctype>

namespace {

// Helper to URL encode instrument keys (e.g., 'NSE_INDEX|Nifty 50' -> 'NSE_INDEX%7CNifty%2050')
std::string url_encode(const std::string& value) {
    std::ostringstream escaped;
    escaped.fill('0');
    escaped << std::hex;

    for (char c : value) {
        const unsigned char u = static_cast<unsigned char>(c);   // isalnum(char) is undefined for negatives
        if (std::isalnum(u) || c == '-' || c == '_' || c == '.' || c == '~') {
            escaped << c;
        } else {
            // setw(2): without it a byte below 0x10 printed as one digit ("%A" for a newline), a
            // malformed escape.
            escaped << '%' << std::uppercase << std::setw(2) << static_cast<int>(u);
        }
    }
    return escaped.str();
}

// Days since 1970-01-01 for a proleptic Gregorian date, and the inverse (Howard Hinnant's civil
// algorithms). Plain integer arithmetic, so the chunking below does not depend on the host's
// timezone database or on how complete <chrono>'s calendar support is.
int64_t days_from_civil(int y, unsigned m, unsigned d) {
    y -= m <= 2;
    const int64_t era = (y >= 0 ? y : y - 399) / 400;
    const unsigned yoe = static_cast<unsigned>(y - era * 400);
    const unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
    const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return era * 146097 + static_cast<int64_t>(doe) - 719468;
}

void civil_from_days(int64_t z, int& y, unsigned& m, unsigned& d) {
    z += 719468;
    const int64_t era = (z >= 0 ? z : z - 146096) / 146097;
    const unsigned doe = static_cast<unsigned>(z - era * 146097);
    const unsigned yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    y = static_cast<int>(yoe) + static_cast<int>(era) * 400;
    const unsigned doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    const unsigned mp = (5 * doy + 2) / 153;
    d = doy - (153 * mp + 2) / 5 + 1;
    m = mp < 10 ? mp + 3 : mp - 9;
    y += m <= 2;
}

bool parse_ymd(const std::string& s, int& y, unsigned& m, unsigned& d) {
    if (s.size() < 10 || s[4] != '-' || s[7] != '-') return false;
    for (size_t i : {0u, 1u, 2u, 3u, 5u, 6u, 8u, 9u}) {
        if (!std::isdigit(static_cast<unsigned char>(s[i]))) return false;
    }
    y = std::stoi(s.substr(0, 4));
    m = static_cast<unsigned>(std::stoi(s.substr(5, 2)));
    d = static_cast<unsigned>(std::stoi(s.substr(8, 2)));
    if (m < 1 || m > 12 || d < 1) return false;
    int ry; unsigned rm, rd;
    civil_from_days(days_from_civil(y, m, d), ry, rm, rd);   // round-trip rejects 02-30 and the like
    return ry == y && rm == m && rd == d;
}

std::string format_ymd(int64_t day_number) {
    int y; unsigned m, d;
    civil_from_days(day_number, y, m, d);
    char buf[48];   // worst case for the format below, so the compiler can prove no truncation
    snprintf(buf, sizeof(buf), "%04d-%02u-%02u", y, m, d);
    return buf;
}

} // namespace

std::vector<std::pair<std::string, std::string>> UpstoxHistoricalBackfillEngine::chunk_date_range(
    const std::string& from_date, const std::string& to_date, int window_days) {
    std::vector<std::pair<std::string, std::string>> chunks;
    int fy, ty; unsigned fm, fd, tm, td;
    if (window_days < 1 || !parse_ymd(from_date, fy, fm, fd) || !parse_ymd(to_date, ty, tm, td)) {
        chunks.emplace_back(from_date, to_date);   // unreadable range: one request, as the daily path does
        return chunks;
    }
    const int64_t first = days_from_civil(fy, fm, fd);
    const int64_t last = days_from_civil(ty, tm, td);
    if (last < first) {
        chunks.emplace_back(from_date, to_date);
        return chunks;
    }
    // Windows of `window_days` calendar days from `from_date`, the last one clamped to `to_date`.
    // The old loop iterated day-of-month from from_day to to_day within from_date's month, and it
    // never read to_year or to_month: a range crossing a month boundary (28 Oct .. 2 Nov) had
    // from_day > to_day, so the loop body never ran and nothing was fetched at all.
    for (int64_t day = first; day <= last; day += window_days) {
        const int64_t end = std::min<int64_t>(last, day + window_days - 1);
        chunks.emplace_back(format_ymd(day), format_ymd(end));
    }
    return chunks;
}

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

    // Intraday requests are split into 3-day windows to stay under Upstox's 1000-candle response
    // cap. Daily requests go through as one range.
    std::vector<std::pair<std::string, std::string>> date_chunks;
    if (interval != "day") {
        date_chunks = chunk_date_range(from_date, to_date, 3);
    } else {
        date_chunks.push_back({from_date, to_date});
    }

    for (const auto& chunk : date_chunks) {
        std::string chunk_from = chunk.first;
        std::string chunk_to = chunk.second;

        std::string url = "https://api.upstox.com/v2/historical-candle/" + encoded_key + "/" + url_encode(interval) + "/" + chunk_to + "/" + chunk_from;

        std::string response;
        bool chunk_ok = false;

        for (int attempt = 0; attempt < 3; ++attempt) {
            out_report.retry_count += attempt;
            response.clear();

            // In-process HTTPS request; the URL is passed to libcurl as data. It used to be
            // interpolated into a `curl "<url>"` shell command, so a quote in an instrument key
            // or interval ended the string and ran the remainder in a shell.
            hermes::http::Request req;
            req.method = "GET";
            req.url = url;
            req.headers = {"Accept: application/json"};
            req.timeout_secs = 15;
            const hermes::http::Response http = hermes::http::perform(req);
            if (http.transport_ok) {
                response = http.body;
            } else {
                out_report.error_message = http.error;
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

            // end_arr pointed at the closing ']' of the array just consumed, so pos now sits one
            // past it. When that ']' was the final byte, pos == response.length() and indexing here
            // reads past the end of the buffer. Short-circuit instead: it was undefined behaviour,
            // and it was found by the CI static-analysis gate rather than by a crash.
            if (pos < response.length() && response[pos] == ']') break;
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
