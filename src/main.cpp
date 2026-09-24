#include "common/env_loader.hpp"
#include "roadmap/db_client.hpp"
#include "roadmap/roadmap_server.hpp"
#include <iostream>
#include <memory>

int main(int argc, char* argv[]) {
    std::cout << "===================================================================\n";
    std::cout << "       ⚡ C++ AUTONOMOUS TRADING AGENT & ROADMAP SERVER ⚡\n";
    std::cout << "===================================================================\n";

    // Load environment configuration from .env file
    EnvLoader::load(".env");

    std::string db_host = EnvLoader::get("MYSQL_HOST", "127.0.0.1");
    int db_port = EnvLoader::get_int("MYSQL_PORT", 3307);
    std::string db_user = EnvLoader::get("MYSQL_USER", "mylife");
    std::string db_pass = EnvLoader::get("MYSQL_PASSWORD", "");
    std::string db_name = EnvLoader::get("DATABASE_NAME", "myjob_agent");

    int server_port = EnvLoader::get_int("ROADMAP_PORT", 8080);

    std::cout << "[Init] Target DB: " << db_host << ":" << db_port << "/" << db_name << "\n";
    std::cout << "[Init] HTTP Roadmap Server Port: " << server_port << "\n";

    auto db_client = std::make_shared<RoadmapDbClient>(db_host, db_port, db_user, db_pass, db_name);

    if (db_client->test_connection()) {
        std::cout << "✅ [Database] Oracle Cloud MySQL Connection Successful!\n";
    } else {
        std::cerr << "⚠️ [Database] Connection check failed. Please verify SSH tunnel at " << db_host << ":" << db_port << "\n";
    }

    RoadmapServer server(server_port, db_client);
    server.start();

    return 0;
}
