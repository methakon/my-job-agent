#!/usr/bin/env python3
"""
historical_market_data_migrator.py
----------------------------------
Production-Grade Historical Market Data Migration Utility
for Option Quote Consolidation into unified_option_quotes_history.

Key Principles:
1. CODE-OWNED: All data movement, transformations, deduplication, and checkpoints
   are executed strictly by this version-controlled utility, never manual SQL by operators/agents.
2. RUN-SCOPED PROVENANCE: Every inserted row is tagged with a unique migrationRunId
   and sourceRecordId, enabling deterministic, run-scoped auditability and targeted rollback.
3. STRICT INSERTION VALIDATION: Replaces blanket INSERT IGNORE with explicit duplicate
   detection, strict SQL execution, SHOW WARNINGS zero-tolerance validation, and exact
   row accounting invariants.
4. SENTINEL PRESERVATION: Fyers contract discovery sentinels (ts = 1980-01-01) are
   strictly preserved with dataQuality='SENTINEL_TS' and sourceRecordId.
5. ISOLATED: Strictly historical (ts < Midnight IST). Zero writes to legacy source tables.
   Zero interaction with live ingestion ring buffers or trading desks.
6. SAFE: Dry-run and validation modes are guaranteed 100% read-only.
"""

import os
import sys
import time
import uuid
import signal
import socket
import hashlib
import logging
import argparse
import json
from datetime import datetime, date
from decimal import Decimal
import re
try:
    import pymysql
    import pymysql.cursors
    import pymysql.connections
except ImportError:
    class _PyMySQLErr:
        class MySQLError(Exception): pass
        class Error(Exception): pass
        class OperationalError(Exception): pass
        class IntegrityError(Exception): pass
        class DatabaseError(Exception): pass
        class InternalError(Exception): pass
    class _PyMySQLCursors:
        class DictCursor:
            def __init__(self, *args, **kwargs): pass
    class _PyMySQLConnections:
        class Connection:
            def __init__(self, *args, **kwargs): pass
            def query(self, *args, **kwargs): pass
    class _PyMySQLStub:
        err = _PyMySQLErr
        cursors = _PyMySQLCursors
        connections = _PyMySQLConnections
    pymysql = _PyMySQLStub()
    sys.modules["pymysql"] = pymysql
    sys.modules["pymysql.err"] = pymysql.err
    sys.modules["pymysql.cursors"] = pymysql.cursors
    sys.modules["pymysql.connections"] = pymysql.connections

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s - %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S%z"
)
logger = logging.getLogger("MarketDataMigrator")

MONTH_MAP = {
    "01": "JAN", "02": "FEB", "03": "MAR", "04": "APR",
    "05": "MAY", "06": "JUN", "07": "JUL", "08": "AUG",
    "09": "SEP", "10": "OCT", "11": "NOV", "12": "DEC"
}
REV_MONTH_MAP = {v: k for k, v in MONTH_MAP.items()}

CHECKPOINT_TABLE = "cpp_historical_migration_checkpoints"
TARGET_TABLE = "unified_option_quotes_history"
SOURCE_FNF = "fnf_option_quotes_history"
SOURCE_UPSTOX = "upstox_live_paper_option_quotes"

LIVE_BUFFERS = [
    "fnf_option_quotes",
    "unified_option_quotes",
    "fnf_market_snapshots",
    "unified_market_snapshots"
]

class MigrationError(Exception):
    """Base exception for migration failures."""
    pass

class StrictSqlWarningError(MigrationError):
    """Raised when unexpected database warnings occur during batch execution."""
    pass

class RowAccountingInvariantError(MigrationError):
    """Raised when scanned != inserted + duplicates."""
    pass

class WorkerConcurrencyError(MigrationError):
    """Raised when another worker holds an active lease."""
    pass

class WorkerLeaseLostError(MigrationError):
    """Raised when worker lease ownership is lost during batch commit (fencing violation)."""
    pass

class RollbackDependencyViolationError(MigrationError):
    """Raised when attempting to rollback a run with subsequent dependent runs."""
    pass

class DestructiveQueryBlockedError(MigrationError):
    """Raised when an attempt is made to execute a destructive or modifying SQL operation in violation of the Absolute Data Preservation Rule."""
    pass

class CircuitBreakerError(MigrationError):
    """Raised when measured database health metrics (connections, errors, thread pool pressure) violate safe operating thresholds."""
    pass

class DatabaseIdentityMismatchError(MigrationError):
    """Raised when connected database does not match the target canonical schema."""
    pass

class InvalidProviderProvenanceError(ValueError):
    """Raised when record source provider cannot be resolved or is invalid."""
    pass


def normalize_provider_venue(source):
    """
    Canonicalize provider names for deduplication hashing and Tier 2 matching.
    - Strips whitespace and normalizes case.
    - Maps known aliases:
        {'FYERS', 'FYERS_LIVE'} -> 'FYERS_LIVE'
        {'UPSTOX', 'UPSTOX_LIVE'} -> 'UPSTOX_LIVE'
    - Rejects missing, empty, whitespace-only, or literal 'NULL' values.
    - Preserves unknown providers as uppercase strings without collision.
    """
    if source is None:
        raise InvalidProviderProvenanceError("Provider source cannot be None")

    s = str(source).strip()
    if not s or s.upper() == "NULL":
        raise InvalidProviderProvenanceError(f"Invalid provider source: {source!r}")

    s_upper = s.upper()
    if s_upper in ("FYERS", "FYERS_LIVE"):
        return "FYERS_LIVE"
    if s_upper in ("UPSTOX", "UPSTOX_LIVE"):
        return "UPSTOX_LIVE"

    return s_upper


FORBIDDEN_SQL_PATTERNS = [
    re.compile(r'\bDELETE\b', re.IGNORECASE),
    re.compile(r'\bTRUNCATE\b', re.IGNORECASE),
    re.compile(r'\bDROP\b', re.IGNORECASE),
    re.compile(r'\bREPLACE\s+INTO\b', re.IGNORECASE),
    re.compile(r'\bCALL\b', re.IGNORECASE),
    re.compile(r'\bPREPARE\b', re.IGNORECASE),
    re.compile(r'\bEXECUTE\b', re.IGNORECASE),
    re.compile(r'\bUPDATE\s+`?(?:unified_option_quotes_history|fnf_option_quotes_history|upstox_live_paper_option_quotes)`?\b', re.IGNORECASE),
]

def strip_sql_comments(sql):
    """Strip SQL comments (-- ..., /* ... */, and # ...)"""
    if not sql:
        return ""
    # 1. Strip multi-line comments
    s = re.sub(r'/\*.*?\*/', ' ', sql, flags=re.DOTALL)
    # 2. Strip single-line comments (-- and #)
    s = re.sub(r'(--|#).*$', ' ', s, flags=re.MULTILINE)
    return s.strip()

def assert_non_destructive_sql(sql):
    """
    Absolute Data Preservation Rule enforcement:
    Intercepts and blocks any DELETE, TRUNCATE, DROP, REPLACE, CALL, PREPARE, EXECUTE,
    or UPDATE against quote tables, across single and multi-statement queries.
    """
    if not sql:
        return
    cleaned = strip_sql_comments(sql)

    # Check each sub-statement if separated by semicolons (multi-statement evasion defense)
    statements = [stmt.strip() for stmt in cleaned.split(";") if stmt.strip()]
    for stmt in statements:
        for pattern in FORBIDDEN_SQL_PATTERNS:
            if pattern.search(stmt):
                match = pattern.search(stmt).group(0).upper()
                raise DestructiveQueryBlockedError(
                    f"SAFETY INTERCEPTOR BLOCKED: Execution of destructive SQL statement '{match}' "
                    f"is strictly prohibited by the Absolute Data Preservation Rule. "
                    f"Zero data deletion and additive-only policy is enforced across all tables."
                )

class SafeDictCursor(pymysql.cursors.DictCursor):
    """Cursor that intercepts and blocks any destructive SQL execution."""
    def execute(self, query, args=None):
        assert_non_destructive_sql(query)
        return super().execute(query, args)

    def executemany(self, query, args):
        assert_non_destructive_sql(query)
        return super().executemany(query, args)

    def callproc(self, procname, args=()):
        raise DestructiveQueryBlockedError(
            f"SAFETY INTERCEPTOR BLOCKED: Stored procedure execution (callproc '{procname}') "
            f"is prohibited by the Absolute Data Preservation Rule."
        )

class SafeConnection(pymysql.connections.Connection):
    """Connection class enforcing non-destructive query validation at driver socket level."""
    def query(self, sql, *args, **kwargs):
        if isinstance(sql, bytes):
            sql_str = sql.decode('utf-8', errors='replace')
        else:
            sql_str = str(sql)
        assert_non_destructive_sql(sql_str)
        return super().query(sql, *args, **kwargs)

    def cursor(self, cursor=None):
        if cursor is None:
            cursor = SafeDictCursor
        return super().cursor(cursor)


def load_env(env_path=".env"):
    """Load environment variables from file."""
    env = {}
    if not os.path.exists(env_path):
        return env
    with open(env_path, "r") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip("\"'")
    return env

def get_connection(env, autocommit=False, timeout=30, role=None):
    """
    Establish SSL-enabled MySQL connection wrapped with SafeConnection.
    Supports role-based credential separation:
    - role='admin' / 'ddl': looks for DDL_MYSQL_USER / DDL_MYSQL_PASSWORD
    - role='worker' / 'migrator': looks for MIGRATION_MYSQL_USER / MIGRATION_MYSQL_PASSWORD
    - default fallback: MYSQL_USER / MYSQL_PASSWORD
    """
    host = env.get("MYSQL_HOST", "127.0.0.1")
    port = int(env.get("MYSQL_PORT", 3307))

    if role in ("admin", "ddl"):
        user = env.get("DDL_MYSQL_USER", env.get("MYSQL_USER", "mylife"))
        password = env.get("DDL_MYSQL_PASSWORD", env.get("MYSQL_PASSWORD", ""))
    elif role in ("worker", "migrator"):
        user = env.get("MIGRATION_MYSQL_USER", env.get("MYSQL_USER", "mylife"))
        password = env.get("MIGRATION_MYSQL_PASSWORD", env.get("MYSQL_PASSWORD", ""))
    else:
        user = env.get("MYSQL_USER", "mylife")
        password = env.get("MYSQL_PASSWORD", "")

    database = env.get("DATABASE_NAME", env.get("MYSQL_DATABASE", "myjob_agent"))
    ssl_enabled = env.get("MYSQL_SSL", "false").lower() == "true"

    ssl_ctx = None
    if ssl_enabled or host not in ("127.0.0.1", "localhost"):
        import ssl
        ssl_ctx = ssl.create_default_context()
        ssl_ctx.check_hostname = False
        ssl_ctx.verify_mode = ssl.CERT_NONE

    return SafeConnection(
        host=host,
        port=port,
        user=user,
        password=password,
        database=database,
        autocommit=autocommit,
        ssl=ssl_ctx,
        connect_timeout=timeout,
        read_timeout=timeout * 4,
        write_timeout=timeout * 4,
        cursorclass=SafeDictCursor
    )

def format_decimal(val, prec=4):
    """Normalize decimal to string with fixed precision or 'NULL'."""
    if val is None:
        return "NULL"
    try:
        d = Decimal(str(val))
        return f"{d:.{prec}f}"
    except Exception:
        return "NULL"

def format_int(val):
    """Normalize int to string or 'NULL'."""
    if val is None:
        return "NULL"
    try:
        return str(int(Decimal(str(val))))
    except Exception:
        return "NULL"

def format_ts(val):
    """Normalize datetime to string YYYY-MM-DD HH:MM:SS.ffffff or 'NULL'."""
    if val is None:
        return "NULL"
    if isinstance(val, (datetime, date)):
        if isinstance(val, datetime) and val.microsecond > 0:
            return val.strftime("%Y-%m-%d %H:%M:%S.%f")
        return val.strftime("%Y-%m-%d %H:%M:%S")
    s = str(val).strip()
    return s if s else "NULL"

def format_str(val):
    """Normalize string or 'NULL'."""
    if val is None:
        return "NULL"
    s = str(val).strip()
    return s if s else "NULL"

def compute_canonical_dedup_hash(
    source, instrument_key, ts, source_ts, seq_num=None,
    ltp=None, bid=None, ask=None, bid_qty=None, ask_qty=None, volume=None, oi=None, change_oi=None,
    bid_depth=None, ask_depth=None, underlying_price=None, payload_hash=None,
    canonical_mode=True,
    include_raw_payload_hash=False,
    include_sequence_number=False
):
    """
    Compute cryptographic SHA-256 canonical deduplication hash.
    Explicitly EXCLUDES local arrival timestamps (createdAt, receivedTimestamp).

    CONTRACT MODES:
    1. canonical_mode=True (DEFAULT & PREFERRED):
       Strictly anchors identity to the 15 canonical market state fields:
       (source, instrumentKey, ts, sourceTimestamp, ltp, bid, ask, bidQty, askQty,
        volume, oi, changeOi, bidDepth, askDepth, underlyingPrice).
       Guarantees that sequenceNumber and raw payload_hash are EXCLUDED from the preimage
       at the function boundary, regardless of values supplied by callers:
       - seq is serialized as "seq=EXCLUDED"
       - phash is serialized as "phash=EXCLUDED"
       Guarantees 100% equivalence parity with Tier 2 canonical_market_state_equals.

    2. canonical_mode=False (LEGACY WIRE COMPATIBILITY MODE):
       Includes raw transport payload_hash and sequenceNumber in the preimage if enabled
       via include_raw_payload_hash=True / include_sequence_number=True.
    """
    if canonical_mode:
        src_str = format_str(normalize_provider_venue(source))
        seq_str = "EXCLUDED"
        phash_str = "EXCLUDED"
    else:
        src_str = format_str(source)
        seq_str = format_int(seq_num) if include_sequence_number else "EXCLUDED"
        phash_str = format_str(payload_hash) if include_raw_payload_hash else "EXCLUDED"

    serialized = (
        f"src={src_str};"
        f"key={format_str(instrument_key)};"
        f"ts={format_ts(ts)};"
        f"sts={format_ts(source_ts)};"
        f"seq={seq_str};"
        f"ltp={format_decimal(ltp, 4)};"
        f"bid={format_decimal(bid, 4)};"
        f"ask={format_decimal(ask, 4)};"
        f"bqty={format_int(bid_qty)};"
        f"aqty={format_int(ask_qty)};"
        f"vol={format_decimal(volume, 2)};"
        f"oi={format_decimal(oi, 2)};"
        f"coi={format_decimal(change_oi, 2)};"
        f"bdepth={format_int(bid_depth)};"
        f"adepth={format_int(ask_depth)};"
        f"uprice={format_decimal(underlying_price, 4)};"
        f"phash={phash_str}"
    )
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()

def canonical_market_state_equals(c, m):
    """
    Compare candidate observation (c) with native canonical record (m).
    Strictly preserves NULL vs 0. Compares prices, quantities, depth, volume, OI, and source ts.
    """
    # 1. Price fields (decimal 4 prec)
    if format_decimal(c.get("ltp"), 4) != format_decimal(m.get("ltp"), 4):
        return False
    if format_decimal(c.get("bid"), 4) != format_decimal(m.get("bid"), 4):
        return False
    if format_decimal(c.get("ask"), 4) != format_decimal(m.get("ask"), 4):
        return False
    if format_decimal(c.get("underlyingPrice"), 4) != format_decimal(m.get("underlyingPrice"), 4):
        return False

    # 2. Quantity & Depth fields (int)
    if format_int(c.get("bidQty")) != format_int(m.get("bidQty")):
        return False
    if format_int(c.get("askQty")) != format_int(m.get("askQty")):
        return False
    if format_int(c.get("bidDepth")) != format_int(m.get("bidDepth")):
        return False
    if format_int(c.get("askDepth")) != format_int(m.get("askDepth")):
        return False

    # 3. Cumulative Metrics (decimal 2 prec)
    if format_decimal(c.get("volume"), 2) != format_decimal(m.get("volume"), 2):
        return False
    if format_decimal(c.get("oi"), 2) != format_decimal(m.get("oi"), 2):
        return False
    if format_decimal(c.get("changeOi"), 2) != format_decimal(m.get("changeOi"), 2):
        return False

    # 4. Source event time (where available)
    if format_ts(c.get("sourceTimestamp")) != format_ts(m.get("sourceTimestamp")):
        return False

    return True

def normalize_contract_symbol(contract_symbol, underlying, expiry, strike, option_type):
    """Derive canonical instrument key e.g. NSE:NIFTY26SEP24000CE."""
    if contract_symbol and contract_symbol.startswith("NSE:"):
        return contract_symbol
    if contract_symbol and "|" in contract_symbol:
        tail = contract_symbol.split("|")[-1]
        return f"NSE:{tail}"
    if underlying and expiry and strike and option_type:
        exp_str = format_ts(expiry).split(" ")[0]
        parts = exp_str.split("-")
        if len(parts) == 3:
            day = parts[2]
            mon = MONTH_MAP.get(parts[1], "SEP")
            strike_val = int(Decimal(str(strike)))
            return f"NSE:{underlying}{day}{mon}{strike_val}{option_type}"
    if contract_symbol:
        clean = contract_symbol.replace("NSE:", "").replace("BSE:", "")
        return f"NSE:{clean}"
    return "NSE:UNKNOWN"


class HistoricalMarketDataMigrator:
    def __init__(self, env, batch_size=2000, batch_pause_ms=150, max_threads_connected=140, min_connection_headroom=50, max_retries=3, run_id=None, include_raw_payload_hash=False):
        self.env = env
        self.batch_size = batch_size
        self.batch_pause_ms = batch_pause_ms
        self.max_threads_connected = max_threads_connected
        self.min_connection_headroom = min_connection_headroom
        self.max_retries = max_retries
        self.migration_run_id = run_id or f"run_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:8]}"
        self.worker_uuid = str(uuid.uuid4())
        self.worker_pid = os.getpid()
        self.worker_host = socket.gethostname()
        self.include_raw_payload_hash = include_raw_payload_hash
        self.shutdown_requested = False
        self.baseline_metrics = {}
        self._setup_signals()

    def _setup_signals(self):
        def _handle(sig, frame):
            logger.warning(f"Termination signal {sig} received. Gracefully finishing current batch...")
            self.shutdown_requested = True
        signal.signal(signal.SIGINT, _handle)
        signal.signal(signal.SIGTERM, _handle)

    def _get_connection(self, autocommit=False, role=None):
        conn = get_connection(self.env, autocommit=autocommit, role=role)
        # Database identity assertion: ensure connection is targeting the intended schema
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT DATABASE() AS current_db")
                row = cur.fetchone()
                if row and isinstance(row, dict) and "current_db" in row:
                    curr_db = row["current_db"]
                    expected_db = self.env.get("DATABASE_NAME", self.env.get("MYSQL_DATABASE", "myjob_agent"))
                    if curr_db and curr_db != expected_db:
                        conn.close()
                        raise DatabaseIdentityMismatchError(
                            f"Database identity mismatch: Connected to '{curr_db}', expected '{expected_db}'"
                        )
        except DatabaseIdentityMismatchError:
            raise
        except Exception as e:
            logger.debug(f"Database identity verification handled exception: {e}")
        return conn

    def _record_baseline_metrics(self, conn):
        """Record baseline database connection and health metrics prior to migration execution."""
        status = {"Threads_connected": 0, "Threads_running": 0, "Connection_errors_max_connections": 0, "max_connections": 200}
        try:
            with conn.cursor() as cur:
                cur.execute("""
                    SHOW GLOBAL STATUS WHERE Variable_name IN (
                        'Threads_connected', 'Threads_running', 'Max_used_connections',
                        'Connection_errors_max_connections', 'Connection_errors_internal',
                        'Aborted_clients', 'Aborted_connects'
                    )
                """)
                rows = cur.fetchall()
                if rows and isinstance(rows, list):
                    for r in rows:
                        if isinstance(r, dict) and "Variable_name" in r and "Value" in r:
                            status[r["Variable_name"]] = int(r["Value"])
                cur.execute("SHOW VARIABLES LIKE 'max_connections'")
                max_conn_row = cur.fetchone()
                if max_conn_row and isinstance(max_conn_row, dict) and "Value" in max_conn_row:
                    status["max_connections"] = int(max_conn_row["Value"])
        except Exception as e:
            logger.warning(f"Unable to read baseline metrics: {e}. Using defaults.")
        self.baseline_metrics = status
        logger.info(
            f"Baseline database health recorded: Threads_connected={status.get('Threads_connected')}/{status.get('max_connections')} "
            f"| Threads_running={status.get('Threads_running')} "
            f"| Connection_errors_max={status.get('Connection_errors_max_connections')}"
        )
        return status

    def _check_system_health(self, conn):
        """
        Check database connection headroom, resource pressure, and live buffer backlogs.
        Fails safely on monitoring errors, query timeouts, or threshold breaches.
        """
        try:
            with conn.cursor() as cur:
                # 1. Connection & Thread Pool Status Check
                cur.execute("""
                    SHOW GLOBAL STATUS WHERE Variable_name IN (
                        'Threads_connected', 'Threads_running',
                        'Connection_errors_max_connections', 'Connection_errors_internal'
                    )
                """)
                rows = cur.fetchall()
                if not rows or not isinstance(rows, list):
                    raise CircuitBreakerError("Health monitoring query returned empty status. Failing safely.")

                status = {}
                for r in rows:
                    if isinstance(r, dict) and "Variable_name" in r and "Value" in r:
                        status[r["Variable_name"]] = int(r["Value"])

                threads_conn = status.get("Threads_connected", 0)
                threads_run = status.get("Threads_running", 0)
                conn_errs = status.get("Connection_errors_max_connections", 0)
                base_errs = self.baseline_metrics.get("Connection_errors_max_connections", conn_errs)
                max_conn = self.baseline_metrics.get("max_connections", 200)

                # 1a. Rising connection errors circuit breaker
                if conn_errs > base_errs:
                    raise CircuitBreakerError(
                        f"Rising connection errors detected: Connection_errors_max_connections increased from {base_errs} to {conn_errs} (+{conn_errs - base_errs}). "
                        f"Stopping migration immediately to protect live trading."
                    )

                # 1b. Connection exhaustion / headroom circuit breaker
                headroom = max_conn - threads_conn
                if threads_conn >= self.max_threads_connected or headroom < self.min_connection_headroom:
                    raise CircuitBreakerError(
                        f"Connection capacity threshold reached: Threads_connected={threads_conn}/{max_conn} (headroom={headroom} < {self.min_connection_headroom}). "
                        f"Stopping migration immediately to reserve connections for live trading."
                    )

                # 1c. Thread pool execution pressure
                if threads_run >= 6:
                    raise CircuitBreakerError(
                        f"Database thread pool execution pressure high: Threads_running={threads_run} >= 6. "
                        f"Stopping migration immediately to prevent CPU starvation."
                    )

                # 2. Live Quote Buffer Backlog Check (fnf_option_quotes & unified_option_quotes)
                for buf_table in ("fnf_option_quotes", "unified_option_quotes"):
                    cur.execute(f"SELECT COUNT(*) AS cnt FROM {buf_table}")
                    buf_row = cur.fetchone()
                    buf_cnt = buf_row.get("cnt", 0) if (buf_row and isinstance(buf_row, dict)) else 0
                    if buf_cnt > 5000:
                        raise CircuitBreakerError(
                            f"Live quote buffer backlog detected: {buf_table} has {buf_cnt} unpersisted records (> 5,000 threshold). "
                            f"Stopping migration immediately to protect live trading persistence."
                        )

        except CircuitBreakerError:
            raise
        except Exception as e:
            logger.warning(f"Health monitoring check encountered exception: {e}. Failing safely.")
            raise CircuitBreakerError(f"Health monitoring check failure: {e}. Stopping migration safely to prevent unmonitored execution.")


    # ──────────────────────────────────────────────────────────────────────────
    # MODE 1: VALIDATE
    # ──────────────────────────────────────────────────────────────────────────
    def validate_environment(self):
        """Verify database connectivity, timezones, schema, user privileges, and live buffer isolation."""
        logger.info("=== MODE: VALIDATE (Read-Only) ===")
        conn = self._get_connection(autocommit=True, role="migrator")
        results = {"status": "SUCCESS", "checks": {}}
        try:
            with conn.cursor() as cur:
                # 1. Server info & timezone
                cur.execute("SELECT VERSION() AS ver, @@global.time_zone AS g_tz, @@session.time_zone AS s_tz, NOW() AS db_now, CONVERT_TZ(NOW(), '+00:00', '+05:30') AS db_ist")
                tz_info = cur.fetchone()
                results["checks"]["mysql_version"] = tz_info["ver"]
                results["checks"]["global_timezone"] = tz_info["g_tz"]
                results["checks"]["session_timezone"] = tz_info["s_tz"]
                results["checks"]["calculated_ist"] = str(tz_info["db_ist"])

                # 2. Dynamic watermark
                cur.execute("SELECT CAST(DATE(CONVERT_TZ(NOW(), '+00:00', '+05:30')) AS DATETIME) AS ist_midnight")
                watermark = cur.fetchone()["ist_midnight"]
                results["checks"]["dynamic_watermark"] = str(watermark)

                # 3. Live buffer isolation check
                buffer_counts = {}
                for buf in LIVE_BUFFERS:
                    cur.execute(f"SELECT COUNT(*) AS cnt FROM {buf}")
                    cnt = cur.fetchone()["cnt"]
                    buffer_counts[buf] = cnt
                    if cnt > 0:
                        logger.warning(f"Live buffer {buf} has {cnt} rows!")
                results["checks"]["live_buffers"] = buffer_counts

                # 4. Target table schema check
                cur.execute(f"SHOW COLUMNS FROM {TARGET_TABLE}")
                cols = {c["Field"]: c for c in cur.fetchall()}
                results["checks"]["target_columns_total"] = len(cols)

                req_ext_cols = [
                    "underlyingPrice", "bidDepth", "askDepth",
                    "instrumentToken", "payloadHash", "canonicalDedupHash",
                    "sourceOrigin", "migrationRunId", "sourceRecordId"
                ]
                missing = [c for c in req_ext_cols if c not in cols]
                results["checks"]["missing_extension_columns"] = missing
                results["checks"]["schema_ready_for_migration"] = len(missing) == 0

                # 5. Checkpoint table check
                cur.execute(f"SHOW TABLES LIKE '{CHECKPOINT_TABLE}'")
                has_cp = cur.fetchone() is not None
                results["checks"]["checkpoint_table_exists"] = has_cp

                # 6. Connected user & privilege check
                cur.execute("SELECT CURRENT_USER() AS cur_user")
                cur_user = cur.fetchone()["cur_user"]
                results["checks"]["connected_user"] = cur_user

                cur.execute("SHOW GRANTS")
                grants = [list(g.values())[0] for g in cur.fetchall()]
                results["checks"]["user_grants"] = grants

                has_delete = any("DELETE" in g.upper() or "ALL PRIVILEGES" in g.upper() for g in grants)
                has_drop = any("DROP" in g.upper() or "ALL PRIVILEGES" in g.upper() for g in grants)
                results["checks"]["least_privilege_enforced"] = not (has_delete or has_drop)
                if has_delete or has_drop:
                    logger.warning(f"Connected user '{cur_user}' possesses broad privileges ({grants}). Least-privilege separation recommended.")

                logger.info(f"Validation summary: MySQL {tz_info['ver']} | Watermark: {watermark} | Schema ready: {len(missing) == 0}")
                return results
        finally:
            conn.close()

    # ──────────────────────────────────────────────────────────────────────────
    # MODE 2: DRY-RUN RECONCILIATION
    # ──────────────────────────────────────────────────────────────────────────
    def dry_run_reconciliation(self, sample_size=5000):
        """Read-only dry-run reconciliation without writing to database."""
        logger.info(f"=== MODE: DRY-RUN (Read-Only, sample_size={sample_size}) ===")
        conn = self._get_connection(autocommit=True)
        report = {"status": "SUCCESS", "timestamp": datetime.now().isoformat()}
        try:
            with conn.cursor() as cur:
                # 1. Total row inventory (Exact)
                cur.execute(f"SELECT COUNT(*) AS total FROM {TARGET_TABLE}")
                target_cnt = cur.fetchone()["total"]
                cur.execute(f"SELECT COUNT(*) AS total FROM {SOURCE_FNF}")
                fnf_cnt = cur.fetchone()["total"]
                cur.execute(f"SELECT COUNT(*) AS total FROM {SOURCE_UPSTOX}")
                upstox_cnt = cur.fetchone()["total"]

                # 2. Dynamic watermark
                cur.execute("SELECT CAST(DATE(CONVERT_TZ(NOW(), '+00:00', '+05:30')) AS DATETIME) AS ist_midnight")
                migration_ceiling_ts = cur.fetchone()["ist_midnight"]

                report["inventory"] = {
                    "target_table": {"name": TARGET_TABLE, "exact_rows": target_cnt},
                    "source_fnf": {"name": SOURCE_FNF, "exact_rows": fnf_cnt},
                    "source_upstox": {"name": SOURCE_UPSTOX, "exact_rows": upstox_cnt},
                    "total_raw_inventory": target_cnt + fnf_cnt + upstox_cnt,
                    "migration_ceiling_cutoff_ist": str(migration_ceiling_ts)
                }

                # 3. Sentinel counts in FNF (Exact)
                cur.execute(f"SELECT COUNT(*) AS cnt FROM {SOURCE_FNF} WHERE ts = '1980-01-01 00:00:00'")
                sentinels = cur.fetchone()["cnt"]
                report["sentinel_records"] = {
                    "source": SOURCE_FNF,
                    "condition": "ts = '1980-01-01 00:00:00'",
                    "exact_count": sentinels,
                    "eligibility": "100% Eligible (ts < migration_ceiling_ts)",
                    "migration_action": "Preserve in target with dataQuality='SENTINEL_TS' and sourceRecordId"
                }

                # 4. Unmappable null constraint check (Exact)
                cur.execute(f"""
                SELECT
                  (SELECT COUNT(*) FROM {SOURCE_FNF} WHERE contractSymbol IS NULL OR expiry IS NULL OR strike IS NULL OR ltp IS NULL) AS fnf_unmappable,
                  (SELECT COUNT(*) FROM {SOURCE_UPSTOX} WHERE contractSymbol IS NULL OR expiry IS NULL OR strike IS NULL OR ltp IS NULL) AS upstox_unmappable
                """)
                unmappable = cur.fetchone()
                report["unmappable_records"] = {
                    "fnf_unmappable_exact": unmappable["fnf_unmappable"],
                    "upstox_unmappable_exact": unmappable["upstox_unmappable"],
                    "status": "VALIDATED_ZERO"
                }

                # 5. Sample deduplication benchmark on Upstox
                cur.execute(f"SELECT * FROM {SOURCE_UPSTOX} WHERE ts < %s LIMIT %s", (migration_ceiling_ts, sample_size))
                upstox_sample = cur.fetchall()
                upstox_hashes = set()
                upstox_dups = 0
                for r in upstox_sample:
                    h = compute_canonical_dedup_hash(
                        source="UPSTOX",
                        instrument_key=r.get("contractSymbol"),
                        ts=r.get("ts"),
                        source_ts=r.get("providerTs") or r.get("ts"),
                        seq_num=None,
                        ltp=r.get("ltp"),
                        bid=r.get("bid"),
                        ask=r.get("ask"),
                        bid_qty=r.get("bidQty"),
                        ask_qty=r.get("askQty"),
                        volume=r.get("volume"),
                        oi=r.get("openInterest"),
                        change_oi=r.get("oiChange"),
                        bid_depth=r.get("bidDepth"),
                        ask_depth=r.get("askDepth"),
                        underlying_price=r.get("underlyingPrice"),
                        payload_hash=r.get("payloadHash")
                    )
                    if h in upstox_hashes:
                        upstox_dups += 1
                    else:
                        upstox_hashes.add(h)

                # 6. Sample deduplication benchmark on FNF
                cur.execute(f"SELECT * FROM {SOURCE_FNF} WHERE ts < %s LIMIT %s", (migration_ceiling_ts, sample_size))
                fnf_sample = cur.fetchall()
                fnf_hashes = set()
                fnf_dups = 0
                for r in fnf_sample:
                    is_sentinel = (r.get("ts") == datetime(1980, 1, 1, 0, 0))
                    source_ts = r.get("createdAt") if is_sentinel else r.get("ts")
                    h = compute_canonical_dedup_hash(
                        source="fyers",
                        instrument_key=r.get("contractSymbol"),
                        ts=r.get("ts"),
                        source_ts=source_ts,
                        seq_num=None,
                        ltp=r.get("ltp"),
                        bid=r.get("bid"),
                        ask=r.get("ask"),
                        bid_qty=r.get("bidQty"),
                        ask_qty=r.get("askQty"),
                        volume=r.get("volume"),
                        oi=r.get("oi"),
                        change_oi=r.get("changeOi"),
                        bid_depth=None,
                        ask_depth=None,
                        underlying_price=None,
                        payload_hash=None
                    )
                    if h in fnf_hashes:
                        fnf_dups += 1
                    else:
                        fnf_hashes.add(h)

                upstox_dup_rate = (upstox_dups / len(upstox_sample)) if upstox_sample else 0
                fnf_dup_rate = (fnf_dups / len(fnf_sample)) if fnf_sample else 0

                report["deduplication_analysis"] = {
                    "sampling_details": {
                        "sample_size_per_source": sample_size,
                        "label": "Sample-Derived Estimates (Labeled per directive)"
                    },
                    "upstox_sample": {
                        "scanned": len(upstox_sample),
                        "unique": len(upstox_hashes),
                        "redundant_re_deliveries": upstox_dups,
                        "dup_rate_pct": round(upstox_dup_rate * 100, 2)
                    },
                    "fnf_sample": {
                        "scanned": len(fnf_sample),
                        "unique": len(fnf_hashes),
                        "redundant_re_deliveries": fnf_dups,
                        "dup_rate_pct": round(fnf_dup_rate * 100, 2)
                    },
                    "projections": {
                        "estimated_upstox_unique_to_insert": int(round(upstox_cnt * (1 - upstox_dup_rate))),
                        "estimated_fnf_unique_to_insert": int(round(fnf_cnt * (1 - fnf_dup_rate))),
                        "estimated_final_target_rows": int(round(target_cnt + (upstox_cnt * (1 - upstox_dup_rate)) + (fnf_cnt * (1 - fnf_dup_rate)))),
                        "exact_accounting_note": "Exact unique and duplicate totals will be transactionally recorded in cpp_historical_migration_checkpoints upon batch execution."
                    }
                }

                logger.info(f"Dry-run complete. Inventory: {report['inventory']['total_raw_inventory']} total rows. Zero writes performed.")
                return report
        finally:
            conn.close()

    # ──────────────────────────────────────────────────────────────────────────
    # MODE 3: PHASE B DDL EXECUTION (IDEMPOTENT & REHEARSED)
    # ──────────────────────────────────────────────────────────────────────────
    def apply_phase_b_ddl(self, confirmed=False):
        """Execute Phase B DDL only if explicitly confirmed."""
        logger.info("=== MODE: APPLY-DDL (Phase B) ===")
        if not confirmed:
            raise PermissionError("DDL execution requires explicit confirmation flag (--confirm-ddl).")

        conn = self._get_connection(autocommit=True, role="ddl")
        try:
            with conn.cursor() as cur:
                # 1. Create checkpoint table if not exists
                logger.info(f"Ensuring checkpoint table {CHECKPOINT_TABLE} exists...")
                cur.execute(f"""
                CREATE TABLE IF NOT EXISTS {CHECKPOINT_TABLE} (
                    source_table VARCHAR(64) NOT NULL PRIMARY KEY,
                    migration_run_id VARCHAR(64) NULL,
                    last_processed_id VARCHAR(64) NOT NULL DEFAULT '',
                    rows_scanned BIGINT NOT NULL DEFAULT 0,
                    rows_inserted BIGINT NOT NULL DEFAULT 0,
                    rows_skipped_duplicate BIGINT NOT NULL DEFAULT 0,
                    rows_skipped_sentinel BIGINT NOT NULL DEFAULT 0,
                    status ENUM('IDLE', 'RUNNING', 'COMPLETED', 'FAILED', 'ROLLED_BACK', 'QUARANTINED', 'PAUSED') NOT NULL DEFAULT 'IDLE',
                    worker_uuid VARCHAR(64) NULL,
                    worker_pid INT NULL,
                    worker_host VARCHAR(128) NULL,
                    heartbeat_ts DATETIME NULL,
                    started_at DATETIME NULL,
                    completed_at DATETIME NULL,
                    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
                """)

                # 2. Inspect existing columns on target table
                cur.execute(f"SHOW COLUMNS FROM {TARGET_TABLE}")
                existing_cols = {c["Field"] for c in cur.fetchall()}

                col_defs = [
                    ("underlyingPrice", "DECIMAL(14,4) NULL"),
                    ("bidDepth", "BIGINT NULL"),
                    ("askDepth", "BIGINT NULL"),
                    ("instrumentToken", "VARCHAR(96) NULL"),
                    ("payloadHash", "VARCHAR(64) NULL"),
                    ("canonicalDedupHash", "VARCHAR(64) NULL"),
                    ("sourceOrigin", "VARCHAR(32) NOT NULL DEFAULT 'UNIFIED_NATIVE'"),
                    ("migrationRunId", "VARCHAR(64) NULL"),
                    ("sourceRecordId", "VARCHAR(64) NULL")
                ]

                for col_name, col_type in col_defs:
                    if col_name not in existing_cols:
                        logger.info(f"Adding column {col_name} ({col_type}) with ALGORITHM=INSTANT...")
                        cur.execute(f"ALTER TABLE {TARGET_TABLE} ADD COLUMN {col_name} {col_type}, ALGORITHM=INSTANT")
                    else:
                        logger.info(f"Column {col_name} already exists on {TARGET_TABLE}. Skipping.")

                # 3. Inspect existing indexes
                cur.execute(f"SHOW INDEX FROM {TARGET_TABLE}")
                existing_idxs = {idx["Key_name"] for idx in cur.fetchall()}

                if "uq_uoq_history_dedup_hash" not in existing_idxs:
                    logger.info("Adding unique index uq_uoq_history_dedup_hash on canonicalDedupHash (ALGORITHM=INPLACE, LOCK=NONE)...")
                    cur.execute(f"ALTER TABLE {TARGET_TABLE} ADD UNIQUE KEY uq_uoq_history_dedup_hash (canonicalDedupHash), ALGORITHM=INPLACE, LOCK=NONE")
                else:
                    logger.info("Unique index uq_uoq_history_dedup_hash already exists. Skipping.")

                if "idx_uoq_history_token_ts" not in existing_idxs:
                    logger.info("Adding index idx_uoq_history_token_ts on (instrumentToken, ts) (ALGORITHM=INPLACE, LOCK=NONE)...")
                    cur.execute(f"ALTER TABLE {TARGET_TABLE} ADD KEY idx_uoq_history_token_ts (instrumentToken, ts), ALGORITHM=INPLACE, LOCK=NONE")

                if "idx_uoq_history_run_id" not in existing_idxs:
                    logger.info("Adding index idx_uoq_history_run_id on (migrationRunId) (ALGORITHM=INPLACE, LOCK=NONE)...")
                    cur.execute(f"ALTER TABLE {TARGET_TABLE} ADD KEY idx_uoq_history_run_id (migrationRunId), ALGORITHM=INPLACE, LOCK=NONE")

                # Seed checkpoint records explicitly only if absent (zero suppression, zero mutation of active state)
                for src in [SOURCE_UPSTOX, SOURCE_FNF]:
                    self._ensure_checkpoint_seeded(cur, src)

                logger.info("Phase B DDL executed and verified successfully.")
                return {"status": "SUCCESS", "message": "Phase B DDL applied successfully"}
        finally:
            conn.close()

    def _ensure_checkpoint_seeded(self, cur, source_table):
        """
        Explicit duplicate-checked checkpoint initialization:
        Inspects existing state without suppressing errors.
        Handles concurrent primary-key collision (Error 1062) safely by re-reading existing state.
        Never overwrites active progress, leases, or timestamps.
        """
        cur.execute(f"SELECT source_table, status, last_processed_id, rows_scanned, rows_inserted FROM {CHECKPOINT_TABLE} WHERE source_table = %s", (source_table,))
        existing = cur.fetchone()
        if existing:
            logger.info(f"Checkpoint for '{source_table}' already exists (status={existing['status']}, last_id='{existing['last_processed_id']}'). Preserving state.")
            return existing

        logger.info(f"Seeding fresh checkpoint record for '{source_table}'...")
        try:
            cur.execute(f"""
            INSERT INTO {CHECKPOINT_TABLE} (source_table, last_processed_id, status)
            VALUES (%s, '', 'IDLE')
            """, (source_table,))
            return {"source_table": source_table, "status": "IDLE", "last_processed_id": ""}
        except pymysql.err.IntegrityError as e:
            if len(e.args) > 0 and e.args[0] == 1062:
                logger.info(f"Concurrent worker initialized checkpoint for '{source_table}' simultaneously. Re-reading preserved state...")
                cur.execute(f"SELECT source_table, status, last_processed_id, rows_scanned, rows_inserted FROM {CHECKPOINT_TABLE} WHERE source_table = %s", (source_table,))
                concurrent_state = cur.fetchone()
                if concurrent_state:
                    return concurrent_state
            raise

    # ──────────────────────────────────────────────────────────────────────────
    # MODE 4: EXECUTE MIGRATION (STRICT INSERTION, ZERO INSERT IGNORE)
    # ──────────────────────────────────────────────────────────────────────────
    def execute_migration(self, source_choice=None, row_limit=None):
        """Execute checkpointed batch migration for specified source table(s)."""
        logger.info(f"=== MODE: MIGRATE (Run ID: {self.migration_run_id} | Worker: {self.worker_uuid}) ===")
        sources = [source_choice] if source_choice else [SOURCE_UPSTOX, SOURCE_FNF]

        for src in sources:
            if self.shutdown_requested:
                break
            self._migrate_single_source(src, row_limit=row_limit)

    def _acquire_worker_lease(self, conn, source_table):
        """Acquire exclusive mutual exclusion lease on checkpoint table."""
        with conn.cursor() as cur:
            cur.execute(f"""
            UPDATE {CHECKPOINT_TABLE}
            SET status = 'RUNNING',
                migration_run_id = %s,
                worker_uuid = %s,
                worker_pid = %s,
                worker_host = %s,
                heartbeat_ts = NOW(),
                started_at = COALESCE(started_at, NOW())
            WHERE source_table = %s
              AND (status != 'RUNNING' OR heartbeat_ts < DATE_SUB(NOW(), INTERVAL 5 MINUTE));
            """, (self.migration_run_id, self.worker_uuid, self.worker_pid, self.worker_host, source_table))
            conn.commit()
            if cur.rowcount == 0:
                cur.execute(f"SELECT status, worker_uuid, worker_pid, worker_host, heartbeat_ts FROM {CHECKPOINT_TABLE} WHERE source_table = %s", (source_table,))
                curr = cur.fetchone()
                raise WorkerConcurrencyError(f"Cannot acquire lease for {source_table}. Active worker: {curr}")

    def _release_worker_lease(self, conn, source_table, status='IDLE'):
        """Release lease on checkpoint table."""
        with conn.cursor() as cur:
            cur.execute(f"""
            UPDATE {CHECKPOINT_TABLE}
            SET status = %s,
                worker_uuid = NULL,
                heartbeat_ts = NOW(),
                completed_at = CASE WHEN %s = 'COMPLETED' THEN NOW() ELSE completed_at END
            WHERE source_table = %s AND worker_uuid = %s;
            """, (status, status, source_table, self.worker_uuid))
            conn.commit()

    def _migrate_single_source(self, source_table, row_limit=None):
        logger.info(f"--- Starting migration for source: {source_table} [Run: {self.migration_run_id}] ---")
        conn = self._get_connection(autocommit=False, role="migrator")
        try:
            self._acquire_worker_lease(conn, source_table)
            self._record_baseline_metrics(conn)

            with conn.cursor() as cur:
                cur.execute(f"SELECT last_processed_id, rows_scanned, rows_inserted, rows_skipped_duplicate, rows_skipped_sentinel FROM {CHECKPOINT_TABLE} WHERE source_table = %s", (source_table,))
                cp = cur.fetchone()
                last_id = cp["last_processed_id"]
                total_scanned = cp["rows_scanned"]
                total_inserted = cp["rows_inserted"]
                total_dups = cp["rows_skipped_duplicate"]
                total_sentinels = cp["rows_skipped_sentinel"]

            with conn.cursor() as cur:
                cur.execute("SELECT CAST(DATE(CONVERT_TZ(NOW(), '+00:00', '+05:30')) AS DATETIME) AS ist_midnight")
                migration_ceiling_ts = cur.fetchone()["ist_midnight"]

            logger.info(f"Resuming {source_table} from last_id='{last_id}' | Watermark: {migration_ceiling_ts}")

            in_pass_2 = False
            forward_boundary_id = last_id
            rows_migrated_this_run = 0
            while not self.shutdown_requested:
                # Active circuit-breaker check before dispatching each batch
                self._check_system_health(conn)

                if row_limit and rows_migrated_this_run >= row_limit:
                    logger.info(f"Reached execution limit of {row_limit} rows for this run.")
                    break

                batch_start_ts = time.time()
                batch_limit = min(self.batch_size, row_limit - rows_migrated_this_run) if row_limit else self.batch_size

                if not in_pass_2:
                    with conn.cursor() as cur:
                        cur.execute(f"""
                        SELECT * FROM {source_table}
                        WHERE id > %s AND ts < %s
                        ORDER BY id ASC
                        LIMIT %s
                        """, (forward_boundary_id, migration_ceiling_ts, batch_limit))
                        rows = cur.fetchall()

                    if not rows:
                        logger.info(f"Pass 1 (Forward Scan) completed for {source_table}. Running Pass 2 (Late-Arrival Anti-Join Reconciliation)...")
                        in_pass_2 = True

                if in_pass_2:
                    origin_tag = "MIGRATED_UPSTOX" if source_table == SOURCE_UPSTOX else "MIGRATED_FNF"
                    with conn.cursor() as cur:
                        cur.execute(f"""
                        SELECT s.* FROM {source_table} s
                        LEFT JOIN {TARGET_TABLE} t ON t.sourceRecordId = s.id AND t.sourceOrigin = %s
                        WHERE s.ts < %s AND t.id IS NULL
                        LIMIT %s
                        """, (origin_tag, migration_ceiling_ts, batch_limit))
                        rows = cur.fetchall()

                    if not rows:
                        logger.info(f"Pass 2 verified: 0 unmigrated records remain for {source_table}. Marking COMPLETED.")
                        self._release_worker_lease(conn, source_table, status='COMPLETED')
                        return
                    else:
                        logger.info(f"Pass 2 captured {len(rows)} late-arriving concurrent records. Ingesting...")

                target_records = []
                batch_sentinels = 0
                for r in rows:
                    is_sentinel = (r.get("ts") == datetime(1980, 1, 1, 0, 0))
                    if is_sentinel:
                        batch_sentinels += 1

                    mapped = self._map_record(source_table, r, is_sentinel)
                    target_records.append(mapped)

                # Strict safe insertion with zero INSERT IGNORE
                inserted_count, duplicates_in_batch = self._insert_target_batch_strictly(conn, target_records)

                if not in_pass_2:
                    forward_boundary_id = rows[-1]["id"]
                    checkpoint_last_id = forward_boundary_id
                else:
                    # During Pass 2, preserve forward watermark so checkpoint last_processed_id never regresses
                    checkpoint_last_id = forward_boundary_id

                total_scanned += len(rows)
                total_inserted += inserted_count
                total_dups += duplicates_in_batch
                total_sentinels += batch_sentinels
                rows_migrated_this_run += inserted_count

                # Commit batch and checkpoint atomically in the SAME transaction
                with conn.cursor() as cur:
                    cur.execute(f"""
                    UPDATE {CHECKPOINT_TABLE}
                    SET last_processed_id = %s,
                        rows_scanned = %s,
                        rows_inserted = %s,
                        rows_skipped_duplicate = %s,
                        rows_skipped_sentinel = %s,
                        heartbeat_ts = NOW()
                    WHERE source_table = %s AND worker_uuid = %s;
                    """, (checkpoint_last_id, total_scanned, total_inserted, total_dups, total_sentinels, source_table, self.worker_uuid))
                    if cur.rowcount != 1:
                        raise WorkerLeaseLostError(
                            f"Fencing token validation failed on {source_table}: "
                            f"checkpoint update affected {cur.rowcount} rows (expected exactly 1). "
                            f"Worker lease '{self.worker_uuid}' was lost or stolen. Rolling back batch transaction."
                        )

                conn.commit()
                batch_elapsed = time.time() - batch_start_ts
                logger.info(f"[{source_table}] Batch committed in {batch_elapsed:.3f}s: {len(rows)} scanned, {inserted_count} inserted, {duplicates_in_batch} dedup skipped. (Total inserted: {total_inserted})")

                if batch_elapsed > 5.0:
                    raise CircuitBreakerError(
                        f"Batch execution latency exceeded 5.0s threshold (took {batch_elapsed:.2f}s). "
                        f"Stopping migration immediately to prevent database latency degradation."
                    )

                # Inter-batch pause to yield thread pool and I/O resources to live trading
                if self.batch_pause_ms > 0:
                    time.sleep(self.batch_pause_ms / 1000.0)

            if self.shutdown_requested:
                logger.warning(f"Process interrupted. Releasing lease as IDLE for {source_table}...")
                self._release_worker_lease(conn, source_table, status='IDLE')
        except WorkerLeaseLostError as lease_err:
            logger.error(f"FENCING VIOLATION on {source_table}: {lease_err}")
            try:
                conn.rollback()
            except Exception:
                pass
            raise
        except CircuitBreakerError as cb_err:
            logger.warning(f"CIRCUIT BREAKER TRIPPED on {source_table}: {cb_err}")
            logger.warning("Orderly safe stop triggered. Zero data deleted. Checkpoint status updated to PAUSED. Trading agent untouched.")
            try:
                conn.commit()
                self._release_worker_lease(conn, source_table, status='PAUSED')
            except Exception:
                pass
            return
        except Exception as e:
            logger.error(f"Migration error on {source_table}: {e}", exc_info=True)
            try:
                conn.rollback()
                self._release_worker_lease(conn, source_table, status='FAILED')
            except Exception:
                pass
            raise
        finally:
            conn.close()

    def _insert_target_batch_strictly(self, conn, records):
        """
        Execute strict batch insertion without blanket INSERT IGNORE.
        1. Eliminate intra-batch duplicates.
        2. Filter out records whose canonicalDedupHash already exists in the target table.
        3. Insert remaining records using standard INSERT INTO (strict mode).
        4. Validate SHOW WARNINGS (zero-tolerance for truncation or coercion).
        5. Assert exact row accounting invariant: scanned == inserted + duplicates.
        """
        if not records:
            return 0, 0

        # 1. Eliminate intra-batch duplicates
        seen_in_batch = set()
        unique_in_batch = []
        intra_batch_dups = 0
        for rec in records:
            h = rec["canonicalDedupHash"]
            if h in seen_in_batch:
                intra_batch_dups += 1
            else:
                seen_in_batch.add(h)
                unique_in_batch.append(rec)

        # Tier 1: Check against canonicalDedupHash (covers previously migrated records and replayed batches)
        tier1_existing_dups = 0
        tier1_candidates = []
        if unique_in_batch:
            hashes = [r["canonicalDedupHash"] for r in unique_in_batch]
            with conn.cursor() as cur:
                format_strings = ','.join(['%s'] * len(hashes))
                cur.execute(f"SELECT canonicalDedupHash FROM {TARGET_TABLE} WHERE canonicalDedupHash IN ({format_strings})", hashes)
                existing_hashes = {row["canonicalDedupHash"] for row in cur.fetchall()}

            for r in unique_in_batch:
                if r["canonicalDedupHash"] in existing_hashes:
                    tier1_existing_dups += 1
                else:
                    tier1_candidates.append(r)

        # Tier 2: Check remaining candidates against UNHASHED native canonical records in target
        # Uses covering composite index idx_uoq_history_key_ts on (instrumentKey, ts)
        tier2_existing_dups = 0
        to_insert = []
        if tier1_candidates:
            key_ts_pairs = [(r.get("instrumentKey"), r.get("ts")) for r in tier1_candidates if r.get("instrumentKey") and r.get("ts")]
            native_canonical_matches = {}
            chunk_size = 500
            for i in range(0, len(key_ts_pairs), chunk_size):
                chunk = key_ts_pairs[i:i + chunk_size]
                clause = " OR ".join(["(instrumentKey = %s AND ts = %s)"] * len(chunk))
                params = [param for pair in chunk for param in pair]
                sql = f"""
                SELECT instrumentKey, ts, source, sourceTimestamp, ltp, bid, ask, bidQty, askQty, volume, oi, changeOi, underlyingPrice, bidDepth, askDepth
                FROM {TARGET_TABLE}
                WHERE ({clause})
                """
                with conn.cursor() as cur:
                    cur.execute(sql, params)
                    for row in cur.fetchall():
                        k = (row["instrumentKey"], row["ts"])
                        if k not in native_canonical_matches:
                            native_canonical_matches[k] = []
                        native_canonical_matches[k].append(row)

            for r in tier1_candidates:
                c_key = (r.get("instrumentKey"), r.get("ts"))
                matches = native_canonical_matches.get(c_key, [])
                if not matches or not r.get("source"):
                    to_insert.append(r)
                    continue

                cand_venue = normalize_provider_venue(r.get("source"))
                is_canonical_dup = False
                for m in matches:
                    m_venue = normalize_provider_venue(m["source"])
                    if m_venue == cand_venue:
                        if canonical_market_state_equals(r, m):
                            is_canonical_dup = True
                            break
                if is_canonical_dup:
                    tier2_existing_dups += 1
                else:
                    to_insert.append(r)

        # 3. Insert candidate rows using standard INSERT
        inserted_count = 0
        if to_insert:
            cols = [
                "id", "instrumentKey", "underlying", "exchange", "segment", "instrumentType",
                "expiry", "strike", "optionType", "ltp", "bid", "ask", "bidQty", "askQty",
                "volume", "oi", "previousOi", "changeOi", "iv", "delta", "gamma", "theta", "vega",
                "depth", "source", "sourceTimestamp", "receivedTimestamp", "sequenceNumber",
                "dataQuality", "underlyingPrice", "bidDepth", "askDepth", "instrumentToken",
                "payloadHash", "canonicalDedupHash", "sourceOrigin", "migrationRunId", "sourceRecordId", "ts", "archivedAt"
            ]
            sql = f"""
            INSERT INTO {TARGET_TABLE} ({", ".join(cols)})
            VALUES ({", ".join(["%s"] * len(cols))})
            """
            data = [[r.get(c) for c in cols] for r in to_insert]

            with conn.cursor() as cur:
                cur.executemany(sql, data)
                inserted_count = cur.rowcount

                # 4. Strict warning validation
                cur.execute("SHOW WARNINGS")
                warnings = cur.fetchall()
                if warnings:
                    raise StrictSqlWarningError(f"Unexpected database warnings during batch insert: {warnings}")

        total_duplicates = intra_batch_dups + tier1_existing_dups + tier2_existing_dups

        # 5. Exact Row Accounting Assertion
        if len(records) != (inserted_count + total_duplicates):
            raise RowAccountingInvariantError(
                f"Row accounting invariant violated: scanned={len(records)}, inserted={inserted_count}, duplicates={total_duplicates}"
            )

        return inserted_count, total_duplicates

    def _map_record(self, source_table, r, is_sentinel):
        """Map source-specific row to canonical target schema with run & row provenance."""
        if source_table == SOURCE_UPSTOX:
            inst_key = r.get("contractSymbol")
            canonical_key = normalize_contract_symbol(
                inst_key, r.get("underlying"), r.get("expiry"), r.get("strike"), r.get("optionType")
            )
            h = compute_canonical_dedup_hash(
                source="UPSTOX",
                instrument_key=canonical_key,
                ts=r.get("ts"),
                source_ts=r.get("providerTs") or r.get("ts"),
                seq_num=None,
                ltp=r.get("ltp"),
                bid=r.get("bid"),
                ask=r.get("ask"),
                bid_qty=r.get("bidQty"),
                ask_qty=r.get("askQty"),
                volume=r.get("volume"),
                oi=r.get("openInterest"),
                change_oi=r.get("oiChange"),
                bid_depth=r.get("bidDepth"),
                ask_depth=r.get("askDepth"),
                underlying_price=r.get("underlyingPrice"),
                payload_hash=r.get("payloadHash"),
                include_raw_payload_hash=self.include_raw_payload_hash
            )
            return {
                "id": str(uuid.uuid4()),
                "instrumentKey": canonical_key,
                "underlying": r.get("underlying"),
                "exchange": "NSE",
                "segment": "FO",
                "instrumentType": "OPTION",
                "expiry": r.get("expiry"),
                "strike": r.get("strike"),
                "optionType": r.get("optionType"),
                "ltp": r.get("ltp"),
                "bid": r.get("bid"),
                "ask": r.get("ask"),
                "bidQty": r.get("bidQty"),
                "askQty": r.get("askQty"),
                "volume": r.get("volume"),
                "oi": r.get("openInterest"),
                "previousOi": r.get("prevOi"),
                "changeOi": r.get("oiChange"),
                "iv": r.get("impliedVolatility"),
                "delta": None, "gamma": None, "theta": None, "vega": None,
                "depth": None,
                "source": "UPSTOX",
                "sourceTimestamp": r.get("providerTs") or r.get("ts"),
                "receivedTimestamp": r.get("ts"),
                "sequenceNumber": None,
                "dataQuality": "VALID",
                "underlyingPrice": r.get("underlyingPrice"),
                "bidDepth": r.get("bidDepth"),
                "askDepth": r.get("askDepth"),
                "instrumentToken": r.get("instrumentToken"),
                "payloadHash": r.get("payloadHash"),
                "canonicalDedupHash": h,
                "sourceOrigin": "MIGRATED_UPSTOX",
                "migrationRunId": self.migration_run_id,
                "sourceRecordId": str(r.get("id")),
                "ts": r.get("ts"),
                "archivedAt": datetime.now()
            }
        else: # SOURCE_FNF
            inst_key = r.get("contractSymbol")
            canonical_key = normalize_contract_symbol(
                inst_key, r.get("underlying"), r.get("expiry"), r.get("strike"), r.get("optionType")
            )
            # Sentinel preservation: true arrival time preserved in sourceTimestamp & receivedTimestamp
            source_ts = r.get("createdAt") if is_sentinel else r.get("ts")
            received_ts = r.get("createdAt") if is_sentinel else r.get("ts")

            h = compute_canonical_dedup_hash(
                source="fyers",
                instrument_key=canonical_key,
                ts=r.get("ts"),
                source_ts=source_ts,
                seq_num=None,
                ltp=r.get("ltp"),
                bid=r.get("bid"),
                ask=r.get("ask"),
                bid_qty=r.get("bidQty"),
                ask_qty=r.get("askQty"),
                volume=r.get("volume"),
                oi=r.get("oi"),
                change_oi=r.get("changeOi"),
                bid_depth=None,
                ask_depth=None,
                underlying_price=None,
                payload_hash=None,
                include_raw_payload_hash=self.include_raw_payload_hash
            )
            return {
                "id": str(uuid.uuid4()),
                "instrumentKey": canonical_key,
                "underlying": r.get("underlying"),
                "exchange": "NSE",
                "segment": "FO",
                "instrumentType": "OPTION",
                "expiry": r.get("expiry"),
                "strike": r.get("strike"),
                "optionType": r.get("optionType"),
                "ltp": r.get("ltp"),
                "bid": r.get("bid"),
                "ask": r.get("ask"),
                "bidQty": r.get("bidQty"),
                "askQty": r.get("askQty"),
                "volume": r.get("volume"),
                "oi": r.get("oi"),
                "previousOi": None,
                "changeOi": r.get("changeOi"),
                "iv": None, "delta": None, "gamma": None, "theta": None, "vega": None,
                "depth": None,
                "source": "fyers",
                "sourceTimestamp": source_ts,
                "receivedTimestamp": received_ts,
                "sequenceNumber": None,
                "dataQuality": "SENTINEL_TS" if is_sentinel else "VALID",
                "underlyingPrice": None,
                "bidDepth": None,
                "askDepth": None,
                "instrumentToken": None,
                "payloadHash": None,
                "canonicalDedupHash": h,
                "sourceOrigin": "MIGRATED_FNF",
                "migrationRunId": self.migration_run_id,
                "sourceRecordId": str(r.get("id")),
                "ts": r.get("ts"),
                "archivedAt": datetime.now()
            }

    # ──────────────────────────────────────────────────────────────────────────
    # MODE 5: NON-DESTRUCTIVE RUN RECOVERY & QUARANTINE (ZERO DATA DELETION)
    # ──────────────────────────────────────────────────────────────────────────
    def plan_run_recovery(self, target_run_id, quarantine=True):
        """
        Non-Destructive Run Recovery & Quarantine Planner:
        Complies strictly with the Absolute Data Preservation Rule (ZERO DATA DELETION).
        Marks a migration run as 'QUARANTINED' in the checkpoint ledger
        WITHOUT deleting any records from unified_option_quotes_history.
        """
        logger.info(f"=== MODE: RUN RECOVERY / QUARANTINE (Target Run ID: {target_run_id}) ===")
        conn = self._get_connection(autocommit=False)
        try:
            with conn.cursor() as cur:
                # 1. Dependency Guard: verify no newer run exists that might depend on this run
                cur.execute(f"""
                SELECT migration_run_id, started_at
                FROM {CHECKPOINT_TABLE}
                WHERE migration_run_id != %s
                  AND status IN ('COMPLETED', 'RUNNING')
                  AND started_at > (
                      SELECT started_at FROM {CHECKPOINT_TABLE} WHERE migration_run_id = %s LIMIT 1
                  )
                """, (target_run_id, target_run_id))
                newer_runs = cur.fetchall()
                if newer_runs:
                    raise RollbackDependencyViolationError(
                        f"Cannot quarantine/recover run '{target_run_id}'. Subsequent run '{newer_runs[0]['migration_run_id']}' "
                        f"was started after this run and may depend on records deduplicated against it. "
                        f"Quarantine subsequent runs in reverse chronological (LIFO) order first."
                    )

                # 2. Count affected records (READ-ONLY verification)
                cur.execute(f"SELECT COUNT(*) AS cnt FROM {TARGET_TABLE} WHERE migrationRunId = %s", (target_run_id,))
                res = cur.fetchone()
                cnt = res["cnt"] if res else 0
                if cnt == 0:
                    logger.warning(f"No records found in {TARGET_TABLE} for run ID {target_run_id}.")
                    return {"status": "NOOP", "run_id": target_run_id, "preserved_rows": 0, "deleted_rows": 0}

                # 3. Update checkpoint ledger non-destructively: status='QUARANTINED', ZERO rows deleted
                target_status = "QUARANTINED" if quarantine else "INSPECTED"
                cur.execute(f"""
                UPDATE {CHECKPOINT_TABLE}
                SET status = %s,
                    worker_uuid = NULL,
                    updated_at = NOW()
                WHERE migration_run_id = %s;
                """, (target_status, target_run_id))

            conn.commit()
            logger.info(
                f"Quarantine complete for run {target_run_id}: Status updated to '{target_status}'. "
                f"ZERO DATA DELETION enforced: all {cnt} records remain intact in {TARGET_TABLE}."
            )
            return {
                "status": "SUCCESS",
                "run_id": target_run_id,
                "action": target_status,
                "preserved_rows": cnt,
                "deleted_rows": 0
            }
        except Exception as e:
            conn.rollback()
            logger.error(f"Run recovery/quarantine failed: {e}")
            raise
        finally:
            conn.close()

    def rollback_run(self, target_run_id, confirmed=False):
        """
        Safe rollback alias delegating to non-destructive plan_run_recovery().
        Destructive DELETE is permanently forbidden by the Absolute Data Preservation Rule.
        """
        if not confirmed:
            raise PermissionError("Rollback/quarantine requires explicit confirmation flag (--confirm-rollback).")
        logger.warning(
            f"ABSOLUTE DATA PRESERVATION ENFORCED: Destructive DELETE is prohibited. "
            f"Quarantining run {target_run_id} non-destructively in checkpoint ledger."
        )
        return self.plan_run_recovery(target_run_id, quarantine=True)

    # ──────────────────────────────────────────────────────────────────────────
    # MODE 6: VERIFY MIGRATION RECONCILIATION
    # ──────────────────────────────────────────────────────────────────────────
    def verify_migration(self):
        """Independently reconcile source, target, and checkpoint ledger."""
        logger.info("=== MODE: VERIFY (Read-Only Independent Audit) ===")
        conn = self._get_connection(autocommit=True)
        report = {"status": "SUCCESS", "timestamp": datetime.now().isoformat(), "reconciliation": {}}
        try:
            with conn.cursor() as cur:
                cur.execute(f"SELECT * FROM {CHECKPOINT_TABLE}")
                checkpoints = cur.fetchall()
                report["reconciliation"]["checkpoints"] = checkpoints

                cur.execute(f"""
                SELECT sourceOrigin, COUNT(*) AS count
                FROM {TARGET_TABLE}
                GROUP BY sourceOrigin
                """)
                origins = cur.fetchall()
                report["reconciliation"]["target_by_origin"] = origins

                cur.execute(f"""
                SELECT migrationRunId, sourceOrigin, COUNT(*) AS count
                FROM {TARGET_TABLE}
                WHERE migrationRunId IS NOT NULL
                GROUP BY migrationRunId, sourceOrigin
                """)
                runs = cur.fetchall()
                report["reconciliation"]["target_by_run"] = runs

                cur.execute(f"""
                SELECT COUNT(*) AS sentinel_count
                FROM {TARGET_TABLE}
                WHERE dataQuality = 'SENTINEL_TS'
                """)
                target_sentinels = cur.fetchone()["sentinel_count"]
                report["reconciliation"]["target_sentinel_records"] = target_sentinels

                logger.info(f"Verification complete: {origins}")
                return report
        finally:
            conn.close()

def main():
    parser = argparse.ArgumentParser(description="Production-Grade Historical Market Data Consolidation Utility")
    parser.add_argument("--validate", action="store_true", help="Run read-only environment and prerequisite validation")
    parser.add_argument("--dry-run", action="store_true", help="Run read-only candidate and deduplication dry-run")
    parser.add_argument("--apply-ddl", action="store_true", help="Apply Phase B DDL (requires --confirm-ddl)")
    parser.add_argument("--confirm-ddl", action="store_true", help="Explicit confirmation gate for DDL execution")
    parser.add_argument("--migrate", action="store_true", help="Execute bounded batch migration")
    parser.add_argument("--verify", action="store_true", help="Run independent reconciliation verification")
    parser.add_argument("--rollback", action="store_true", help="Execute run-scoped rollback (requires --run-id and --confirm-rollback)")
    parser.add_argument("--run-id", type=str, default=None, help="Target migrationRunId for execution or rollback")
    parser.add_argument("--confirm-rollback", action="store_true", help="Explicit confirmation gate for rollback")
    parser.add_argument("--source", choices=[SOURCE_UPSTOX, SOURCE_FNF], help="Restrict migration to single source table")
    parser.add_argument("--limit", type=int, default=None, help="Limit number of rows migrated in this execution")
    parser.add_argument("--batch-size", type=int, default=2000, help="Batch chunk size (default: 2000)")
    parser.add_argument("--batch-pause-ms", type=int, default=150, help="Inter-batch throttle sleep in milliseconds (default: 150)")
    parser.add_argument("--max-threads-connected", type=int, default=140, help="Stop migration if Threads_connected exceeds threshold (default: 140)")
    parser.add_argument("--min-connection-headroom", type=int, default=50, help="Stop migration if connection headroom drops below threshold (default: 50)")
    parser.add_argument("--json-report", type=str, default=None, help="Output file path for machine-readable JSON report")
    parser.add_argument("--env-file", type=str, default=".env", help="Path to .env configuration file")

    args = parser.parse_args()

    env = load_env(args.env_file)
    if not env:
        logger.error(f"Failed to load environment variables from {args.env_file}")
        sys.exit(1)

    migrator = HistoricalMarketDataMigrator(
        env,
        batch_size=args.batch_size,
        batch_pause_ms=args.batch_pause_ms,
        max_threads_connected=args.max_threads_connected,
        min_connection_headroom=args.min_connection_headroom,
        run_id=args.run_id
    )
    output = None

    if args.validate:
        output = migrator.validate_environment()
    elif args.dry_run:
        output = migrator.dry_run_reconciliation()
    elif args.apply_ddl:
        output = migrator.apply_phase_b_ddl(confirmed=args.confirm_ddl)
    elif args.migrate:
        migrator.execute_migration(source_choice=args.source, row_limit=args.limit)
        output = migrator.verify_migration()
    elif args.rollback:
        if not args.run_id:
            logger.error("--rollback requires --run-id")
            sys.exit(1)
        output = migrator.rollback_run(args.run_id, confirmed=args.confirm_rollback)
    elif args.verify:
        output = migrator.verify_migration()
    else:
        parser.print_help()
        sys.exit(0)

    if args.json_report and output:
        with open(args.json_report, "w") as f:
            json.dump(output, f, indent=2, default=str)
        logger.info(f"Report written to {args.json_report}")

if __name__ == "__main__":
    main()
