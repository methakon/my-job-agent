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

        return decode_binary_stream(data, len, now_ms, out_ticks);
    }

private:
    static bool decode_json(const std::string& json_str, uint64_t now_ms, std::vector<CanonicalOptionTick>& out_ticks) {
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

        // Strict positive ltp and non-empty valid symbol check
        if (ltp > 0.0 && ltp < 1000000.0 && !instrument_key.empty() &&
            instrument_key.find("NSE_COM") == std::string::npos &&
            instrument_key.find("NCD_FO") == std::string::npos) {
            CanonicalOptionTick tick;
            tick.provenance = "UPSTOX_WS";
            tick.timestamp_ms = now_ms;
            tick.received_timestamp_ms = now_ms;
            tick.is_real_data = true;
            tick.ltp = ltp;
            tick.bid_price = ltp;
            tick.ask_price = ltp;
            tick.instrument_key = instrument_key;
            tick.symbol = instrument_key;
            out_ticks.push_back(tick);
            return true;
        }
        return false;
    }

    // --- Protobuf wire-format primitive helpers ---
    static bool read_varint(const uint8_t*& ptr, const uint8_t* end, uint64_t& val) {
        val = 0;
        int shift = 0;
        while (ptr < end && shift <= 63) {
            uint8_t b = *ptr++;
            val |= (static_cast<uint64_t>(b & 0x7F) << shift);
            if ((b & 0x80) == 0) return true;
            shift += 7;
        }
        return false;
    }

    static bool skip_field(const uint8_t*& ptr, const uint8_t* end, uint32_t wire_type) {
        if (wire_type == 0) { // Varint
            uint64_t dummy = 0;
            return read_varint(ptr, end, dummy);
        } else if (wire_type == 1) { // 64-bit
            if (ptr + 8 > end) return false;
            ptr += 8;
            return true;
        } else if (wire_type == 2) { // Length-delimited
            uint64_t len = 0;
            if (!read_varint(ptr, end, len)) return false;
            if (ptr + len > end) return false;
            ptr += len;
            return true;
        } else if (wire_type == 5) { // 32-bit
            if (ptr + 4 > end) return false;
            ptr += 4;
            return true;
        }
        return false;
    }

    // message LTPC { double ltp = 1; int64 ltt = 2; int64 ltq = 3; double cp = 4; }
    static void parse_ltpc(const uint8_t* ptr, const uint8_t* end, double& ltp, int64_t& ltt, double& cp) {
        while (ptr < end) {
            uint64_t tag = 0;
            if (!read_varint(ptr, end, tag)) break;
            uint32_t fn = tag >> 3;
            uint32_t wt = tag & 0x07;
            if (fn == 1 && wt == 1) { // ltp
                if (ptr + 8 > end) break;
                std::memcpy(&ltp, ptr, 8);
                ptr += 8;
            } else if (fn == 2 && wt == 0) { // ltt
                uint64_t v = 0; if (!read_varint(ptr, end, v)) break;
                ltt = static_cast<int64_t>(v);
            } else if (fn == 4 && wt == 1) { // cp
                if (ptr + 8 > end) break;
                std::memcpy(&cp, ptr, 8);
                ptr += 8;
            } else {
                if (!skip_field(ptr, end, wt)) break;
            }
        }
    }

    // message Quote { int32 bq = 1; double bp = 2; int32 bno = 3; int32 aq = 4; double ap = 5; int32 ano = 6; }
    static void parse_quote(const uint8_t* ptr, const uint8_t* end, double& bp, double& ap, int32_t& bq, int32_t& aq) {
        while (ptr < end) {
            uint64_t tag = 0;
            if (!read_varint(ptr, end, tag)) break;
            uint32_t fn = tag >> 3;
            uint32_t wt = tag & 0x07;
            if (fn == 1 && wt == 0) {
                uint64_t v = 0; if (!read_varint(ptr, end, v)) break;
                bq = static_cast<int32_t>(v);
            } else if (fn == 2 && wt == 1) {
                if (ptr + 8 > end) break;
                std::memcpy(&bp, ptr, 8);
                ptr += 8;
            } else if (fn == 4 && wt == 0) {
                uint64_t v = 0; if (!read_varint(ptr, end, v)) break;
                aq = static_cast<int32_t>(v);
            } else if (fn == 5 && wt == 1) {
                if (ptr + 8 > end) break;
                std::memcpy(&ap, ptr, 8);
                ptr += 8;
            } else {
                if (!skip_field(ptr, end, wt)) break;
            }
        }
    }

    // message MarketLevel { repeated Quote bidAskQuote = 1; }
    static void parse_market_level(const uint8_t* ptr, const uint8_t* end, double& bp, double& ap, int32_t& bq, int32_t& aq) {
        while (ptr < end) {
            uint64_t tag = 0;
            if (!read_varint(ptr, end, tag)) break;
            uint32_t fn = tag >> 3;
            uint32_t wt = tag & 0x07;
            if (fn == 1 && wt == 2) {
                uint64_t sub_len = 0;
                if (!read_varint(ptr, end, sub_len) || ptr + sub_len > end) break;
                if (bp == 0.0 && ap == 0.0) {
                    parse_quote(ptr, ptr + sub_len, bp, ap, bq, aq);
                }
                ptr += sub_len;
            } else {
                if (!skip_field(ptr, end, wt)) break;
            }
        }
    }

    // message ExtendedFeedDetails { double atp = 1; double cp = 2; int64 vtt = 3; double oi = 4; ... }
    static void parse_extended_feed_details(const uint8_t* ptr, const uint8_t* end, int64_t& vtt, double& oi) {
        while (ptr < end) {
            uint64_t tag = 0;
            if (!read_varint(ptr, end, tag)) break;
            uint32_t fn = tag >> 3;
            uint32_t wt = tag & 0x07;
            if (fn == 3 && wt == 0) { // vtt (volume traded today)
                uint64_t v = 0; if (!read_varint(ptr, end, v)) break;
                vtt = static_cast<int64_t>(v);
            } else if (fn == 4 && wt == 1) { // oi
                if (ptr + 8 > end) break;
                std::memcpy(&oi, ptr, 8);
                ptr += 8;
            } else {
                if (!skip_field(ptr, end, wt)) break;
            }
        }
    }

    // message MarketFullFeed { LTPC ltpc = 1; MarketLevel marketLevel = 2; OptionGreeks optionGreeks = 3; MarketOHLC marketOHLC = 4; ExtendedFeedDetails eFeedDetails = 5; }
    static void parse_market_full_feed(const uint8_t* ptr, const uint8_t* end, double& ltp, int64_t& ltt, double& cp, double& bp, double& ap, int32_t& bq, int32_t& aq, int64_t& vtt, double& oi) {
        while (ptr < end) {
            uint64_t tag = 0;
            if (!read_varint(ptr, end, tag)) break;
            uint32_t fn = tag >> 3;
            uint32_t wt = tag & 0x07;
            if (fn == 1 && wt == 2) {
                uint64_t sub_len = 0;
                if (!read_varint(ptr, end, sub_len) || ptr + sub_len > end) break;
                parse_ltpc(ptr, ptr + sub_len, ltp, ltt, cp);
                ptr += sub_len;
            } else if (fn == 2 && wt == 2) {
                uint64_t sub_len = 0;
                if (!read_varint(ptr, end, sub_len) || ptr + sub_len > end) break;
                parse_market_level(ptr, ptr + sub_len, bp, ap, bq, aq);
                ptr += sub_len;
            } else if (fn == 5 && wt == 2) {
                uint64_t sub_len = 0;
                if (!read_varint(ptr, end, sub_len) || ptr + sub_len > end) break;
                parse_extended_feed_details(ptr, ptr + sub_len, vtt, oi);
                ptr += sub_len;
            } else {
                if (!skip_field(ptr, end, wt)) break;
            }
        }
    }

    // message IndexFullFeed { LTPC ltpc = 1; MarketOHLC marketOHLC = 2; double lastClose = 3; ... }
    static void parse_index_full_feed(const uint8_t* ptr, const uint8_t* end, double& ltp, int64_t& ltt, double& cp, double& last_close) {
        while (ptr < end) {
            uint64_t tag = 0;
            if (!read_varint(ptr, end, tag)) break;
            uint32_t fn = tag >> 3;
            uint32_t wt = tag & 0x07;
            if (fn == 1 && wt == 2) {
                uint64_t sub_len = 0;
                if (!read_varint(ptr, end, sub_len) || ptr + sub_len > end) break;
                parse_ltpc(ptr, ptr + sub_len, ltp, ltt, cp);
                ptr += sub_len;
            } else if (fn == 3 && wt == 1) {
                if (ptr + 8 > end) break;
                std::memcpy(&last_close, ptr, 8);
                ptr += 8;
            } else {
                if (!skip_field(ptr, end, wt)) break;
            }
        }
    }

    // message FullFeed { oneof FullFeedUnion { MarketFullFeed marketFF = 1; IndexFullFeed indexFF = 2; } }
    static void parse_full_feed(const uint8_t* ptr, const uint8_t* end, double& ltp, int64_t& ltt, double& cp, double& bp, double& ap, int32_t& bq, int32_t& aq, int64_t& vtt, double& oi) {
        while (ptr < end) {
            uint64_t tag = 0;
            if (!read_varint(ptr, end, tag)) break;
            uint32_t fn = tag >> 3;
            uint32_t wt = tag & 0x07;
            if (fn == 1 && wt == 2) {
                uint64_t sub_len = 0;
                if (!read_varint(ptr, end, sub_len) || ptr + sub_len > end) break;
                parse_market_full_feed(ptr, ptr + sub_len, ltp, ltt, cp, bp, ap, bq, aq, vtt, oi);
                ptr += sub_len;
            } else if (fn == 2 && wt == 2) {
                uint64_t sub_len = 0;
                if (!read_varint(ptr, end, sub_len) || ptr + sub_len > end) break;
                double last_close = 0.0;
                parse_index_full_feed(ptr, ptr + sub_len, ltp, ltt, cp, last_close);
                if (cp == 0.0 && last_close != 0.0) cp = last_close;
                ptr += sub_len;
            } else {
                if (!skip_field(ptr, end, wt)) break;
            }
        }
    }

    // message OptionChain { LTPC ltpc = 1; Quote bidAskQuote = 2; OptionGreeks optionGreeks = 3; ExtendedFeedDetails eFeedDetails = 4; }
    static void parse_option_chain(const uint8_t* ptr, const uint8_t* end, double& ltp, int64_t& ltt, double& cp, double& bp, double& ap, int32_t& bq, int32_t& aq, int64_t& vtt, double& oi) {
        while (ptr < end) {
            uint64_t tag = 0;
            if (!read_varint(ptr, end, tag)) break;
            uint32_t fn = tag >> 3;
            uint32_t wt = tag & 0x07;
            if (fn == 1 && wt == 2) {
                uint64_t sub_len = 0;
                if (!read_varint(ptr, end, sub_len) || ptr + sub_len > end) break;
                parse_ltpc(ptr, ptr + sub_len, ltp, ltt, cp);
                ptr += sub_len;
            } else if (fn == 2 && wt == 2) {
                uint64_t sub_len = 0;
                if (!read_varint(ptr, end, sub_len) || ptr + sub_len > end) break;
                parse_quote(ptr, ptr + sub_len, bp, ap, bq, aq);
                ptr += sub_len;
            } else if (fn == 4 && wt == 2) {
                uint64_t sub_len = 0;
                if (!read_varint(ptr, end, sub_len) || ptr + sub_len > end) break;
                parse_extended_feed_details(ptr, ptr + sub_len, vtt, oi);
                ptr += sub_len;
            } else {
                if (!skip_field(ptr, end, wt)) break;
            }
        }
    }

    // message Feed { oneof FeedUnion { LTPC ltpc = 1; FullFeed ff = 2; OptionChain oc = 3; } }
    static void parse_feed(const uint8_t* ptr, const uint8_t* end, double& ltp, int64_t& ltt, double& cp, double& bp, double& ap, int32_t& bq, int32_t& aq, int64_t& vtt, double& oi) {
        while (ptr < end) {
            uint64_t tag = 0;
            if (!read_varint(ptr, end, tag)) break;
            uint32_t fn = tag >> 3;
            uint32_t wt = tag & 0x07;
            if (fn == 1 && wt == 2) { // LTPC
                uint64_t sub_len = 0;
                if (!read_varint(ptr, end, sub_len) || ptr + sub_len > end) break;
                parse_ltpc(ptr, ptr + sub_len, ltp, ltt, cp);
                ptr += sub_len;
            } else if (fn == 2 && wt == 2) { // FullFeed
                uint64_t sub_len = 0;
                if (!read_varint(ptr, end, sub_len) || ptr + sub_len > end) break;
                parse_full_feed(ptr, ptr + sub_len, ltp, ltt, cp, bp, ap, bq, aq, vtt, oi);
                ptr += sub_len;
            } else if (fn == 3 && wt == 2) { // OptionChain
                uint64_t sub_len = 0;
                if (!read_varint(ptr, end, sub_len) || ptr + sub_len > end) break;
                parse_option_chain(ptr, ptr + sub_len, ltp, ltt, cp, bp, ap, bq, aq, vtt, oi);
                ptr += sub_len;
            } else {
                if (!skip_field(ptr, end, wt)) break;
            }
        }
    }

    // message FeedResponse { Type type = 1; map<string, Feed> feeds = 2; }
    static bool decode_binary_stream(const uint8_t* data, size_t len, uint64_t now_ms, std::vector<CanonicalOptionTick>& out_ticks) {
        if (!data || len < 4) return false;

        const uint8_t* ptr = data;
        const uint8_t* end = data + len;

        bool found_any = false;

        while (ptr < end) {
            uint64_t tag = 0;
            if (!read_varint(ptr, end, tag)) break;
            uint32_t fn = tag >> 3;
            uint32_t wt = tag & 0x07;

            if (fn == 2 && wt == 2) { // map<string, Feed> feeds = 2;
                uint64_t map_entry_len = 0;
                if (!read_varint(ptr, end, map_entry_len) || ptr + map_entry_len > end) break;

                const uint8_t* mptr = ptr;
                const uint8_t* mend = ptr + map_entry_len;
                ptr += map_entry_len;

                std::string inst_key;
                double ltp = 0.0;
                int64_t ltt = 0;
                double cp = 0.0;
                double bp = 0.0;
                double ap = 0.0;
                int32_t bq = 0;
                int32_t aq = 0;
                int64_t vtt = 0;
                double oi = 0.0;

                while (mptr < mend) {
                    uint64_t mtag = 0;
                    if (!read_varint(mptr, mend, mtag)) break;
                    uint32_t mfn = mtag >> 3;
                    uint32_t mwt = mtag & 0x07;

                    if (mfn == 1 && mwt == 2) { // string key = 1;
                        uint64_t key_len = 0;
                        if (!read_varint(mptr, mend, key_len) || mptr + key_len > mend) break;
                        inst_key = std::string(reinterpret_cast<const char*>(mptr), key_len);
                        mptr += key_len;
                    } else if (mfn == 2 && mwt == 2) { // Feed value = 2;
                        uint64_t feed_len = 0;
                        if (!read_varint(mptr, mend, feed_len) || mptr + feed_len > mend) break;
                        parse_feed(mptr, mptr + feed_len, ltp, ltt, cp, bp, ap, bq, aq, vtt, oi);
                        mptr += feed_len;
                    } else {
                        if (!skip_field(mptr, mend, mwt)) break;
                    }
                }

                // Strict sanity checks: valid instrument key format, positive non-zero LTP, sensible range
                if (!inst_key.empty() && 
                    inst_key.find("NSE_COM") == std::string::npos && 
                    inst_key.find("NCD_FO") == std::string::npos &&
                    ltp > 0.0 && ltp < 1000000.0) {
                    
                    CanonicalOptionTick tick;
                    tick.provenance = "UPSTOX_WS";
                    tick.instrument_key = inst_key;
                    tick.symbol = inst_key;
                    tick.ltp = ltp;
                    tick.volume = static_cast<int>(vtt);
                    tick.open_interest = static_cast<int>(oi);
                    tick.bid_qty = bq;
                    tick.ask_qty = aq;
                    tick.bid_price = (bp > 0.0) ? bp : ltp;
                    tick.ask_price = (ap > 0.0) ? ap : ltp;
                    tick.timestamp_ms = (ltt > 0) ? static_cast<uint64_t>(ltt) : now_ms;
                    tick.received_timestamp_ms = now_ms;
                    tick.is_real_data = true;

                    out_ticks.push_back(tick);
                    found_any = true;
                }
            } else {
                if (!skip_field(ptr, end, wt)) break;
            }
        }

        return found_any;
    }
};

#endif // MARKET_DATA_UPSTOX_DECODER_HPP
