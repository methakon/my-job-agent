#!/usr/bin/env python3
"""
Trading-Day Accumulation Tracker (Observability Only)
Database: Production MySQL (myjob_agent on 127.0.0.1:3307)
Target Table: cpp_trade_reports (Active Clean Dataset)
Historical Backup Table: cpp_trade_reports_backup_20261003 (Pre-Deduplication 1,140 Dataset)
"""

import os
import sys
import subprocess
from pathlib import Path

def load_env(env_path):
    env_vars = {}
    if not os.path.exists(env_path):
        return env_vars
    with open(env_path, 'r') as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                key, val = line.split('=', 1)
                env_vars[key.strip()] = val.strip().strip("'").strip('"')
    return env_vars

def main():
    repo_dir = Path(__file__).resolve().parent.parent
    env_file = repo_dir / '.env'
    env_vars = load_env(env_file)

    db_host = env_vars.get('MYSQL_HOST', '127.0.0.1')
    db_port = env_vars.get('MYSQL_PORT', '3307')
    db_user = env_vars.get('MYSQL_USER', 'mylife')
    db_pass = env_vars.get('MYSQL_PASSWORD', '')
    db_name = env_vars.get('MYSQL_DATABASE', 'myjob_agent')

    print("===================================================================")
    print("📊 TRADING-DAY ACCUMULATION TRACKER (OBSERVABILITY ONLY)")
    print(f"Target DB Instance: {db_user}@{db_host}:{db_port}/{db_name}")
    print("===================================================================\n")

    # SQL 1: Distinct trading day count on active clean table
    sql_summary = "SELECT COUNT(DISTINCT DATE(closedAt)) AS distinct_days FROM cpp_trade_reports WHERE status = 'CLOSED';"
    cmd_summary = [
        "mysql", f"-u{db_user}", f"-p{db_pass}", f"-h{db_host}", f"-P{db_port}",
        db_name, "-s", "-N", "-e", sql_summary
    ]

    try:
        res_summary = subprocess.run(cmd_summary, capture_output=True, text=True, check=True)
        distinct_count = int(res_summary.stdout.strip() or 0)
    except Exception as e:
        print("❌ Failed to query distinct count:", e, file=sys.stderr)
        sys.exit(1)

    print(f"📌 Progress: {distinct_count} distinct real trading days accumulated toward the 20-30 day validation threshold.\n")

    # SQL 2: Active Table Distribution
    sql_dist = """
    SELECT 
        DATE(closedAt) AS trading_date, 
        COUNT(*) AS closed_trade_count
    FROM cpp_trade_reports 
    WHERE status = 'CLOSED' 
    GROUP BY DATE(closedAt) 
    ORDER BY trading_date ASC;
    """
    cmd_dist = [
        "mysql", f"-u{db_user}", f"-p{db_pass}", f"-h{db_host}", f"-P{db_port}",
        db_name, "-e", sql_dist
    ]

    try:
        res_dist = subprocess.run(cmd_dist, capture_output=True, text=True, check=True)
        print("--- ACTIVE DATASET PER-DAY DISTRIBUTION (cpp_trade_reports) ---")
        print(res_dist.stdout.strip())
    except Exception as e:
        print("❌ Failed to query distribution:", e, file=sys.stderr)
        sys.exit(1)

    # SQL 3: Audit Reconciliation against Archive & Backup Tables
    sql_recon = """
    SELECT 'cpp_trade_reports (Active Clean)' AS table_name, DATE(closedAt) AS date, status, COUNT(*) AS count FROM cpp_trade_reports WHERE status='CLOSED' GROUP BY DATE(closedAt), status
    UNION ALL
    SELECT 'cpp_trade_reports_duplicates_archive' AS table_name, DATE(closedAt) AS date, status, COUNT(*) AS count FROM cpp_trade_reports_duplicates_archive WHERE status='CLOSED' GROUP BY DATE(closedAt), status
    UNION ALL
    SELECT 'cpp_trade_reports_backup_20261003 (Pre-Dedup Baseline)' AS table_name, DATE(closedAt) AS date, status, COUNT(*) AS count FROM cpp_trade_reports_backup_20261003 WHERE status='CLOSED' GROUP BY DATE(closedAt), status;
    """
    cmd_recon = [
        "mysql", f"-u{db_user}", f"-p{db_pass}", f"-h{db_host}", f"-P{db_port}",
        db_name, "-e", sql_recon
    ]

    try:
        res_recon = subprocess.run(cmd_recon, capture_output=True, text=True, check=True)
        print("\n--- RECONCILIATION AUDIT TRAIL (Active vs Duplicates Archive vs Backup) ---")
        print(res_recon.stdout.strip())
    except Exception as e:
        print("❌ Failed to query audit reconciliation:", e, file=sys.stderr)
        sys.exit(1)

    print("\n===================================================================")

if __name__ == "__main__":
    main()
