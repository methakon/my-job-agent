#ifndef MARKET_DATA_NATIVE_WS_TRANSPORT_HPP
#define MARKET_DATA_NATIVE_WS_TRANSPORT_HPP

#include <string>
#include <vector>
#include <functional>
#include <atomic>
#include <thread>
#include <mutex>
#include <iostream>
#include <cstring>
#include <cstdlib>
#include <cstdint>
#include <unistd.h>
#include <sys/types.h>
#include <sys/socket.h>
#include <netdb.h>
#include <fcntl.h>
#include <poll.h>

#include <openssl/ssl.h>
#include <openssl/err.h>

class NativeWsTransport {
public:
    using MessageHandler = std::function<void(const uint8_t* data, size_t len, bool is_binary)>;
    using DisconnectHandler = std::function<void(const std::string& reason)>;

    NativeWsTransport() : sock_(-1), ssl_ctx_(nullptr), ssl_(nullptr), running_(false), connected_(false) {}
    ~NativeWsTransport() {
        stop();
    }

    bool start(const std::string& url, MessageHandler on_msg, DisconnectHandler on_disc, const std::vector<std::string>& headers = {}) {
        stop();
        url_ = url;
        on_message_ = on_msg;
        on_disconnect_ = on_disc;
        headers_ = headers;
        running_ = true;
        connected_ = false;

        worker_ = std::thread([this]() {
            run_loop();
        });
        return true;
    }

    bool send_text(const std::string& text) {
        return send_frame(reinterpret_cast<const uint8_t*>(text.data()), text.size(), 0x01);
    }

    bool send_binary(const uint8_t* data, size_t len) {
        return send_frame(data, len, 0x02);
    }

    void stop() {
        bool was_running = running_.exchange(false);
        if (!was_running) return;

        if (sock_ >= 0) {
            ::shutdown(sock_, SHUT_RDWR);
        }

        if (worker_.joinable()) {
            if (std::this_thread::get_id() != worker_.get_id()) {
                worker_.join();
            }
        }

        close_socket();
        connected_ = false;
    }

    bool is_connected() const { return connected_.load(); }

private:
    struct UrlParts {
        std::string host;
        std::string port;
        std::string path;
    };

    static UrlParts parse_ws_url(const std::string& url) {
        UrlParts parts;
        parts.port = "443";
        parts.path = "/";

        std::string s = url;
        if (s.rfind("wss://", 0) == 0) {
            s = s.substr(6);
        } else if (s.rfind("ws://", 0) == 0) {
            s = s.substr(5);
            parts.port = "80";
        }

        auto slash_pos = s.find('/');
        std::string host_port;
        if (slash_pos != std::string::npos) {
            host_port = s.substr(0, slash_pos);
            parts.path = s.substr(slash_pos);
        } else {
            host_port = s;
        }

        auto colon_pos = host_port.find(':');
        if (colon_pos != std::string::npos) {
            parts.host = host_port.substr(0, colon_pos);
            parts.port = host_port.substr(colon_pos + 1);
        } else {
            parts.host = host_port;
        }

        return parts;
    }

    bool send_frame(const uint8_t* payload, size_t len, uint8_t opcode) {
        if (!connected_ || !ssl_) return false;
        std::lock_guard<std::mutex> lock(send_mutex_);

        std::vector<uint8_t> frame;
        frame.push_back(0x80 | (opcode & 0x0F)); // FIN + opcode

        // Client to server frames must be masked (bit 7 set)
        if (len < 126) {
            frame.push_back(0x80 | static_cast<uint8_t>(len));
        } else if (len <= 0xFFFF) {
            frame.push_back(0x80 | 126);
            frame.push_back((len >> 8) & 0xFF);
            frame.push_back(len & 0xFF);
        } else {
            frame.push_back(0x80 | 127);
            for (int i = 7; i >= 0; --i) {
                frame.push_back((len >> (i * 8)) & 0xFF);
            }
        }

        // Generate 4-byte mask key
        uint8_t mask[4] = {
            static_cast<uint8_t>(rand() & 0xFF),
            static_cast<uint8_t>(rand() & 0xFF),
            static_cast<uint8_t>(rand() & 0xFF),
            static_cast<uint8_t>(rand() & 0xFF)
        };
        for (int i = 0; i < 4; ++i) frame.push_back(mask[i]);

        // Mask payload
        for (size_t i = 0; i < len; ++i) {
            frame.push_back(payload[i] ^ mask[i % 4]);
        }

        int written = SSL_write(ssl_, frame.data(), static_cast<int>(frame.size()));
        return (written == static_cast<int>(frame.size()));
    }

    void close_socket() {
        std::lock_guard<std::mutex> lock(send_mutex_);
        if (ssl_) {
            SSL_shutdown(ssl_);
            SSL_free(ssl_);
            ssl_ = nullptr;
        }
        if (ssl_ctx_) {
            SSL_CTX_free(ssl_ctx_);
            ssl_ctx_ = nullptr;
        }
        if (sock_ >= 0) {
            close(sock_);
            sock_ = -1;
        }
    }

    int ssl_read_all(uint8_t* buf, int len) {
        int total = 0;
        while (total < len && running_.load()) {
            struct pollfd pfd;
            pfd.fd = sock_;
            pfd.events = POLLIN;
            int pr = poll(&pfd, 1, 200);
            if (pr <= 0) {
                if (pr < 0) return -1;
                continue;
            }

            int n = SSL_read(ssl_, buf + total, len - total);
            if (n <= 0) {
                int err = SSL_get_error(ssl_, n);
                if (err == SSL_ERROR_WANT_READ || err == SSL_ERROR_WANT_WRITE) {
                    continue;
                }
                return -1;
            }
            total += n;
        }
        return total;
    }

    void run_loop() {
        UrlParts parts = parse_ws_url(url_);

        struct addrinfo hints, *res = nullptr;
        std::memset(&hints, 0, sizeof(hints));
        hints.ai_family = AF_UNSPEC;
        hints.ai_socktype = SOCK_STREAM;

        if (getaddrinfo(parts.host.c_str(), parts.port.c_str(), &hints, &res) != 0 || !res) {
            if (on_disconnect_) on_disconnect_("DNS resolution failed for " + parts.host);
            return;
        }

        sock_ = socket(res->ai_family, res->ai_socktype, res->ai_protocol);
        if (sock_ < 0) {
            freeaddrinfo(res);
            if (on_disconnect_) on_disconnect_("Socket creation failed");
            return;
        }

        struct timeval tv;
        tv.tv_sec = 10;
        tv.tv_usec = 0;
        setsockopt(sock_, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
        setsockopt(sock_, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));

        if (::connect(sock_, res->ai_addr, res->ai_addrlen) != 0) {
            freeaddrinfo(res);
            close(sock_);
            sock_ = -1;
            if (on_disconnect_) on_disconnect_("TCP connect failed to " + parts.host + ":" + parts.port);
            return;
        }
        freeaddrinfo(res);

        // SSL Handshake
        ssl_ctx_ = SSL_CTX_new(TLS_client_method());
        if (!ssl_ctx_) {
            close(sock_);
            sock_ = -1;
            if (on_disconnect_) on_disconnect_("SSL_CTX_new failed");
            return;
        }

        ssl_ = SSL_new(ssl_ctx_);
        SSL_set_fd(ssl_, sock_);
        SSL_set_tlsext_host_name(ssl_, parts.host.c_str());

        if (SSL_connect(ssl_) <= 0) {
            close_socket();
            if (on_disconnect_) on_disconnect_("TLS handshake failed with " + parts.host);
            return;
        }

        // Send HTTP Upgrade Request
        std::string http_req = "GET " + parts.path + " HTTP/1.1\r\n"
                             + "Host: " + parts.host + "\r\n"
                             + "Upgrade: websocket\r\n"
                             + "Connection: Upgrade\r\n"
                             + "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
                             + "Sec-WebSocket-Version: 13\r\n";
        for (const auto& h : headers_) {
            http_req += h + "\r\n";
        }
        http_req += "\r\n";

        if (SSL_write(ssl_, http_req.data(), static_cast<int>(http_req.size())) <= 0) {
            close_socket();
            if (on_disconnect_) on_disconnect_("Failed to send WebSocket Upgrade request");
            return;
        }

        // Read HTTP 101 Response
        std::string response_header;
        char ch = 0;
        while (response_header.find("\r\n\r\n") == std::string::npos && running_.load()) {
            int n = SSL_read(ssl_, &ch, 1);
            if (n <= 0) break;
            response_header.push_back(ch);
            if (response_header.size() > 8192) break;
        }

        if (response_header.find("101") == std::string::npos) {
            close_socket();
            if (on_disconnect_) on_disconnect_("Server rejected WebSocket Upgrade: " + response_header.substr(0, 40));
            return;
        }

        connected_ = true;

        // WebSocket Frame Loop
        while (running_.load()) {
            uint8_t header[2];
            int r = ssl_read_all(header, 2);
            if (r != 2) break;

            uint8_t opcode = header[0] & 0x0F;
            bool masked = (header[1] & 0x80) != 0;
            uint64_t payload_len = header[1] & 0x7F;

            if (payload_len == 126) {
                uint8_t ext[2];
                if (ssl_read_all(ext, 2) != 2) break;
                payload_len = (static_cast<uint64_t>(ext[0]) << 8) | ext[1];
            } else if (payload_len == 127) {
                uint8_t ext[8];
                if (ssl_read_all(ext, 8) != 8) break;
                payload_len = 0;
                for (int i = 0; i < 8; ++i) {
                    payload_len = (payload_len << 8) | ext[i];
                }
            }

            uint8_t mask_key[4] = {0, 0, 0, 0};
            if (masked) {
                if (ssl_read_all(mask_key, 4) != 4) break;
            }

            if (payload_len > 10 * 1024 * 1024) { // 10MB safety cap
                break;
            }

            std::vector<uint8_t> payload(payload_len);
            if (payload_len > 0) {
                if (ssl_read_all(payload.data(), static_cast<int>(payload_len)) != static_cast<int>(payload_len)) {
                    break;
                }
                if (masked) {
                    for (size_t i = 0; i < payload_len; ++i) {
                        payload[i] ^= mask_key[i % 4];
                    }
                }
            }

            if (opcode == 0x08) { // CLOSE
                break;
            } else if (opcode == 0x09) { // PING -> respond with PONG
                send_frame(payload.data(), payload.size(), 0x0A);
            } else if (opcode == 0x01 || opcode == 0x02) { // TEXT or BINARY
                if (on_message_) {
                    on_message_(payload.data(), payload.size(), (opcode == 0x02));
                }
            }
        }

        connected_ = false;
        close_socket();

        if (on_disconnect_) {
            on_disconnect_("Socket closed");
        }
    }

    std::string url_;
    std::vector<std::string> headers_;
    MessageHandler on_message_;
    DisconnectHandler on_disconnect_;
    std::atomic<bool> running_;
    std::atomic<bool> connected_;
    std::thread worker_;
    std::mutex send_mutex_;

    int sock_;
    SSL_CTX* ssl_ctx_;
    SSL* ssl_;
};

#endif // MARKET_DATA_NATIVE_WS_TRANSPORT_HPP
