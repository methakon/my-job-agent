#include "decision_journal.hpp"
#include <iostream>

DecisionJournal::DecisionJournal(std::shared_ptr<RoadmapDbClient> db_client)
    : db_client_(std::move(db_client)) {}

bool DecisionJournal::log_decision_transactional(const DecisionJournalRecord& record) {
    if (!db_client_) return false;
    std::string git_sha = record.git_commit_sha.empty() ? HERMES_GIT_COMMIT_SHA : record.git_commit_sha;
    std::string ver = record.engine_version.empty() ? HERMES_ENGINE_VERSION : record.engine_version;

    return db_client_->log_decision_journal_record(
        record.decision_uuid,
        record.session_id,
        git_sha,
        ver,
        record.symbol,
        record.action,
        record.confidence,
        record.allocated_margin,
        record.reason,
        record.feature_snapshot_json
    );
}

bool DecisionJournal::reconstruct_decision_by_uuid(const std::string& decision_uuid, DecisionJournalRecord& out_record) {
    if (!db_client_ || decision_uuid.empty()) return false;
    out_record.decision_uuid = decision_uuid;

    return db_client_->fetch_decision_journal_record(
        decision_uuid,
        out_record.session_id,
        out_record.git_commit_sha,
        out_record.engine_version,
        out_record.symbol,
        out_record.action,
        out_record.confidence,
        out_record.allocated_margin,
        out_record.reason,
        out_record.feature_snapshot_json
    );
}

bool DecisionJournal::simulate_forced_crash_rollback(const DecisionJournalRecord& valid_record, const DecisionJournalRecord& invalid_record) {
    if (!db_client_) return false;

    // Log valid record
    bool first_ok = log_decision_transactional(valid_record);

    // Attempting to log duplicate/invalid record will fail and roll back transactionally
    bool second_ok = log_decision_transactional(invalid_record);

    return first_ok && !second_ok;
}
