#include "engine/nse_archive_fetcher.hpp"
#include <curl/curl.h>
#include <iostream>
#include <sstream>
#include <fstream>
#include <iomanip>
#include <algorithm>
#include <unistd.h>
#include <cstdio>

namespace hermes {

namespace {

size_t curl_write_string_cb(char* ptr, size_t size, size_t nmemb, void* userdata) {
    size_t total = size * nmemb;
    std::string* out = static_cast<std::string*>(userdata);
    if (out) {
        out->append(ptr, total);
    }
    return total;
}

std::vector<std::string> split_csv_line(const std::string& line) {
    std::vector<std::string> tokens;
    std::string current;
    bool in_quotes = false;

    for (size_t i = 0; i < line.size(); ++i) {
        char c = line[i];
        if (c == '"') {
            in_quotes = !in_quotes;
        } else if (c == ',' && !in_quotes) {
            tokens.push_back(current);
            current.clear();
        } else {
            current += c;
        }
    }
    tokens.push_back(current);

    // Clean whitespace and surrounding quotes
    for (auto& t : tokens) {
        while (!t.empty() && (t.front() == ' ' || t.front() == '\t' || t.front() == '"')) {
            t.erase(t.begin());
        }
        while (!t.empty() && (t.back() == ' ' || t.back() == '\t' || t.back() == '"' || t.back() == '\r')) {
            t.pop_back();
        }
    }
    return tokens;
}

std::string format_date_to_ddmmyyyy(const std::string& yyyymmdd) {
    // If format is YYYY-MM-DD
    if (yyyymmdd.length() == 10 && yyyymmdd[4] == '-' && yyyymmdd[7] == '-') {
        std::string yyyy = yyyymmdd.substr(0, 4);
        std::string mm = yyyymmdd.substr(5, 2);
        std::string dd = yyyymmdd.substr(8, 2);
        return dd + mm + yyyy;
    }
    // If format is YYYYMMDD
    if (yyyymmdd.length() == 8) {
        std::string yyyy = yyyymmdd.substr(0, 4);
        std::string mm = yyyymmdd.substr(4, 2);
        std::string dd = yyyymmdd.substr(6, 2);
        return dd + mm + yyyy;
    }
    return yyyymmdd;
}

std::string format_date_to_yyyymmdd(const std::string& input_date) {
    if (input_date.length() == 10 && input_date[4] == '-' && input_date[7] == '-') {
        return input_date.substr(0, 4) + input_date.substr(5, 2) + input_date.substr(8, 2);
    }
    return input_date;
}

} // anonymous namespace

bool NseArchiveFetcher::download_file(const std::string& url, std::string& out_content, long timeout_secs) {
    CURL* curl = curl_easy_init();
    if (!curl) return false;

    out_content.clear();
    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, curl_write_string_cb);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &out_content);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, timeout_secs);
    curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 1L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 2L);
    curl_easy_setopt(curl, CURLOPT_USERAGENT, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)");

    CURLcode res = curl_easy_perform(curl);
    long http_code = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &http_code);
    curl_easy_cleanup(curl);

    return (res == CURLE_OK && http_code == 200 && !out_content.empty());
}

bool NseArchiveFetcher::download_and_extract_zip(const std::string& zip_url, std::string& out_unzipped_content, long timeout_secs) {
    std::string zip_bytes;
    if (!download_file(zip_url, zip_bytes, timeout_secs)) {
        return false;
    }

    std::string temp_zip_path = "/tmp/nse_bhavcopy_temp_" + std::to_string(getpid()) + ".zip";
    std::ofstream ofs(temp_zip_path, std::ios::binary);
    if (!ofs) return false;
    ofs.write(zip_bytes.data(), zip_bytes.size());
    ofs.close();

    // Use unzip -p to extract the first entry directly to stdout
    std::string cmd = "unzip -p " + temp_zip_path;
    FILE* pipe = popen(cmd.c_str(), "r");
    if (!pipe) {
        unlink(temp_zip_path.c_str());
        return false;
    }

    char buffer[8192];
    out_unzipped_content.clear();
    while (fgets(buffer, sizeof(buffer), pipe) != nullptr) {
        out_unzipped_content.append(buffer);
    }
    pclose(pipe);
    unlink(temp_zip_path.c_str());

    return !out_unzipped_content.empty();
}

ParticipantOiSnapshot NseArchiveFetcher::parse_participant_oi_csv(const std::string& csv_content, const std::string& date_yyyymmdd) {
    ParticipantOiSnapshot snapshot;
    snapshot.report_date = date_yyyymmdd;
    snapshot.success = false;

    if (csv_content.empty()) {
        snapshot.error_message = "Empty CSV content";
        return snapshot;
    }

    std::istringstream stream(csv_content);
    std::string line;
    bool found_header = false;

    while (std::getline(stream, line)) {
        if (line.empty()) continue;
        auto tokens = split_csv_line(line);
        if (tokens.empty()) continue;

        if (!found_header) {
            if (tokens[0].find("Client Type") != std::string::npos || tokens[0] == "Client Type") {
                found_header = true;
            }
            continue;
        }

        // Data rows: Client, DII, FII, Pro, TOTAL
        if (tokens.size() >= 15) {
            std::string ctype = tokens[0];
            if (ctype == "Client" || ctype == "DII" || ctype == "FII" || ctype == "Pro") {
                ParticipantOiRecord rec;
                rec.client_type = ctype;
                try {
                    rec.future_index_long = std::stoll(tokens[1]);
                    rec.future_index_short = std::stoll(tokens[2]);
                    rec.future_stock_long = std::stoll(tokens[3]);
                    rec.future_stock_short = std::stoll(tokens[4]);
                    rec.option_index_call_long = std::stoll(tokens[5]);
                    rec.option_index_put_long = std::stoll(tokens[6]);
                    rec.option_index_call_short = std::stoll(tokens[7]);
                    rec.option_index_put_short = std::stoll(tokens[8]);
                    rec.total_long_contracts = std::stoll(tokens[13]);
                    rec.total_short_contracts = std::stoll(tokens[14]);
                } catch (...) {}
                snapshot.records.push_back(rec);

                if (ctype == "FII") {
                    snapshot.fii_net_index_futures = rec.net_index_futures();
                    if (rec.future_index_short > 0) {
                        snapshot.fii_long_short_ratio = static_cast<double>(rec.future_index_long) / rec.future_index_short;
                    }
                } else if (ctype == "Pro") {
                    snapshot.pro_net_index_futures = rec.net_index_futures();
                } else if (ctype == "Client") {
                    snapshot.client_net_index_futures = rec.net_index_futures();
                }
            }
        }
    }

    if (!snapshot.records.empty()) {
        snapshot.success = true;
    } else {
        snapshot.error_message = "Failed to parse participant OI records from CSV";
    }
    return snapshot;
}

ParticipantOiSnapshot NseArchiveFetcher::fetch_participant_oi(const std::string& date_yyyymmdd) {
    std::string ddmmyyyy = format_date_to_ddmmyyyy(date_yyyymmdd);
    std::string url = "https://archives.nseindia.com/content/nsccl/fao_participant_oi_" + ddmmyyyy + ".csv";

    std::string content;
    bool ok = download_file(url, content);
    if (!ok) {
        ParticipantOiSnapshot snap;
        snap.report_date = date_yyyymmdd;
        snap.success = false;
        snap.error_message = "HTTP download failed for URL: " + url;
        return snap;
    }

    return parse_participant_oi_csv(content, date_yyyymmdd);
}

BhavcopyOptionChainSnapshot NseArchiveFetcher::parse_bhavcopy_csv(const std::string& csv_content, const std::string& target_underlying) {
    BhavcopyOptionChainSnapshot snapshot;
    snapshot.underlying = target_underlying;
    snapshot.success = false;

    if (csv_content.empty()) {
        snapshot.error_message = "Empty Bhavcopy CSV content";
        return snapshot;
    }

    std::istringstream stream(csv_content);
    std::string line;
    bool found_header = false;

    while (std::getline(stream, line)) {
        if (line.empty()) continue;
        auto tokens = split_csv_line(line);
        if (tokens.size() < 24) continue;

        if (!found_header) {
            if (tokens[0] == "TradDt" || tokens[0].find("TradDt") != std::string::npos) {
                found_header = true;
            }
            continue;
        }

        // Column 7: TckrSymb (NIFTY, BANKNIFTY)
        // Column 12: OptnTp (CE, PE)
        if (tokens[7] == target_underlying && (tokens[12] == "CE" || tokens[12] == "PE")) {
            BhavcopyStrikeRecord rec;
            rec.trade_date = tokens[0];
            rec.underlying = tokens[7];
            rec.expiry_date = tokens[9];
            rec.option_type = tokens[12];
            rec.contract_symbol = tokens[13];

            try {
                rec.strike_price = std::stod(tokens[11]);
                rec.open_price = std::stod(tokens[14]);
                rec.high_price = std::stod(tokens[15]);
                rec.low_price = std::stod(tokens[16]);
                rec.close_price = std::stod(tokens[17]);
                rec.underlying_price = std::stod(tokens[20]);
                rec.settlement_price = std::stod(tokens[21]);
                rec.open_interest = std::stoll(tokens[22]);
                rec.change_in_oi = std::stoll(tokens[23]);
                if (tokens.size() > 24) rec.volume = std::stoll(tokens[24]);
            } catch (...) {}

            if (rec.underlying_price > 0.0) {
                snapshot.underlying_close = rec.underlying_price;
            }
            if (rec.option_type == "CE") {
                snapshot.total_call_oi += rec.open_interest;
            } else if (rec.option_type == "PE") {
                snapshot.total_put_oi += rec.open_interest;
            }

            if (snapshot.trade_date.empty()) {
                snapshot.trade_date = rec.trade_date;
            }
            snapshot.strikes.push_back(rec);
        }
    }

    if (!snapshot.strikes.empty()) {
        snapshot.success = true;
        if (snapshot.total_call_oi > 0) {
            snapshot.aggregate_pcr_oi = static_cast<double>(snapshot.total_put_oi) / snapshot.total_call_oi;
        }
    } else {
        snapshot.error_message = "No strikes matched underlying " + target_underlying;
    }
    return snapshot;
}

BhavcopyOptionChainSnapshot NseArchiveFetcher::fetch_bhavcopy_option_chain(const std::string& date_yyyymmdd, const std::string& target_underlying) {
    std::string raw_date = format_date_to_yyyymmdd(date_yyyymmdd);
    std::string zip_url = "https://archives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_" + raw_date + "_F_0000.csv.zip";

    std::string unzipped_csv;
    bool ok = download_and_extract_zip(zip_url, unzipped_csv);
    if (!ok) {
        BhavcopyOptionChainSnapshot snap;
        snap.trade_date = date_yyyymmdd;
        snap.underlying = target_underlying;
        snap.success = false;
        snap.error_message = "Failed to download or unzip Bhavcopy from: " + zip_url;
        return snap;
    }

    return parse_bhavcopy_csv(unzipped_csv, target_underlying);
}

} // namespace hermes
