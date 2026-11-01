#include "market_calendar.hpp"
#include "../common/env_loader.hpp"
#include <fstream>
#include <iostream>
#include <mutex>
#include <sstream>
#include <cctype>
#include <ctime>
#include <set>
#include <tuple>

namespace hermes {

IstDateTime MarketCalendar::get_ist_time(uint64_t epoch_ms) {
    if (epoch_ms == 0) {
        epoch_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::system_clock::now().time_since_epoch()
        ).count();
    }

    int64_t ist_ms = static_cast<int64_t>(epoch_ms) + IST_OFFSET_MS;
    time_t ist_sec = static_cast<time_t>(ist_ms / 1000);

    struct tm tm_buf;
    gmtime_r(&ist_sec, &tm_buf);

    IstDateTime dt;
    dt.year = tm_buf.tm_year + 1900;
    dt.month = tm_buf.tm_mon + 1;
    dt.day = tm_buf.tm_mday;
    dt.weekday = tm_buf.tm_wday; // 0 = Sun, 1 = Mon, ..., 6 = Sat
    dt.hour = tm_buf.tm_hour;
    dt.minute = tm_buf.tm_min;
    dt.second = tm_buf.tm_sec;
    dt.total_minutes_of_day = dt.hour * 60 + dt.minute;
    return dt;
}

bool MarketCalendar::is_trading_weekday(const IstDateTime& ist) {
    return (ist.weekday >= 1 && ist.weekday <= 5);
}

namespace {

bool real_calendar_date(int y, int m, int d) {
    if (y < 1970 || y > 2200 || m < 1 || m > 12 || d < 1) return false;
    static const int md[12] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
    const bool leap = (y % 4 == 0 && (y % 100 != 0 || y % 400 == 0));
    return d <= ((m == 2 && leap) ? 29 : md[m - 1]);
}

// Holidays added from NSE_HOLIDAYS / NSE_HOLIDAYS_FILE. Built once; read-only afterwards.
const std::set<std::tuple<int, int, int>>& extra_holidays() {
    static std::set<std::tuple<int, int, int>> extra;
    static std::once_flag once;
    std::call_once(once, [] {
        std::vector<std::string> rejected;
        const std::string env = EnvLoader::get("NSE_HOLIDAYS", "");
        if (!env.empty()) {
            auto parsed = MarketCalendar::parse_holiday_list(env, &rejected);
            extra.insert(parsed.begin(), parsed.end());
        }
        const std::string file = EnvLoader::get("NSE_HOLIDAYS_FILE", "");
        if (!file.empty()) {
            std::ifstream in(file);
            if (!in) {
                std::cerr << "⚠️ [MarketCalendar] NSE_HOLIDAYS_FILE could not be read: " << file << "\n";
            } else {
                std::stringstream buf;
                buf << in.rdbuf();
                auto parsed = MarketCalendar::parse_holiday_list(buf.str(), &rejected);
                extra.insert(parsed.begin(), parsed.end());
            }
        }
        for (const std::string& r : rejected) {
            std::cerr << "⚠️ [MarketCalendar] ignored holiday entry that is not a valid YYYY-MM-DD date: \"" << r << "\"\n";
        }
    });
    return extra;
}

const std::set<std::tuple<int, int, int>>& builtin_holidays() {
    // Standard NSE Trading Holidays for 2026
    static const std::set<std::tuple<int, int, int>> holidays = {
        {2026, 1, 26},  // Republic Day
        {2026, 2, 17},  // Mahashivratri
        {2026, 3, 3},   // Holi
        {2026, 3, 20},  // Id-Ul-Fitr
        {2026, 4, 3},   // Good Friday
        {2026, 4, 14},  // Dr. Ambedkar Jayanti
        {2026, 5, 1},   // Maharashtra Day
        {2026, 5, 27},  // Bakri Id / Eid ul-Adha
        {2026, 8, 15},  // Independence Day
        {2026, 10, 2},  // Mahatma Gandhi Jayanti
        {2026, 10, 20}, // Dussehra
        {2026, 11, 8},  // Diwali Laxmi Pujan (regular session closed)
        {2026, 11, 9},  // Diwali Balipratipada
        {2026, 11, 24}, // Guru Nanak Jayanti
        {2026, 12, 25}  // Christmas
    };
    return holidays;
}

}  // namespace

std::set<std::tuple<int, int, int>> MarketCalendar::parse_holiday_list(const std::string& text,
                                                                       std::vector<std::string>* rejected) {
    std::set<std::tuple<int, int, int>> out;
    std::string token;
    auto flush = [&]() {
        // trim
        size_t b = token.find_first_not_of(" \t\r");
        size_t e = token.find_last_not_of(" \t\r");
        std::string t = (b == std::string::npos) ? "" : token.substr(b, e - b + 1);
        token.clear();
        if (t.empty()) return;
        bool shape = t.size() == 10 && t[4] == '-' && t[7] == '-';
        for (size_t i = 0; shape && i < t.size(); ++i) {
            if (i == 4 || i == 7) continue;
            if (!std::isdigit(static_cast<unsigned char>(t[i]))) shape = false;
        }
        if (shape) {
            const int y = std::stoi(t.substr(0, 4)), m = std::stoi(t.substr(5, 2)), d = std::stoi(t.substr(8, 2));
            if (real_calendar_date(y, m, d)) { out.insert(std::make_tuple(y, m, d)); return; }
        }
        if (rejected) rejected->push_back(t);
    };
    bool in_comment = false;
    for (char c : text) {
        if (c == '\n') { in_comment = false; flush(); continue; }
        if (in_comment) continue;
        if (c == '#') { in_comment = true; flush(); continue; }
        if (c == ',') { flush(); continue; }
        token.push_back(c);
    }
    flush();
    return out;
}

bool MarketCalendar::holiday_data_covers_year(int year) {
    for (const auto& h : builtin_holidays()) if (std::get<0>(h) == year) return true;
    for (const auto& h : extra_holidays()) if (std::get<0>(h) == year) return true;
    return false;
}

bool MarketCalendar::is_nse_holiday(int year, int month, int day) {
    // A year with no holiday data cannot answer "is this a holiday?": every weekday of it would read
    // as a trading day. Say so once per year instead of failing silently.
    if (!holiday_data_covers_year(year)) {
        static std::mutex warn_mutex;
        static std::set<int> warned;
        std::lock_guard<std::mutex> lock(warn_mutex);
        if (warned.insert(year).second) {
            std::cerr << "⚠️ [MarketCalendar] No NSE holiday data for " << year
                      << ": every weekday will be treated as a trading day. Set NSE_HOLIDAYS or NSE_HOLIDAYS_FILE.\n";
        }
    }
    const auto key = std::make_tuple(year, month, day);
    return builtin_holidays().count(key) > 0 || extra_holidays().count(key) > 0;
}

bool MarketCalendar::is_trading_day(uint64_t epoch_ms) {
    auto ist = get_ist_time(epoch_ms);
    if (!is_trading_weekday(ist)) return false;
    if (is_nse_holiday(ist.year, ist.month, ist.day)) return false;
    return true;
}

MarketCalendar::ExpiryState MarketCalendar::expiry_state(const std::string& symbol, uint64_t epoch_ms) {
    // Locate the first run of six consecutive digits, the YYMMDD expiry that option
    // trading symbols embed after the underlying name: SENSEX26100172400CE -> 261001.
    std::size_t pos = std::string::npos;
    for (std::size_t i = 0; i + 6 <= symbol.size(); ++i) {
        bool six_digits = true;
        for (std::size_t j = 0; j < 6; ++j) {
            if (!std::isdigit(static_cast<unsigned char>(symbol[i + j]))) {
                six_digits = false;
                break;
            }
        }
        if (!six_digits) continue;

        // A six-digit window only counts if it is a real calendar date. Anything else is the
        // underlying's own digits or the strike, so keep scanning rather than giving up on the
        // first run. This is the NIFTY50 bug: "NIFTY50" + "261006" merges into "502610", which
        // reads as month 26 and is not a date, so bailing there made every NIFTY50-prefixed
        // contract report as not-expired. On 2026-10-14 that let 23 expired contracts through
        // into the trade table.
        const int cand_yy = std::stoi(symbol.substr(i, 2)) + 2000;
        const int cand_mm = std::stoi(symbol.substr(i + 2, 2));
        const int cand_dd = std::stoi(symbol.substr(i + 4, 2));
        if (cand_mm < 1 || cand_mm > 12) continue;
        static const int month_days[12] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
        const bool leap_year = (cand_yy % 4 == 0 && (cand_yy % 100 != 0 || cand_yy % 400 == 0));
        const int day_max = (cand_mm == 2 && leap_year) ? 29 : month_days[cand_mm - 1];
        if (cand_dd < 1 || cand_dd > day_max) continue;

        pos = i;
        break;
    }

    // No readable expiry at all: UNKNOWN, never "not expired".
    if (pos == std::string::npos) return ExpiryState::UNKNOWN;

    // No readable expiry. This used to return false ("not expired") on purpose, on the argument
    // that the insert-time guard was a sufficient backstop and that dropping unrecognised symbols
    // would be the worse failure. Review rejected that: it is a safety check failing open, and the
    // guard it relied on is the unique idempotency index, which constrains duplicate writes, not
    // tradability. UNKNOWN is now reported as its own state so the caller can refuse the contract
    // and say so, rather than silently dropping it.

    const int yy = std::stoi(symbol.substr(pos, 2)) + 2000;
    const int mm = std::stoi(symbol.substr(pos + 2, 2));
    const int dd = std::stoi(symbol.substr(pos + 4, 2));
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return ExpiryState::UNKNOWN;

    const auto ist = get_ist_time(epoch_ms);

    const long expiry_num = static_cast<long>(yy) * 10000L + mm * 100L + dd;
    const long today_num = static_cast<long>(ist.year) * 10000L + ist.month * 100L + ist.day;

    // Strictly before today: a contract expiring today is still tradable.
    return (expiry_num < today_num) ? ExpiryState::EXPIRED : ExpiryState::NOT_EXPIRED;
}

// Boolean compatibility form. Note the direction: an UNKNOWN expiry is NOT reported as expired
// here, so a caller that only asks this question keeps its previous behaviour. Callers that gate
// entries must use expiry_state() and treat UNKNOWN as blocking - see main.cpp.
bool MarketCalendar::is_contract_expired(const std::string& symbol, uint64_t epoch_ms) {
    return expiry_state(symbol, epoch_ms) == MarketCalendar::ExpiryState::EXPIRED;
}

SessionPhase MarketCalendar::get_session_phase(uint64_t epoch_ms) {
    if (!is_trading_day(epoch_ms)) {
        return SessionPhase::CLOSED;
    }

    auto ist = get_ist_time(epoch_ms);
    int m = ist.total_minutes_of_day;

    if (m < PRE_OPEN_START_MIN) return SessionPhase::CLOSED;
    if (m < OPEN_AUCTION_START_MIN) return SessionPhase::PRE_OPEN;
    if (m < MARKET_OPEN_START_MIN) return SessionPhase::OPEN_AUCTION;
    if (m < MARKET_CLOSE_MIN) return SessionPhase::MARKET_OPEN;
    if (m < POST_OPEN_END_MIN) return SessionPhase::POST_OPEN;
    return SessionPhase::CLOSED;
}

bool MarketCalendar::is_market_open(uint64_t epoch_ms) {
    return get_session_phase(epoch_ms) == SessionPhase::MARKET_OPEN;
}

std::string MarketCalendar::session_phase_to_string(SessionPhase phase) {
    switch (phase) {
        case SessionPhase::PRE_OPEN: return "PRE_OPEN";
        case SessionPhase::OPEN_AUCTION: return "OPEN_AUCTION";
        case SessionPhase::MARKET_OPEN: return "MARKET_OPEN";
        case SessionPhase::POST_OPEN: return "POST_OPEN";
        case SessionPhase::CLOSED:
        default: return "CLOSED";
    }
}

} // namespace hermes
