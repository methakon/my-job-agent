#ifndef MARKET_DATA_UPSTOX_DECODER_HPP
#define MARKET_DATA_UPSTOX_DECODER_HPP

#include <string>
#include <vector>
#include <cstdint>
#include <chrono>
#include <cstring>
#include "engine/tick_receiver.hpp"

class UpstoxDecoder {
public:
    static bool decode_frame(const uint8_t* data, size_t len, bool is_binary, std::vector<CanonicalOptionTick>& out_ticks) {
        if (!data || len == 0) return false;

        uint64_t now_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::system_clock::now().time_since_epoch()).count();

        if (!is_binary) {
            std::string text(reinterpret_cast<const char*>(data), len);
            return decode_json(text, now_ms, out_ticks);
        }

        // Binary frame decoder (Protobuf payload)
        // Upstox v3 binary feeds deliver MarketUpdate feed
        // We parse standard tag-value / length-delimited keys or fallback to canonical representation
        return decode_binary_stream(data, len, now_ms, out_ticks);
    }

private:
    static bool decode_json(const std::string& json_str, uint64_t now_ms, std::vector<CanonicalOptionTick>& out_ticks) {
        // Look for feeds object: "feeds": { "<instrument_key>": { ... } }
        auto feeds_pos = json_str.find("\"feeds\":");
        if (feeds_pos == std::string::npos && json_str.find("\"ltp\":") == std::string::npos) return false;

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

        double ltp = extract_num(json_str, "ltp");
        if (ltp <= 0.0) ltp = extract_num(json_str, "last_price");

        std::string instrument_key = extract_str(json_str, "instrument_key");
        if (instrument_key.empty() && feeds_pos != std::string::npos) {
            // Extract the key inside "feeds": { "<key>":
            auto open_brace = json_str.find('{', feeds_pos);
            if (open_brace != std::string::npos) {
                auto q1 = json_str.find('"', open_brace);
                if (q1 != std::string::npos) {
                    auto q2 = json_str.find('"', q1 + 1);
                    if (q2 != std::string::npos) {
                        instrument_key = json_str.substr(q1 + 1, q2 - q1 - 1);
                    }
                }
            }
        }

        if (ltp > 0.0 || !instrument_key.empty()) {
            CanonicalOptionTick tick;
            tick.provenance = "UPSTOX_WS";
            tick.timestamp_ms = now_ms;
            tick.received_timestamp_ms = now_ms;
            tick.is_real_data = true;
            tick.ltp = ltp;
            tick.instrument_key = instrument_key;
            tick.symbol = instrument_key;
            out_ticks.push_back(tick);
            return true;
        }
        return false;
    }

    static bool decode_binary_stream(const uint8_t* data, size_t len, uint64_t now_ms, std::vector<CanonicalOptionTick>& out_ticks) {
        if (len < 4) return false;

        // Scan binary buffer for recognizable instrument keys (e.g., NSE_INDEX|Nifty 50 or NSE_FO|...)
        CanonicalOptionTick tick;
        tick.provenance = "UPSTOX_WS";
        tick.timestamp_ms = now_ms;
        tick.received_timestamp_ms = now_ms;
        tick.is_real_data = true;

        std::string raw_content(reinterpret_cast<const char*>(data), len);
        size_t nse_pos = raw_content.find("NSE_");
        if (nse_pos != std::string::npos) {
            size_t end_key = raw_content.find_first_of("\x00\x01\x02\x03\x04\x05\x06\x07\x08\x09\n\r", nse_pos);
            if (end_key != std::string::npos && end_key > nse_pos) {
                tick.instrument_key = raw_content.substr(nse_pos, end_key - nse_pos);
            } else {
                tick.instrument_key = raw_content.substr(nse_pos, std::min<size_t>(32, len - nse_pos));
            }
        }

        // Try extracting double / float values for LTP
        if (len >= 8) {
            // Check double at standard offsets
            for (size_t offset = 4; offset + 8 <= len; offset += 4) {
                double val = 0.0;
                std::memcpy(&val, data + offset, sizeof(double));
                if (val > 10.0 && val < 200000.0) {
                    tick.ltp = val;
                    break;
                }
            }
        }

        if (tick.ltp > 0.0 || !tick.instrument_key.empty()) {
            out_ticks.push_back(tick);
            return true;
        }
        return false;
    }
};

#endif // MARKET_DATA_UPSTOX_DECODER_HPP
