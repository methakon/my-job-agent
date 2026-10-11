#!/usr/bin/env python3
"""
test_historical_market_data_migrator.py
---------------------------------------
Comprehensive Unit and Offline Integration Test Suite for HistoricalMarketDataMigrator.

Covers (Item 8 Automated Verification):
1. Deduplication hash calculation:
   - Proves arrival timestamps (createdAt, receivedTimestamp) are excluded from the hash.
   - Proves intra-second price/depth/volume updates produce distinct hashes.
   - Proves cross-provider records never collide.
   - Proves NULL values do not collide with 0 or empty string.
2. Symbol normalization across FNF and Upstox symbologies.
3. Sentinel timestamp detection, tagging (SENTINEL_TS), and sourceRecordId linking.
4. Run-scoped provenance (migrationRunId and sourceRecordId).
5. Strict insertion duplicate filtering without INSERT IGNORE.
6. Strict SQL warning zero-tolerance assertion.
7. Row accounting invariant validation (scanned == inserted + dups).
8. Worker lease concurrency mutual exclusion and expired lease takeover.
9. Run-scoped rollback isolation.
"""

import unittest
from datetime import datetime, timedelta
from decimal import Decimal
import sys
import os
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.dirname(__file__))
from historical_market_data_migrator import (
    compute_canonical_dedup_hash,
    canonical_market_state_equals,
    normalize_contract_symbol,
    normalize_provider_venue,
    HistoricalMarketDataMigrator,
    StrictSqlWarningError,
    RowAccountingInvariantError,
    WorkerConcurrencyError,
    InvalidProviderProvenanceError
)

class TestMarketDataMigrator(unittest.TestCase):

    def test_dedup_hash_excludes_arrival_timestamps(self):
        """Identical market state must produce identical hash regardless of when it was inserted."""
        ts = datetime(2026, 9, 24, 14, 2, 51)
        source_ts = datetime(2026, 9, 24, 14, 2, 51)

        hash1 = compute_canonical_dedup_hash(
            source="UPSTOX", instrument_key="NSE:NIFTY26SEP24000CE", ts=ts, source_ts=source_ts,
            seq_num=101, ltp=154.50, bid=154.40, ask=154.60, bid_qty=500, ask_qty=450,
            volume=12000, oi=45000, change_oi=500, bid_depth=5, ask_depth=5,
            underlying_price=24850.25, payload_hash="payload_abc"
        )

        hash2 = compute_canonical_dedup_hash(
            source="UPSTOX", instrument_key="NSE:NIFTY26SEP24000CE", ts=ts, source_ts=source_ts,
            seq_num=101, ltp=154.50, bid=154.40, ask=154.60, bid_qty=500, ask_qty=450,
            volume=12000, oi=45000, change_oi=500, bid_depth=5, ask_depth=5,
            underlying_price=24850.25, payload_hash="payload_abc"
        )
        self.assertEqual(hash1, hash2, "Identical deliveries must produce identical hashes")

    def test_dedup_hash_differentiates_intra_second_updates(self):
        """Intra-second price updates with same timestamp must produce distinct hashes."""
        ts = datetime(2026, 9, 24, 14, 2, 51)
        source_ts = datetime(2026, 9, 24, 14, 2, 51)

        hash_tick1 = compute_canonical_dedup_hash(
            source="UPSTOX", instrument_key="NSE:NIFTY26SEP24000CE", ts=ts, source_ts=source_ts,
            seq_num=101, ltp=154.50, bid=154.40, ask=154.60, bid_qty=500, ask_qty=450,
            volume=12000, oi=45000, change_oi=500, bid_depth=5, ask_depth=5,
            underlying_price=24850.25, payload_hash="payload_1"
        )

        hash_tick2 = compute_canonical_dedup_hash(
            source="UPSTOX", instrument_key="NSE:NIFTY26SEP24000CE", ts=ts, source_ts=source_ts,
            seq_num=102, ltp=154.75, bid=154.60, ask=154.80, bid_qty=600, ask_qty=350,
            volume=12050, oi=45000, change_oi=500, bid_depth=5, ask_depth=5,
            underlying_price=24850.25, payload_hash="payload_2"
        )
        self.assertNotEqual(hash_tick1, hash_tick2, "Intra-second market state updates must NEVER be collapsed")

    def test_dedup_hash_cross_provider_isolation(self):
        """Same economic tick from different providers must produce distinct hashes."""
        ts = datetime(2026, 9, 24, 14, 2, 51)

        hash_upstox = compute_canonical_dedup_hash(
            source="UPSTOX", instrument_key="NSE:NIFTY26SEP24000CE", ts=ts, source_ts=ts,
            seq_num=None, ltp=154.50, bid=154.40, ask=154.60, bid_qty=500, ask_qty=450,
            volume=12000, oi=45000, change_oi=500, bid_depth=None, ask_depth=None,
            underlying_price=None, payload_hash=None
        )

        hash_fyers = compute_canonical_dedup_hash(
            source="fyers", instrument_key="NSE:NIFTY26SEP24000CE", ts=ts, source_ts=ts,
            seq_num=None, ltp=154.50, bid=154.40, ask=154.60, bid_qty=500, ask_qty=450,
            volume=12000, oi=45000, change_oi=500, bid_depth=None, ask_depth=None,
            underlying_price=None, payload_hash=None
        )
        self.assertNotEqual(hash_upstox, hash_fyers, "Cross-provider observations must remain distinct")

    def test_null_vs_zero_differentiation(self):
        """NULL value must not collide with 0 in hash calculation."""
        ts = datetime(2026, 9, 24, 14, 2, 51)

        hash_null_oi = compute_canonical_dedup_hash(
            source="fyers", instrument_key="NSE:NIFTY26SEP24000CE", ts=ts, source_ts=ts,
            seq_num=None, ltp=154.50, bid=154.40, ask=154.60, bid_qty=500, ask_qty=450,
            volume=12000, oi=None, change_oi=None, bid_depth=None, ask_depth=None,
            underlying_price=None, payload_hash=None
        )

        hash_zero_oi = compute_canonical_dedup_hash(
            source="fyers", instrument_key="NSE:NIFTY26SEP24000CE", ts=ts, source_ts=ts,
            seq_num=None, ltp=154.50, bid=154.40, ask=154.60, bid_qty=500, ask_qty=450,
            volume=12000, oi=0, change_oi=0, bid_depth=None, ask_depth=None,
            underlying_price=None, payload_hash=None
        )
        self.assertNotEqual(hash_null_oi, hash_zero_oi, "NULL oi must never collide with 0 oi")

    def test_contract_symbol_normalization(self):
        """Verify normalization of diverse broker contract symbols to canonical key."""
        self.assertEqual(
            normalize_contract_symbol("NSE:NIFTY26SEP24000CE", "NIFTY", "2026-09-26", 24000, "CE"),
            "NSE:NIFTY26SEP24000CE"
        )
        self.assertEqual(
            normalize_contract_symbol("NSE_FO|NIFTY26SEP24000CE", "NIFTY", "2026-09-26", 24000, "CE"),
            "NSE:NIFTY26SEP24000CE"
        )
        self.assertEqual(
            normalize_contract_symbol("NIFTY26SEP24000CE", "NIFTY", "2026-09-26", 24000, "CE"),
            "NSE:NIFTY26SEP24000CE"
        )

    def test_sentinel_preservation_and_provenance(self):
        """Verify 1980 sentinel records preserve dataQuality='SENTINEL_TS', true arrival time, and sourceRecordId."""
        migrator = HistoricalMarketDataMigrator(env={}, batch_size=100, run_id="run_test_123")
        sentinel_record = {
            "id": "fnf-uuid-9999",
            "contractSymbol": "NSE:NIFTY26SEP24000CE",
            "underlying": "NIFTY",
            "expiry": "2026-09-26",
            "strike": 24000,
            "optionType": "CE",
            "ltp": 120.0,
            "bid": 119.0,
            "ask": 121.0,
            "bidQty": 100,
            "askQty": 100,
            "volume": 0,
            "oi": 0,
            "changeOi": 0,
            "ts": datetime(1980, 1, 1, 0, 0),
            "createdAt": datetime(2026, 9, 20, 10, 0, 0)
        }
        mapped = migrator._map_record("fnf_option_quotes_history", sentinel_record, is_sentinel=True)
        self.assertEqual(mapped["dataQuality"], "SENTINEL_TS")
        self.assertEqual(mapped["sourceOrigin"], "MIGRATED_FNF")
        self.assertEqual(mapped["ts"], datetime(1980, 1, 1, 0, 0))
        self.assertEqual(mapped["sourceTimestamp"], datetime(2026, 9, 20, 10, 0, 0))
        self.assertEqual(mapped["receivedTimestamp"], datetime(2026, 9, 20, 10, 0, 0))
        self.assertEqual(mapped["migrationRunId"], "run_test_123")
        self.assertEqual(mapped["sourceRecordId"], "fnf-uuid-9999")

    def test_two_tier_deduplication_against_existing_canonical_records(self):
        """
        Prove Two-Tier Deduplication against:
        1. Existing unhashed canonical observation (Tier 2 duplicate skip).
        2. Cross-provider observation (same ts, different broker) -> preserved & inserted.
        3. Intra-second market update (same ts, same broker, different price) -> preserved & inserted.
        4. Genuinely distinct quote -> preserved & inserted.
        5. Replayed batch (Tier 1 hash collision) -> 100% skipped, zero duplicates.
        """
        migrator = HistoricalMarketDataMigrator(env={}, batch_size=100, run_id="run_fixture_test")
        mock_conn = MagicMock()
        mock_cur = MagicMock()
        mock_conn.cursor.return_value.__enter__.return_value = mock_cur

        ts_event = datetime(2026, 9, 23, 11, 36, 54)

        # Existing unhashed canonical row in target table
        existing_native_canonical_row = {
            "instrumentKey": "NSE:NIFTY26SEP24000CE",
            "ts": ts_event,
            "source": "FYERS_LIVE",
            "ltp": Decimal("154.5000"),
            "bid": Decimal("154.4000"),
            "ask": Decimal("154.6000"),
            "volume": Decimal("12000.00"),
            "oi": Decimal("45000.00")
        }

        # Mock database returns:
        # 1. Tier 1 hash check: empty set (target has no matching hashes)
        # 2. Tier 2 unhashed lookup: returns the existing native canonical row
        # 3. SHOW WARNINGS: empty
        mock_cur.fetchall.side_effect = [
            [], # Tier 1 hash lookup
            [existing_native_canonical_row], # Tier 2 unhashed canonical match
            []  # SHOW WARNINGS
        ]
        mock_cur.rowcount = 3 # 3 rows inserted out of 4 candidates

        # 4 Candidates:
        # C1: Equivalent incoming observation from FNF -> MUST BE DETECTED AND SKIPPED
        cand_equiv = {
            "canonicalDedupHash": "hash_equiv_fnf",
            "instrumentKey": "NSE:NIFTY26SEP24000CE",
            "ts": ts_event,
            "source": "fyers",
            "ltp": 154.50, "bid": 154.40, "ask": 154.60, "volume": 12000, "oi": 45000
        }
        # C2: Cross-provider observation from UPSTOX -> MUST BE PRESERVED & INSERTED
        cand_crossprovider = {
            "canonicalDedupHash": "hash_crossprovider",
            "instrumentKey": "NSE:NIFTY26SEP24000CE",
            "ts": ts_event,
            "source": "UPSTOX",
            "ltp": 154.50, "bid": 154.40, "ask": 154.60, "volume": 12000, "oi": 45000
        }
        # C3: Intra-second price update from FYERS -> MUST BE PRESERVED & INSERTED
        cand_intrasecond = {
            "canonicalDedupHash": "hash_intrasecond",
            "instrumentKey": "NSE:NIFTY26SEP24000CE",
            "ts": ts_event,
            "source": "fyers",
            "ltp": 154.75, "bid": 154.60, "ask": 154.80, "volume": 12050, "oi": 45000
        }
        # C4: Distinct quote (different strike/ts) -> MUST BE PRESERVED & INSERTED
        cand_distinct = {
            "canonicalDedupHash": "hash_distinct",
            "instrumentKey": "NSE:NIFTY26SEP24500CE",
            "ts": ts_event,
            "source": "fyers",
            "ltp": 80.00, "bid": 79.50, "ask": 80.50, "volume": 5000, "oi": 20000
        }

        candidates = [cand_equiv, cand_crossprovider, cand_intrasecond, cand_distinct]
        inserted, duplicates = migrator._insert_target_batch_strictly(mock_conn, candidates)

        self.assertEqual(inserted, 3, "Exactly 3 distinct market observations must be inserted")
        self.assertEqual(duplicates, 1, "Exactly 1 duplicate of existing canonical row must be skipped")
        self.assertEqual(len(candidates), inserted + duplicates, "Row accounting invariant must hold")

        # Now test RERUN IDEMPOTENCY:
        # On rerun, all previously inserted hashes exist in Tier 1 hash lookup!
        mock_cur.fetchall.side_effect = [
            [{"canonicalDedupHash": "hash_crossprovider"}, {"canonicalDedupHash": "hash_intrasecond"}, {"canonicalDedupHash": "hash_distinct"}], # Tier 1 match
            [existing_native_canonical_row], # Tier 2 match
        ]
        inserted_rerun, duplicates_rerun = migrator._insert_target_batch_strictly(mock_conn, candidates)
        self.assertEqual(inserted_rerun, 0, "Rerun must insert ZERO duplicates")
        self.assertEqual(duplicates_rerun, 4, "Rerun must classify ALL 4 rows as duplicates")

    def test_strict_warning_zero_tolerance(self):
        """Verify that unexpected database warnings immediately raise StrictSqlWarningError."""
        migrator = HistoricalMarketDataMigrator(env={}, batch_size=100)
        mock_conn = MagicMock()
        mock_cur = MagicMock()
        mock_conn.cursor.return_value.__enter__.return_value = mock_cur

        mock_cur.fetchall.side_effect = [
            [], # no target dups
            [{"Level": "Warning", "Code": 1265, "Message": "Data truncated for column 'underlyingPrice'"}] # Warning!
        ]
        mock_cur.rowcount = 1

        records = [{"canonicalDedupHash": "hash_x", "id": "1"}]
        with self.assertRaises(StrictSqlWarningError):
            migrator._insert_target_batch_strictly(mock_conn, records)

    def test_row_accounting_invariant_violation(self):
        """Verify RowAccountingInvariantError is raised if rowcount does not match expectation."""
        migrator = HistoricalMarketDataMigrator(env={}, batch_size=100)
        mock_conn = MagicMock()
        mock_cur = MagicMock()
        mock_conn.cursor.return_value.__enter__.return_value = mock_cur

        mock_cur.fetchall.side_effect = [
            [], # no target dups
            []  # clean warnings
        ]
        mock_cur.rowcount = 0 # Discrepancy! Sent 1, inserted 0 without duplicates

        records = [{"canonicalDedupHash": "hash_x", "id": "1"}]
        with self.assertRaises(RowAccountingInvariantError):
            migrator._insert_target_batch_strictly(mock_conn, records)

    def test_worker_concurrency_lease_collision(self):
        """Verify WorkerConcurrencyError is raised when another worker holds active lease."""
        migrator = HistoricalMarketDataMigrator(env={}, batch_size=100)
        mock_conn = MagicMock()
        mock_cur = MagicMock()
        mock_conn.cursor.return_value.__enter__.return_value = mock_cur

        mock_cur.rowcount = 0 # Lease acquisition failed
        mock_cur.fetchone.return_value = {
            "status": "RUNNING",
            "worker_uuid": "active-worker-abc",
            "worker_pid": 12345,
            "worker_host": "prod-vm-1",
            "heartbeat_ts": datetime.now()
        }

        with self.assertRaises(WorkerConcurrencyError):
            migrator._acquire_worker_lease(mock_conn, "upstox_live_paper_option_quotes")

    def test_run_scoped_quarantine_isolation_zero_deletion(self):
        """Verify rollback delegates to plan_run_recovery: quarantines run, ZERO DELETE executed."""
        migrator = HistoricalMarketDataMigrator(env={}, batch_size=100)
        mock_conn = MagicMock()
        mock_cur = MagicMock()
        mock_conn.cursor.return_value.__enter__.return_value = mock_cur
        migrator._get_connection = MagicMock(return_value=mock_conn)

        mock_cur.fetchall.return_value = [] # No newer runs (dependency check passes)
        mock_cur.fetchone.return_value = {"cnt": 500}

        res = migrator.rollback_run("run_20261011_010000_deadbeef", confirmed=True)
        self.assertEqual(res["status"], "SUCCESS")
        self.assertEqual(res["action"], "QUARANTINED")
        self.assertEqual(res["preserved_rows"], 500)
        self.assertEqual(res["deleted_rows"], 0, "STRICT ZERO DELETION: deleted_rows must be 0")

        # Verify NO DELETE query was EVER executed
        for call_args in mock_cur.execute.call_args_list:
            sql_statement = call_args[0][0].upper()
            self.assertNotIn("DELETE", sql_statement, "ABSOLUTE SAFETY: SQL DELETE must never be executed")
            self.assertNotIn("TRUNCATE", sql_statement, "ABSOLUTE SAFETY: SQL TRUNCATE must never be executed")
            self.assertNotIn("DROP", sql_statement, "ABSOLUTE SAFETY: SQL DROP must never be executed")

        # Verify UPDATE checkpoint was executed with QUARANTINED
        update_checkpoint_calls = [
            call for call in mock_cur.execute.call_args_list
            if "UPDATE cpp_historical_migration_checkpoints" in call[0][0]
        ]
        self.assertTrue(len(update_checkpoint_calls) > 0, "Checkpoint status must be updated")
        self.assertEqual(update_checkpoint_calls[0][0][1][0], "QUARANTINED")

    def test_assert_non_destructive_sql_interceptor(self):
        """Verify that assert_non_destructive_sql intercepts and blocks all destructive and modifying statements."""
        from historical_market_data_migrator import assert_non_destructive_sql, DestructiveQueryBlockedError

        destructive_queries = [
            # Standard destructive statements
            "DELETE FROM unified_option_quotes_history",
            "delete from fnf_option_quotes_history where id = 1",
            "TRUNCATE TABLE unified_option_quotes_history",
            "truncate table upstox_live_paper_option_quotes",
            "DROP TABLE unified_option_quotes_history",
            "drop table if exists temp_table",
            "DROP DATABASE myjob_agent",
            # Comment evasion variants
            "/* bypass comment */ DELETE FROM quotes",
            "-- comment line\nTRUNCATE TABLE quotes",
            "# mysql hash comment\nDELETE FROM unified_option_quotes_history",
            "SELECT 1; # comment\nDROP TABLE test",
            # Multi-statement injection variants
            "SELECT * FROM unified_option_quotes_history; DELETE FROM fnf_option_quotes_history;",
            "INSERT INTO dummy VALUES (1); TRUNCATE TABLE unified_option_quotes_history",
            # Implicit deletion via REPLACE INTO
            "REPLACE INTO unified_option_quotes_history (id) VALUES ('123')",
            # Stored procedure & prepared statement indirect execution
            "CALL purge_records_proc()",
            "PREPARE stmt FROM 'DELETE FROM quotes'",
            "EXECUTE stmt",
            # In-place overwriting of market quote history tables
            "UPDATE unified_option_quotes_history SET ltp = 100",
            "UPDATE `unified_option_quotes_history` SET ltp = 100",
            "UPDATE fnf_option_quotes_history SET ltp = 100",
            "UPDATE upstox_live_paper_option_quotes SET ltp = 100",
        ]

        for q in destructive_queries:
            with self.subTest(query=q):
                with self.assertRaises(DestructiveQueryBlockedError, msg=f"Should have blocked: {q}"):
                    assert_non_destructive_sql(q)

        # Non-destructive queries must pass cleanly
        non_destructive_queries = [
            "SELECT * FROM unified_option_quotes_history WHERE id = 'abc'",
            "INSERT INTO unified_option_quotes_history (id) VALUES ('123')",
            "UPDATE cpp_historical_migration_checkpoints SET status = 'QUARANTINED'",
            "UPDATE cpp_historical_migration_checkpoints SET last_processed_id = 'abc', rows_inserted = 10",
            "ALTER TABLE unified_option_quotes_history ADD COLUMN bidDepth INT NULL",
            "SHOW COLUMNS FROM unified_option_quotes_history",
            "SELECT id, is_deleted FROM contracts" # safe column containing word 'deleted'
        ]

        for q in non_destructive_queries:
            with self.subTest(query=q):
                try:
                    assert_non_destructive_sql(q)
                except DestructiveQueryBlockedError:
                    self.fail(f"Legitimate query incorrectly blocked: {q}")

    def test_safe_dict_cursor_blocks_destructive_sql(self):
        """Verify that SafeDictCursor intercepts destructive SQL and stored procedures at cursor level."""
        from historical_market_data_migrator import SafeDictCursor, DestructiveQueryBlockedError

        cursor = SafeDictCursor(MagicMock())
        with self.assertRaises(DestructiveQueryBlockedError):
            cursor.execute("DELETE FROM unified_option_quotes_history WHERE id = '123'")

        with self.assertRaises(DestructiveQueryBlockedError):
            cursor.executemany("TRUNCATE TABLE %s", [("test",)])

        with self.assertRaises(DestructiveQueryBlockedError):
            cursor.callproc("any_stored_procedure", [1, 2])

    def test_safe_connection_socket_level_interceptor(self):
        """Verify that SafeConnection intercepts destructive SQL at connection query level."""
        import pymysql.connections
        from historical_market_data_migrator import SafeConnection, DestructiveQueryBlockedError

        with patch.object(pymysql.connections.Connection, "query") as mock_super_query:
            conn = SafeConnection.__new__(SafeConnection)
            with self.assertRaises(DestructiveQueryBlockedError):
                conn.query("DELETE FROM unified_option_quotes_history WHERE id = 'xyz'")

            with self.assertRaises(DestructiveQueryBlockedError):
                conn.query(b"TRUNCATE TABLE unified_option_quotes_history")

            # Non-destructive query passes to super().query
            conn.query("SELECT 1 AS safe_test")
            mock_super_query.assert_called_once()

    def test_omitted_field_differences(self):
        """Verify that differences in optional/omitted fields (depth, underlyingPrice) are preserved."""
        from historical_market_data_migrator import canonical_market_state_equals
        c = {"ltp": 100.0, "bid": 99.0, "ask": 101.0, "bidDepth": None, "underlyingPrice": None}
        m_with_depth = {"ltp": 100.0, "bid": 99.0, "ask": 101.0, "bidDepth": 5, "underlyingPrice": 24000.0}
        m_without_depth = {"ltp": 100.0, "bid": 99.0, "ask": 101.0, "bidDepth": None, "underlyingPrice": None}

        self.assertFalse(canonical_market_state_equals(c, m_with_depth), "Candidate with NULL depth must not equal native row with depth 5")
        self.assertTrue(canonical_market_state_equals(c, m_without_depth), "Candidate with NULL depth matches native row with NULL depth")

    def test_canonical_market_state_equals_strict_semantics(self):
        """Verify strict NULL-vs-0, intra-second timestamp, and price precision differentiation."""
        from historical_market_data_migrator import canonical_market_state_equals

        base_state = {
            "ltp": 150.0, "bid": 149.0, "ask": 151.0, "bidQty": 100, "askQty": 100,
            "volume": 500.0, "oi": 1000.0, "changeOi": 50.0, "bidDepth": 3, "askDepth": 3,
            "underlyingPrice": 24000.0, "sourceTimestamp": datetime(2026, 9, 20, 10, 0, 0, 123456)
        }

        # 1. NULL vs Zero for bidDepth: bidDepth=0 must NOT equal bidDepth=None
        s_depth_zero = {**base_state, "bidDepth": 0}
        s_depth_null = {**base_state, "bidDepth": None}
        self.assertFalse(canonical_market_state_equals(s_depth_zero, s_depth_null), "bidDepth=0 must not match bidDepth=None")

        # 2. NULL vs Zero for quantity: bidQty=0 must NOT equal bidQty=None
        s_qty_zero = {**base_state, "bidQty": 0}
        s_qty_null = {**base_state, "bidQty": None}
        self.assertFalse(canonical_market_state_equals(s_qty_zero, s_qty_null), "bidQty=0 must not match bidQty=None")

        # 3. NULL vs Zero for price: ltp=0.0 must NOT equal ltp=None
        s_ltp_zero = {**base_state, "ltp": 0.0}
        s_ltp_null = {**base_state, "ltp": None}
        self.assertFalse(canonical_market_state_equals(s_ltp_zero, s_ltp_null), "ltp=0.0 must not match ltp=None")

        # 4. Intra-second timestamp differentiation: different microsecond in the same second
        s_micro_1 = {**base_state, "sourceTimestamp": datetime(2026, 9, 20, 10, 0, 0, 100000)}
        s_micro_2 = {**base_state, "sourceTimestamp": datetime(2026, 9, 20, 10, 0, 0, 200000)}
        self.assertFalse(canonical_market_state_equals(s_micro_1, s_micro_2), "Intra-second microsecond updates must be distinguished")

        # 5. Exact match
        s_identical = {**base_state}
        self.assertTrue(canonical_market_state_equals(base_state, s_identical), "Identical market state must evaluate equal")

    def test_concurrent_inserts_with_lower_uuids_pass2(self):
        """Verify that Pass 2 anti-join captures records with lower UUIDs inserted concurrently."""
        migrator = HistoricalMarketDataMigrator(env={}, batch_size=100)
        mock_conn = MagicMock()
        mock_cur = MagicMock()
        mock_conn.cursor.return_value.__enter__.return_value = mock_cur
        migrator._get_connection = MagicMock(return_value=mock_conn)
        migrator._acquire_worker_lease = MagicMock()
        migrator._release_worker_lease = MagicMock()
        migrator._record_baseline_metrics = MagicMock()
        migrator._check_system_health = MagicMock()

        # Checkpoint: last_id is high e.g. 'ffff'
        mock_cur.fetchone.side_effect = [
            {"last_processed_id": "ffff", "rows_scanned": 1000, "rows_inserted": 950, "rows_skipped_duplicate": 50, "rows_skipped_sentinel": 0},
            {"ist_midnight": datetime(2026, 10, 11, 0, 0)} # watermark
        ]

        # Pass 1 query returns [] (forward scan exhausted)
        # Pass 2 query returns 1 record with lower UUID '0001'
        concurrent_record = {
            "id": "0001-lower-uuid",
            "contractSymbol": "NSE:NIFTY26SEP24000CE",
            "ts": datetime(2026, 9, 20, 10, 0, 0),
            "ltp": 150.0, "bid": 149.0, "ask": 151.0, "bidQty": 100, "askQty": 100,
            "volume": 500, "openInterest": 1000, "oiChange": 0, "expiry": "2026-09-26",
            "strike": 24000, "optionType": "CE", "underlying": "NIFTY"
        }
        mock_cur.fetchall.side_effect = [
            [], # Pass 1 forward scan returns []
            [concurrent_record], # Pass 2 anti-join returns concurrent record!
            [], # SHOW WARNINGS in insert
            []  # Pass 2 subsequent check returns [] (exhausted)
        ]
        mock_cur.rowcount = 1
        migrator._insert_target_batch_strictly = MagicMock(return_value=(1, 0))

        # Run migration with limit 1
        migrator._migrate_single_source("upstox_live_paper_option_quotes", row_limit=1)
        migrator._insert_target_batch_strictly.assert_called_once()
        self.assertEqual(migrator._insert_target_batch_strictly.call_args[0][1][0]["sourceRecordId"], "0001-lower-uuid")

    def test_crash_resume_at_checkpoint_boundary(self):
        """Verify that resuming from checkpoint begins strictly at last_processed_id."""
        migrator = HistoricalMarketDataMigrator(env={}, batch_size=100)
        mock_conn = MagicMock()
        mock_cur = MagicMock()
        mock_conn.cursor.return_value.__enter__.return_value = mock_cur
        migrator._get_connection = MagicMock(return_value=mock_conn)
        migrator._acquire_worker_lease = MagicMock()
        migrator._release_worker_lease = MagicMock()
        migrator._record_baseline_metrics = MagicMock()
        migrator._check_system_health = MagicMock()

        last_committed_id = "abcd-boundary-uuid"
        mock_cur.fetchone.side_effect = [
            {"last_processed_id": last_committed_id, "rows_scanned": 5000, "rows_inserted": 4900, "rows_skipped_duplicate": 100, "rows_skipped_sentinel": 0},
            {"ist_midnight": datetime(2026, 10, 11, 0, 0)}
        ]
        mock_cur.fetchall.side_effect = [[], []] # empty to terminate immediately

        migrator._migrate_single_source("fnf_option_quotes_history")
        # Verify query used `id > last_committed_id`
        select_sql = mock_cur.execute.call_args_list[2][0][0]
        select_params = mock_cur.execute.call_args_list[2][0][1]
        self.assertIn("id > %s", select_sql)
        self.assertEqual(select_params[0], last_committed_id)

    def test_rollback_dependency_violation(self):
        """Verify that rolling back an earlier run with a dependent subsequent run is blocked."""
        migrator = HistoricalMarketDataMigrator(env={}, batch_size=100)
        mock_conn = MagicMock()
        mock_cur = MagicMock()
        mock_conn.cursor.return_value.__enter__.return_value = mock_cur
        migrator._get_connection = MagicMock(return_value=mock_conn)

        # Mock newer run exists
        mock_cur.fetchall.return_value = [
            {"migration_run_id": "run_2_subsequent", "started_at": datetime.now()}
        ]

        from historical_market_data_migrator import RollbackDependencyViolationError
        with self.assertRaises(RollbackDependencyViolationError):
            migrator.rollback_run("run_1_earlier", confirmed=True)

    def test_engine_permission_denied_simulation(self):
        """Verify that engine-level permission denial (Error 1142) safely aborts and releases lease as FAILED."""
        import pymysql.err
        migrator = HistoricalMarketDataMigrator(env={}, batch_size=100)
        mock_conn = MagicMock()
        mock_cur = MagicMock()
        mock_conn.cursor.return_value.__enter__.return_value = mock_cur
        migrator._get_connection = MagicMock(return_value=mock_conn)
        migrator._acquire_worker_lease = MagicMock()
        migrator._release_worker_lease = MagicMock()
        migrator._record_baseline_metrics = MagicMock()
        migrator._check_system_health = MagicMock()

        # Simulate checkpoint read succeeds, followed by dynamic watermark query
        mock_cur.fetchone.side_effect = [
            {
                "last_processed_id": "", "rows_scanned": 0, "rows_inserted": 0,
                "rows_skipped_duplicate": 0, "rows_skipped_sentinel": 0
            },
            {"ist_midnight": datetime(2026, 10, 11, 0, 0)}
        ]
        # Simulate batch query raises MySQL Error 1142 (Permission Denied)
        mock_cur.fetchall.side_effect = pymysql.err.OperationalError(1142, "INSERT command denied to user 'migrator_worker'@'%' for table 'unified_option_quotes_history'")

        with self.assertRaises(pymysql.err.OperationalError) as ctx:
            migrator._migrate_single_source("upstox_live_paper_option_quotes")

        self.assertIn("1142", str(ctx.exception))
        # Verify rollback was called and lease released as FAILED
        mock_conn.rollback.assert_called_once()
        migrator._release_worker_lease.assert_called_with(mock_conn, "upstox_live_paper_option_quotes", status="FAILED")

    def test_explicit_checkpoint_seeding_preserves_state(self):
        """Verify _ensure_checkpoint_seeded inserts strictly when absent and preserves existing state."""
        migrator = HistoricalMarketDataMigrator(env={}, batch_size=100)
        mock_cur = MagicMock()

        # Case 1: Checkpoint absent -> Executes strict INSERT INTO
        mock_cur.fetchone.return_value = None
        res_absent = migrator._ensure_checkpoint_seeded(mock_cur, "fnf_option_quotes_history")
        self.assertEqual(res_absent["status"], "IDLE")
        insert_calls = [c for c in mock_cur.execute.call_args_list if "INSERT INTO" in c[0][0]]
        self.assertEqual(len(insert_calls), 1)
        self.assertNotIn("IGNORE", insert_calls[0][0][0], "Zero INSERT IGNORE: must use strict INSERT INTO")

        # Case 2: Checkpoint already active/completed -> Zero writes, returns existing state untouched
        mock_cur.reset_mock()
        active_checkpoint = {
            "source_table": "fnf_option_quotes_history",
            "status": "RUNNING",
            "last_processed_id": "uuid-progress-boundary",
            "rows_scanned": 50000,
            "rows_inserted": 48500
        }
        mock_cur.fetchone.return_value = active_checkpoint
        res_existing = migrator._ensure_checkpoint_seeded(mock_cur, "fnf_option_quotes_history")
        self.assertEqual(res_existing["status"], "RUNNING")
        self.assertEqual(res_existing["last_processed_id"], "uuid-progress-boundary")
        # Assert NO INSERT INTO or UPDATE statement was executed!
        for c in mock_cur.execute.call_args_list:
            sql = c[0][0].strip().upper()
            self.assertFalse(sql.startswith("INSERT INTO"), "Must not execute INSERT INTO when checkpoint exists")
            self.assertFalse(sql.startswith("UPDATE"), "Must not execute UPDATE when checkpoint exists")

    def test_checkpoint_initialization_concurrency_race(self):
        """Verify that concurrent worker initialization collision (MySQL Error 1062) re-reads winning state safely."""
        import pymysql.err
        migrator = HistoricalMarketDataMigrator(env={}, batch_size=100)
        mock_cur = MagicMock()

        # Step 1: Worker observes None initially
        # Step 2: Worker attempts strict INSERT INTO, but competing worker just inserted, raising Error 1062
        # Step 3: Worker catches 1062 and issues SELECT query to re-read winning state
        winning_state = {
            "source_table": "fnf_option_quotes_history",
            "status": "RUNNING",
            "last_processed_id": "uuid-winner",
            "rows_scanned": 100,
            "rows_inserted": 95
        }
        mock_cur.fetchone.side_effect = [None, winning_state]

        def insert_side_effect(sql, *args, **kwargs):
            if "INSERT INTO" in sql:
                raise pymysql.err.IntegrityError(1062, "Duplicate entry 'fnf_option_quotes_history' for key 'PRIMARY'")
            return None

        mock_cur.execute.side_effect = insert_side_effect

        res = migrator._ensure_checkpoint_seeded(mock_cur, "fnf_option_quotes_history")

        self.assertEqual(res["status"], "RUNNING")
        self.assertEqual(res["last_processed_id"], "uuid-winner")
        self.assertEqual(res["rows_scanned"], 100)
        # Verify SELECT was called twice (initial check + recovery check after 1062)
        select_calls = [c for c in mock_cur.execute.call_args_list if "SELECT" in c[0][0]]
        self.assertEqual(len(select_calls), 2)

    def test_circuit_breaker_rising_connection_errors(self):
        """Verify circuit breaker trips when connection errors rise during migration."""
        from historical_market_data_migrator import CircuitBreakerError
        migrator = HistoricalMarketDataMigrator(env={}, batch_size=100)
        migrator.baseline_metrics = {
            "Connection_errors_max_connections": 10,
            "max_connections": 200
        }
        mock_conn = MagicMock()
        mock_cur = MagicMock()
        mock_conn.cursor.return_value.__enter__.return_value = mock_cur

        # Simulate Connection_errors_max_connections increasing from 10 to 11
        mock_cur.fetchall.return_value = [
            {"Variable_name": "Threads_connected", "Value": "15"},
            {"Variable_name": "Threads_running", "Value": "1"},
            {"Variable_name": "Connection_errors_max_connections", "Value": "11"},
            {"Variable_name": "Connection_errors_internal", "Value": "0"}
        ]

        with self.assertRaises(CircuitBreakerError) as ctx:
            migrator._check_system_health(mock_conn)
        self.assertIn("Rising connection errors detected", str(ctx.exception))

    def test_circuit_breaker_connection_headroom_exhaustion(self):
        """Verify circuit breaker trips when Threads_connected exceeds threshold or headroom < min_headroom."""
        from historical_market_data_migrator import CircuitBreakerError
        migrator = HistoricalMarketDataMigrator(env={}, batch_size=100, max_threads_connected=140, min_connection_headroom=50)
        migrator.baseline_metrics = {
            "Connection_errors_max_connections": 0,
            "max_connections": 200
        }
        mock_conn = MagicMock()
        mock_cur = MagicMock()
        mock_conn.cursor.return_value.__enter__.return_value = mock_cur

        # Case 1: Threads_connected = 155 (headroom 45 < 50)
        mock_cur.fetchall.return_value = [
            {"Variable_name": "Threads_connected", "Value": "155"},
            {"Variable_name": "Threads_running", "Value": "2"},
            {"Variable_name": "Connection_errors_max_connections", "Value": "0"},
            {"Variable_name": "Connection_errors_internal", "Value": "0"}
        ]

        with self.assertRaises(CircuitBreakerError) as ctx:
            migrator._check_system_health(mock_conn)
        self.assertIn("Connection capacity threshold reached", str(ctx.exception))

    def test_circuit_breaker_thread_pool_pressure(self):
        """Verify circuit breaker trips when Threads_running exceeds threshold (>= 6)."""
        from historical_market_data_migrator import CircuitBreakerError
        migrator = HistoricalMarketDataMigrator(env={}, batch_size=100)
        migrator.baseline_metrics = {
            "Connection_errors_max_connections": 0,
            "max_connections": 200
        }
        mock_conn = MagicMock()
        mock_cur = MagicMock()
        mock_conn.cursor.return_value.__enter__.return_value = mock_cur

        mock_cur.fetchall.return_value = [
            {"Variable_name": "Threads_connected", "Value": "20"},
            {"Variable_name": "Threads_running", "Value": "7"},
            {"Variable_name": "Connection_errors_max_connections", "Value": "0"},
            {"Variable_name": "Connection_errors_internal", "Value": "0"}
        ]

        with self.assertRaises(CircuitBreakerError) as ctx:
            migrator._check_system_health(mock_conn)
        self.assertIn("thread pool execution pressure high", str(ctx.exception))

    def test_circuit_breaker_tripped_sets_checkpoint_paused_safely(self):
        """Verify that a tripped circuit breaker releases worker lease as PAUSED without deleting or modifying services."""
        from historical_market_data_migrator import CircuitBreakerError
        migrator = HistoricalMarketDataMigrator(env={}, batch_size=100)
        mock_conn = MagicMock()
        mock_cur = MagicMock()
        mock_conn.cursor.return_value.__enter__.return_value = mock_cur
        migrator._get_connection = MagicMock(return_value=mock_conn)
        migrator._acquire_worker_lease = MagicMock()
        migrator._release_worker_lease = MagicMock()
        migrator._record_baseline_metrics = MagicMock()
        # Mock _check_system_health tripping
        migrator._check_system_health = MagicMock(side_effect=CircuitBreakerError("Simulated connection pressure"))

        mock_cur.fetchone.side_effect = [
            {"last_processed_id": "prev-id", "rows_scanned": 100, "rows_inserted": 95, "rows_skipped_duplicate": 5, "rows_skipped_sentinel": 0},
            {"ist_midnight": datetime(2026, 10, 11, 0, 0)}
        ]

        migrator._migrate_single_source("fnf_option_quotes_history")

        # Lease released as PAUSED cleanly
        migrator._release_worker_lease.assert_called_with(mock_conn, "fnf_option_quotes_history", status="PAUSED")

    def test_circuit_breaker_live_quote_buffer_backlog(self):
        """Verify circuit breaker trips when either live quote buffer exceeds 5,000 rows."""
        from historical_market_data_migrator import CircuitBreakerError
        migrator = HistoricalMarketDataMigrator(env={}, batch_size=100)
        migrator.baseline_metrics = {
            "Connection_errors_max_connections": 0,
            "max_connections": 200
        }
        mock_conn = MagicMock()
        mock_cur = MagicMock()
        mock_conn.cursor.return_value.__enter__.return_value = mock_cur

        # Healthy connection metrics
        mock_cur.fetchall.return_value = [
            {"Variable_name": "Threads_connected", "Value": "15"},
            {"Variable_name": "Threads_running", "Value": "1"},
            {"Variable_name": "Connection_errors_max_connections", "Value": "0"},
            {"Variable_name": "Connection_errors_internal", "Value": "0"}
        ]
        # First buffer fnf_option_quotes has 5,200 rows!
        mock_cur.fetchone.side_effect = [{"cnt": 5200}, {"cnt": 0}]

        with self.assertRaises(CircuitBreakerError) as ctx:
            migrator._check_system_health(mock_conn)
        self.assertIn("Live quote buffer backlog detected", str(ctx.exception))
        self.assertIn("fnf_option_quotes", str(ctx.exception))

    def test_circuit_breaker_fails_safely_on_monitoring_exception(self):
        """Verify monitoring failures and connection drops fail safely by raising CircuitBreakerError."""
        import pymysql.err
        from historical_market_data_migrator import CircuitBreakerError
        migrator = HistoricalMarketDataMigrator(env={}, batch_size=100)
        mock_conn = MagicMock()
        mock_cur = MagicMock()
        mock_conn.cursor.return_value.__enter__.return_value = mock_cur
        mock_cur.execute.side_effect = pymysql.err.OperationalError(2006, "MySQL server has gone away")

        with self.assertRaises(CircuitBreakerError) as ctx:
            migrator._check_system_health(mock_conn)
        self.assertIn("Health monitoring check failure", str(ctx.exception))

    def test_safe_resume_from_paused_checkpoint(self):
        """Verify resuming from a PAUSED checkpoint begins strictly at last_processed_id without rollback."""
        migrator = HistoricalMarketDataMigrator(env={}, batch_size=100)
        mock_conn = MagicMock()
        mock_cur = MagicMock()
        mock_conn.cursor.return_value.__enter__.return_value = mock_cur
        migrator._get_connection = MagicMock(return_value=mock_conn)
        migrator._acquire_worker_lease = MagicMock()
        migrator._release_worker_lease = MagicMock()
        migrator._record_baseline_metrics = MagicMock()
        migrator._check_system_health = MagicMock()

        paused_boundary_id = "uuid-paused-state-456"
        mock_cur.fetchone.side_effect = [
            {
                "last_processed_id": paused_boundary_id,
                "rows_scanned": 15000,
                "rows_inserted": 14200,
                "rows_skipped_duplicate": 800,
                "rows_skipped_sentinel": 0
            },
            {"ist_midnight": datetime(2026, 10, 11, 0, 0)}
        ]
        mock_cur.fetchall.side_effect = [[], []] # empty to terminate loop cleanly

        migrator._migrate_single_source("fnf_option_quotes_history")

        # Verify resumption query used `id > paused_boundary_id`
        select_sql = mock_cur.execute.call_args_list[2][0][0]
        select_params = mock_cur.execute.call_args_list[2][0][1]
        self.assertIn("id > %s", select_sql)
        self.assertEqual(select_params[0], paused_boundary_id)
        # Verify ZERO rollback was called
        mock_conn.rollback.assert_not_called()

    def test_database_identity_mismatch_fails_cleanly(self):
        """Verify that connecting to an incorrect database schema raises DatabaseIdentityMismatchError."""
        from historical_market_data_migrator import DatabaseIdentityMismatchError
        migrator = HistoricalMarketDataMigrator(env={"DATABASE_NAME": "myjob_agent"})
        mock_conn = MagicMock()
        mock_cur = MagicMock()
        mock_conn.cursor.return_value.__enter__.return_value = mock_cur
        mock_cur.fetchone.return_value = {"current_db": "wrong_database"}

        with patch("historical_market_data_migrator.get_connection", return_value=mock_conn):
            with self.assertRaises(DatabaseIdentityMismatchError):
                migrator._get_connection()
        mock_conn.close.assert_called_once()

    def test_checkpoint_durability_atomic_transaction(self):
        """Verify that failure between target insertion and checkpoint persistence triggers rollback of target rows."""
        import pymysql.err
        migrator = HistoricalMarketDataMigrator(env={}, batch_size=100)
        mock_conn = MagicMock()
        mock_cur = MagicMock()
        mock_conn.cursor.return_value.__enter__.return_value = mock_cur
        migrator._get_connection = MagicMock(return_value=mock_conn)
        migrator._acquire_worker_lease = MagicMock()
        migrator._release_worker_lease = MagicMock()
        migrator._record_baseline_metrics = MagicMock()
        migrator._check_system_health = MagicMock()

        sample_record = {
            "id": "uuid-1", "contractSymbol": "NSE:NIFTY26SEP24000CE",
            "ts": datetime(2026, 9, 20, 10, 0, 0), "ltp": 150.0, "bid": 149.0,
            "ask": 151.0, "bidQty": 100, "askQty": 100, "volume": 500,
            "oi": 1000, "changeOi": 0, "expiry": "2026-09-26",
            "strike": 24000, "optionType": "CE", "underlying": "NIFTY"
        }
        mock_cur.fetchone.side_effect = [
            {"last_processed_id": "", "rows_scanned": 0, "rows_inserted": 0, "rows_skipped_duplicate": 0, "rows_skipped_sentinel": 0},
            {"ist_midnight": datetime(2026, 10, 11, 0, 0)}
        ]
        mock_cur.fetchall.side_effect = [
            [sample_record], # Pass 1 batch query
            [], # SHOW WARNINGS
        ]
        migrator._insert_target_batch_strictly = MagicMock(return_value=(1, 0))

        # Simulate checkpoint UPDATE query raising an operational error
        def execute_side_effect(sql, *args, **kwargs):
            if "UPDATE cpp_historical_migration_checkpoints" in sql:
                raise pymysql.err.OperationalError(2013, "Lost connection to MySQL server during query")
            return None

        mock_cur.execute.side_effect = execute_side_effect

        with self.assertRaises(pymysql.err.OperationalError):
            migrator._migrate_single_source("fnf_option_quotes_history")

        # Verify rollback was called to ensure uncommitted target rows are rolled back atomically
        mock_conn.rollback.assert_called_once()
        mock_conn.commit.assert_not_called()

    def test_simulated_interruption_and_recovery_cycle(self):
        """
        Demonstrate recovery from a simulated interruption between batch processing,
        target insertion, and checkpoint persistence across a process restart.
        """
        import pymysql.err

        # Phase 1: Worker 1 crashes during Batch 2 checkpoint update
        migrator_1 = HistoricalMarketDataMigrator(env={}, batch_size=1)
        conn_1 = MagicMock()
        cur_1 = MagicMock()
        conn_1.cursor.return_value.__enter__.return_value = cur_1
        migrator_1._get_connection = MagicMock(return_value=conn_1)
        migrator_1._acquire_worker_lease = MagicMock()
        migrator_1._release_worker_lease = MagicMock()
        migrator_1._record_baseline_metrics = MagicMock()
        migrator_1._check_system_health = MagicMock()

        rec_batch1 = {
            "id": "uuid-001", "contractSymbol": "NSE:NIFTY26SEP24000CE",
            "ts": datetime(2026, 9, 20, 10, 0, 0), "ltp": 150.0, "bid": 149.0,
            "ask": 151.0, "bidQty": 100, "askQty": 100, "volume": 500,
            "oi": 1000, "changeOi": 0, "expiry": "2026-09-26",
            "strike": 24000, "optionType": "CE", "underlying": "NIFTY"
        }
        rec_batch2 = {
            "id": "uuid-002", "contractSymbol": "NSE:NIFTY26SEP24000CE",
            "ts": datetime(2026, 9, 20, 10, 0, 1), "ltp": 151.0, "bid": 150.0,
            "ask": 152.0, "bidQty": 100, "askQty": 100, "volume": 510,
            "oi": 1000, "changeOi": 0, "expiry": "2026-09-26",
            "strike": 24000, "optionType": "CE", "underlying": "NIFTY"
        }

        # Checkpoint initial state: empty
        cur_1.fetchone.side_effect = [
            {"last_processed_id": "", "rows_scanned": 0, "rows_inserted": 0, "rows_skipped_duplicate": 0, "rows_skipped_sentinel": 0},
            {"ist_midnight": datetime(2026, 10, 11, 0, 0)}
        ]
        # Query batches: batch 1, then batch 2
        cur_1.fetchall.side_effect = [
            [rec_batch1],
            [rec_batch2]
        ]
        migrator_1._insert_target_batch_strictly = MagicMock(side_effect=[(1, 0), (1, 0)])

        batch_count = [0]
        def execute_crash_side_effect(sql, *args, **kwargs):
            if "UPDATE cpp_historical_migration_checkpoints" in sql:
                batch_count[0] += 1
                if batch_count[0] == 2:
                    # Crash on second batch update
                    raise pymysql.err.OperationalError(2013, "Connection reset during commit")
            return None

        cur_1.execute.side_effect = execute_crash_side_effect

        cur_1.rowcount = 1
        # Worker 1 runs and crashes on batch 2
        with self.assertRaises(pymysql.err.OperationalError):
            migrator_1._migrate_single_source("fnf_option_quotes_history")

        # Verify worker 1 rolled back the incomplete batch 2 transaction
        conn_1.rollback.assert_called_once()
        # Verify worker 1 only successfully committed batch 1
        self.assertEqual(conn_1.commit.call_count, 1)

        # Phase 2: Worker 2 restarts after the crash
        # The persistent checkpoint retains batch 1 state ('uuid-001')
        migrator_2 = HistoricalMarketDataMigrator(env={}, batch_size=1)
        conn_2 = MagicMock()
        cur_2 = MagicMock()
        cur_2.rowcount = 1
        conn_2.cursor.return_value.__enter__.return_value = cur_2
        migrator_2._get_connection = MagicMock(return_value=conn_2)
        migrator_2._acquire_worker_lease = MagicMock()
        migrator_2._release_worker_lease = MagicMock()
        migrator_2._record_baseline_metrics = MagicMock()
        migrator_2._check_system_health = MagicMock()

        cur_2.fetchone.side_effect = [
            {"last_processed_id": "uuid-001", "rows_scanned": 1, "rows_inserted": 1, "rows_skipped_duplicate": 0, "rows_skipped_sentinel": 0},
            {"ist_midnight": datetime(2026, 10, 11, 0, 0)}
        ]
        # Resumed scan queries id > 'uuid-001', retrieving uuid-002 again, then empty (pass 1 done), then pass 2 empty
        cur_2.fetchall.side_effect = [
            [rec_batch2],
            [], # Pass 1 forward scan done
            []  # Pass 2 anti-join done
        ]
        migrator_2._insert_target_batch_strictly = MagicMock(return_value=(1, 0))

        migrator_2._migrate_single_source("fnf_option_quotes_history")

        # Verify that the resumed query specifically used `id > 'uuid-001'`
        scan_call = [c for c in cur_2.execute.call_args_list if "WHERE id > %s" in c[0][0]][0]
        self.assertEqual(scan_call[0][1][0], "uuid-001")

        # Verify that uuid-002 was cleanly inserted and committed by the resumed worker
        migrator_2._insert_target_batch_strictly.assert_called_once()
        self.assertEqual(migrator_2._insert_target_batch_strictly.call_args[0][1][0]["sourceRecordId"], "uuid-002")
        conn_2.commit.assert_called_once()

    def test_late_arrival_reconciliation_preserves_monotonic_watermark(self):
        """Verify Pass 2 late-arrival ingestion never regresses last_processed_id in checkpoint ledger."""
        migrator = HistoricalMarketDataMigrator(env={}, batch_size=100)
        mock_conn = MagicMock()
        mock_cur = MagicMock()
        mock_cur.rowcount = 1
        mock_conn.cursor.return_value.__enter__.return_value = mock_cur
        migrator._get_connection = MagicMock(return_value=mock_conn)
        migrator._acquire_worker_lease = MagicMock()
        migrator._release_worker_lease = MagicMock()
        migrator._record_baseline_metrics = MagicMock()
        migrator._check_system_health = MagicMock()

        # Checkpoint starts at 'ffff'
        mock_cur.fetchone.side_effect = [
            {"last_processed_id": "ffff", "rows_scanned": 1000, "rows_inserted": 950, "rows_skipped_duplicate": 50, "rows_skipped_sentinel": 0},
            {"ist_midnight": datetime(2026, 10, 11, 0, 0)}
        ]
        late_record_lower_uuid = {
            "id": "0001-lower-uuid", "contractSymbol": "NSE:NIFTY26SEP24000CE",
            "ts": datetime(2026, 9, 20, 10, 0, 0), "ltp": 150.0, "bid": 149.0,
            "ask": 151.0, "bidQty": 100, "askQty": 100, "volume": 500,
            "oi": 1000, "changeOi": 0, "expiry": "2026-09-26",
            "strike": 24000, "optionType": "CE", "underlying": "NIFTY"
        }
        mock_cur.fetchall.side_effect = [
            [], # Pass 1 forward scan returns [] (exhausted)
            [late_record_lower_uuid], # Pass 2 anti-join returns late record with lower uuid!
            [], # Pass 2 subsequent check returns [] (exhausted)
        ]
        migrator._insert_target_batch_strictly = MagicMock(return_value=(1, 0))

        migrator._migrate_single_source("fnf_option_quotes_history")

        # Find the checkpoint UPDATE query call
        update_calls = [c for c in mock_cur.execute.call_args_list if "UPDATE cpp_historical_migration_checkpoints" in c[0][0]]
        self.assertTrue(len(update_calls) > 0)
        checkpoint_updated_id = update_calls[0][0][1][0]
        # Verify that checkpoint_updated_id remained 'ffff' and did NOT regress to '0001-lower-uuid'!
        self.assertEqual(checkpoint_updated_id, "ffff", "Pass 2 must preserve forward watermark and not regress last_processed_id")

class TestCanonicalHashCompletenessAndAdversarialFields(unittest.TestCase):
    """
    Adversarial verification of Tier 1 SHA-256 hash and Tier 2 state equality:
    1. Single-field perturbations across every market state field.
    2. Strict NULL vs 0 distinguishability for all price, quantity, and metric fields.
    3. Microsecond timestamp precision (intra-second quote bursts).
    4. Provider isolation (FYERS vs UPSTOX).
    5. Tier 2 full canonical-state equality sensitivity.
    """

    def setUp(self):
        self.base_params = {
            "source": "fyers",
            "instrument_key": "NSE:NIFTY26SEP24000CE",
            "ts": datetime(2026, 9, 23, 9, 15, 0, 100000),
            "source_ts": datetime(2026, 9, 23, 9, 15, 0, 95000),
            "seq_num": 1001,
            "ltp": Decimal("154.5000"),
            "bid": Decimal("154.4000"),
            "ask": Decimal("154.6000"),
            "bid_qty": 75,
            "ask_qty": 150,
            "volume": Decimal("125000.00"),
            "oi": Decimal("450000.00"),
            "change_oi": Decimal("2500.00"),
            "bid_depth": 500,
            "ask_depth": 800,
            "underlying_price": Decimal("24850.2500"),
            "payload_hash": "a1b2c3d4e5f67890abcdef1234567890abcdef1234567890abcdef1234567890"
        }
        self.base_hash = compute_canonical_dedup_hash(**self.base_params)

    def test_single_field_perturbations_produce_distinct_hashes(self):
        """
        Prove that altering any of the 15 canonical market state fields produces a distinct cryptographic hash.
        (Tests the 14 other fields relative to self.base_params).
        """
        perturbations = {
            "source": "UPSTOX",
            "instrument_key": "NSE:NIFTY26SEP24050CE",
            "ts": datetime(2026, 9, 23, 9, 15, 0, 100001), # +1 microsecond
            "source_ts": datetime(2026, 9, 23, 9, 15, 0, 95001),
            "ltp": Decimal("154.5500"), # +0.05 tick
            "bid": Decimal("154.4500"),
            "ask": Decimal("154.6500"),
            "bid_qty": 76,
            "ask_qty": 151,
            "volume": Decimal("125001.00"),
            "oi": Decimal("450001.00"),
            "change_oi": Decimal("2501.00"),
            "bid_depth": 501,
            "ask_depth": 801,
            "underlying_price": Decimal("24850.3000")
        }

        for field_name, altered_value in perturbations.items():
            with self.subTest(field=field_name):
                modified_params = dict(self.base_params)
                modified_params[field_name] = altered_value
                altered_hash = compute_canonical_dedup_hash(**modified_params)
                self.assertNotEqual(
                    self.base_hash, altered_hash,
                    f"Altering single canonical market field '{field_name}' must produce a distinct SHA-256 hash."
                )

    def test_function_boundary_sequence_and_payload_invariance_in_canonical_mode(self):
        """
        Prove that in canonical_mode=True (default), sequenceNumber and raw payload_hash
        are strictly excluded at the function boundary, regardless of values supplied by callers.
        Also proves that legacy mode (canonical_mode=False) preserves optional wire-level differentiation.
        """
        # 1. seq_num variation with non-None values in default canonical mode
        for alt_seq in [None, 0, 1002, 999999]:
            with self.subTest(seq_num=alt_seq):
                h = compute_canonical_dedup_hash(**dict(self.base_params, seq_num=alt_seq))
                self.assertEqual(
                    self.base_hash, h,
                    f"seq_num={alt_seq} must be excluded at function boundary in canonical_mode=True"
                )

        # 2. payload_hash variation with arbitrary strings in default canonical mode
        for alt_phash in [None, "", "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", "hash_xyz"]:
            with self.subTest(payload_hash=alt_phash):
                h = compute_canonical_dedup_hash(**dict(self.base_params, payload_hash=alt_phash))
                self.assertEqual(
                    self.base_hash, h,
                    f"payload_hash={alt_phash} must be excluded at function boundary in canonical_mode=True"
                )

        # 3. Simultaneous variation of both seq_num and payload_hash in default canonical mode
        h_both = compute_canonical_dedup_hash(
            **dict(self.base_params, seq_num=88888, payload_hash="completely_different_hash")
        )
        self.assertEqual(
            self.base_hash, h_both,
            "Simultaneous non-canonical metadata changes must produce 100% identical hash in canonical mode"
        )

        # 4. Legacy mode demonstration: canonical_mode=False
        h_legacy_base = compute_canonical_dedup_hash(
            **self.base_params, canonical_mode=False, include_sequence_number=True, include_raw_payload_hash=True
        )
        h_legacy_alt_seq = compute_canonical_dedup_hash(
            **dict(self.base_params, seq_num=9999),
            canonical_mode=False, include_sequence_number=True, include_raw_payload_hash=True
        )
        self.assertNotEqual(
            h_legacy_base, h_legacy_alt_seq,
            "Legacy mode: sequence number inclusion must produce distinct hashes"
        )

        h_legacy_alt_phash = compute_canonical_dedup_hash(
            **dict(self.base_params, payload_hash="different_phash"),
            canonical_mode=False, include_sequence_number=True, include_raw_payload_hash=True
        )
        self.assertNotEqual(
            h_legacy_base, h_legacy_alt_phash,
            "Legacy mode: payload hash inclusion must produce distinct hashes"
        )

    def test_null_versus_zero_distinction_for_all_numeric_fields(self):
        """Prove that NULL and 0 are strictly distinguishable and never collide in hash generation for all 11 numeric market fields."""
        numeric_fields = [
            ("ltp", Decimal("0.0000")),
            ("bid", Decimal("0.0000")),
            ("ask", Decimal("0.0000")),
            ("bid_qty", 0),
            ("ask_qty", 0),
            ("volume", Decimal("0.00")),
            ("oi", Decimal("0.00")),
            ("change_oi", Decimal("0.00")),
            ("bid_depth", 0),
            ("ask_depth", 0),
            ("underlying_price", Decimal("0.0000"))
        ]

        for field_name, zero_val in numeric_fields:
            with self.subTest(field=field_name):
                params_zero = dict(self.base_params)
                params_zero[field_name] = zero_val
                hash_zero = compute_canonical_dedup_hash(**params_zero)

                params_null = dict(self.base_params)
                params_null[field_name] = None
                hash_null = compute_canonical_dedup_hash(**params_null)

                self.assertNotEqual(
                    hash_zero, hash_null,
                    f"Field '{field_name}' with value 0 must NOT collide with value NULL in SHA-256 hash."
                )

    def test_sub_second_timestamp_precision_prevents_false_collision(self):
        """Prove that intra-second quote updates with microsecond offsets produce distinct hashes."""
        ts_base = datetime(2026, 9, 23, 11, 30, 45, 0)
        ts_intra = datetime(2026, 9, 23, 11, 30, 45, 125000)

        params_base = dict(self.base_params, ts=ts_base)
        params_intra = dict(self.base_params, ts=ts_intra)

        hash_base = compute_canonical_dedup_hash(**params_base)
        hash_intra = compute_canonical_dedup_hash(**params_intra)

        self.assertNotEqual(hash_base, hash_intra, "Microsecond timestamp differences must yield distinct hashes")

    def test_provider_isolation_prevents_cross_broker_collision(self):
        """Prove that identical market observations from different providers yield distinct hashes."""
        params_fyers = dict(self.base_params, source="fyers")
        params_upstox = dict(self.base_params, source="UPSTOX")

        hash_fyers = compute_canonical_dedup_hash(**params_fyers)
        hash_upstox = compute_canonical_dedup_hash(**params_upstox)

        self.assertNotEqual(hash_fyers, hash_upstox, "Provider identity must isolate hashes across brokers")

    def test_tier2_canonical_market_state_equals_adversarial_sensitivity(self):
        """Prove that canonical_market_state_equals rejects records differing in any single market state field."""
        cand_base = {
            "ltp": 154.50, "bid": 154.40, "ask": 154.60, "underlyingPrice": 24850.25,
            "bidQty": 75, "askQty": 150, "bidDepth": 500, "askDepth": 800,
            "volume": 125000, "oi": 450000, "changeOi": 2500,
            "sourceTimestamp": datetime(2026, 9, 23, 9, 15, 0, 95000)
        }
        match_base = {
            "ltp": Decimal("154.5000"), "bid": Decimal("154.4000"), "ask": Decimal("154.6000"),
            "underlyingPrice": Decimal("24850.2500"), "bidQty": 75, "askQty": 150,
            "bidDepth": 500, "askDepth": 800, "volume": Decimal("125000.00"),
            "oi": Decimal("450000.00"), "changeOi": Decimal("2500.00"),
            "sourceTimestamp": datetime(2026, 9, 23, 9, 15, 0, 95000)
        }

        # Baseline equality holds
        self.assertTrue(canonical_market_state_equals(cand_base, match_base))

        single_field_diffs = {
            "ltp": 154.55,
            "bid": 154.45,
            "ask": 154.65,
            "underlyingPrice": 24850.30,
            "bidQty": 76,
            "askQty": 151,
            "bidDepth": 501,
            "askDepth": 801,
            "volume": 125001,
            "oi": 450001,
            "changeOi": 2501,
            "sourceTimestamp": datetime(2026, 9, 23, 9, 15, 0, 95001)
        }

        for field_name, altered_val in single_field_diffs.items():
            with self.subTest(field=field_name):
                modified_cand = dict(cand_base)
                modified_cand[field_name] = altered_val
                self.assertFalse(
                    canonical_market_state_equals(modified_cand, match_base),
                    f"canonical_market_state_equals must return False when '{field_name}' differs"
                )

    def test_tier2_null_versus_zero_sensitivity(self):
        """Prove that canonical_market_state_equals strictly rejects NULL vs 0 equivalence."""
        cand_base = {
            "ltp": 154.50, "bid": 154.40, "ask": 154.60, "underlyingPrice": 24850.25,
            "bidQty": 75, "askQty": 150, "bidDepth": 500, "askDepth": 800,
            "volume": 125000, "oi": 450000, "changeOi": 2500,
            "sourceTimestamp": datetime(2026, 9, 23, 9, 15, 0)
        }
        match_base = {
            "ltp": Decimal("154.5000"), "bid": Decimal("154.4000"), "ask": Decimal("154.6000"),
            "underlyingPrice": Decimal("24850.2500"), "bidQty": 75, "askQty": 150,
            "bidDepth": 500, "askDepth": 800, "volume": Decimal("125000.00"),
            "oi": Decimal("450000.00"), "changeOi": Decimal("2500.00"),
            "sourceTimestamp": datetime(2026, 9, 23, 9, 15, 0)
        }

        # Candidate has 0, Target has None/NULL
        for field in ["bidQty", "askQty", "bidDepth", "askDepth", "volume", "oi", "changeOi", "underlyingPrice"]:
            with self.subTest(field=field):
                c = dict(cand_base, **{field: 0})
                m = dict(match_base, **{field: None})
                self.assertFalse(
                    canonical_market_state_equals(c, m),
                    f"canonical_market_state_equals must NOT equate 0 with NULL for '{field}'"
                )

    def test_duplicate_retransmission_with_perturbed_non_market_metadata(self):
        """
        Prove that retransmitted duplicate packets differing ONLY in non-market ingestion metadata
        (id, receivedTimestamp, createdAt, archivedAt, migrationRunId, sourceRecordId, dataQuality, instrumentToken)
        produce 100% IDENTICAL canonical hashes, ensuring duplicate retransmissions are deduplicated.
        """
        migrator = HistoricalMarketDataMigrator(env={}, batch_size=100, run_id="run_test_meta_1")
        record_t1 = {
            "id": 1001,
            "contractSymbol": "NSE:NIFTY26SEP24000CE",
            "ts": datetime(2026, 9, 23, 9, 15, 0, 100000),
            "providerTs": datetime(2026, 9, 23, 9, 15, 0, 95000),
            "ltp": Decimal("154.5000"),
            "bid": Decimal("154.4000"),
            "ask": Decimal("154.6000"),
            "bidQty": 75,
            "askQty": 150,
            "volume": Decimal("125000.00"),
            "openInterest": Decimal("450000.00"),
            "oiChange": Decimal("2500.00"),
            "bidDepth": 500,
            "askDepth": 800,
            "underlyingPrice": Decimal("24850.2500"),
            "payloadHash": "abcdef123456",
            "instrumentToken": "UPSTOX_TOKEN_1111",
            "createdAt": datetime(2026, 9, 23, 9, 15, 0, 105000)
        }
        mapped_1 = migrator._map_record("upstox_live_paper_option_quotes", record_t1, is_sentinel=False)

        # Retransmitted packet 50ms later with different host ingestion metadata:
        migrator_run2 = HistoricalMarketDataMigrator(env={}, batch_size=100, run_id="run_test_meta_2")
        record_t2 = dict(record_t1, **{
            "id": 1002, # new source row ID
            "instrumentToken": "UPSTOX_TOKEN_9999", # arbitrary broker token change
            "createdAt": datetime(2026, 9, 23, 9, 15, 0, 155000) # arrived 50ms later
        })
        mapped_2 = migrator_run2._map_record("upstox_live_paper_option_quotes", record_t2, is_sentinel=False)

        self.assertNotEqual(mapped_1["id"], mapped_2["id"])
        self.assertNotEqual(mapped_1["migrationRunId"], mapped_2["migrationRunId"])
        self.assertNotEqual(mapped_1["sourceRecordId"], mapped_2["sourceRecordId"])
        self.assertNotEqual(mapped_1["instrumentToken"], mapped_2["instrumentToken"])

        # Market canonical hash MUST BE EXACTLY IDENTICAL
        self.assertEqual(
            mapped_1["canonicalDedupHash"], mapped_2["canonicalDedupHash"],
            "Duplicate retransmission differing only in non-market metadata must produce IDENTICAL hash"
        )

    def test_instrument_token_exclusion_cannot_merge_distinct_canonical_instruments(self):
        """
        Prove that excluding instrumentToken never allows distinct instruments to collide:
        Canonical identity is strictly anchored to instrumentKey.
        """
        migrator = HistoricalMarketDataMigrator(env={}, batch_size=100)
        rec_ce = {
            "id": 2001,
            "contractSymbol": "NSE:NIFTY26SEP24000CE",
            "ts": datetime(2026, 9, 23, 9, 15, 0),
            "providerTs": datetime(2026, 9, 23, 9, 15, 0),
            "ltp": 154.50, "bid": 154.40, "ask": 154.60, "bidQty": 75, "askQty": 150,
            "volume": 125000, "openInterest": 450000, "oiChange": 2500,
            "bidDepth": 500, "askDepth": 800, "underlyingPrice": 24850.25,
            "payloadHash": "hash1",
            "instrumentToken": "TOKEN_SHARED" # Same token provided by broker
        }
        rec_pe = dict(rec_ce, **{
            "id": 2002,
            "contractSymbol": "NSE:NIFTY26SEP24000PE", # Different option type
            "instrumentToken": "TOKEN_SHARED" # Same broker token
        })

        mapped_ce = migrator._map_record("upstox_live_paper_option_quotes", rec_ce, is_sentinel=False)
        mapped_pe = migrator._map_record("upstox_live_paper_option_quotes", rec_pe, is_sentinel=False)

        self.assertNotEqual(
            mapped_ce["canonicalDedupHash"], mapped_pe["canonicalDedupHash"],
            "Distinct contracts sharing the same instrumentToken must NEVER collide"
        )

class TestSevenCanonicalDuplicateEquivalenceCases(unittest.TestCase):
    """
    Dedicated adversarial test suite validating the 7 core cases of the approved
    canonical duplicate-equivalence contract (Item 3):
    1. Same canonical market state, different raw payload hash.
    2. Same canonical market state, different arrival metadata.
    3. Same quote values, different source sequence number.
    4. Different source event timestamps with otherwise identical quote values.
    5. Same canonical instrument with different broker tokens.
    6. Distinct canonical instruments with identical quote values.
    7. NULL versus zero and sub-second timestamp differences.
    """

    def setUp(self):
        self.ts_common = datetime(2026, 9, 23, 9, 15, 0, 100000)
        self.sts_common = datetime(2026, 9, 23, 9, 15, 0, 95000)
        self.canonical_state_base = {
            "source": "UPSTOX",
            "instrument_key": "NSE:NIFTY26SEP24000CE",
            "ts": self.ts_common,
            "source_ts": self.sts_common,
            "seq_num": 1001,
            "ltp": Decimal("154.5000"),
            "bid": Decimal("154.4000"),
            "ask": Decimal("154.6000"),
            "bid_qty": 75,
            "ask_qty": 150,
            "volume": Decimal("125000.00"),
            "oi": Decimal("450000.00"),
            "change_oi": Decimal("2500.00"),
            "bid_depth": 500,
            "ask_depth": 800,
            "underlying_price": Decimal("24850.2500"),
            "payload_hash": "raw_payload_hash_version_1"
        }

    def test_case_1_same_canonical_market_state_different_raw_payload_hash(self):
        """
        Case 1: Same canonical market state, different raw payload hash.
        Contract Requirement: If these records represent the same canonical market state,
        they must NOT evade deduplication merely because their raw payload hashes differ.
        """
        state_v1 = dict(self.canonical_state_base, payload_hash="payload_signature_alpha")
        state_v2 = dict(self.canonical_state_base, payload_hash="payload_signature_beta")

        # 1. Tier 2 Canonical Market State Comparator:
        # Tier 2 evaluates pure market state; verifies records evaluate as EQUAL (True)
        rec_m1 = {
            "ltp": state_v1["ltp"], "bid": state_v1["bid"], "ask": state_v1["ask"],
            "bidQty": state_v1["bid_qty"], "askQty": state_v1["ask_qty"],
            "bidDepth": state_v1["bid_depth"], "askDepth": state_v1["ask_depth"],
            "volume": state_v1["volume"], "oi": state_v1["oi"], "changeOi": state_v1["change_oi"],
            "underlyingPrice": state_v1["underlying_price"], "sourceTimestamp": state_v1["source_ts"]
        }
        rec_m2 = dict(rec_m1)
        self.assertTrue(
            canonical_market_state_equals(rec_m1, rec_m2),
            "Tier 2 market state comparator must confirm exact equivalence regardless of raw payload hash"
        )

        # 2. Tier 1 Canonical Market State Mode (canonical_mode=True by default):
        # Under pure canonical market-state identity, hashes must be IDENTICAL (deduplicates)
        # Sequence number and raw payload hash are excluded at function boundary regardless of caller arguments.
        h_canon_1 = compute_canonical_dedup_hash(**state_v1)
        h_canon_2 = compute_canonical_dedup_hash(**state_v2)
        self.assertEqual(
            h_canon_1, h_canon_2,
            "Canonical market-state deduplication hash MUST be identical when only raw payload hash differs"
        )

        # 3. Demonstration of Legacy Wire Mode (canonical_mode=False, include_raw_payload_hash=True):
        # Shows that including phash causes identical market states to evade Tier 1 dedup
        h_raw_1 = compute_canonical_dedup_hash(**state_v1, canonical_mode=False, include_raw_payload_hash=True)
        h_raw_2 = compute_canonical_dedup_hash(**state_v2, canonical_mode=False, include_raw_payload_hash=True)
        self.assertNotEqual(
            h_raw_1, h_raw_2,
            "Demonstration: Raw payload hashing in legacy mode treats wire-level variants as distinct"
        )

    def test_case_2_same_canonical_market_state_different_arrival_metadata(self):
        """
        Case 2: Same canonical market state, different arrival metadata.
        Expected Behavior: DEDUPLICATE (produce identical hash).
        Why: Arrival timestamps (receivedTimestamp, createdAt) and run IDs are host/pipeline artifacts,
        not market reality.
        """
        migrator_runA = HistoricalMarketDataMigrator(env={}, batch_size=100, run_id="run_A")
        migrator_runB = HistoricalMarketDataMigrator(env={}, batch_size=100, run_id="run_B")

        raw_row = {
            "id": 501, "contractSymbol": "NSE:NIFTY26SEP24000CE",
            "ts": self.ts_common, "providerTs": self.sts_common,
            "ltp": 154.50, "bid": 154.40, "ask": 154.60, "bidQty": 75, "askQty": 150,
            "volume": 125000, "openInterest": 450000, "oiChange": 2500,
            "bidDepth": 500, "askDepth": 800, "underlyingPrice": 24850.25,
            "payloadHash": "phash_shared", "instrumentToken": "TOK1",
            "createdAt": datetime(2026, 9, 23, 9, 15, 0, 101000)
        }
        raw_row_delayed = dict(raw_row, **{
            "id": 999,
            "createdAt": datetime(2026, 9, 23, 9, 15, 0, 999000) # arrived 898ms later
        })

        mapped_A = migrator_runA._map_record("upstox_live_paper_option_quotes", raw_row, is_sentinel=False)
        mapped_B = migrator_runB._map_record("upstox_live_paper_option_quotes", raw_row_delayed, is_sentinel=False)

        self.assertEqual(
            mapped_A["canonicalDedupHash"], mapped_B["canonicalDedupHash"],
            "Different arrival metadata must produce identical canonical dedup hash (must deduplicate)"
        )

    def test_case_3_same_quote_values_different_source_sequence_number(self):
        """
        Case 3: Same quote values, different source sequence number.
        Expected Behavior: DEDUPLICATE.
        Why: In live feeds, sequence numbers increment on feed reconnections and heartbeats without quote changes.
        """
        s1 = dict(self.canonical_state_base, seq_num=1001)
        s2 = dict(self.canonical_state_base, seq_num=1002)

        # In canonical_mode=True (default), sequence invariance is guaranteed at the function boundary,
        # even when callers supply different non-None seq_num values:
        h1 = compute_canonical_dedup_hash(**s1)
        h2 = compute_canonical_dedup_hash(**s2)
        self.assertEqual(
            h1, h2,
            "Sequence number variation alone must not prevent canonical deduplication when quote values are identical"
        )

        # In legacy mode (canonical_mode=False, include_sequence_number=True):
        h_seq1 = compute_canonical_dedup_hash(**s1, canonical_mode=False, include_sequence_number=True)
        h_seq2 = compute_canonical_dedup_hash(**s2, canonical_mode=False, include_sequence_number=True)
        self.assertNotEqual(
            h_seq1, h_seq2,
            "Legacy mode: sequence number inclusion differentiates records"
        )

    def test_case_4_different_source_event_timestamps_with_otherwise_identical_quote_values(self):
        """
        Case 4: Different source event timestamps with otherwise identical quote values.
        Expected Behavior: REMAIN DISTINCT.
        Why: Consecutive ticks at T1 and T2 (even with unchanged price) are distinct chronological market states.
        """
        ts_1 = datetime(2026, 9, 23, 9, 15, 0, 100000)
        ts_2 = datetime(2026, 9, 23, 9, 15, 0, 200000) # +100ms later

        s1 = dict(self.canonical_state_base, ts=ts_1, source_ts=ts_1)
        s2 = dict(self.canonical_state_base, ts=ts_2, source_ts=ts_2)

        h1 = compute_canonical_dedup_hash(**s1)
        h2 = compute_canonical_dedup_hash(**s2)

        self.assertNotEqual(
            h1, h2,
            "Different source event timestamps must produce distinct hashes (must remain distinct)"
        )

    def test_case_5a_same_provider_same_instrument_different_broker_tokens(self):
        """
        Case 5a: Same provider + same canonical instrument + different broker tokens.
        Expected Behavior: DEDUPLICATE.
        Rationale: Broker tokens (instrumentToken) are internal broker gateway identifiers that change
        across master contract updates. Contract identity is strictly anchored to instrumentKey.
        Both observations come from the SAME provider (Upstox).
        """
        migrator = HistoricalMarketDataMigrator(env={}, batch_size=100)
        row_tok1 = {
            "id": 1, "contractSymbol": "NSE:NIFTY26SEP24000CE",
            "ts": self.ts_common, "providerTs": self.sts_common,
            "ltp": 154.50, "bid": 154.40, "ask": 154.60, "bidQty": 75, "askQty": 150,
            "volume": 125000, "openInterest": 450000, "oiChange": 2500,
            "bidDepth": 500, "askDepth": 800, "underlyingPrice": 24850.25,
            "payloadHash": "phash1", "instrumentToken": "TOKEN_OLD_20260901"
        }
        row_tok2 = dict(row_tok1, instrumentToken="TOKEN_NEW_20260915")

        m1 = migrator._map_record("upstox_live_paper_option_quotes", row_tok1, is_sentinel=False)
        m2 = migrator._map_record("upstox_live_paper_option_quotes", row_tok2, is_sentinel=False)

        self.assertEqual(
            m1["canonicalDedupHash"], m2["canonicalDedupHash"],
            "Same provider with differing broker instrumentToken on same canonical contract must deduplicate"
        )

    def test_case_5b_different_providers_otherwise_identical_canonical_observations(self):
        """
        Case 5b: Different providers + otherwise identical canonical observations.
        Expected Behavior: REMAIN DISTINCT (Provider Isolation Preserved).
        Rationale: Provider provenance ('fyers' vs 'UPSTOX') is an immutable attribute of market observation identity.
        Quotes from different brokers represent distinct exchange gateway channels.
        - Tier 1: 'src=fyers' vs 'src=UPSTOX' produces distinct hashes.
        - Tier 2: cand_venue != m_venue evaluates is_canonical_dup = False.
        """
        s_fyers = dict(self.canonical_state_base, source="fyers")
        s_upstox = dict(self.canonical_state_base, source="UPSTOX")

        h_fyers = compute_canonical_dedup_hash(**s_fyers)
        h_upstox = compute_canonical_dedup_hash(**s_upstox)

        self.assertNotEqual(
            h_fyers, h_upstox,
            "Tier 1: Different providers with identical market observations must produce distinct hashes"
        )

        # Tier 2: Verify VENUE_NORM matching in batch insertion strictly isolates providers
        migrator = HistoricalMarketDataMigrator(env={}, batch_size=100)
        mock_conn = MagicMock()
        mock_cur = MagicMock()
        mock_conn.cursor.return_value.__enter__.return_value = mock_cur

        # Target table already contains a native canonical record from FYERS_LIVE
        existing_fyers_row = {
            "instrumentKey": "NSE:NIFTY26SEP24000CE",
            "ts": self.ts_common,
            "source": "FYERS_LIVE",
            "sourceTimestamp": self.sts_common,
            "ltp": Decimal("154.5000"), "bid": Decimal("154.4000"), "ask": Decimal("154.6000"),
            "bidQty": 75, "askQty": 150, "bidDepth": 500, "askDepth": 800,
            "volume": Decimal("125000.00"), "oi": Decimal("450000.00"), "changeOi": Decimal("2500.00"),
            "underlyingPrice": Decimal("24850.2500")
        }
        # Incoming candidate from UPSTOX with identical quote values
        cand_upstox = {
            "canonicalDedupHash": h_upstox,
            "instrumentKey": "NSE:NIFTY26SEP24000CE",
            "ts": self.ts_common,
            "source": "UPSTOX",
            "sourceTimestamp": self.sts_common,
            "ltp": 154.50, "bid": 154.40, "ask": 154.60,
            "bidQty": 75, "askQty": 150, "bidDepth": 500, "askDepth": 800,
            "volume": 125000, "oi": 450000, "changeOi": 2500,
            "underlyingPrice": 24850.25
        }

        mock_cur.fetchall.side_effect = [
            [], # Tier 1: hash not found in target
            [existing_fyers_row], # Tier 2: returns the existing FYERS_LIVE row
            []  # SHOW WARNINGS: clean
        ]
        mock_cur.rowcount = 1

        inserted, duplicates = migrator._insert_target_batch_strictly(mock_conn, [cand_upstox])
        self.assertEqual(inserted, 1, "Tier 2: Upstox quote must be inserted and NOT skipped as duplicate of Fyers quote")
        self.assertEqual(duplicates, 0, "Provider isolation must prevent cross-broker duplicate matching")


    def test_case_6_distinct_canonical_instruments_with_identical_quote_values(self):
        """
        Case 6: Distinct canonical instruments with identical quote values.
        Expected Behavior: REMAIN DISTINCT.
        Why: CE vs PE contracts (or different strikes) trading at the identical price are distinct financial assets.
        """
        s_ce = dict(self.canonical_state_base, instrument_key="NSE:NIFTY26SEP24000CE")
        s_pe = dict(self.canonical_state_base, instrument_key="NSE:NIFTY26SEP24000PE")

        h_ce = compute_canonical_dedup_hash(**s_ce)
        h_pe = compute_canonical_dedup_hash(**s_pe)

        self.assertNotEqual(
            h_ce, h_pe,
            "Distinct canonical instruments sharing identical prices must produce distinct hashes (remain distinct)"
        )

    def test_case_7_null_versus_zero_and_subsecond_timestamp_differences(self):
        """
        Case 7: NULL versus zero and sub-second timestamp differences.
        Expected Behavior: REMAIN DISTINCT.
        Why:
        - NULL represents absence of data; 0 represents mathematical zero (zero contracts/volume).
        - Sub-second timestamp differences represent distinct sequential ticks.
        """
        # Part A: NULL vs Zero (Volume)
        s_vol_null = dict(self.canonical_state_base, volume=None)
        s_vol_zero = dict(self.canonical_state_base, volume=Decimal("0.00"))

        h_null = compute_canonical_dedup_hash(**s_vol_null)
        h_zero = compute_canonical_dedup_hash(**s_vol_zero)

        self.assertNotEqual(
            h_null, h_zero,
            "Volume NULL and Volume 0.00 must produce distinct hashes (remain distinct)"
        )

        # Part B: Sub-second Microsecond Offsets
        s_ts_zero_us = dict(self.canonical_state_base, ts=datetime(2026, 9, 23, 9, 15, 0, 0))
        s_ts_500_us = dict(self.canonical_state_base, ts=datetime(2026, 9, 23, 9, 15, 0, 500000))

        h_us0 = compute_canonical_dedup_hash(**s_ts_zero_us)
        h_us500 = compute_canonical_dedup_hash(**s_ts_500_us)

        self.assertNotEqual(
            h_us0, h_us500,
            "Sub-second timestamp differences must produce distinct hashes (remain distinct)"
        )


class TestProviderVenueNormalizationAndTier2Remediation(unittest.TestCase):
    """
    Dedicated test suite verifying:
    1. Provider normalization, alias mapping, case/whitespace handling, unknown providers, and invalid inputs.
    2. Legacy unnormalized hash compatibility through Tier 2.
    3. Cross-provider isolation and unhashed-target controls.
    4. Invalid provenance abort, rollback, and checkpoint preservation.
    """

    def test_provider_venue_normalization_contract(self):
        """
        Verify provider normalization contract:
        - Fyers aliases resolve to 'FYERS_LIVE'
        - Upstox aliases resolve to 'UPSTOX_LIVE'
        - Case and whitespace insensitivity
        - Unknown providers preserved in uppercase
        - None, empty, whitespace-only, and literal 'NULL' raise InvalidProviderProvenanceError
        """
        # 1. Fyers aliases
        self.assertEqual(normalize_provider_venue("fyers"), "FYERS_LIVE")
        self.assertEqual(normalize_provider_venue("FYERS"), "FYERS_LIVE")
        self.assertEqual(normalize_provider_venue("FYERS_LIVE"), "FYERS_LIVE")
        self.assertEqual(normalize_provider_venue("  fyers  "), "FYERS_LIVE")
        self.assertEqual(normalize_provider_venue("Fyers_Live"), "FYERS_LIVE")

        # 2. Upstox aliases
        self.assertEqual(normalize_provider_venue("upstox"), "UPSTOX_LIVE")
        self.assertEqual(normalize_provider_venue("UPSTOX"), "UPSTOX_LIVE")
        self.assertEqual(normalize_provider_venue("UPSTOX_LIVE"), "UPSTOX_LIVE")
        self.assertEqual(normalize_provider_venue("  UpStox  "), "UPSTOX_LIVE")
        self.assertEqual(normalize_provider_venue("Upstox_Live"), "UPSTOX_LIVE")

        # 3. Unknown providers preserved in uppercase
        self.assertEqual(normalize_provider_venue("bloomberg"), "BLOOMBERG")
        self.assertEqual(normalize_provider_venue("ZERODHA"), "ZERODHA")
        self.assertEqual(normalize_provider_venue("  custom_feed  "), "CUSTOM_FEED")

        # 4. Invalid provenance raises InvalidProviderProvenanceError
        invalid_inputs = [None, "", "   ", "\t\n", "NULL", "null", "Null", "  NULL  "]
        for bad_val in invalid_inputs:
            with self.subTest(invalid_val=bad_val):
                with self.assertRaises(InvalidProviderProvenanceError):
                    normalize_provider_venue(bad_val)

    def test_tier2_recovers_legacy_unnormalized_target_hash(self):
        """
        Prove that an incoming normalized candidate ('FYERS_LIVE') matches a legacy target row
        stored with unnormalized source ('fyers') and legacy hash, even though Tier 1 misses
        due to cryptographic hash divergence.
        """
        ts_val = datetime(2026, 9, 23, 9, 15, 0, 100000)
        sts_val = datetime(2026, 9, 23, 9, 15, 0, 95000)
        key = "NSE:NIFTY26SEP24000CE"

        base_market_state = {
            "ltp": Decimal("154.5000"),
            "bid": Decimal("154.4000"),
            "ask": Decimal("154.6000"),
            "bid_qty": 75,
            "ask_qty": 150,
            "volume": Decimal("125000.00"),
            "oi": Decimal("450000.00"),
            "change_oi": Decimal("2500.00"),
            "bid_depth": 500,
            "ask_depth": 800,
            "underlying_price": Decimal("24850.2500")
        }

        # 1. Compute legacy unnormalized target hash (raw src='fyers')
        # Uses canonical_mode=False to simulate unnormalized legacy serialization on disk
        legacy_target_hash = compute_canonical_dedup_hash(
            source="fyers",
            instrument_key=key,
            ts=ts_val,
            source_ts=sts_val,
            seq_num=None,
            ltp=base_market_state["ltp"],
            bid=base_market_state["bid"],
            ask=base_market_state["ask"],
            bid_qty=base_market_state["bid_qty"],
            ask_qty=base_market_state["ask_qty"],
            volume=base_market_state["volume"],
            oi=base_market_state["oi"],
            change_oi=base_market_state["change_oi"],
            bid_depth=base_market_state["bid_depth"],
            ask_depth=base_market_state["ask_depth"],
            underlying_price=base_market_state["underlying_price"],
            payload_hash=None,
            canonical_mode=False
        )

        # 2. Compute incoming normalized candidate hash (canonical contract: normalizes 'FYERS_LIVE')
        candidate_norm_hash = compute_canonical_dedup_hash(
            source="FYERS_LIVE",
            instrument_key=key,
            ts=ts_val,
            source_ts=sts_val,
            seq_num=None,
            ltp=base_market_state["ltp"],
            bid=base_market_state["bid"],
            ask=base_market_state["ask"],
            bid_qty=base_market_state["bid_qty"],
            ask_qty=base_market_state["ask_qty"],
            volume=base_market_state["volume"],
            oi=base_market_state["oi"],
            change_oi=base_market_state["change_oi"],
            bid_depth=base_market_state["bid_depth"],
            ask_depth=base_market_state["ask_depth"],
            underlying_price=base_market_state["underlying_price"],
            payload_hash=None,
            canonical_mode=True
        )

        # Verify cryptographic divergence
        self.assertNotEqual(legacy_target_hash, candidate_norm_hash, "Legacy and normalized hashes must diverge")

        # 3. Setup mock connection and cursor
        mock_conn = MagicMock()
        mock_cur = MagicMock()
        mock_conn.cursor.return_value.__enter__.return_value = mock_cur

        # Target record on disk: has legacy unnormalized hash and source='fyers'
        existing_target_record = {
            "instrumentKey": key,
            "ts": ts_val,
            "source": "fyers",
            "sourceTimestamp": sts_val,
            "ltp": base_market_state["ltp"],
            "bid": base_market_state["bid"],
            "ask": base_market_state["ask"],
            "bidQty": base_market_state["bid_qty"],
            "askQty": base_market_state["ask_qty"],
            "volume": base_market_state["volume"],
            "oi": base_market_state["oi"],
            "changeOi": base_market_state["change_oi"],
            "underlyingPrice": base_market_state["underlying_price"],
            "bidDepth": base_market_state["bid_depth"],
            "askDepth": base_market_state["ask_depth"],
            "canonicalDedupHash": legacy_target_hash
        }

        # Simulate database responses matching _insert_target_batch_strictly sequence:
        # 1. Tier 1 hash lookup -> returns [] (MISS, candidate hash not present)
        # 2. Tier 2 lookup -> returns [existing_target_record] (MATCH)
        mock_cur.fetchall.side_effect = [
            [],                          # Tier 1 hash query result
            [existing_target_record]     # Tier 2 candidate query result
        ]

        migrator = HistoricalMarketDataMigrator(env={}, batch_size=100, run_id="test_run_remediation")

        candidate_record = {
            "instrumentKey": key,
            "ts": ts_val,
            "source": "FYERS_LIVE",
            "sourceTimestamp": sts_val,
            "ltp": base_market_state["ltp"],
            "bid": base_market_state["bid"],
            "ask": base_market_state["ask"],
            "bidQty": base_market_state["bid_qty"],
            "askQty": base_market_state["ask_qty"],
            "volume": base_market_state["volume"],
            "oi": base_market_state["oi"],
            "changeOi": base_market_state["change_oi"],
            "underlyingPrice": base_market_state["underlying_price"],
            "bidDepth": base_market_state["bid_depth"],
            "askDepth": base_market_state["ask_depth"],
            "canonicalDedupHash": candidate_norm_hash
        }

        # Explicitly verify normalizer maps both to FYERS_LIVE and comparator evaluates True
        self.assertEqual(normalize_provider_venue(candidate_record["source"]), "FYERS_LIVE")
        self.assertEqual(normalize_provider_venue(existing_target_record["source"]), "FYERS_LIVE")
        self.assertTrue(canonical_market_state_equals(candidate_record, existing_target_record))

        inserted, duplicates = migrator._insert_target_batch_strictly(mock_conn, [candidate_record])

        # 4. Strict assertions
        self.assertEqual(inserted, 0, "Zero rows must be inserted")
        self.assertEqual(duplicates, 1, "Legacy target must be matched as a duplicate in Tier 2")

        # Assert executed queries
        self.assertEqual(mock_cur.execute.call_count, 2, "Exactly two SELECT queries must be executed")

        tier1_call = mock_cur.execute.call_args_list[0]
        self.assertIn("SELECT canonicalDedupHash FROM", tier1_call[0][0])
        self.assertEqual(tier1_call[0][1], [candidate_norm_hash])

        tier2_call = mock_cur.execute.call_args_list[1]
        tier2_sql = tier2_call[0][0]
        self.assertIn("FROM unified_option_quotes_history", tier2_sql)
        self.assertIn("(instrumentKey = %s AND ts = %s)", tier2_sql)
        self.assertNotIn("canonicalDedupHash IS NULL", tier2_sql, "Tier 2 SQL must NOT contain 'canonicalDedupHash IS NULL'")
        self.assertEqual(tier2_call[0][1], [key, ts_val])

        # Assert executemany was never called (100% duplicate batch)
        mock_cur.executemany.assert_not_called()

    def test_tier2_negative_controls_cross_provider_and_null_hash(self):
        """
        Verify Tier 2 negative controls:
        1. Control A: Target with canonicalDedupHash IS NULL is matched as duplicate.
        2. Control B: Cross-provider target (e.g. 'UPSTOX' vs 'fyers') is NOT matched as duplicate and is inserted.
        """
        ts_val = datetime(2026, 9, 23, 9, 15, 0, 100000)
        sts_val = datetime(2026, 9, 23, 9, 15, 0, 95000)
        key = "NSE:NIFTY26SEP24000CE"

        base_state = {
            "ltp": Decimal("154.5000"),
            "bid": Decimal("154.4000"),
            "ask": Decimal("154.6000"),
            "bid_qty": 75,
            "ask_qty": 150,
            "volume": Decimal("125000.00"),
            "oi": Decimal("450000.00"),
            "change_oi": Decimal("2500.00"),
            "bid_depth": 500,
            "ask_depth": 800,
            "underlying_price": Decimal("24850.2500")
        }

        migrator = HistoricalMarketDataMigrator(env={}, batch_size=100)

        # Control A: Target with canonicalDedupHash IS NULL
        mock_conn = MagicMock()
        mock_cur = MagicMock()
        mock_conn.cursor.return_value.__enter__.return_value = mock_cur

        unhashed_target = {
            "instrumentKey": key, "ts": ts_val, "source": "fyers", "sourceTimestamp": sts_val,
            "ltp": base_state["ltp"], "bid": base_state["bid"], "ask": base_state["ask"],
            "bidQty": base_state["bid_qty"], "askQty": base_state["ask_qty"],
            "volume": base_state["volume"], "oi": base_state["oi"], "changeOi": base_state["change_oi"],
            "underlyingPrice": base_state["underlying_price"], "bidDepth": base_state["bid_depth"],
            "askDepth": base_state["ask_depth"], "canonicalDedupHash": None
        }
        mock_cur.fetchall.side_effect = [[], [unhashed_target]]

        cand_fyers = {
            "instrumentKey": key, "ts": ts_val, "source": "FYERS_LIVE", "sourceTimestamp": sts_val,
            "ltp": base_state["ltp"], "bid": base_state["bid"], "ask": base_state["ask"],
            "bidQty": base_state["bid_qty"], "askQty": base_state["ask_qty"],
            "volume": base_state["volume"], "oi": base_state["oi"], "changeOi": base_state["change_oi"],
            "underlyingPrice": base_state["underlying_price"], "bidDepth": base_state["bid_depth"],
            "askDepth": base_state["ask_depth"], "canonicalDedupHash": "hash_fyers_test"
        }

        inserted_a, dups_a = migrator._insert_target_batch_strictly(mock_conn, [cand_fyers])
        self.assertEqual(inserted_a, 0)
        self.assertEqual(dups_a, 1)
        mock_cur.executemany.assert_not_called()

        # Control B: Cross-provider target (stored target is UPSTOX, candidate is FYERS_LIVE)
        mock_conn_b = MagicMock()
        mock_cur_b = MagicMock()
        mock_conn_b.cursor.return_value.__enter__.return_value = mock_cur_b

        upstox_target = dict(unhashed_target, source="UPSTOX")
        mock_cur_b.fetchall.side_effect = [[], [upstox_target], []]  # T1 miss, T2 returns upstox, SHOW WARNINGS clean
        mock_cur_b.rowcount = 1

        inserted_b, dups_b = migrator._insert_target_batch_strictly(mock_conn_b, [cand_fyers])
        self.assertEqual(inserted_b, 1, "Cross-provider observation must be inserted")
        self.assertEqual(dups_b, 0, "Cross-provider observation must NOT be skipped as duplicate")
        mock_cur_b.executemany.assert_called_once()

    def test_invalid_provider_provenance_aborts_batch_and_rolls_back(self):
        """
        Prove that a record with invalid provider provenance:
        - Raises InvalidProviderProvenanceError during batch processing
        - Triggers conn.rollback()
        - Releases worker lease as FAILED
        - Does NOT advance checkpoint last_processed_id
        """
        migrator = HistoricalMarketDataMigrator(env={}, batch_size=100)
        mock_conn = MagicMock()
        mock_cur = MagicMock()
        mock_conn.cursor.return_value.__enter__.return_value = mock_cur
        migrator._get_connection = MagicMock(return_value=mock_conn)
        migrator._acquire_worker_lease = MagicMock()
        migrator._release_worker_lease = MagicMock()
        migrator._record_baseline_metrics = MagicMock()
        migrator._check_system_health = MagicMock()

        # Checkpoint initial read: last_processed_id = 'id_boundary_100'
        mock_cur.fetchone.side_effect = [
            {"last_processed_id": "id_boundary_100", "rows_scanned": 100, "rows_inserted": 100, "rows_skipped_duplicate": 0, "rows_skipped_sentinel": 0},
            {"ist_midnight": datetime(2026, 10, 11, 0, 0)}
        ]

        # Batch contains one row with invalid source (empty string)
        invalid_source_row = {
            "id": 101,
            "contractSymbol": "NSE:NIFTY26SEP24000CE",
            "ts": datetime(2026, 9, 23, 9, 15, 0),
            "providerTs": datetime(2026, 9, 23, 9, 15, 0),
            "source": "",  # INVALID PROVENANCE
            "ltp": 154.50, "bid": 154.40, "ask": 154.60, "bidQty": 75, "askQty": 150,
            "volume": 125000, "openInterest": 450000, "oiChange": 2500
        }
        mock_cur.fetchall.return_value = [invalid_source_row]

        with patch.object(migrator, "_map_record", side_effect=InvalidProviderProvenanceError("Invalid provider source: ''")):
            with self.assertRaises(InvalidProviderProvenanceError):
                migrator._migrate_single_source("upstox_live_paper_option_quotes")

        # Invariant assertions:
        # 1. conn.rollback() was called
        mock_conn.rollback.assert_called_once()
        # 2. Worker lease released as FAILED
        migrator._release_worker_lease.assert_called_with(mock_conn, "upstox_live_paper_option_quotes", status="FAILED")
        # 3. Checkpoint UPDATE was NEVER executed!
        checkpoint_updates = [c for c in mock_cur.execute.call_args_list if "UPDATE" in c[0][0] and "cpp_historical_migration_checkpoints" in c[0][0]]
        self.assertEqual(len(checkpoint_updates), 0, "Checkpoint must not be updated on failure")

    def test_tier2_multi_venue_collision_disambiguation(self):
        """
        Test A: Multi-venue collision disambiguation.
        Two target records share identical (instrumentKey, ts) but have different providers:
          - Target A: 'FYERS_LIVE' (different market state from candidate)
          - Target B: 'UPSTOX_LIVE' (identical market state to candidate)
        Candidate: 'UPSTOX' (normalizes to 'UPSTOX_LIVE').

        Assertions:
          - Both target records are available in Tier 2 matches dict.
          - Provider normalization maps candidate 'UPSTOX' to 'UPSTOX_LIVE'.
          - Candidate correctly matches Target B and rejects Target A.
          - Exactly 1 duplicate counted, 0 inserted.
          - Negative control: Candidate with 'BLOOMBERG' at same (key, ts) evaluates to 0 duplicates and is inserted.
          - Row-accounting invariant holds: scanned == inserted + duplicates.
        """
        key = "NSE:NIFTY26SEP24000CE"
        ts = datetime(2026, 9, 23, 9, 15, 0, 100000)
        sts = datetime(2026, 9, 23, 9, 15, 0, 95000)

        # Target A: Fyers quote
        target_fyers = {
            "instrumentKey": key, "ts": ts, "source": "FYERS_LIVE", "sourceTimestamp": sts,
            "ltp": Decimal("155.0000"), "bid": Decimal("154.9000"), "ask": Decimal("155.1000"),
            "bidQty": 100, "askQty": 200, "volume": Decimal("130000.00"), "oi": Decimal("460000.00"),
            "changeOi": Decimal("2600.00"), "underlyingPrice": Decimal("24855.0000"),
            "bidDepth": 600, "askDepth": 900, "canonicalDedupHash": "hash_target_fyers"
        }

        # Target B: Upstox quote
        target_upstox = {
            "instrumentKey": key, "ts": ts, "source": "UPSTOX_LIVE", "sourceTimestamp": sts,
            "ltp": Decimal("154.5000"), "bid": Decimal("154.4000"), "ask": Decimal("154.6000"),
            "bidQty": 75, "askQty": 150, "volume": Decimal("125000.00"), "oi": Decimal("450000.00"),
            "changeOi": Decimal("2500.00"), "underlyingPrice": Decimal("24850.2500"),
            "bidDepth": 500, "askDepth": 800, "canonicalDedupHash": "hash_target_upstox"
        }

        # Candidate: Upstox raw source ('UPSTOX') with market state identical to Target B
        candidate_upstox = {
            "instrumentKey": key, "ts": ts, "source": "UPSTOX", "sourceTimestamp": sts,
            "ltp": Decimal("154.5000"), "bid": Decimal("154.4000"), "ask": Decimal("154.6000"),
            "bidQty": 75, "askQty": 150, "volume": Decimal("125000.00"), "oi": Decimal("450000.00"),
            "changeOi": Decimal("2500.00"), "underlyingPrice": Decimal("24850.2500"),
            "bidDepth": 500, "askDepth": 800, "canonicalDedupHash": "hash_cand_upstox"
        }

        mock_conn = MagicMock()
        mock_cur = MagicMock()
        mock_conn.cursor.return_value.__enter__.return_value = mock_cur

        # Tier 1 returns empty (MISS); Tier 2 returns both target_fyers and target_upstox
        mock_cur.fetchall.side_effect = [
            [],                             # Tier 1 hash query
            [target_fyers, target_upstox]   # Tier 2 returns both rows for the tuple (key, ts)
        ]

        migrator = HistoricalMarketDataMigrator(env={}, batch_size=100)

        # Execute
        inserted, duplicates = migrator._insert_target_batch_strictly(mock_conn, [candidate_upstox])

        # Assertions
        self.assertEqual(inserted, 0, "No row should be inserted for matching Upstox candidate")
        self.assertEqual(duplicates, 1, "Exactly 1 duplicate must be detected")
        mock_cur.executemany.assert_not_called()

        # Negative control: Candidate at same (key, ts) but from 'BLOOMBERG'
        candidate_bloomberg = dict(candidate_upstox, source="BLOOMBERG", canonicalDedupHash="hash_cand_bbg")
        mock_conn_ctrl = MagicMock()
        mock_cur_ctrl = MagicMock()
        mock_conn_ctrl.cursor.return_value.__enter__.return_value = mock_cur_ctrl
        mock_cur_ctrl.fetchall.side_effect = [
            [],                             # Tier 1 hash query
            [target_fyers, target_upstox],  # Tier 2 returns both rows
            []                              # SHOW WARNINGS (clean)
        ]
        mock_cur_ctrl.rowcount = 1

        inserted_ctrl, dups_ctrl = migrator._insert_target_batch_strictly(mock_conn_ctrl, [candidate_bloomberg])
        self.assertEqual(inserted_ctrl, 1, "Bloomberg candidate must be inserted")
        self.assertEqual(dups_ctrl, 0, "Bloomberg candidate must NOT match Fyers or Upstox targets")
        mock_cur_ctrl.executemany.assert_called_once()

    def test_tier2_multi_chunk_boundary_splitting(self):
        """
        Test B: Multi-chunk boundary splitting for > 500 candidates.
        Tests 1,201 unique candidates with chunk_size = 500:
          - Expected chunk 1: 500 pairs
          - Expected chunk 2: 500 pairs
          - Expected chunk 3: 201 pairs
          Total = 3 separate Tier 2 queries executed.

        Scenario setup:
          - Candidates 0..99 match existing target records -> 100 duplicates
          - Candidates 100..1200 do NOT match -> 1,101 inserts
        Total = 1,201 processed (1,101 inserted + 100 duplicates).

        Assertions:
          - Exactly 3 Tier 2 queries executed with sizes 500, 500, 201 pairs.
          - Parameter lengths: chunk 1 = 1000, chunk 2 = 1000, chunk 3 = 402 parameters.
          - Executed parameters match candidate (key, ts) without omission.
          - Results across chunks combined seamlessly.
          - Final accounting: inserted == 1101, duplicates == 100, scanned == 1201.
          - Boundary assertions: executemany called with exactly 1,101 rows.
        """
        chunk_size = 500
        total_candidates = 1201
        num_dups = 100
        base_ts = datetime(2026, 9, 23, 9, 15, 0)

        candidates = []
        matching_targets = []

        for i in range(total_candidates):
            key = f"NSE:NIFTY26SEP{24000 + i}CE"
            ts = base_ts + timedelta(seconds=i)
            cand = {
                "instrumentKey": key,
                "ts": ts,
                "source": "UPSTOX",
                "sourceTimestamp": ts,
                "ltp": Decimal("100.0000"),
                "bid": Decimal("99.9000"),
                "ask": Decimal("100.1000"),
                "bidQty": 100,
                "askQty": 100,
                "volume": Decimal("1000.00"),
                "oi": Decimal("5000.00"),
                "changeOi": Decimal("100.00"),
                "underlyingPrice": Decimal("24800.0000"),
                "bidDepth": 10,
                "askDepth": 10,
                "canonicalDedupHash": f"hash_cand_{i}"
            }
            candidates.append(cand)

            if i < num_dups:
                # Target row matching candidate i
                tgt = dict(cand, source="UPSTOX_LIVE", canonicalDedupHash=f"hash_target_{i}")
                matching_targets.append(tgt)

        # Setup mock connection and cursor
        mock_conn = MagicMock()
        mock_cur = MagicMock()
        mock_conn.cursor.return_value.__enter__.return_value = mock_cur

        executed_tier2_queries = []

        def mock_execute(sql, params=None):
            if "WHERE canonicalDedupHash IN" in sql:
                mock_cur.fetchall.return_value = []  # Tier 1 misses all
            elif "FROM unified_option_quotes_history" in sql and "WHERE (" in sql:
                executed_tier2_queries.append((sql, params))
                # Return targets that match this chunk's parameters
                pairs_in_query = [(params[j], params[j+1]) for j in range(0, len(params), 2)]
                matched_rows = [t for t in matching_targets if (t["instrumentKey"], t["ts"]) in pairs_in_query]
                mock_cur.fetchall.return_value = matched_rows
            elif "SHOW WARNINGS" in sql:
                mock_cur.fetchall.return_value = []
            return None

        mock_cur.execute.side_effect = mock_execute
        mock_cur.rowcount = total_candidates - num_dups  # 1101 inserted

        migrator = HistoricalMarketDataMigrator(env={}, batch_size=2000)

        # Execute
        inserted, duplicates = migrator._insert_target_batch_strictly(mock_conn, candidates)

        # 1. Assert chunk query execution counts
        expected_chunks = 3  # 500 + 500 + 201
        self.assertEqual(len(executed_tier2_queries), expected_chunks, f"Must execute exactly {expected_chunks} chunk queries")

        # 2. Assert chunk sizes and parameter counts
        chunk1_sql, chunk1_params = executed_tier2_queries[0]
        chunk2_sql, chunk2_params = executed_tier2_queries[1]
        chunk3_sql, chunk3_params = executed_tier2_queries[2]

        self.assertEqual(len(chunk1_params), 500 * 2, "Chunk 1 must have 1000 parameters (500 pairs)")
        self.assertEqual(len(chunk2_params), 500 * 2, "Chunk 2 must have 1000 parameters (500 pairs)")
        self.assertEqual(len(chunk3_params), 201 * 2, "Chunk 3 must have 402 parameters (201 pairs)")

        self.assertEqual(chunk1_sql.count("(instrumentKey = %s AND ts = %s)"), 500)
        self.assertEqual(chunk2_sql.count("(instrumentKey = %s AND ts = %s)"), 500)
        self.assertEqual(chunk3_sql.count("(instrumentKey = %s AND ts = %s)"), 201)

        # 3. Assert parameter integrity (no omissions or duplicates across chunks)
        all_queried_pairs = []
        for _, p_list in executed_tier2_queries:
            for j in range(0, len(p_list), 2):
                all_queried_pairs.append((p_list[j], p_list[j+1]))

        expected_pairs = [(c["instrumentKey"], c["ts"]) for c in candidates]
        self.assertEqual(all_queried_pairs, expected_pairs, "All candidate pairs must be queried in order without gaps")

        # 4. Assert accounting invariant and insertion results
        self.assertEqual(duplicates, num_dups, f"Exactly {num_dups} duplicates must be resolved across chunks")
        self.assertEqual(inserted, total_candidates - num_dups, f"Exactly {total_candidates - num_dups} rows must be inserted")
        self.assertEqual(len(candidates), inserted + duplicates, "Row accounting invariant must hold")

        # 5. Assert executemany called with exactly the un-duplicated rows
        mock_cur.executemany.assert_called_once()
        insert_call_args = mock_cur.executemany.call_args[0]
        inserted_data = insert_call_args[1]
        self.assertEqual(len(inserted_data), total_candidates - num_dups)


class TestCheckpointFencingAndSchemaRefinements(unittest.TestCase):
    """
    Targeted regression tests for:
    1. Checkpoint fencing token validation (WorkerLeaseLostError on rowcount != 1).
    2. Atomic transaction rollback discarding uncommitted target inserts upon lease loss.
    3. Prevention of target insert commits when lease is lost.
    4. Successful single-row checkpoint update completing normal commit.
    5. Phase B DDL market-depth column definitions as BIGINT NULL.
    6. Non-suppression of fencing failure through outer exception handlers.
    """

    def setUp(self):
        self.sample_record = {
            "id": "uuid-fencing-001",
            "contractSymbol": "NSE:NIFTY26SEP24000CE",
            "ts": datetime(2026, 9, 20, 10, 0, 0),
            "ltp": 150.0, "bid": 149.0, "ask": 151.0, "bidQty": 100, "askQty": 100,
            "volume": 500, "openInterest": 1000, "oiChange": 0, "expiry": "2026-09-26",
            "strike": 24000, "optionType": "CE", "underlying": "NIFTY"
        }

    def _setup_migrator(self, checkpoint_rowcount=1):
        from historical_market_data_migrator import HistoricalMarketDataMigrator
        migrator = HistoricalMarketDataMigrator(env={}, batch_size=1)
        mock_conn = MagicMock()
        mock_cur = MagicMock()
        mock_conn.cursor.return_value.__enter__.return_value = mock_cur
        migrator._get_connection = MagicMock(return_value=mock_conn)
        migrator._acquire_worker_lease = MagicMock()
        migrator._release_worker_lease = MagicMock()
        migrator._record_baseline_metrics = MagicMock()
        migrator._check_system_health = MagicMock()

        mock_cur.fetchone.side_effect = [
            {"last_processed_id": "", "rows_scanned": 0, "rows_inserted": 0, "rows_skipped_duplicate": 0, "rows_skipped_sentinel": 0},
            {"ist_midnight": datetime(2026, 10, 11, 0, 0)}
        ]
        mock_cur.fetchall.side_effect = [
            [self.sample_record], # Pass 1 batch query
            [],                   # Pass 1 forward scan done
            []                    # Pass 2 anti-join done
        ]
        mock_cur.rowcount = checkpoint_rowcount
        migrator._insert_target_batch_strictly = MagicMock(return_value=(1, 0))
        return migrator, mock_conn, mock_cur

    def test_checkpoint_update_zero_rows_raises_lease_loss_exception(self):
        """1. Verify that a checkpoint update affecting zero rows raises WorkerLeaseLostError."""
        from historical_market_data_migrator import WorkerLeaseLostError
        migrator, mock_conn, mock_cur = self._setup_migrator(checkpoint_rowcount=0)

        with self.assertRaises(WorkerLeaseLostError) as ctx:
            migrator._migrate_single_source("fnf_option_quotes_history")

        self.assertIn("Fencing token validation failed", str(ctx.exception))
        self.assertIn("affected 0 rows", str(ctx.exception))

    def test_entire_batch_transaction_rolls_back_when_lease_lost(self):
        """2. Verify that the entire batch transaction rolls back when lease ownership is lost."""
        from historical_market_data_migrator import WorkerLeaseLostError
        migrator, mock_conn, mock_cur = self._setup_migrator(checkpoint_rowcount=0)

        with self.assertRaises(WorkerLeaseLostError):
            migrator._migrate_single_source("fnf_option_quotes_history")

        mock_conn.rollback.assert_called_once()
        mock_conn.commit.assert_not_called()

    def test_batch_cannot_commit_target_inserts_after_failed_checkpoint_update(self):
        """3. Verify that the batch cannot commit target inserts after a failed checkpoint update."""
        from historical_market_data_migrator import WorkerLeaseLostError
        migrator, mock_conn, mock_cur = self._setup_migrator(checkpoint_rowcount=0)

        with self.assertRaises(WorkerLeaseLostError):
            migrator._migrate_single_source("fnf_option_quotes_history")

        # Verify target rows were prepared/inserted into connection
        migrator._insert_target_batch_strictly.assert_called_once()
        # Verify transaction was never committed, guaranteeing target inserts are discarded
        self.assertEqual(mock_conn.commit.call_count, 0)
        self.assertEqual(mock_conn.rollback.call_count, 1)

    def test_successful_checkpoint_update_one_row_allows_transaction_commit(self):
        """4. Verify that a successful checkpoint update affecting exactly one row allows normal commit."""
        migrator, mock_conn, mock_cur = self._setup_migrator(checkpoint_rowcount=1)

        migrator._migrate_single_source("fnf_option_quotes_history")

        # Verify batch committed cleanly
        mock_conn.commit.assert_called_once()
        mock_conn.rollback.assert_not_called()

    def test_market_depth_fields_defined_as_bigint_null(self):
        """5. Verify that both market-depth fields in Phase B DDL are defined as BIGINT NULL."""
        from historical_market_data_migrator import HistoricalMarketDataMigrator
        migrator = HistoricalMarketDataMigrator(env={})
        mock_conn = MagicMock()
        mock_cur = MagicMock()
        mock_conn.cursor.return_value.__enter__.return_value = mock_cur
        migrator._get_connection = MagicMock(return_value=mock_conn)
        migrator._ensure_checkpoint_seeded = MagicMock()

        # Target columns absent to trigger column addition
        mock_cur.fetchall.side_effect = [
            [], # SHOW COLUMNS FROM unified_option_quotes_history (none exist)
            []  # SHOW INDEX FROM unified_option_quotes_history (none exist)
        ]

        migrator.apply_phase_b_ddl(confirmed=True)

        executed_statements = [call[0][0] for call in mock_cur.execute.call_args_list]

        # Verify bidDepth added as BIGINT NULL
        bid_depth_stmt = next((s for s in executed_statements if "ADD COLUMN bidDepth" in s), None)
        self.assertIsNotNone(bid_depth_stmt, "bidDepth ADD COLUMN statement must be present")
        self.assertIn("BIGINT NULL", bid_depth_stmt)
        self.assertNotIn("INT NULL", bid_depth_stmt.replace("BIGINT NULL", ""))

        # Verify askDepth added as BIGINT NULL
        ask_depth_stmt = next((s for s in executed_statements if "ADD COLUMN askDepth" in s), None)
        self.assertIsNotNone(ask_depth_stmt, "askDepth ADD COLUMN statement must be present")
        self.assertIn("BIGINT NULL", ask_depth_stmt)
        self.assertNotIn("INT NULL", ask_depth_stmt.replace("BIGINT NULL", ""))

    def test_exception_handling_does_not_suppress_fencing_failure(self):
        """6. Verify that outer exception handling does not suppress fencing failure or commit."""
        from historical_market_data_migrator import WorkerLeaseLostError
        # Test when checkpoint update affects unexpected number of rows (>1 or 0)
        for bad_rowcount in [0, 2]:
            with self.subTest(rowcount=bad_rowcount):
                migrator, mock_conn, mock_cur = self._setup_migrator(checkpoint_rowcount=bad_rowcount)

                # Exception must propagate out of _migrate_single_source without being swallowed
                with self.assertRaises(WorkerLeaseLostError):
                    migrator._migrate_single_source("fnf_option_quotes_history")

                # Must never commit
                self.assertEqual(mock_conn.commit.call_count, 0)
                # Must roll back
                self.assertEqual(mock_conn.rollback.call_count, 1)


if __name__ == "__main__":
    unittest.main()




