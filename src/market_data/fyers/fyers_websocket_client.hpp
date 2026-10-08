#ifndef MARKET_DATA_FYERS_WEBSOCKET_CLIENT_HPP
#define MARKET_DATA_FYERS_WEBSOCKET_CLIENT_HPP

#include "market_data/broker_websocket_client.hpp"
#include "market_data/native_ws_transport.hpp"
#include "market_data/fyers/fyers_decoder.hpp"
#include <string>
#include <vector>
#include <memory>
#include <atomic>
#include <mutex>

class FyersWebSocketClient : public IBrokerWebSocketClient {
public:
    FyersWebSocketClient();
    ~FyersWebSocketClient() override;

    std::string provider_name() const override { return "fyers"; }
    bool connect(const BrokerCredentials& creds) override;
    bool subscribe(const std::vector<std::string>& symbols) override;
    void disconnect() override;
    bool is_connected() const override;
    void set_on_tick(TickCallback cb) override { on_tick_ = cb; }
    void set_on_disconnect(DisconnectCallback cb) override { on_disconnect_ = cb; }

private:
    void handle_message(const uint8_t* data, size_t len, bool is_binary);
    void handle_disconnect(const std::string& reason);
    void send_auth_handshake();

    std::unique_ptr<NativeWsTransport> transport_;
    BrokerCredentials credentials_;
    std::vector<std::string> subscribed_symbols_;
    TickCallback on_tick_;
    DisconnectCallback on_disconnect_;
    std::atomic<bool> connected_{false};
    std::mutex sub_mutex_;
};

#endif // MARKET_DATA_FYERS_WEBSOCKET_CLIENT_HPP
