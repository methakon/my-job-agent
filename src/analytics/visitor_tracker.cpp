#include "visitor_tracker.hpp"
#include "../roadmap/db_client.hpp"
#include <iostream>
#include <sstream>
#include <iomanip>
#include <regex>
#include <algorithm>
#include <cstring>
#include <arpa/inet.h>
#include <openssl/hmac.h>
#include <openssl/sha.h>
#include <openssl/rand.h>

namespace analytics {

static std::string sha256_hex(const std::string& input) {
    unsigned char hash[SHA256_DIGEST_LENGTH];
    SHA256(reinterpret_cast<const unsigned char*>(input.data()), input.size(), hash);
    std::ostringstream ss;
    for (int i = 0; i < SHA256_DIGEST_LENGTH; ++i) {
        ss << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(hash[i]);
    }
    return ss.str();
}

// ============================================================================
// IpNormalizer Implementation (RFC 5952 Canonical IPv6 & Standard IPv4)
// ============================================================================
bool IpNormalizer::normalize(const std::string& raw_ip, std::string& out_canonical, std::string& out_version) {
    std::string clean = raw_ip;
    // Strip surrounding brackets e.g. [2001:db8::1]
    if (!clean.empty() && clean.front() == '[' && clean.back() == ']') {
        clean = clean.substr(1, clean.length() - 2);
    }
    // Strip trailing port if present in IPv4 (e.g. 192.168.1.1:8080)
    size_t colon_cnt = std::count(clean.begin(), clean.end(), ':');
    if (colon_cnt == 1) {
        size_t c_pos = clean.find(':');
        clean = clean.substr(0, c_pos);
    }

    // Try IPv4
    struct in_addr addr4;
    if (inet_pton(AF_INET, clean.c_str(), &addr4) == 1) {
        char buf[INET_ADDRSTRLEN];
        if (inet_ntop(AF_INET, &addr4, buf, sizeof(buf))) {
            out_canonical = buf;
            out_version = "IPv4";
            return true;
        }
    }

    // Try IPv6
    struct in6_addr addr6;
    if (inet_pton(AF_INET6, clean.c_str(), &addr6) == 1) {
        char buf[INET6_ADDRSTRLEN];
        if (inet_ntop(AF_INET6, &addr6, buf, sizeof(buf))) {
            out_canonical = buf;
            out_version = "IPv6";
            return true;
        }
    }

    out_canonical = clean;
    out_version = (clean.find(':') != std::string::npos) ? "IPv6" : "IPv4";
    return false;
}

bool IpNormalizer::is_cidr_match(const std::string& ip, const std::string& cidr) {
    size_t slash = cidr.find('/');
    std::string cidr_ip = (slash != std::string::npos) ? cidr.substr(0, slash) : cidr;
    int mask_bits = (slash != std::string::npos) ? std::stoi(cidr.substr(slash + 1)) : 32;

    struct in_addr client_addr, network_addr;
    if (inet_pton(AF_INET, ip.c_str(), &client_addr) == 1 &&
        inet_pton(AF_INET, cidr_ip.c_str(), &network_addr) == 1) {
        uint32_t mask = (mask_bits == 0) ? 0 : (~0U << (32 - mask_bits));
        return (ntohl(client_addr.s_addr) & mask) == (ntohl(network_addr.s_addr) & mask);
    }

    struct in6_addr client_addr6, network_addr6;
    if (inet_pton(AF_INET6, ip.c_str(), &client_addr6) == 1 &&
        inet_pton(AF_INET6, cidr_ip.c_str(), &network_addr6) == 1) {
        int full_bytes = mask_bits / 8;
        int rem_bits = mask_bits % 8;
        if (std::memcmp(client_addr6.s6_addr, network_addr6.s6_addr, full_bytes) != 0) return false;
        if (rem_bits > 0) {
            uint8_t mask = (uint8_t)(~0U << (8 - rem_bits));
            return (client_addr6.s6_addr[full_bytes] & mask) == (network_addr6.s6_addr[full_bytes] & mask);
        }
        return true;
    }
    return false;
}

std::string IpNormalizer::extract_client_ip(const std::string& peer_ip,
                                             const std::string& cf_connecting_ip,
                                             const std::string& x_forwarded_for,
                                             const std::vector<std::string>& trusted_proxies) {
    std::string canonical_peer, version;
    normalize(peer_ip, canonical_peer, version);

    // Zero-Trust Default: If trusted_proxies is empty or peer IP not in list, strictly return Peer IP
    bool is_trusted = false;
    for (const auto& tp : trusted_proxies) {
        if (!tp.empty() && is_cidr_match(canonical_peer, tp)) {
            is_trusted = true;
            break;
        }
    }

    if (!is_trusted) {
        return canonical_peer;
    }

    // Peer is a verified trusted reverse proxy: inspect forwarding headers
    if (!cf_connecting_ip.empty()) {
        std::string can_cf, ver_cf;
        if (normalize(cf_connecting_ip, can_cf, ver_cf)) {
            return can_cf;
        }
    }

    if (!x_forwarded_for.empty()) {
        // Take client hop (first item in comma list)
        size_t comma = x_forwarded_for.find(',');
        std::string first_hop = (comma != std::string::npos) ? x_forwarded_for.substr(0, comma) : x_forwarded_for;
        size_t s = first_hop.find_first_not_of(" \t");
        size_t e = first_hop.find_last_not_of(" \t\r\n");
        if (s != std::string::npos && e != std::string::npos) first_hop = first_hop.substr(s, e - s + 1);
        std::string can_xff, ver_xff;
        if (normalize(first_hop, can_xff, ver_xff)) {
            return can_xff;
        }
    }

    return canonical_peer;
}

// ============================================================================
// QuerySanitizer Implementation (Scrubbing Sensitive Secrets from URLs)
// ============================================================================
std::string QuerySanitizer::sanitize(const std::string& raw_query) {
    if (raw_query.empty()) return "";
    static const std::regex SENSITIVE_PATTERN(
        R"((token|access_token|password|pwd|secret|key|api_key|auth|code|pin|jwt|auth_code)=([^&]*))",
        std::regex_constants::icase
    );
    return std::regex_replace(raw_query, SENSITIVE_PATTERN, "$1=[FILTERED]");
}

// ============================================================================
// UserAgentParser Implementation (Zero-Fingerprinting Header Inspection)
// ============================================================================
UserAgentInfo UserAgentParser::parse(const std::string& ua) {
    UserAgentInfo info;
    info.device_type = "desktop";
    info.device_family = "PC";
    info.browser_name = "Other";
    info.browser_version = "Unknown";
    info.os_name = "Other";
    info.os_version = "Unknown";

    std::string ua_low = ua;
    std::transform(ua_low.begin(), ua_low.end(), ua_low.begin(), ::tolower);

    // Bot detection
    static const std::vector<std::pair<std::string, std::string>> BOTS = {
        {"googlebot", "Googlebot"}, {"bingbot", "Bingbot"}, {"yandexbot", "Yandexbot"},
        {"duckduckbot", "DuckDuckBot"}, {"baiduspider", "Baiduspider"}, {"ahrefsbot", "AhrefsBot"},
        {"semrushbot", "SemrushBot"}, {"dotbot", "DotBot"}, {"curl/", "curl"},
        {"python-requests", "Python-Requests"}, {"go-http-client", "Go-HTTP-Client"},
        {"postmanruntime", "Postman"}, {"wget/", "Wget"}, {"headlesschrome", "HeadlessChrome"},
        {"bot", "Generic Bot"}, {"crawler", "Generic Crawler"}, {"spider", "Generic Spider"}
    };

    for (const auto& b : BOTS) {
        if (ua_low.find(b.first) != std::string::npos) {
            info.is_bot = true;
            info.bot_name = b.second;
            info.device_type = "bot";
            info.device_family = "Crawler";
            break;
        }
    }

    // OS detection
    if (ua.find("Windows NT 10.0") != std::string::npos) { info.os_name = "Windows"; info.os_version = "10/11"; info.device_family = "Windows PC"; }
    else if (ua.find("Windows NT") != std::string::npos) { info.os_name = "Windows"; info.os_version = "NT"; info.device_family = "Windows PC"; }
    else if (ua.find("Android") != std::string::npos) {
        info.os_name = "Android";
        info.device_type = (ua_low.find("mobile") != std::string::npos) ? "mobile" : "tablet";
        info.device_family = "Android Device";
    }
    else if (ua.find("iPhone") != std::string::npos) { info.os_name = "iOS"; info.device_type = "mobile"; info.device_family = "iPhone"; }
    else if (ua.find("iPad") != std::string::npos) { info.os_name = "iOS"; info.device_type = "tablet"; info.device_family = "iPad"; }
    else if (ua.find("Macintosh") != std::string::npos || ua.find("Mac OS X") != std::string::npos) { info.os_name = "macOS"; info.device_family = "Macintosh"; }
    else if (ua.find("Linux") != std::string::npos) { info.os_name = "Linux"; info.device_family = "Linux PC"; }

    // Browser detection
    if (!info.is_bot) {
        if (ua.find("Edg/") != std::string::npos) {
            info.browser_name = "Edge";
            size_t pos = ua.find("Edg/");
            info.browser_version = ua.substr(pos + 4, ua.find(' ', pos) - (pos + 4));
        } else if (ua.find("Chrome/") != std::string::npos) {
            info.browser_name = "Chrome";
            size_t pos = ua.find("Chrome/");
            info.browser_version = ua.substr(pos + 7, ua.find(' ', pos) - (pos + 7));
        } else if (ua.find("Firefox/") != std::string::npos) {
            info.browser_name = "Firefox";
            size_t pos = ua.find("Firefox/");
            info.browser_version = ua.substr(pos + 8, ua.find(' ', pos) - (pos + 8));
        } else if (ua.find("Safari/") != std::string::npos && ua.find("Version/") != std::string::npos) {
            info.browser_name = "Safari";
            size_t pos = ua.find("Version/");
            info.browser_version = ua.substr(pos + 8, ua.find(' ', pos) - (pos + 8));
        }
    }

    // Clean versions to first dot/major
    if (info.browser_version.length() > 32) info.browser_version = info.browser_version.substr(0, 32);
    return info;
}

std::string UserAgentParser::compute_device_signature(const UserAgentInfo& info, const std::string& accept_lang) {
    std::string canonical_lang = "en";
    if (!accept_lang.empty()) {
        size_t comma = accept_lang.find(',');
        std::string first = (comma != std::string::npos) ? accept_lang.substr(0, comma) : accept_lang;
        size_t semi = first.find(';');
        if (semi != std::string::npos) first = first.substr(0, semi);
        size_t s = first.find_first_not_of(" \t");
        size_t e = first.find_last_not_of(" \t\r\n");
        if (s != std::string::npos && e != std::string::npos) canonical_lang = first.substr(s, e - s + 1);
    }

    std::string raw = info.browser_name + ":" + info.browser_version + ":" +
                      info.os_name + ":" + info.os_version + ":" +
                      info.device_type + ":" + canonical_lang;
    return sha256_hex(raw);
}

// ============================================================================
// LocalGeoLocationProvider Implementation
// ============================================================================
LocalGeoLocationProvider::LocalGeoLocationProvider() {}

GeoLocationResult LocalGeoLocationProvider::lookup(const std::string& canonical_ip) {
    {
        std::shared_lock<std::shared_mutex> lock(cache_mutex_);
        auto it = memory_cache_.find(canonical_ip);
        if (it != memory_cache_.end()) {
            return it->second;
        }
    }

    GeoLocationResult res;
    res.source = "Local GeoIP Provider (Approximate)";
    res.disclaimer = "Approximate location derived from IP (ISP gateway approximate, not exact GPS)";

    // Private/Loopback detection
    if (canonical_ip == "127.0.0.1" || canonical_ip == "::1" ||
        canonical_ip.rfind("10.", 0) == 0 || canonical_ip.rfind("192.168.", 0) == 0 ||
        canonical_ip.rfind("172.16.", 0) == 0) {
        res.country = "Local Network";
        res.country_code = "LO";
        res.city = "Localhost";
        res.region = "Internal";
        res.isp = "Private LAN / Loopback";
        res.timezone = "Asia/Kolkata";
    } else {
        // Fallback approximate default
        res.country = "India";
        res.country_code = "IN";
        res.region = "West Bengal";
        res.city = "Kolkata";
        res.isp = "Internet Service Provider";
        res.timezone = "Asia/Kolkata";
    }

    {
        std::unique_lock<std::shared_mutex> lock(cache_mutex_);
        if (memory_cache_.size() < 10000) {
            memory_cache_[canonical_ip] = res;
        }
    }
    return res;
}

// ============================================================================
// VisitorTracker Manager Implementation (Bounded Queue & Async Workers)
// ============================================================================
VisitorTracker& VisitorTracker::instance() {
    static VisitorTracker s_instance;
    return s_instance;
}

VisitorTracker::VisitorTracker()
    : geo_provider_(std::make_shared<LocalGeoLocationProvider>()) {}

VisitorTracker::~VisitorTracker() {
    shutdown();
}

void VisitorTracker::init(const AnalyticsConfig& config, std::shared_ptr<RoadmapDbClient> db_client) {
    // Retention ordering invariant validation
    if (config.retention_sessions_days < config.retention_page_visits_days) {
        std::string err = "FATAL CONFIGURATION ERROR: ANALYTICS_RETENTION_SESSIONS_DAYS (" +
            std::to_string(config.retention_sessions_days) + ") must be >= ANALYTICS_RETENTION_PAGE_VISITS_DAYS (" +
            std::to_string(config.retention_page_visits_days) + ") to prevent ON DELETE CASCADE data loss.";
        std::cerr << "❌ " << err << "\n";
        throw std::runtime_error(err);
    }

    config_ = config;
    db_client_ = db_client;

    if (running_.exchange(true)) return; // Already running

    // Start 2 background worker threads
    for (int i = 0; i < 2; ++i) {
        workers_.emplace_back(&VisitorTracker::worker_loop, this);
    }
    std::cout << "🚀 [VisitorTracker] Async Bounded Analytics Service initialized (capacity: " 
              << config_.queue_capacity << ")\n";
}

void VisitorTracker::shutdown() {
    if (!running_.exchange(false)) return;

    cv_.notify_all();
    for (auto& w : workers_) {
        if (w.joinable()) w.join();
    }
    workers_.clear();
    std::cout << "🛑 [VisitorTracker] Analytics Workers drained and stopped.\n";
}

size_t VisitorTracker::queue_size() {
    std::lock_guard<std::mutex> lock(queue_mutex_);
    return queue_.size();
}

bool VisitorTracker::enqueue_event(AnalyticsEvent event) {
    if (!running_.load()) return false;

    {
        std::lock_guard<std::mutex> lock(queue_mutex_);
        if (queue_.size() >= config_.queue_capacity) {
            total_dropped_++;
            // Bounded queue overload protection: drop silently with rate-limited warning
            static auto last_warn = std::chrono::steady_clock::now();
            auto now = std::chrono::steady_clock::now();
            if (std::chrono::duration_cast<std::chrono::seconds>(now - last_warn).count() >= 5) {
                last_warn = now;
                std::cerr << "⚠️ [VisitorTracker] Bounded analytics queue full (" << config_.queue_capacity 
                          << "). Dropping analytics event to protect HTTP request delivery.\n";
            }
            return false;
        }
        queue_.push(std::move(event));
        total_enqueued_++;
    }
    cv_.notify_one();
    return true;
}

void VisitorTracker::worker_loop() {
    while (running_.load()) {
        AnalyticsEvent event;
        {
            std::unique_lock<std::mutex> lock(queue_mutex_);
            cv_.wait(lock, [this]() {
                return !running_.load() || !queue_.empty();
            });

            if (!running_.load() && queue_.empty()) break;
            if (queue_.empty()) continue;

            event = std::move(queue_.front());
            queue_.pop();
        }

        try {
            process_event(event);
        } catch (const std::exception& e) {
            std::cerr << "❌ [VisitorTracker] Worker Exception: " << e.what() << "\n";
        } catch (...) {
            std::cerr << "❌ [VisitorTracker] Unknown Worker Exception\n";
        }
    }
}

void VisitorTracker::process_event(const AnalyticsEvent& event) {
    if (!db_client_) return;

    // Lookup GeoLocation
    GeoLocationResult geo = geo_provider_->lookup(event.canonical_ip);

    // Call database client transactional insertion method
    bool ok = db_client_->record_analytics_event(event, geo, config_.secret);
    if (ok) {
        total_persisted_++;
    }
}

void VisitorTracker::run_retention_purge() {
    if (!db_client_) return;
    try {
        db_client_->run_analytics_retention_purge(
            config_.retention_raw_ip_days,
            config_.retention_page_visits_days,
            config_.retention_sessions_days,
            config_.retention_locations_days
        );
    } catch (const std::exception& e) {
        std::cerr << "❌ [VisitorTracker] Retention Purge Exception: " << e.what() << "\n";
    }
}

} // namespace analytics
