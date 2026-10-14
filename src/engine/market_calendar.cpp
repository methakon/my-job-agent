#include "market_calendar.hpp"
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
