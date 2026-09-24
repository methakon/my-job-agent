#ifndef ROADMAP_DB_CLIENT_HPP
#define ROADMAP_DB_CLIENT_HPP

#include <string>
#include <vector>

struct ChecklistItem {
    int id;
    int item_order;
    std::string grp;
    std::string goal;
    std::string item;
    std::string status;
    std::string note;
    std::string instr;
    std::string doneWhen;
};

struct RoadmapOverview {
    int total = 0;
    int done = 0;
    int in_progress = 0;
    int pending = 0;
    int blocked = 0;
    int pct = 0;
};

class RoadmapDbClient {
public:
    RoadmapDbClient(std::string host, int port, std::string user, std::string password, std::string db_name);
    ~RoadmapDbClient();

    bool test_connection();
    std::vector<ChecklistItem> fetch_all_items();
    RoadmapOverview compute_overview(const std::vector<ChecklistItem>& items);
    bool update_item_status(int id, const std::string& status);
    bool update_item_note(int id, const std::string& note);

private:
    std::string host_;
    int port_;
    std::string user_;
    std::string password_;
    std::string db_name_;
};

#endif // ROADMAP_DB_CLIENT_HPP
