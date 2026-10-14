-- Minimal, version-controlled schema for database-backed tests.
--
-- Structure only: no rows, no production data. Nine tables, which is exactly what the
-- suite touches - the six ensure_test_schema() derives its _test copies from, plus the
-- three the fixtures write to directly. Loaded into a disposable CI MySQL service.
--
-- Not a substitute for the real schema: the CI database is synthetic by design.

-- MySQL dump 10.13  Distrib 8.0.46, for Linux (x86_64)
--
-- ------------------------------------------------------

/*!50503 SET NAMES utf8mb4 */;
SET @MYSQLDUMP_TEMP_LOG_BIN = @@SESSION.SQL_LOG_BIN;
SET @@SESSION.SQL_LOG_BIN= 0;

--
-- GTID state at the beginning of the backup 
--

SET @@GLOBAL.GTID_PURGED=/*!80000 '+'*/ 'c554a174-a77b-11f1-a3cc-02001700ef1b:1-20110851';

--
-- Table structure for table `cpp_trade_reports`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
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
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `cpp_portfolios`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
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
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `cpp_post_session_analysis`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
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
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `cpp_strategy_config`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `cpp_strategy_config` (
  `config_key` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `config_value` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `description` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `updated_by` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT 'SYSTEM',
  PRIMARY KEY (`config_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `cpp_strategy_config_audit`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
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
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `hermes_cpp_decision_journal`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
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
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `fnf_market_snapshots`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
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
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `fnf_market_snapshots_history`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
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
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `upstox_live_paper_option_quotes`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
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
/*!40101 SET character_set_client = @saved_cs_client */;
SET @@SESSION.SQL_LOG_BIN = @MYSQLDUMP_TEMP_LOG_BIN;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

-- Dump completed on 2026-10-15  2:31:13