#ifndef ENGINE_MARKET_CALENDAR_HPP
#define ENGINE_MARKET_CALENDAR_HPP

#include <string>
#include <cstdint>
#include <chrono>

namespace hermes {

enum class SessionPhase {
    CLOSED,
    PRE_OPEN,      // 09:00 - 09:08 IST
    OPEN_AUCTION,  // 09:08 - 09:15 IST
    MARKET_OPEN,   // 09:15 - 15:30 IST (Continuous trading)
    POST_OPEN      // 15:30 - 16:00 IST
};

struct IstDateTime {
    int year;
    int month;   // 1 - 12
    int day;     // 1 - 31
    int weekday; // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
    int hour;    // 0 - 23
    int minute;  // 0 - 59
    int second;  // 0 - 59
    int total_minutes_of_day; // hour * 60 + minute
};

class MarketCalendar {
public:
    static constexpr int64_t IST_OFFSET_MS = 19800000; // +5.5 hours in ms

    static constexpr int PRE_OPEN_START_MIN = 9 * 60;        // 09:00 (540)
    static constexpr int OPEN_AUCTION_START_MIN = 9 * 60 + 8;// 09:08 (548)
    static constexpr int MARKET_OPEN_START_MIN = 9 * 60 + 15;// 09:15 (555)
    static constexpr int MARKET_CLOSE_MIN = 15 * 60 + 30;    // 15:30 (930)
    static constexpr int POST_OPEN_END_MIN = 16 * 60;        // 16:00 (960)

    static IstDateTime get_ist_time(uint64_t epoch_ms = 0);
    static bool is_trading_weekday(const IstDateTime& ist);
    static bool is_nse_holiday(int year, int month, int day);
    static bool is_trading_day(uint64_t epoch_ms = 0);

    // True when the YYMMDD expiry embedded in a trading symbol has already passed in IST
    // terms, e.g. SENSEX26100172400CE -> 2026-10-01 is expired on 2026-10-14.
    //
    // Returns false when no expiry can be parsed. An unrecognised symbol must never be
    // treated as expired, so the insert-time guard in create_paper_trade remains the
    // backstop for anything this cannot read -- the two must never disagree in the
    // dangerous direction (accepting a contract that has already expired).
    //
    // The comparison is date-granular and uses "strictly before today": a contract
    // expiring today is still tradable and is NOT reported expired.
    static bool is_contract_expired(const std::string& symbol, uint64_t epoch_ms = 0);
    static SessionPhase get_session_phase(uint64_t epoch_ms = 0);
    static bool is_market_open(uint64_t epoch_ms = 0);
    static std::string session_phase_to_string(SessionPhase phase);
};

} // namespace hermes

#endif // ENGINE_MARKET_CALENDAR_HPP
