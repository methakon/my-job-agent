#ifndef MARKET_DATA_FYERS_DECODER_HPP
#define MARKET_DATA_FYERS_DECODER_HPP

#include <string>
#include <vector>
#include <cstdint>
#include <chrono>
#include <cstring>
#include "engine/tick_receiver.hpp"

class FyersDecoder {
public:
    static bool decode_frame(const uint8_t* data, size_t len, bool is_binary, std::vector<CanonicalOptionTick>& out_ticks) {
        if (!data || len == 0) return false;

        uint64_t now_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::system_clock::now().time_since_epoch()).count();

        if (!is_binary) {
            std::string text(reinterpret_cast<const char*>(data), len);
            return decode_json(text, now_ms, out_ticks);
        }

        return decode_binary(data, len, now_ms, out_ticks);
    }

private:
    static bool decode_json(const std::string& json_str, uint64_t now_ms, std::vector<CanonicalOptionTick>& out_ticks) {
        auto extract_num = [](const std::string& str, const std::string& key) -> double {
            auto pos = str.find("\"" + key + "\":");
            if (pos == std::string::npos) return 0.0;
            auto colon = str.find(':', pos);
            if (colon == std::string::npos) return 0.0;
            auto start = str.find_first_not_of(" \"\r\n\t", colon + 1);
            if (start == std::string::npos) return 0.0;
            auto end = str.find_first_of(",}\" \r\n\t", start);
            if (end == std::string::npos) end = str.size();
            try {
                return std::stod(str.substr(start, end - start));
            } catch (...) {
                return 0.0;
            }
        };

        auto extract_str = [](const std::string& str, const std::string& key) -> std::string {
            auto pos = str.find("\"" + key + "\":");
            if (pos == std::string::npos) return "";
            auto colon = str.find(':', pos);
            if (colon == std::string::npos) return "";
            auto q1 = str.find('"', colon + 1);
            if (q1 == std::string::npos) return "";
            auto q2 = str.find('"', q1 + 1);
            if (q2 == std::string::npos) return "";
            return str.substr(q1 + 1, q2 - q1 - 1);
        };

        std::string symbol = extract_str(json_str, "symbol");
        if (symbol.empty()) symbol = extract_str(json_str, "original_name");
        if (symbol.empty()) symbol = extract_str(json_str, "name");

        double ltp = extract_num(json_str, "ltp");
        if (ltp <= 0.0) ltp = extract_num(json_str, "lp");
        if (ltp <= 0.0) ltp = extract_num(json_str, "iv");

        if (ltp > 0.0 || !symbol.empty()) {
            CanonicalOptionTick tick;
            tick.provenance = "FYERS_WS";
            tick.timestamp_ms = now_ms;
            tick.received_timestamp_ms = now_ms;
            tick.is_real_data = true;
            tick.ltp = ltp;
            tick.symbol = symbol;
            tick.instrument_key = symbol;

            double vol = extract_num(json_str, "vol_traded_today");
            if (vol <= 0.0) vol = extract_num(json_str, "v");
            tick.volume = static_cast<uint64_t>(vol);

            double bid = extract_num(json_str, "bid_price");
            if (bid <= 0.0) bid = extract_num(json_str, "bp");
            tick.bid_price = bid;

            double ask = extract_num(json_str, "ask_price");
            if (ask <= 0.0) ask = extract_num(json_str, "sp");
            tick.ask_price = ask;

            out_ticks.push_back(tick);
            return true;
        }

        return false;
    }

    static bool decode_binary(const uint8_t* data, size_t len, uint64_t now_ms, std::vector<CanonicalOptionTick>& out_ticks) {
        if (len < 8) return false;

        // FYERS binary frame scanning: contains symbol string (e.g. NSE:NIFTY or NSE:BANKNIFTY)
        std::string raw(reinterpret_cast<const char*>(data), len);
        size_t nse_pos = raw.find("NSE:");
        if (nse_pos == std::string::npos) {
            nse_pos = raw.find("BSE:");
        }

        CanonicalOptionTick tick;
        tick.provenance = "FYERS_WS";
        tick.timestamp_ms = now_ms;
        tick.received_timestamp_ms = now_ms;
        tick.is_real_data = true;

        if (nse_pos != std::string::npos) {
            size_t end_sym = raw.find_first_of("\x00\x01\x02\x03\x04\x05\x06\x07\x08\x09\n\r ", nse_pos);
            if (end_sym != std::string::npos && end_sym > nse_pos) {
                tick.symbol = raw.substr(nse_pos, end_sym - nse_pos);
                tick.instrument_key = tick.symbol;
            }
        }

        // Search for plausible price values
        for (size_t offset = 4; offset + 4 <= len; offset += 4) {
            uint32_t raw_val = 0;
            std::memcpy(&raw_val, data + offset, 4);
            // FYERS prices are integer cents/paise (divide by 100) or floats
            double price = static_cast<double>(raw_val) / 100.0;
            if (price > 10.0 && price < 200000.0) {
                tick.ltp = price;
                break;
            }
        }

        if (tick.ltp > 0.0 || !tick.symbol.empty()) {
            out_ticks.push_back(tick);
            return true;
        }

        return false;
    }
};

#endif // MARKET_DATA_FYERS_DECODER_HPP
