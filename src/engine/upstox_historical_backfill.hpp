#ifndef HERMES_UPSTOX_HISTORICAL_BACKFILL_HPP
#define HERMES_UPSTOX_HISTORICAL_BACKFILL_HPP

#include <string>
#include <vector>
#include <map>
#include <memory>
#include <mutex>

struct UpstoxCandleRecord {
    std::string timestamp_iso;
    std::string timestamp_mysql;
    double open{0.0};
    double high{0.0};
    double low{0.0};
    double close{0.0};
    int64_t volume{0};
    int64_t open_interest{0};
    std::string instrument_key;
    std::string symbol;
    std::string interval; // e.g. "day", "30minute", "1minute"
    std::string data_source{"UPSTOX_HISTORICAL_CANDLE"};
    std::string granularity{"CANDLE"};
};

struct UpstoxBackfillReport {
    std::string instrument;
    std::string upstox_ref;
    std::string session_date;
    std::string interval;
    std::string first_timestamp;
    std::string last_timestamp;
    size_t records_retrieved{0};
    size_t records_inserted{0};
    size_t duplicates_prevented{0};
    size_t full_sessions_count{0};
    size_t partial_sessions_count{0};
    size_t degraded_sessions_count{0};
    bool ohlc_sanity_pass{false};
    bool volume_sanity_pass{false};
    bool oi_available{false};
    bool api_success{false};
    int retry_count{0};
    std::string data_source{"UPSTOX_HISTORICAL_CANDLE"};
    std::string granularity{"CANDLE"};
    std::string error_message;
};

class UpstoxHistoricalBackfillEngine {
public:
    UpstoxHistoricalBackfillEngine();

    // Map display symbol to official Upstox V3 instrument key
    static std::string get_upstox_instrument_key(const std::string& symbol);

    // Normalize symbol name for MySQL table consistency ("NIFTY50", "NIFTYBANK", "SENSEX")
    static std::string normalize_symbol_for_db(const std::string& symbol);

    // Fetch historical candle data from Upstox V2/V3 REST API via curl
    static std::vector<UpstoxCandleRecord> fetch_historical_candles_api(
        const std::string& instrument_key,
        const std::string& symbol,
        const std::string& interval,
        const std::string& to_date,
        const std::string& from_date,
        UpstoxBackfillReport& out_report
    );

    // Parse ISO timestamp (e.g. "2026-09-30T15:29:00+05:30") to MySQL format ("2026-09-30 15:29:00")
    static std::string iso_to_mysql_datetime(const std::string& iso_str);

    // Execute OHLC and volume sanity checks on candle dataset
    static bool validate_candle_sanity(const std::vector<UpstoxCandleRecord>& candles, bool& out_ohlc, bool& out_vol);
};

#endif // HERMES_UPSTOX_HISTORICAL_BACKFILL_HPP
