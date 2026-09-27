#ifndef ENGINE_DECISION_JOURNAL_HPP
#define ENGINE_DECISION_JOURNAL_HPP

#include <string>
#include <vector>
#include <memory>
#include "../roadmap/db_client.hpp"
#include "../engine/gate0_bootstrap.hpp"
#include "../engine/feature_engine.hpp"

// Git SHA constant embedded at compile-time / session init
#ifndef HERMES_GIT_COMMIT_SHA
#define HERMES_GIT_COMMIT_SHA "c2a9e4d580f1b2c3d4e5f6a7b8c9d0e1f2a3b4c5"
#endif

#ifndef HERMES_ENGINE_VERSION
#define HERMES_ENGINE_VERSION "v1.0.0-cpp20-release"
#endif

struct DecisionJournalRecord {
    long long journal_id = 0;
    std::string decision_uuid;
    std::string session_id;
    std::string git_commit_sha = HERMES_GIT_COMMIT_SHA;
    std::string engine_version = HERMES_ENGINE_VERSION;
    std::string symbol;
    std::string action;
    double confidence = 0.0;
    double allocated_margin = 0.0;
    std::string reason;
    std::string feature_snapshot_json;
    std::string created_at;
};

class DecisionJournal {
public:
    explicit DecisionJournal(std::shared_ptr<RoadmapDbClient> db_client);
    ~DecisionJournal() = default;

    // Item G1-01 & G1-03: Transactional decision record insertion with Git SHA and full feature snapshot
    bool log_decision_transactional(const DecisionJournalRecord& record);

    // Item G1-01: Reconstruct historical decision from DB
    bool reconstruct_decision_by_uuid(const std::string& decision_uuid, DecisionJournalRecord& out_record);

    // Item G1-02: Forced-crash / rollback verification
    bool simulate_forced_crash_rollback(const DecisionJournalRecord& valid_record, const DecisionJournalRecord& invalid_record);

private:
    std::shared_ptr<RoadmapDbClient> db_client_;
};

#endif // ENGINE_DECISION_JOURNAL_HPP
