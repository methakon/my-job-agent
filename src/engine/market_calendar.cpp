#include "market_calendar.hpp"
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

bool MarketCalendar::is_nse_holiday(int year, int month, int day) {
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

    return holidays.find(std::make_tuple(year, month, day)) != holidays.end();
}

bool MarketCalendar::is_trading_day(uint64_t epoch_ms) {
    auto ist = get_ist_time(epoch_ms);
    if (!is_trading_weekday(ist)) return false;
    if (is_nse_holiday(ist.year, ist.month, ist.day)) return false;
    return true;
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
