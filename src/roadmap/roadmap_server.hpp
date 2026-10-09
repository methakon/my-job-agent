#ifndef ROADMAP_SERVER_HPP
#define ROADMAP_SERVER_HPP

#include "db_client.hpp"
#include <string>
#include <memory>

class RoadmapServer {
public:
    RoadmapServer(int port, std::shared_ptr<RoadmapDbClient> db_client = nullptr);
    ~RoadmapServer();

    void set_db_client(std::shared_ptr<RoadmapDbClient> db_client) { db_client_ = db_client; }
    void start();
    void stop();

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
    bool running_;
};

#endif // ROADMAP_SERVER_HPP
