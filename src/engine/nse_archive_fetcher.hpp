#ifndef NSE_ARCHIVE_FETCHER_HPP
#define NSE_ARCHIVE_FETCHER_HPP

#include <string>
#include <vector>
#include <cstdint>
#include <map>

namespace hermes {

struct ParticipantOiRecord {
    std::string client_type; // "Client", "DII", "FII", "Pro"
    int64_t future_index_long{0};
    int64_t future_index_short{0};
    int64_t future_stock_long{0};
    int64_t future_stock_short{0};
    int64_t option_index_call_long{0};
    int64_t option_index_put_long{0};
    int64_t option_index_call_short{0};
    int64_t option_index_put_short{0};
    int64_t total_long_contracts{0};
    int64_t total_short_contracts{0};

    int64_t net_index_futures() const { return future_index_long - future_index_short; }
    int64_t net_index_calls() const { return option_index_call_long - option_index_call_short; }
    int64_t net_index_puts() const { return option_index_put_long - option_index_put_short; }
};

struct ParticipantOiSnapshot {
    std::string report_date; // YYYY-MM-DD
    std::vector<ParticipantOiRecord> records;
    double fii_long_short_ratio{0.0};
    int64_t fii_net_index_futures{0};
    int64_t pro_net_index_futures{0};
    int64_t client_net_index_futures{0};
    bool success{false};
    std::string error_message;
};

struct BhavcopyStrikeRecord {
    std::string trade_date;
    std::string underlying; // e.g. "NIFTY", "BANKNIFTY"
    std::string expiry_date;
    double strike_price{0.0};
    std::string option_type; // "CE" or "PE"
    std::string contract_symbol;
    double open_price{0.0};
    double high_price{0.0};
    double low_price{0.0};
    double close_price{0.0};
    double underlying_price{0.0};
    double settlement_price{0.0};
    int64_t open_interest{0};
    int64_t change_in_oi{0};
    int64_t volume{0};
};

struct BhavcopyOptionChainSnapshot {
    std::string trade_date;
    std::string underlying;
    double underlying_close{0.0};
    std::vector<BhavcopyStrikeRecord> strikes;
    int64_t total_call_oi{0};
    int64_t total_put_oi{0};
    double aggregate_pcr_oi{0.0};
    bool success{false};
    std::string error_message;
};

class NseArchiveFetcher {
public:
    // Downloads and parses official daily Participant-wise Open Interest report (fao_participant_oi_DDMMYYYY.csv)
    static ParticipantOiSnapshot fetch_participant_oi(const std::string& date_yyyymmdd);

    // Parses raw CSV text of Participant-wise Open Interest
    static ParticipantOiSnapshot parse_participant_oi_csv(const std::string& csv_content, const std::string& date_yyyymmdd);

    // Downloads, unzips, and parses official daily F&O Bhavcopy (BhavCopy_NSE_FO_0_0_0_YYYYMMDD_F_0000.csv.zip)
    static BhavcopyOptionChainSnapshot fetch_bhavcopy_option_chain(const std::string& date_yyyymmdd, const std::string& target_underlying = "NIFTY");

    // Parses unzipped Bhavcopy CSV content for specified underlying
    static BhavcopyOptionChainSnapshot parse_bhavcopy_csv(const std::string& csv_content, const std::string& target_underlying);

    // Helper: downloads content via libcurl
    static bool download_file(const std::string& url, std::string& out_content, long timeout_secs = 15);

    // Helper: downloads zip file and extracts payload
    static bool download_and_extract_zip(const std::string& zip_url, std::string& out_unzipped_content, long timeout_secs = 20);
};

} // namespace hermes

#endif // NSE_ARCHIVE_FETCHER_HPP
