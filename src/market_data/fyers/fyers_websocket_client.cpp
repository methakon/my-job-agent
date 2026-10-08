#include "market_data/fyers/fyers_websocket_client.hpp"
#include <iostream>
#include <sstream>
#include <thread>
#include <chrono>

FyersWebSocketClient::FyersWebSocketClient()
    : transport_(std::make_unique<NativeWsTransport>()) {}

FyersWebSocketClient::~FyersWebSocketClient() {
    disconnect();
}

void FyersWebSocketClient::send_auth_handshake() {
    if (!transport_ || !transport_->is_connected()) return;

    // FYERS HSM Handshake packet or auth JSON
    // Format: {"type":"cn","user":"<app_id>","x-access-token":"<access_token>"}
    std::string auth_token = credentials_.app_id.empty()
        ? credentials_.access_token
        : (credentials_.app_id + ":" + credentials_.access_token);

    std::ostringstream ss;
    ss << "{\"type\":\"cn\",\"user\":\"" << credentials_.app_id
       << "\",\"x-access-token\":\"" << credentials_.access_token << "\"}";

    transport_->send_text(ss.str());
    std::cout << "🔑 [FyersWS] Sent authentication handshake frame for app: " << credentials_.app_id << "\n";
}

bool FyersWebSocketClient::connect(const BrokerCredentials& creds) {
    disconnect();
    credentials_ = creds;

    std::string feed_url = creds.feed_url.empty()
        ? "wss://socket.fyers.in/hsm/v1-5/prod"
        : creds.feed_url;

    std::cout << "🌐 [FyersWS] Connecting to FYERS feed URL: " << feed_url << "...\n";

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
        std::cerr << "❌ [FyersWS] Transport start failed.\n";
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
        std::cerr << "❌ [FyersWS] Connection handshake timed out.\n";
        disconnect();
        return false;
    }

    std::cout << "✅ [FyersWS] Connected successfully to FYERS Market Data Feed.\n";
    send_auth_handshake();

    std::lock_guard<std::mutex> lock(sub_mutex_);
    if (!subscribed_symbols_.empty()) {
        subscribe(subscribed_symbols_);
    }

    return true;
}

bool FyersWebSocketClient::subscribe(const std::vector<std::string>& symbols) {
    if (symbols.empty()) return true;

    {
        std::lock_guard<std::mutex> lock(sub_mutex_);
        subscribed_symbols_ = symbols;
    }

    if (!connected_ || !transport_->is_connected()) {
        std::cout << "ℹ️ [FyersWS] Queued " << symbols.size() << " symbols for subscription upon connect.\n";
        return true;
    }

    // Subscription frame format: {"type":"sub","scrips":["NSE:NIFTY50-INDEX", ...],"channel":1}
    std::ostringstream ss;
    ss << "{\"type\":\"sub\",\"scrips\":[";
    for (size_t i = 0; i < symbols.size(); ++i) {
        ss << "\"" << symbols[i] << "\"";
        if (i + 1 < symbols.size()) ss << ",";
    }
    ss << "],\"channel\":1}";

    std::string payload = ss.str();
    bool ok = transport_->send_text(payload);
    if (ok) {
        std::cout << "📡 [FyersWS] Subscribed to " << symbols.size() << " instruments: " << payload << "\n";
    } else {
        std::cerr << "⚠️ [FyersWS] Failed to send subscription frame.\n";
    }
    return ok;
}

void FyersWebSocketClient::disconnect() {
    connected_ = false;
    if (transport_) {
        transport_->stop();
    }
}

bool FyersWebSocketClient::is_connected() const {
    return connected_.load() && transport_ && transport_->is_connected();
}

void FyersWebSocketClient::handle_message(const uint8_t* data, size_t len, bool is_binary) {
    std::vector<CanonicalOptionTick> ticks;
    bool decoded = FyersDecoder::decode_frame(data, len, is_binary, ticks);
    if (decoded && !ticks.empty() && on_tick_) {
        for (const auto& tick : ticks) {
            on_tick_(tick);
        }
    }
}

void FyersWebSocketClient::handle_disconnect(const std::string& reason) {
    connected_ = false;
    std::cout << "⚠️ [FyersWS] Disconnected: " << reason << "\n";
    if (on_disconnect_) {
        on_disconnect_(reason);
    }
}
