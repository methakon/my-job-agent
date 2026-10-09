-- ============================================================================
-- Cookie-Less Privacy-Conscious Visitor Tracking & Analytics Schema (v8 Master)
-- ============================================================================

-- Table 1: analytics_visitors (Estimated Client Identity & Sensitive Raw IP Vault)
CREATE TABLE IF NOT EXISTS analytics_visitors (
    id VARCHAR(64) PRIMARY KEY,                  -- Opaque client identity ("cid_...")
    active_lookup_hash VARCHAR(64) NULL,         -- HMAC(SECRET, canonical_ip); NULL on redaction
    ip_address VARCHAR(45) NULL,                 -- Sensitive raw IP; set to NULL on redaction
    ip_version ENUM('IPv4', 'IPv6') NOT NULL DEFAULT 'IPv4',
    identity_generation INT UNSIGNED NOT NULL DEFAULT 1,
    is_redacted TINYINT(1) NOT NULL DEFAULT 0,
    first_seen_at DATETIME NOT NULL,
    last_seen_at DATETIME NOT NULL,
    total_visits INT UNSIGNED NOT NULL DEFAULT 1,     -- Incremented strictly on committed session
    total_page_views INT UNSIGNED NOT NULL DEFAULT 1, -- Incremented strictly on committed page visit
    first_user_agent VARCHAR(512),
    latest_user_agent VARCHAR(512),
    browser_name VARCHAR(64),
    browser_version VARCHAR(32),
    operating_system VARCHAR(64),
    os_version VARCHAR(32),
    device_type VARCHAR(32),
    device_family VARCHAR(64),
    referrer_first VARCHAR(512),
    referrer_latest VARCHAR(512),
    is_bot TINYINT(1) NOT NULL DEFAULT 0,
    bot_name VARCHAR(64),
    identity_confidence ENUM('HIGH', 'MEDIUM', 'LOW') NOT NULL DEFAULT 'MEDIUM',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE INDEX uq_active_lookup_hash (active_lookup_hash),
    INDEX idx_visitors_lookup (active_lookup_hash, is_redacted),
    INDEX idx_visitors_ip (ip_address),
    INDEX idx_visitors_last_seen (last_seen_at),
    INDEX idx_visitors_is_bot (is_bot),
    INDEX idx_visitors_is_redacted (is_redacted)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table 2: analytics_devices (Observable HTTP Headers Deduplicated by Signature)
CREATE TABLE IF NOT EXISTS analytics_devices (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    visitor_id VARCHAR(64) NOT NULL,
    device_signature VARCHAR(64) NOT NULL,       -- SHA256(browser:os:type:lang)
    device_type VARCHAR(32) NOT NULL,
    device_family VARCHAR(64),
    operating_system VARCHAR(64),
    operating_system_version VARCHAR(32),
    browser VARCHAR(64),
    browser_version VARCHAR(32),
    user_agent VARCHAR(512),
    language VARCHAR(32),
    accepted_languages VARCHAR(255),
    first_seen_at DATETIME NOT NULL,
    last_seen_at DATETIME NOT NULL,
    seen_count INT UNSIGNED NOT NULL DEFAULT 1,
    UNIQUE INDEX uq_visitor_device_sig (visitor_id, device_signature),
    INDEX idx_dev_visitor (visitor_id),
    INDEX idx_dev_browser (browser),
    INDEX idx_dev_os (operating_system),
    INDEX idx_dev_type (device_type),
    CONSTRAINT fk_dev_visitor FOREIGN KEY (visitor_id) REFERENCES analytics_visitors(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table 3: analytics_locations (Approximate Location Derived From IP)
CREATE TABLE IF NOT EXISTS analytics_locations (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    visitor_id VARCHAR(64) NOT NULL UNIQUE,
    country VARCHAR(64) DEFAULT 'Unknown',
    country_code VARCHAR(8) DEFAULT 'XX',
    region VARCHAR(64) DEFAULT 'Unknown',
    city VARCHAR(64) DEFAULT 'Unknown',
    postal_code VARCHAR(32),
    latitude DOUBLE,
    longitude DOUBLE,
    timezone VARCHAR(64),
    continent VARCHAR(32),
    isp VARCHAR(128),
    asn VARCHAR(64),
    source VARCHAR(64) DEFAULT 'Local GeoIP Database (MaxMind)',
    disclaimer VARCHAR(128) DEFAULT 'Approximate location derived from IP',
    looked_up_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_loc_country (country),
    INDEX idx_loc_city (city),
    INDEX idx_loc_code (country_code),
    CONSTRAINT fk_loc_visitor FOREIGN KEY (visitor_id) REFERENCES analytics_visitors(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table 4: analytics_sessions (Server-Side 30-min Inactivity Window & Concurrency)
CREATE TABLE IF NOT EXISTS analytics_sessions (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    visitor_id VARCHAR(64) NOT NULL,
    session_key VARCHAR(64) NOT NULL UNIQUE,
    is_active TINYINT(1) NULL DEFAULT 1,         -- 1 when active, NULL when expired/closed
    first_seen_at DATETIME NOT NULL,
    last_seen_at DATETIME NOT NULL,
    page_count INT UNSIGNED NOT NULL DEFAULT 1,
    duration_seconds INT UNSIGNED NOT NULL DEFAULT 0,
    entry_page VARCHAR(255),
    exit_page VARCHAR(255),
    referrer VARCHAR(512),
    device_id BIGINT,
    location_id BIGINT,
    is_bot TINYINT(1) NOT NULL DEFAULT 0,
    UNIQUE INDEX uq_visitor_active_session (visitor_id, is_active),
    INDEX idx_sess_visitor (visitor_id),
    INDEX idx_sess_key (session_key),
    INDEX idx_sess_last_seen (last_seen_at),
    INDEX idx_sess_device (device_id),
    INDEX idx_sess_location (location_id),
    CONSTRAINT fk_sess_visitor FOREIGN KEY (visitor_id) REFERENCES analytics_visitors(id) ON DELETE CASCADE,
    CONSTRAINT fk_sess_device FOREIGN KEY (device_id) REFERENCES analytics_devices(id) ON DELETE SET NULL,
    CONSTRAINT fk_sess_location FOREIGN KEY (location_id) REFERENCES analytics_locations(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table 5: analytics_page_visits (Tracked HTML GET Requests)
CREATE TABLE IF NOT EXISTS analytics_page_visits (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    visitor_id VARCHAR(64) NOT NULL,
    session_id BIGINT NOT NULL,
    request_id VARCHAR(36) NOT NULL,
    page_url VARCHAR(1024) NOT NULL,
    path VARCHAR(255) NOT NULL,
    query_string VARCHAR(512),
    page_title VARCHAR(255),
    referrer_url VARCHAR(512),
    http_method VARCHAR(10) NOT NULL DEFAULT 'GET',
    status_code INT NOT NULL DEFAULT 200,
    visited_at DATETIME NOT NULL,
    response_time_ms DOUBLE NOT NULL DEFAULT 0.0,
    user_agent VARCHAR(512),
    browser_name VARCHAR(64),
    os_name VARCHAR(64),
    device_type VARCHAR(32),
    is_bot TINYINT(1) NOT NULL DEFAULT 0,
    INDEX idx_pv_visitor (visitor_id),
    INDEX idx_pv_session (session_id),
    INDEX idx_pv_visited_at (visited_at),
    INDEX idx_pv_path (path),
    INDEX idx_pv_is_bot (is_bot),
    CONSTRAINT fk_pv_visitor FOREIGN KEY (visitor_id) REFERENCES analytics_visitors(id) ON DELETE CASCADE,
    CONSTRAINT fk_pv_session FOREIGN KEY (session_id) REFERENCES analytics_sessions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
