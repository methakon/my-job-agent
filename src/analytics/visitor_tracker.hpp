#ifndef VISITOR_TRACKER_HPP
#define VISITOR_TRACKER_HPP

#include <string>
#include <vector>
#include <memory>
#include <chrono>
#include <queue>
#include <mutex>
#include <condition_variable>
#include <thread>
#include <atomic>
#include <unordered_map>
#include <shared_mutex>

// Forward declaration in global namespace
class RoadmapDbClient;

namespace analytics {

// ============================================================================
// Immutable Analytics Event Snapshot
// ============================================================================
// The HTTP request handler constructs this complete independent snapshot
// before enqueueing it. The background worker operates strictly on this
// immutable snapshot, never accessing request buffers, sockets, or contexts.
struct AnalyticsEvent {
    std::string request_id;
    std::chrono::system_clock::time_point captured_timestamp;
    std::string canonical_ip;
    std::string ip_version;          // "IPv4" or "IPv6"
    std::string http_method;
    std::string path;
    std::string sanitized_query_string;
    std::string full_url;
    std::string user_agent;
    std::string referer;
    std::string accept_language;
    std::string page_title;
    int status_code = 200;
    double response_time_ms = 0.0;
    bool is_bot = false;
    std::string bot_name;
    std::string browser_name;
    std::string browser_version;
    std::string os_name;
    std::string os_version;
    std::string device_type;         // "desktop", "mobile", "tablet", "bot", "unknown"
    std::string device_family;
    std::string device_signature;    // SHA256(browser:os:type:lang)
};

// Parsed User-Agent and device breakdown
struct UserAgentInfo {
    std::string browser_name;
    std::string browser_version;
    std::string os_name;
    std::string os_version;
    std::string device_type;
    std::string device_family;
    bool is_bot = false;
    std::string bot_name;
};

// Geolocation result
struct GeoLocationResult {
    std::string country = "Unknown";
    std::string country_code = "XX";
    std::string region = "Unknown";
    std::string city = "Unknown";
    std::string postal_code;
    double latitude = 0.0;
    double longitude = 0.0;
    std::string timezone = "UTC";
    std::string continent = "Unknown";
    std::string isp = "Unknown";
    std::string asn = "Unknown";
    std::string source = "Local GeoIP Database";
    std::string disclaimer = "Approximate location derived from IP";
};

// Configuration container
struct AnalyticsConfig {
    std::string secret;
    std::vector<std::string> trusted_proxies;
    int retention_raw_ip_days = 30;
    int retention_page_visits_days = 90;
    int retention_sessions_days = 180;
    int retention_locations_days = 365;
    size_t queue_capacity = 10000;
    bool geo_http_fallback_enabled = false;
};

// ============================================================================
// Helper Utilities: IP Normalization, Query Sanitizer, UA Parser
// ============================================================================
class IpNormalizer {
public:
    static bool normalize(const std::string& raw_ip, std::string& out_canonical, std::string& out_version);
    static bool is_cidr_match(const std::string& ip, const std::string& cidr);
    static std::string extract_client_ip(const std::string& peer_ip,
                                         const std::string& cf_connecting_ip,
                                         const std::string& x_forwarded_for,
                                         const std::vector<std::string>& trusted_proxies);
};

class QuerySanitizer {
public:
    static std::string sanitize(const std::string& raw_query);
};

class UserAgentParser {
public:
    static UserAgentInfo parse(const std::string& ua);
    static std::string compute_device_signature(const UserAgentInfo& info, const std::string& accept_lang);
};

// ============================================================================
// Geolocation Provider Abstraction
// ============================================================================
class IGeoLocationProvider {
public:
    virtual ~IGeoLocationProvider() = default;
    virtual GeoLocationResult lookup(const std::string& canonical_ip) = 0;
};

class LocalGeoLocationProvider : public IGeoLocationProvider {
public:
    LocalGeoLocationProvider();
    GeoLocationResult lookup(const std::string& canonical_ip) override;

private:
    std::shared_mutex cache_mutex_;
    std::unordered_map<std::string, GeoLocationResult> memory_cache_;
};

// ============================================================================
// VisitorTracker Manager (Bounded Queue, Async Worker, Persistence-Gated)
// ============================================================================
class VisitorTracker {
public:
    static VisitorTracker& instance();

    void init(const AnalyticsConfig& config, std::shared_ptr<RoadmapDbClient> db_client);
    void shutdown();

    // Construct and enqueue immutable event snapshot (non-blocking)
    bool enqueue_event(AnalyticsEvent event);

    // Manual retention execution
    void run_retention_purge();

    const AnalyticsConfig& config() const { return config_; }
    size_t queue_size();
    uint64_t total_events_enqueued() const { return total_enqueued_.load(); }
    uint64_t total_events_dropped() const { return total_dropped_.load(); }
    uint64_t total_events_persisted() const { return total_persisted_.load(); }

    std::shared_ptr<IGeoLocationProvider> geo_provider() { return geo_provider_; }

private:
    VisitorTracker();
    ~VisitorTracker();

    void worker_loop();
    void process_event(const AnalyticsEvent& event);

    AnalyticsConfig config_;
    std::shared_ptr<RoadmapDbClient> db_client_;
    std::shared_ptr<IGeoLocationProvider> geo_provider_;

    std::queue<AnalyticsEvent> queue_;
    std::mutex queue_mutex_;
    std::condition_variable cv_;
    std::atomic<bool> running_{false};
    std::vector<std::thread> workers_;

    std::atomic<uint64_t> total_enqueued_{0};
    std::atomic<uint64_t> total_dropped_{0};
    std::atomic<uint64_t> total_persisted_{0};
};

} // namespace analytics

#endif // VISITOR_TRACKER_HPP
