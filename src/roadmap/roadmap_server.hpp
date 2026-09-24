#ifndef ROADMAP_SERVER_HPP
#define ROADMAP_SERVER_HPP

#include "db_client.hpp"
#include <string>
#include <memory>

class RoadmapServer {
public:
    RoadmapServer(int port, std::shared_ptr<RoadmapDbClient> db_client);
    ~RoadmapServer();

    void start();
    void stop();

    std::string render_home_page();
    std::string render_html_page(bool is_authenticated);
    std::string render_login_page(const std::string& error_msg = "");
    std::string render_json_summary();

private:
    int port_;
    std::shared_ptr<RoadmapDbClient> db_client_;
    bool running_;
};

#endif // ROADMAP_SERVER_HPP
