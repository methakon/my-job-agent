-- ============================================================================
-- History tables for unified archival
-- Generated from TypeORM entity definitions + live table SHOW CREATE TABLE
--
-- DDL review gate: PASS (pre-fix). Execution requires BLOCKER-1 code fix
-- commit first (now committed as 76d34a8).
--
-- SAFETY:
--   - NO DROP, NO TRUNCATE, NO DELETE, NO ALTER of existing tables
--   - CREATE TABLE IF NOT EXISTS — idempotent, safe to re-run
--   - Separate from historical migration (2.49M-row backfill)
-- ============================================================================

-- ============================================================================
-- 1. unified_option_quotes_history
--    Schema: same as unified_option_quotes + archivedAt
-- ============================================================================
CREATE TABLE IF NOT EXISTS `unified_option_quotes_history` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `instrumentKey` varchar(96) COLLATE utf8mb4_unicode_ci NOT NULL,
  `underlying` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `exchange` varchar(16) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `segment` varchar(24) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `instrumentType` varchar(24) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `expiry` date DEFAULT NULL,
  `strike` decimal(14,4) DEFAULT NULL,
  `optionType` varchar(2) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `ltp` decimal(14,4) DEFAULT NULL,
  `bid` decimal(14,4) DEFAULT NULL,
  `ask` decimal(14,4) DEFAULT NULL,
  `bidQty` int DEFAULT NULL,
  `askQty` int DEFAULT NULL,
  `volume` decimal(18,2) DEFAULT NULL,
  `oi` decimal(18,2) DEFAULT NULL,
  `previousOi` decimal(18,2) DEFAULT NULL,
  `changeOi` decimal(18,2) DEFAULT NULL,
  `iv` decimal(10,4) DEFAULT NULL,
  `delta` decimal(10,6) DEFAULT NULL,
  `gamma` decimal(10,6) DEFAULT NULL,
  `theta` decimal(10,6) DEFAULT NULL,
  `vega` decimal(10,6) DEFAULT NULL,
  `depth` json DEFAULT NULL,
  `source` varchar(24) COLLATE utf8mb4_unicode_ci NOT NULL,
  `sourceTimestamp` datetime DEFAULT NULL,
  `receivedTimestamp` datetime NOT NULL,
  `sequenceNumber` int DEFAULT NULL,
  `dataQuality` varchar(12) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'GOOD',
  `ts` datetime NOT NULL,
  `createdAt` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `archivedAt` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_uoq_history_key_ts` (`instrumentKey`,`ts`),
  KEY `idx_uoq_history_chain` (`underlying`,`expiry`,`strike`),
  KEY `idx_uoq_history_received` (`receivedTimestamp`),
  KEY `idx_uoq_history_archived` (`archivedAt`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 2. unified_market_snapshots_history
--    Schema: same as unified_market_snapshots + archivedAt
-- ============================================================================
CREATE TABLE IF NOT EXISTS `unified_market_snapshots_history` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `symbol` varchar(96) COLLATE utf8mb4_unicode_ci NOT NULL,
  `underlying` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `exchange` varchar(16) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `ltp` decimal(14,4) DEFAULT NULL,
  `volume` decimal(18,2) DEFAULT NULL,
  `bid` decimal(14,4) DEFAULT NULL,
  `ask` decimal(14,4) DEFAULT NULL,
  `bidQty` int DEFAULT NULL,
  `askQty` int DEFAULT NULL,
  `open` decimal(14,4) DEFAULT NULL,
  `high` decimal(14,4) DEFAULT NULL,
  `low` decimal(14,4) DEFAULT NULL,
  `close` decimal(14,4) DEFAULT NULL,
  `depth` json DEFAULT NULL,
  `source` varchar(24) COLLATE utf8mb4_unicode_ci NOT NULL,
  `sourceTimestamp` datetime DEFAULT NULL,
  `receivedTimestamp` datetime NOT NULL,
  `sequenceNumber` int DEFAULT NULL,
  `dataQuality` varchar(12) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'GOOD',
  `ts` datetime NOT NULL,
  `createdAt` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `archivedAt` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_ums_history_symbol_ts` (`symbol`,`ts`),
  KEY `idx_ums_history_received` (`receivedTimestamp`),
  KEY `idx_ums_history_archived` (`archivedAt`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
