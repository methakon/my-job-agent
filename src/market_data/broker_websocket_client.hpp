#ifndef MARKET_DATA_BROKER_WEBSOCKET_CLIENT_HPP
#define MARKET_DATA_BROKER_WEBSOCKET_CLIENT_HPP

#include <string>
#include <vector>
#include <functional>
#include <memory>
#include "engine/tick_receiver.hpp"

struct BrokerCredentials {
    std::string provider;    // "upstox" or "fyers"
    std::string app_id;
    std::string access_token;
    std::string feed_url;
};

class IBrokerWebSocketClient {
public:
    using TickCallback = std::function<void(const CanonicalOptionTick&)>;
    using DisconnectCallback = std::function<void(const std::string& reason)>;

    virtual ~IBrokerWebSocketClient() = default;

    virtual std::string provider_name() const = 0;
    virtual bool connect(const BrokerCredentials& creds) = 0;
    virtual bool subscribe(const std::vector<std::string>& symbols) = 0;
    virtual void disconnect() = 0;
    virtual bool is_connected() const = 0;
    virtual void set_on_tick(TickCallback cb) = 0;
    virtual void set_on_disconnect(DisconnectCallback cb) = 0;
};

#endif // MARKET_DATA_BROKER_WEBSOCKET_CLIENT_HPP
