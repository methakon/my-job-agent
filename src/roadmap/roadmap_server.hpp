#ifndef ROADMAP_SERVER_HPP
#define ROADMAP_SERVER_HPP

#include "db_client.hpp"
#include <string>
#include <memory>
#include <atomic>

class RoadmapServer {
public:
    RoadmapServer(int port, std::shared_ptr<RoadmapDbClient> db_client = nullptr);
    ~RoadmapServer();

    void set_db_client(std::shared_ptr<RoadmapDbClient> db_client) { db_client_ = db_client; }
    void start();
    // Safe to call from another thread or a shutdown path: wakes the blocked accept() so start()
    // returns.
    void stop();

    // Address the listener binds, from ROADMAP_BIND_ADDR. Defaults to loopback: the portal sits
    // behind a local reverse proxy / tunnel, and binding every interface exposed the operator
    // surface to anything that could route to the host. An unparseable value yields "" and the
    // server refuses to start rather than guessing.
    static std::string resolve_bind_address(const std::string& configured);

    std::string render_home_page(bool is_authenticated = false);
    std::string render_html_page(bool is_authenticated);
    std::string render_login_page(const std::string& error_msg = "");
    std::string render_dashboard_page(bool is_authenticated, const std::string& user_id = "");
    std::string render_portfolio_page(bool is_authenticated, const std::string& user_id = "");
    std::string render_paper_trading_page(bool is_authenticated = true, const std::string& user_id = "", int page = 1, int limit = 20);
    std::string render_tokens_page(bool is_authenticated);
    std::string render_health_page(bool is_authenticated = false);
    std::string render_json_summary();
    std::string render_swagger_ui_page(bool is_authenticated = false);
    std::string render_openapi_json();

    // Visitor Tracking & Analytics System (Cookie-less, Privacy-Conscious)
    std::string render_visitor_info_page(bool is_authenticated = false);
    std::string render_admin_visitors_page(bool is_authenticated, int page = 1, int limit = 20, const std::string& search = "", const std::string& country = "", int bot_filter = -1);
    std::string render_admin_visitor_detail_page(bool is_authenticated, const std::string& visitor_id);

private:
    int port_;
    std::shared_ptr<RoadmapDbClient> db_client_;
    // Written by stop() on one thread and read by the accept loop on another, so it is atomic. As
    // a plain bool the loop was free to cache it and never see the write.
    std::atomic<bool> running_;
    std::atomic<int> listen_fd_{-1};
};

#endif // ROADMAP_SERVER_HPP
