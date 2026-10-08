#ifndef MARKET_DATA_UPSTOX_WEBSOCKET_CLIENT_HPP
#define MARKET_DATA_UPSTOX_WEBSOCKET_CLIENT_HPP

#include "market_data/broker_websocket_client.hpp"
#include "market_data/native_ws_transport.hpp"
#include "market_data/upstox/upstox_decoder.hpp"
#include <string>
#include <vector>
#include <memory>
#include <atomic>
#include <mutex>

class UpstoxWebSocketClient : public IBrokerWebSocketClient {
public:
    UpstoxWebSocketClient();
    ~UpstoxWebSocketClient() override;

    std::string provider_name() const override { return "upstox"; }
    bool connect(const BrokerCredentials& creds) override;
    bool subscribe(const std::vector<std::string>& symbols) override;
    void disconnect() override;
    bool is_connected() const override;
    void set_on_tick(TickCallback cb) override { on_tick_ = cb; }
    void set_on_disconnect(DisconnectCallback cb) override { on_disconnect_ = cb; }

    // Helper to fetch the authorized WebSocket redirect URI from Upstox v3 feed API
    static std::string fetch_authorized_feed_url(const std::string& access_token);

private:
    void handle_message(const uint8_t* data, size_t len, bool is_binary);
    void handle_disconnect(const std::string& reason);

    std::unique_ptr<NativeWsTransport> transport_;
    BrokerCredentials credentials_;
    std::vector<std::string> subscribed_symbols_;
    TickCallback on_tick_;
    DisconnectCallback on_disconnect_;
    std::atomic<bool> connected_{false};
    std::mutex sub_mutex_;
};

#endif // MARKET_DATA_UPSTOX_WEBSOCKET_CLIENT_HPP
