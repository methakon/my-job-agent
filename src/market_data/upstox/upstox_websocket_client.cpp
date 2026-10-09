#include "market_data/upstox/upstox_websocket_client.hpp"
#include <iostream>
#include <sstream>
#include <curl/curl.h>
#include <thread>
#include <chrono>

namespace {
size_t write_string_callback(char* ptr, size_t size, size_t nmemb, void* userdata) {
    size_t total = size * nmemb;
    std::string* str = static_cast<std::string*>(userdata);
    str->append(ptr, total);
    return total;
}
} // namespace

UpstoxWebSocketClient::UpstoxWebSocketClient()
    : transport_(std::make_unique<NativeWsTransport>()) {}

UpstoxWebSocketClient::~UpstoxWebSocketClient() {
    disconnect();
}

std::string UpstoxWebSocketClient::fetch_authorized_feed_url(const std::string& access_token) {
    if (access_token.empty()) return "";

    CURL* curl = curl_easy_init();
    if (!curl) return "";

    std::string response_body;
    struct curl_slist* headers = nullptr;
    headers = curl_slist_append(headers, ("Authorization: Bearer " + access_token).c_str());
    headers = curl_slist_append(headers, "Accept: application/json");

    curl_easy_setopt(curl, CURLOPT_URL, "https://api.upstox.com/v3/feed/market-data-feed/authorize");
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, write_string_callback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response_body);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 10L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 1L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 2L);

    CURLcode res = curl_easy_perform(curl);
    long http_code = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &http_code);

    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);

    if (res != CURLE_OK || http_code != 200) {
        std::cerr << "⚠️ [UpstoxWS] Feed authorization failed (HTTP " << http_code << "): " << response_body << "\n";
        return "";
    }

    // Extract "authorizedRedirectUri": "..."
    auto pos = response_body.find("\"authorizedRedirectUri\":");
    if (pos == std::string::npos) {
        std::cerr << "⚠️ [UpstoxWS] authorizedRedirectUri not found in response: " << response_body << "\n";
        return "";
    }

    auto start_q = response_body.find("\"", pos + 24);
    if (start_q == std::string::npos) return "";
    auto end_q = response_body.find("\"", start_q + 1);
    if (end_q == std::string::npos) return "";

    std::string feed_url = response_body.substr(start_q + 1, end_q - start_q - 1);
    return feed_url;
}

bool UpstoxWebSocketClient::connect(const BrokerCredentials& creds) {
    disconnect();
    credentials_ = creds;

    std::string feed_url = creds.feed_url;
    if (feed_url.empty()) {
        std::cout << "🔑 [UpstoxWS] Authorizing feed with Upstox v3 API...\n";
        feed_url = fetch_authorized_feed_url(creds.access_token);
        if (feed_url.empty()) {
            std::cerr << "❌ [UpstoxWS] Failed to obtain authorized WebSocket feed URL.\n";
            return false;
        }
    }

    std::cout << "🌐 [UpstoxWS] Connecting to feed URL: " << feed_url.substr(0, 45) << "...\n";

    bool started = transport_->start(
        feed_url,
        [this](const uint8_t* data, size_t len, bool is_binary) {
            handle_message(data, len, is_binary);
        },
        [this](const std::string& reason) {
            handle_disconnect(reason);
        }
    );

    if (!started) {
        std::cerr << "❌ [UpstoxWS] Transport start failed.\n";
        return false;
    }

    // Wait up to 5 seconds for connection handshake
    for (int i = 0; i < 50; ++i) {
        if (transport_->is_connected()) {
            connected_ = true;
            break;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }

    if (!connected_) {
        std::cerr << "❌ [UpstoxWS] Connection handshake timed out.\n";
        disconnect();
        return false;
    }

    std::cout << "✅ [UpstoxWS] Connected successfully to Upstox Market Data Feed.\n";

    // Auto-resubscribe if symbols were previously registered
    std::lock_guard<std::mutex> lock(sub_mutex_);
    if (!subscribed_symbols_.empty()) {
        subscribe(subscribed_symbols_);
    }

    return true;
}

bool UpstoxWebSocketClient::subscribe(const std::vector<std::string>& symbols) {
    if (symbols.empty()) return true;

    {
        std::lock_guard<std::mutex> lock(sub_mutex_);
        subscribed_symbols_ = symbols;
    }

    if (!connected_ || !transport_->is_connected()) {
        std::cout << "ℹ️ [UpstoxWS] Queued " << symbols.size() << " symbols for subscription upon connect.\n";
        return true;
    }

    std::ostringstream ss;
    ss << "{\"guid\":\"cpp-upstox-feed\",\"method\":\"sub\",\"data\":{\"mode\":\"full\",\"instrumentKeys\":[";
    for (size_t i = 0; i < symbols.size(); ++i) {
        ss << "\"" << symbols[i] << "\"";
        if (i + 1 < symbols.size()) ss << ",";
    }
    ss << "]}}";

    std::string payload = ss.str();
    bool ok = transport_->send_binary(reinterpret_cast<const uint8_t*>(payload.data()), payload.size());
    if (ok) {
        std::cout << "📡 [UpstoxWS] Subscribed to " << symbols.size() << " instruments: " << payload << "\n";
    } else {
        std::cerr << "⚠️ [UpstoxWS] Failed to send subscription frame.\n";
    }
    return ok;
}

void UpstoxWebSocketClient::disconnect() {
    connected_ = false;
    if (transport_) {
        transport_->stop();
    }
}

bool UpstoxWebSocketClient::is_connected() const {
    return connected_.load() && transport_ && transport_->is_connected();
}

void UpstoxWebSocketClient::handle_message(const uint8_t* data, size_t len, bool is_binary) {
    std::cout << "📥 [UpstoxWS] Received frame len=" << len << " binary=" << is_binary << " hex: ";
    for (size_t i = 0; i < std::min<size_t>(len, 48); ++i) {
        std::cout << std::hex << (int)data[i] << " " << std::dec;
    }
    std::cout << "\n";
    std::vector<CanonicalOptionTick> ticks;
    bool decoded = UpstoxDecoder::decode_frame(data, len, is_binary, ticks);
    std::cout << "📥 [UpstoxWS] Decoded result=" << decoded << " ticks_count=" << ticks.size() << "\n";
    if (decoded && !ticks.empty() && on_tick_) {
        for (const auto& tick : ticks) {
            std::cout << "✅ [UpstoxWS] Ingested tick: " << tick.instrument_key << " ltp=" << tick.ltp << " vol=" << tick.volume << "\n";
            on_tick_(tick);
        }
    }
}

void UpstoxWebSocketClient::handle_disconnect(const std::string& reason) {
    connected_ = false;
    std::cout << "⚠️ [UpstoxWS] Disconnected: " << reason << "\n";
    if (on_disconnect_) {
        on_disconnect_(reason);
    }
}
