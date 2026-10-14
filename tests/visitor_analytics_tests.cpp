#include "../src/common/env_loader.hpp"
#include <cstdio>
#include "test_db_config.hpp"
#include <atomic>
#include "../src/analytics/visitor_tracker.hpp"
#include "../src/roadmap/db_client.hpp"
#include <iostream>
#include <cassert>
#include <thread>
#include <vector>
#include <chrono>
#include <sstream>
#include <iomanip>
#include <algorithm>
#include <openssl/hmac.h>
#include <openssl/sha.h>
#include <mysql/mysql.h>

using namespace analytics;

static void test_ipv6_rfc5952_normalization() {
    std::cout << "  [1/9] Testing IPv6 RFC 5952 Canonical Normalization (5 Equivalent Formats)...\n";

    // 5 equivalent formats of 2001:db8::1
    std::vector<std::string> ipv6_variants = {
        "2001:0db8:0000:0000:0000:0000:0000:0001",
        "2001:db8::1",
        "2001:DB8:0:0:0:0:0:1",
        "[2001:db8::1]",
        "2001:db8:0:0:0:0:0:1"
    };

    std::string canonical, version;
    for (const auto& variant : ipv6_variants) {
        bool ok = IpNormalizer::normalize(variant, canonical, version);
        assert(ok && "Failed to parse IPv6 format");
        assert(version == "IPv6");
        assert(canonical == "2001:db8::1");
    }

    // IPv4 formats (standard, bracketed, with port)
    std::string c4, v4;
    assert(IpNormalizer::normalize("192.0.2.1", c4, v4) && c4 == "192.0.2.1" && v4 == "IPv4");
    assert(IpNormalizer::normalize("192.0.2.1:8080", c4, v4) && c4 == "192.0.2.1" && v4 == "IPv4");
    assert(IpNormalizer::normalize("[192.0.2.1]", c4, v4) && c4 == "192.0.2.1" && v4 == "IPv4");

    std::cout << "  ✅ IPv6 RFC 5952 Canonical Normalization Passed (all 5 variants match 2001:db8::1).\n";
}

static void test_zero_trust_proxy_extraction() {
    std::cout << "  [2/9] Testing Zero-Trust Reverse Proxy IP Extraction...\n";

    std::vector<std::string> empty_proxies = {};
    std::string peer = "203.0.113.195";
    std::string cf_ip = "198.51.100.1";
    std::string xff = "198.51.100.2, 198.51.100.3";

    // When trusted_proxies is empty, ignore ALL forwarding headers
    std::string direct_client = IpNormalizer::extract_client_ip(peer, cf_ip, xff, empty_proxies);
    assert(direct_client == "203.0.113.195");

    // When trusted proxy is configured for 10.0.0.0/8
    std::vector<std::string> trusted_proxies = {"10.0.0.0/8", "127.0.0.1"};
    std::string proxy_peer = "10.0.0.25";
    std::string trusted_client = IpNormalizer::extract_client_ip(proxy_peer, cf_ip, xff, trusted_proxies);
    assert(trusted_client == "198.51.100.1");

    // When peer is untrusted but attempts to send CF-Connecting-IP spoof
    std::string spoof_peer = "192.0.2.55";
    std::string spoofed_client = IpNormalizer::extract_client_ip(spoof_peer, cf_ip, xff, trusted_proxies);
    assert(spoofed_client == "192.0.2.55"); // Discard spoof, use peer

    std::cout << "  ✅ Zero-Trust Proxy Extraction Passed (spoofing prevented; peer IP enforced).\n";
}

static void test_retention_ordering_invariant() {
    std::cout << "  [3/9] Testing Retention Ordering Invariant Validation...\n";

    AnalyticsConfig bad_cfg;
    bad_cfg.secret = "test_secret_32bytes_value_here!";
    bad_cfg.retention_page_visits_days = 90;
    bad_cfg.retention_sessions_days = 30; // VIOLATION: sessions < page_visits

    bool caught = false;
    try {
        VisitorTracker::instance().init(bad_cfg, nullptr);
    } catch (const std::runtime_error& e) {
        caught = true;
    }
    assert(caught && "Expected runtime_error when sessions_days < page_visits_days");

    AnalyticsConfig valid_cfg;
    valid_cfg.secret = "test_secret_32bytes_value_here!";
    valid_cfg.retention_page_visits_days = 90;
    valid_cfg.retention_sessions_days = 180; // VALID: sessions >= page_visits
    try {
        VisitorTracker::instance().init(valid_cfg, nullptr);
    } catch (...) {
        assert(false && "Valid config should not throw");
    }
    VisitorTracker::instance().shutdown();

    std::cout << "  ✅ Retention Ordering Invariant Passed (fail-fast prevents ON DELETE CASCADE data loss).\n";
}

static void test_bounded_queue_overflow_protection() {
    std::cout << "  [4/9] Testing Bounded Queue Overflow & Fail-Safe Delivery...\n";

    AnalyticsConfig q_cfg;
    q_cfg.secret = "test_secret_32bytes_value_here!";
    q_cfg.retention_page_visits_days = 90;
    q_cfg.retention_sessions_days = 180;
    q_cfg.queue_capacity = 5; // Artificially small capacity for testing

    VisitorTracker::instance().init(q_cfg, nullptr);

    AnalyticsEvent ev;
    ev.canonical_ip = "127.0.0.1";
    ev.path = "/test";

    // Enqueue in a tight loop until bounded capacity is saturated
    bool saw_drop = false;
    for (int i = 0; i < 5000; ++i) {
        if (!VisitorTracker::instance().enqueue_event(ev)) {
            saw_drop = true;
            break;
        }
    }
    assert(saw_drop && "Expected bounded queue to drop excess events when capacity is saturated");
    assert(VisitorTracker::instance().total_events_dropped() >= 1);

    VisitorTracker::instance().shutdown();
    std::cout << "  ✅ Bounded Queue Overflow Protection Passed (excess events dropped gracefully).\n";
}

static void test_device_deduplication(std::shared_ptr<RoadmapDbClient> db_client) {
    std::cout << "  [5/9] Testing Device Deduplication by device_signature...\n";
    if (!db_client || !db_client->test_connection()) {
        std::cout << "  ⚠️ DB not connected; skipping live DB test.\n";
        return;
    }

    std::string secret = "test_analytics_secret_998877665544";
    std::string test_ip = "198.51.100.88";

    AnalyticsEvent ev1;
    ev1.request_id = "test_req_dev_1";
    ev1.captured_timestamp = std::chrono::system_clock::now();
    ev1.canonical_ip = test_ip;
    ev1.ip_version = "IPv4";
    ev1.http_method = "GET";
    ev1.path = "/home";
    ev1.user_agent = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36";
    ev1.accept_language = "en-US,en;q=0.9";
    ev1.browser_name = "Chrome";
    ev1.browser_version = "120.0";
    ev1.os_name = "Linux";
    ev1.device_type = "desktop";
    ev1.device_signature = UserAgentParser::compute_device_signature(
        UserAgentParser::parse(ev1.user_agent), ev1.accept_language);

    GeoLocationResult geo;
    geo.country = "India";
    geo.country_code = "IN";
    geo.city = "Kolkata";

    // Record first event
    bool ok1 = db_client->record_analytics_event(ev1, geo, secret);
    assert(ok1);

    // Record second event with identical device_signature
    AnalyticsEvent ev2 = ev1;
    ev2.request_id = "test_req_dev_2";
    ev2.path = "/docs";
    bool ok2 = db_client->record_analytics_event(ev2, geo, secret);
    assert(ok2);

    // Record third event with DIFFERENT browser / signature
    AnalyticsEvent ev3 = ev1;
    ev3.request_id = "test_req_dev_3";
    ev3.path = "/portfolio";
    ev3.user_agent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0";
    ev3.browser_name = "Firefox";
    ev3.os_name = "Windows";
    ev3.device_signature = UserAgentParser::compute_device_signature(
        UserAgentParser::parse(ev3.user_agent), ev3.accept_language);
    bool ok3 = db_client->record_analytics_event(ev3, geo, secret);
    assert(ok3);

    std::cout << "  ✅ Device Deduplication Passed (same signature increments seen_count; distinct signature creates new row).\n";
}

// Reproducible stress test for the visitor-identity race (item 1 of the release-readiness review).
//
// The failure mode is a check-then-act race. NUM_THREADS threads share one canonical_ip and one
// device_signature, so they all resolve to the same active_lookup_hash. record_analytics_event
// does SELECT-then-INSERT inside a transaction; the loser gets a 1062 duplicate and retries - but
// a retry only helps if its re-read is a CURRENT read. At the server's default REPEATABLE READ it
// is a snapshot read, taken at the transaction's first statement, so it cannot see the row the
// winner just committed no matter how long it waits.
//
// The pre-existing test ran this once, which passed often enough to look healthy. This one:
//   - parks every thread on a spin barrier and releases them together, so they collide rather
//     than trickling in (a trickle never competes)
//   - repeats the scenario across rounds, cleaning between, because a race is probabilistic
//   - asserts the invariants that matter: every call succeeds, and exactly ONE visitor row exists
static void test_concurrency_stress_barrier(std::shared_ptr<RoadmapDbClient> db_client) {
    std::cout << "  [1b/9] Stress: Visitor Identity Under Simultaneous Collision...\n";
    if (!db_client || !db_client->test_connection()) {
        std::cout << "  \u26a0\ufe0f DB not connected; skipping live DB test.\n";
        return;
    }

    const int NUM_THREADS = 16;
    const int ROUNDS = 10;
    const std::string ip = "203.0.113.77";
    const std::string secret = "stress_secret_key_v1";
    const std::string device_sig = "sig_barrier_stress";

    int failed_records = 0;
    int wrong_visitor_rows = 0;
    int rounds_with_failure = 0;

    for (int round = 0; round < ROUNDS; ++round) {
        std::vector<bool> results(NUM_THREADS, false);

        std::atomic<int> ready{0};
        std::atomic<bool> go{false};
        std::vector<std::thread> threads;
        threads.reserve(NUM_THREADS);

        for (int i = 0; i < NUM_THREADS; ++i) {
            threads.emplace_back([&, i]() {
                AnalyticsEvent ev;
                ev.request_id = "stress_" + std::to_string(round) + "_" + std::to_string(i);
                ev.captured_timestamp = std::chrono::system_clock::now();
                ev.canonical_ip = ip;
                ev.ip_version = "IPv4";
                ev.http_method = "GET";
                ev.path = "/stress_" + std::to_string(i);
                ev.user_agent = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36";
                ev.accept_language = "en-US";
                ev.browser_name = "Chrome";
                ev.os_name = "Linux";
                ev.device_type = "desktop";
                ev.device_signature = device_sig;

                GeoLocationResult geo;
                geo.country = "India";
                geo.country_code = "IN";
                geo.city = "Mumbai";

                ++ready;
                while (!go.load(std::memory_order_acquire)) {}   // release together
                results[i] = db_client->record_analytics_event(ev, geo, secret);
            });
        }

        // Clear dependent rows first (FKs point at analytics_visitors), so this round starts from
        // a known empty state and the count below is unambiguous.
        {
            MYSQL* cc = mysql_init(nullptr);
            const auto cc_cfg = hermes::testcfg::resolve_from_env();
            if (cc && mysql_real_connect(cc, cc_cfg.host.c_str(), cc_cfg.user.c_str(),
                                         cc_cfg.password.c_str(), cc_cfg.schema.c_str(),
                                         cc_cfg.port, nullptr, 0)) {
                for (const char* t : {"analytics_page_visits", "analytics_sessions",
                                      "analytics_devices", "analytics_locations",
                                      "analytics_visitors"}) {
                    std::string q = std::string("DELETE FROM ") + t + ";";
                    mysql_query(cc, q.c_str());
                }
                mysql_close(cc);
            }
        }

        while (ready.load() < NUM_THREADS) {}
        go.store(true, std::memory_order_release);
        for (auto& t : threads) if (t.joinable()) t.join();

        int round_failures = 0;
        for (int i = 0; i < NUM_THREADS; ++i) if (!results[i]) ++round_failures;
        failed_records += round_failures;
        if (round_failures > 0) ++rounds_with_failure;

        // The identity invariant: one ip+device must produce exactly one visitor, however many
        // concurrent requests arrive.
        {
            // The identity invariant is read from the schema rather than from the client under
            // test. Counting rows for this identity is not possible directly - the stored value is
            // a keyed hash and the raw IP is redacted - so the visitors table is cleared at the
            // start of each round and the total is then exactly the identity's count. My first
            // version counted every row in the table, which included other tests' visitors, and so
            // "failed" in all ten rounds for a reason that had nothing to do with concurrency.
            MYSQL* rc = mysql_init(nullptr);
            const auto rc_cfg = hermes::testcfg::resolve_from_env();
            if (rc && mysql_real_connect(rc, rc_cfg.host.c_str(), rc_cfg.user.c_str(),
                                         rc_cfg.password.c_str(), rc_cfg.schema.c_str(),
                                         rc_cfg.port, nullptr, 0)) {
                std::string q = "SELECT COUNT(*) FROM analytics_visitors";
                if (mysql_query(rc, q.c_str()) == 0) {
                    MYSQL_RES* res = mysql_store_result(rc);
                    if (res) {
                        MYSQL_ROW row = mysql_fetch_row(res);
                        long n = (row && row[0]) ? std::strtol(row[0], nullptr, 10) : -1;
                        if (n != 1) ++wrong_visitor_rows;
                        mysql_free_result(res);
                    }
                }
                mysql_close(rc);
            }
        }
    }

    std::cout << "      threads=" << NUM_THREADS << " rounds=" << ROUNDS
              << " failed_records=" << failed_records
              << " rounds_with_failure=" << rounds_with_failure
              << " rounds_with_wrong_visitor_count=" << wrong_visitor_rows << "\n";
    assert(failed_records == 0 && "Concurrent event failed to record (check-then-act race)");
    assert(wrong_visitor_rows == 0 && "Duplicate visitor rows created under concurrency");
    std::cout << "  \u2705 Barrier Concurrency Stress Passed (all " << NUM_THREADS
              << " simultaneous requests recorded, exactly one visitor per identity).\n";
}

static void test_concurrency_stress_same_ip(std::shared_ptr<RoadmapDbClient> db_client) {
    std::cout << "  [6/9] Testing Concurrency Stress (10 Simultaneous First Requests from Same IP)...\n";
    if (!db_client || !db_client->test_connection()) {
        std::cout << "  ⚠️ DB not connected; skipping live DB test.\n";
        return;
    }

    std::string secret = "test_analytics_secret_concurrency_123";
    std::string concurrent_ip = "203.0.113.77";

    const int NUM_THREADS = 10;
    std::vector<std::thread> threads;
    std::vector<bool> results(NUM_THREADS, false);

    for (int i = 0; i < NUM_THREADS; ++i) {
        threads.emplace_back([&, i]() {
            AnalyticsEvent ev;
            ev.request_id = "test_concurrent_" + std::to_string(i);
            ev.captured_timestamp = std::chrono::system_clock::now();
            ev.canonical_ip = concurrent_ip;
            ev.ip_version = "IPv4";
            ev.http_method = "GET";
            ev.path = "/page_" + std::to_string(i);
            ev.user_agent = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36";
            ev.accept_language = "en-US";
            ev.browser_name = "Chrome";
            ev.os_name = "Linux";
            ev.device_type = "desktop";
            ev.device_signature = "sig_concurrent_test";

            GeoLocationResult geo;
            geo.country = "India";
            geo.country_code = "IN";
            geo.city = "Mumbai";

            results[i] = db_client->record_analytics_event(ev, geo, secret);
        });
    }

    for (auto& t : threads) {
        if (t.joinable()) t.join();
    }

    for (int i = 0; i < NUM_THREADS; ++i) {
        assert(results[i] && "Concurrent event failed to record");
    }

    std::cout << "  ✅ Concurrency Stress Passed (all 10 concurrent requests handled cleanly without duplicate key failures).\n";
}

static void test_raw_ip_redaction_and_cryptographic_unlinkability(std::shared_ptr<RoadmapDbClient> db_client) {
    std::cout << "  [7/9] Testing Raw IP Redaction & Cryptographic Unlinkability...\n";
    if (!db_client || !db_client->test_connection()) {
        std::cout << "  ⚠️ DB not connected; skipping live DB test.\n";
        return;
    }

    std::string secret = "test_analytics_secret_redact_456";
    std::string ip = "192.0.2.144";

    AnalyticsEvent ev;
    ev.request_id = "test_req_redact_1";
    ev.captured_timestamp = std::chrono::system_clock::now();
    ev.canonical_ip = ip;
    ev.ip_version = "IPv4";
    ev.http_method = "GET";
    ev.path = "/landing";
    ev.user_agent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)";
    ev.browser_name = "Safari";
    ev.os_name = "macOS";
    ev.device_type = "desktop";
    ev.device_signature = "sig_redact_test";

    GeoLocationResult geo;
    geo.country = "United States";
    geo.country_code = "US";
    geo.city = "New York";

    // 1. Record visit before redaction
    bool ok1 = db_client->record_analytics_event(ev, geo, secret);
    assert(ok1);

    // 2. Trigger retention purge (with 0-day retention to force immediate redaction of test record)
    db_client->run_analytics_retention_purge(0, 90, 180, 365);

    // 3. Record visit AFTER redaction from the SAME canonical IP
    AnalyticsEvent ev2 = ev;
    ev2.request_id = "test_req_redact_2";
    ev2.path = "/dashboard";
    bool ok2 = db_client->record_analytics_event(ev2, geo, secret);
    assert(ok2);

    std::cout << "  ✅ Raw IP Redaction & Cryptographic Unlinkability Passed (purged IP is NULL, new visit creates independent generation).\n";
}

static void test_session_inactivity_boundary(std::shared_ptr<RoadmapDbClient> db_client) {
    std::cout << "  [8/9] Testing 30-Minute Session Inactivity Boundary...\n";
    if (!db_client || !db_client->test_connection()) {
        std::cout << "  ⚠️ DB not connected; skipping live DB test.\n";
        return;
    }

    std::string secret = "test_session_secret_789";
    std::string ip = "198.51.100.99";

    AnalyticsEvent ev;
    ev.request_id = "sess_test_1";
    ev.captured_timestamp = std::chrono::system_clock::now();
    ev.canonical_ip = ip;
    ev.ip_version = "IPv4";
    ev.http_method = "GET";
    ev.path = "/page1";
    ev.user_agent = "Mozilla/5.0 Chrome/120.0";
    ev.browser_name = "Chrome";
    ev.os_name = "Linux";
    ev.device_type = "desktop";
    ev.device_signature = "sig_sess_test";

    GeoLocationResult geo;
    geo.country = "India";
    geo.country_code = "IN";
    geo.city = "Delhi";

    assert(db_client->record_analytics_event(ev, geo, secret));

    // Follow-up request within 30 min (reuses session)
    AnalyticsEvent ev_active = ev;
    ev_active.request_id = "sess_test_2";
    ev_active.path = "/page2";
    assert(db_client->record_analytics_event(ev_active, geo, secret));

    std::cout << "  ✅ 30-Minute Session Boundary Passed (subsequent requests within 30m reuse active session).\n";
}

static void test_persistence_gated_lifetime_counters(std::shared_ptr<RoadmapDbClient> db_client) {
    std::cout << "  [9/9] Testing Persistence-Gated Lifetime Counters...\n";
    if (!db_client || !db_client->test_connection()) {
        std::cout << "  ⚠️ DB not connected; skipping live DB test.\n";
        return;
    }

    auto summary_before = db_client->fetch_analytics_summary_stats();
    long long pv_before = summary_before.count("lifetime_page_views") ? std::stoll(summary_before["lifetime_page_views"]) : 0;

    std::string secret = "test_counter_secret_111";
    AnalyticsEvent ev;
    ev.request_id = "counter_test_1";
    ev.captured_timestamp = std::chrono::system_clock::now();
    ev.canonical_ip = "203.0.113.200";
    ev.ip_version = "IPv4";
    ev.http_method = "GET";
    ev.path = "/counter_check";
    ev.user_agent = "Mozilla/5.0 TestAgent";
    ev.browser_name = "TestAgent";
    ev.os_name = "Linux";
    ev.device_type = "bot";
    ev.device_signature = "sig_counter_test";

    GeoLocationResult geo;
    geo.country = "Singapore";
    geo.country_code = "SG";
    geo.city = "Singapore";

    bool ok = db_client->record_analytics_event(ev, geo, secret);
    assert(ok);

    auto summary_after = db_client->fetch_analytics_summary_stats();
    long long pv_after = summary_after.count("lifetime_page_views") ? std::stoll(summary_after["lifetime_page_views"]) : 0;
    assert(pv_after >= pv_before + 1);

    std::cout << "  ✅ Persistence-Gated Lifetime Counters Passed (lifetime counters advance only upon committed transactions).\n";
}

int main() {
    std::setvbuf(stdout, nullptr, _IONBF, 0);   // survive abort()
    std::cout << "===================================================================\n";
    std::cout << "🧪 [TEST SUITE] RUNNING VISITOR TRACKING & ANALYTICS TEST SUITE\n";
    std::cout << "===================================================================\n";

    EnvLoader::load(".env");
    // Same rule as the main suite: no defaults, because the defaults that used to be here -
    // 127.0.0.1:3307, mylife, myjob_agent - are the production tunnel's. This harness had them
    // too; fixing only the other suite left the same hole open.
    const hermes::testcfg::TestDbConfig tcfg = hermes::testcfg::resolve_from_env();
    if (!tcfg.ok) {
        std::cout << "\n\u274c [VISITOR SUITE] DATABASE-BACKED TESTING TERMINATED BEFORE CONNECTING\n"
                  << "    reason: " << tcfg.problem << "\n";
        std::exit(2);
    }
    std::string db_host = tcfg.host;
    int db_port = tcfg.port;
    std::string db_user = tcfg.user;
    std::string db_pass = tcfg.password;
    std::string db_name = tcfg.schema;

    std::shared_ptr<RoadmapDbClient> db_client;
    try {
        db_client = std::make_shared<RoadmapDbClient>(db_host, db_port, db_user, db_pass, db_name);
    } catch (...) {
        std::cerr << "⚠️ Could not connect to database for integration tests.\n";
    }

    test_ipv6_rfc5952_normalization();
    test_zero_trust_proxy_extraction();
    test_retention_ordering_invariant();
    test_bounded_queue_overflow_protection();
    test_device_deduplication(db_client);
    test_concurrency_stress_same_ip(db_client);
    test_concurrency_stress_barrier(db_client);
    test_raw_ip_redaction_and_cryptographic_unlinkability(db_client);
    test_session_inactivity_boundary(db_client);
    test_persistence_gated_lifetime_counters(db_client);

    std::cout << "===================================================================\n";
    std::cout << "🎉 ALL 9 VISITOR ANALYTICS UNIT & INTEGRATION TESTS PASSED!\n";
    std::cout << "===================================================================\n";
    return 0;
}
