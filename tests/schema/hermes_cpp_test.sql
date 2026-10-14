-- Test schema (structure only, no rows). See docs/TIMESTAMP_CONVENTIONS.md and
-- docs/RELEASE_INVARIANTS.md. Triggers are created by ensure_test_schema(), not here.

SET FOREIGN_KEY_CHECKS=0;

-- triggers, so relying on the schema to supply one made those tests pass only where an
-- earlier session had created it by hand.
--
-- Pure DDL otherwise: the FOREIGN_KEY_CHECKS pair are plain constants, not session
-- variables, and there are no DEFINER clauses (a restricted account cannot create one).

CREATE TABLE `cpp_trade_reports` (
  `id` varchar(64) NOT NULL,
  `tradeUuid` varchar(64) NOT NULL,
  `instrument` varchar(64) NOT NULL,
  `side` enum('BUY','SELL') NOT NULL,
  `quantity` int NOT NULL,
  `entryPrice` decimal(10,2) NOT NULL,
  `exitPrice` decimal(10,2) DEFAULT NULL,
  `grossPnl` decimal(12,2) DEFAULT '0.00',
  `cost` decimal(10,2) DEFAULT '0.00',
  `netPnl` decimal(12,2) DEFAULT '0.00',
  `status` varchar(32) NOT NULL DEFAULT 'OPEN',
  `orderedAt` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `signal_timestamp` datetime(6) NOT NULL,
  `algoSource` varchar(64) DEFAULT 'CppEngineV1',
  `executionMode` varchar(32) DEFAULT 'PAPER',
  `spread_id` varchar(64) DEFAULT NULL,
  `leg_role` enum('SINGLE','SHORT_PRIMARY','LONG_PROTECTIVE') NOT NULL DEFAULT 'SINGLE',
  `closedAt` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `tradeUuid` (`tradeUuid`),
  UNIQUE KEY `idx_signal_idempotency` (`executionMode`,`algoSource`,`instrument`(32),`side`,`signal_timestamp`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `cpp_portfolios` (
  `id` varchar(64) NOT NULL,
  `label` varchar(64) NOT NULL,
  `capital` decimal(12,2) NOT NULL DEFAULT '100000.00',
  `ceiling` decimal(12,2) NOT NULL DEFAULT '100000.00',
  `deployed` decimal(12,2) NOT NULL DEFAULT '0.00',
  `netPnl` decimal(12,2) NOT NULL DEFAULT '0.00',
  `autoTradeEnabled` tinyint(1) DEFAULT '1',
  `executionMode` varchar(32) DEFAULT 'PAPER',
  `createdAt` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `label` (`label`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `cpp_post_session_analysis` (
  `id` varchar(64) NOT NULL,
  `session_date` date NOT NULL,
  `session_phase` varchar(32) NOT NULL,
  `total_ticks_ingested` bigint NOT NULL,
  `evaluated_decisions_count` bigint NOT NULL,
  `no_action_count` bigint NOT NULL,
  `actionable_signals_count` bigint NOT NULL,
  `risk_vetoes_count` bigint NOT NULL,
  `trades_executed_count` int NOT NULL,
  `realized_drawdown_inr` decimal(14,2) NOT NULL,
  `avg_ofi` decimal(10,4) NOT NULL DEFAULT '0.0000',
  `max_ofi` decimal(10,4) NOT NULL DEFAULT '0.0000',
  `near_miss_count` int NOT NULL DEFAULT '0',
  `recommendations_json` text,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_session_date` (`session_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `cpp_strategy_config` (
  `config_key` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `config_value` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `description` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `updated_by` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT 'SYSTEM',
  PRIMARY KEY (`config_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `cpp_strategy_config_audit` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `config_key` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `old_value` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `new_value` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `approved_by` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `reason` text COLLATE utf8mb4_unicode_ci,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=146 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `hermes_cpp_decision_journal` (
  `journal_id` bigint NOT NULL AUTO_INCREMENT,
  `decision_uuid` varchar(64) NOT NULL,
  `session_id` varchar(64) NOT NULL,
  `git_commit_sha` varchar(40) NOT NULL,
  `engine_version` varchar(32) NOT NULL,
  `symbol` varchar(32) NOT NULL,
  `action` varchar(16) NOT NULL,
  `confidence` double NOT NULL,
  `allocated_margin` double NOT NULL,
  `reason` text NOT NULL,
  `feature_snapshot_json` longtext NOT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`journal_id`),
  UNIQUE KEY `decision_uuid` (`decision_uuid`),
  KEY `idx_session` (`session_id`),
  KEY `idx_symbol` (`symbol`),
  KEY `idx_created` (`created_at`)
) ENGINE=InnoDB AUTO_INCREMENT=1179905 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `fnf_market_snapshots` (
  `id` varchar(36) NOT NULL,
  `instrument` varchar(64) NOT NULL,
  `price` decimal(14,4) NOT NULL,
  `volume` decimal(14,2) NOT NULL DEFAULT '0.00',
  `open` decimal(14,4) DEFAULT NULL,
  `high` decimal(14,4) DEFAULT NULL,
  `low` decimal(14,4) DEFAULT NULL,
  `close` decimal(14,4) DEFAULT NULL,
  `ts` datetime NOT NULL,
  `source` varchar(16) DEFAULT NULL,
  `createdAt` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  KEY `IDX_ec63068f0abd87fa861f7489d2` (`instrument`,`ts`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `fnf_market_snapshots_history` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `instrument` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `price` decimal(14,4) NOT NULL,
  `volume` decimal(14,2) NOT NULL DEFAULT '0.00',
  `open` decimal(14,4) DEFAULT NULL,
  `high` decimal(14,4) DEFAULT NULL,
  `low` decimal(14,4) DEFAULT NULL,
  `close` decimal(14,4) DEFAULT NULL,
  `ts` datetime NOT NULL,
  `source` varchar(16) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `archivedAt` datetime NOT NULL,
  `createdAt` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  KEY `IDX_519b7ba256f0822de9fbd4381b` (`instrument`,`ts`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `upstox_live_paper_option_quotes` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `contractSymbol` varchar(96) COLLATE utf8mb4_unicode_ci NOT NULL,
  `underlying` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL,
  `expiry` date NOT NULL,
  `strike` decimal(14,4) NOT NULL,
  `optionType` varchar(2) COLLATE utf8mb4_unicode_ci NOT NULL,
  `ltp` decimal(14,4) NOT NULL,
  `bid` decimal(14,4) DEFAULT NULL,
  `ask` decimal(14,4) DEFAULT NULL,
  `bidQty` int DEFAULT NULL,
  `askQty` int DEFAULT NULL,
  `volume` bigint DEFAULT NULL,
  `openInterest` bigint DEFAULT NULL,
  `oiChange` bigint DEFAULT NULL,
  `impliedVolatility` decimal(10,6) DEFAULT NULL,
  `delta` decimal(10,6) DEFAULT NULL,
  `gamma` decimal(10,6) DEFAULT NULL,
  `theta` decimal(10,6) DEFAULT NULL,
  `vega` decimal(10,6) DEFAULT NULL,
  `underlyingPrice` decimal(14,4) DEFAULT NULL,
  `bidDepth` bigint DEFAULT NULL,
  `askDepth` bigint DEFAULT NULL,
  `ts` datetime NOT NULL,
  `dataSource` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'UPSTOX',
  `executionMode` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'PAPER',
  `instrumentToken` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `createdAt` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `providerTs` datetime DEFAULT NULL,
  `prevOi` bigint DEFAULT NULL,
  `payloadHash` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_ulpoq_broker_ts` (`dataSource`,`ts`),
  KEY `idx_ulpoq_chain_ts` (`underlying`,`expiry`,`optionType`,`ts`),
  KEY `idx_ulpoq_contract_ts` (`contractSymbol`,`ts`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `project_checklist_items` (
  `id` int NOT NULL AUTO_INCREMENT,
  `grp` varchar(160) NOT NULL,
  `grp_order` int NOT NULL,
  `goal` varchar(300) NOT NULL DEFAULT '',
  `item_order` int NOT NULL,
  `item` varchar(600) NOT NULL,
  `status` varchar(16) NOT NULL DEFAULT 'pending',
  `note` varchar(500) NOT NULL DEFAULT '',
  `createdAt` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updatedAt` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `instr` text,
  `doneWhen` text,
  `edition` varchar(8) NOT NULL DEFAULT 'v4',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=921 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `portal_users` (
  `id` varchar(36) NOT NULL,
  `email` varchar(190) NOT NULL,
  `name` varchar(120) NOT NULL,
  `role` varchar(24) NOT NULL DEFAULT 'operator',
  `passwordEnc` text,
  `profileEnc` text,
  `credentialsEnc` text,
  `createdAt` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updatedAt` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `IDX_097304fca6aaf020c7c75b0857` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `analytics_visitors` (
  `id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `active_lookup_hash` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `ip_address` varchar(45) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `ip_version` enum('IPv4','IPv6') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'IPv4',
  `identity_generation` int unsigned NOT NULL DEFAULT '1',
  `is_redacted` tinyint(1) NOT NULL DEFAULT '0',
  `first_seen_at` datetime NOT NULL,
  `last_seen_at` datetime NOT NULL,
  `total_visits` int unsigned NOT NULL DEFAULT '1',
  `total_page_views` int unsigned NOT NULL DEFAULT '1',
  `first_user_agent` varchar(512) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `latest_user_agent` varchar(512) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `browser_name` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `browser_version` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `operating_system` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `os_version` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `device_type` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `device_family` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `referrer_first` varchar(512) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `referrer_latest` varchar(512) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `is_bot` tinyint(1) NOT NULL DEFAULT '0',
  `bot_name` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `identity_confidence` enum('HIGH','MEDIUM','LOW') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'MEDIUM',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_active_lookup_hash` (`active_lookup_hash`),
  KEY `idx_visitors_lookup` (`active_lookup_hash`,`is_redacted`),
  KEY `idx_visitors_ip` (`ip_address`),
  KEY `idx_visitors_last_seen` (`last_seen_at`),
  KEY `idx_visitors_is_bot` (`is_bot`),
  KEY `idx_visitors_is_redacted` (`is_redacted`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `analytics_devices` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `visitor_id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `device_signature` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `device_type` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL,
  `device_family` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `operating_system` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `operating_system_version` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `browser` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `browser_version` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `user_agent` varchar(512) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `language` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `accepted_languages` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `first_seen_at` datetime NOT NULL,
  `last_seen_at` datetime NOT NULL,
  `seen_count` int unsigned NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_visitor_device_sig` (`visitor_id`,`device_signature`),
  KEY `idx_dev_visitor` (`visitor_id`),
  KEY `idx_dev_browser` (`browser`),
  KEY `idx_dev_os` (`operating_system`),
  KEY `idx_dev_type` (`device_type`),
  CONSTRAINT `fk_dev_visitor` FOREIGN KEY (`visitor_id`) REFERENCES `analytics_visitors` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=27645 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `analytics_sessions` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `visitor_id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `session_key` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `is_active` tinyint(1) DEFAULT '1',
  `first_seen_at` datetime NOT NULL,
  `last_seen_at` datetime NOT NULL,
  `page_count` int unsigned NOT NULL DEFAULT '1',
  `duration_seconds` int unsigned NOT NULL DEFAULT '0',
  `entry_page` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `exit_page` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `referrer` varchar(512) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `device_id` bigint DEFAULT NULL,
  `location_id` bigint DEFAULT NULL,
  `is_bot` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `session_key` (`session_key`),
  UNIQUE KEY `uq_visitor_active_session` (`visitor_id`,`is_active`),
  KEY `idx_sess_visitor` (`visitor_id`),
  KEY `idx_sess_key` (`session_key`),
  KEY `idx_sess_last_seen` (`last_seen_at`),
  KEY `idx_sess_device` (`device_id`),
  KEY `idx_sess_location` (`location_id`),
  CONSTRAINT `fk_sess_device` FOREIGN KEY (`device_id`) REFERENCES `analytics_devices` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_sess_location` FOREIGN KEY (`location_id`) REFERENCES `analytics_locations` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_sess_visitor` FOREIGN KEY (`visitor_id`) REFERENCES `analytics_visitors` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=87 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `analytics_locations` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `visitor_id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `country` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT 'Unknown',
  `country_code` varchar(8) COLLATE utf8mb4_unicode_ci DEFAULT 'XX',
  `region` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT 'Unknown',
  `city` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT 'Unknown',
  `postal_code` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `latitude` double DEFAULT NULL,
  `longitude` double DEFAULT NULL,
  `timezone` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `continent` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `isp` varchar(128) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `asn` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `source` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT 'Local GeoIP Database (MaxMind)',
  `disclaimer` varchar(128) COLLATE utf8mb4_unicode_ci DEFAULT 'Approximate location derived from IP',
  `looked_up_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `visitor_id` (`visitor_id`),
  KEY `idx_loc_country` (`country`),
  KEY `idx_loc_city` (`city`),
  KEY `idx_loc_code` (`country_code`),
  CONSTRAINT `fk_loc_visitor` FOREIGN KEY (`visitor_id`) REFERENCES `analytics_visitors` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=27645 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `analytics_page_visits` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `visitor_id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `session_id` bigint NOT NULL,
  `request_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `page_url` varchar(1024) COLLATE utf8mb4_unicode_ci NOT NULL,
  `path` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `query_string` varchar(512) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `page_title` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `referrer_url` varchar(512) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `http_method` varchar(10) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'GET',
  `status_code` int NOT NULL DEFAULT '200',
  `visited_at` datetime NOT NULL,
  `response_time_ms` double NOT NULL DEFAULT '0',
  `user_agent` varchar(512) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `browser_name` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `os_name` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `device_type` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `is_bot` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  KEY `idx_pv_visitor` (`visitor_id`),
  KEY `idx_pv_session` (`session_id`),
  KEY `idx_pv_visited_at` (`visited_at`),
  KEY `idx_pv_path` (`path`),
  KEY `idx_pv_is_bot` (`is_bot`),
  CONSTRAINT `fk_pv_session` FOREIGN KEY (`session_id`) REFERENCES `analytics_sessions` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_pv_visitor` FOREIGN KEY (`visitor_id`) REFERENCES `analytics_visitors` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=27645 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `portal_user_sessions` (
  `session_token` varchar(128) NOT NULL,
  `user_id` varchar(36) NOT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `expires_at` datetime NOT NULL,
  PRIMARY KEY (`session_token`),
  KEY `idx_user_id` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

SET FOREIGN_KEY_CHECKS=1;
