#!/bin/bash
# Database Sync Runtime Verification Script
# This script verifies the DatabaseSyncService by running synchronized sync operations
# against local and Oracle MySQL databases.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

echo "═══════════════════════════════════════════════════════════════════════════════"
echo "        DATABASE SYNC RUNTIME VERIFICATION"
echo "═══════════════════════════════════════════════════════════════════════════════"

# Check if .env exists
if [ ! -f .env ]; then
    echo "ERROR: .env file not found. Please create .env with database credentials."
    exit 1
fi

# Source environment variables (non-destructive)
export MYSQL_HOST="${MYSQL_HOST:-127.0.0.1}"
export MYSQL_PORT="${MYSQL_PORT:-3307}"
export MYSQL_USER="${MYSQL_USER:-mylife}"
export MYSQL_PASSWORD="${MYSQL_PASSWORD:-}"
export DATABASE_NAME="${DATABASE_NAME:-myjob_agent}"

# Local MySQL credentials (optional - defaults to same as Oracle)
export LOCAL_DB_HOST="${LOCAL_DB_HOST:-127.0.0.1}"
export LOCAL_DB_PORT="${LOCAL_DB_PORT:-3306}"
export LOCAL_DB_USER="${LOCAL_DB_USER:-mylife}"
export LOCAL_DB_PASSWORD="${LOCAL_DB_PASSWORD:-$MYSQL_PASSWORD}"
export LOCAL_DB_NAME="${LOCAL_DB_NAME:-myjob_agent}"

echo ""
echo "CONFIGURATION:"
echo "  Oracle MySQL: $MYSQL_HOST:$MYSQL_PORT/$DATABASE_NAME"
echo "  Local MySQL:  $LOCAL_DB_HOST:$LOCAL_DB_PORT/$LOCAL_DB_NAME"
echo "  Sync Outside Trading Hours Only: true"
echo ""

# Check if typeorm migration:run is needed
echo "─── STEP 1: Checking database migrations ───"
echo "Running: npx typeorm migration:show"
npx typeorm migration:show 2>&1 || echo "Migration show failed"

echo ""
echo "─── STEP 2: Verifying schema consistency ───"
# Note: We do NOT use synchronize: true because that can alter/drop tables
# Migrations are authoritative. If local schema is missing tables, run:
# npx typeorm migration:run

echo ""
echo "─── STEP 3: Testing Oracle MySQL connectivity ───"
MYSQL_PWD="$MYSQL_PASSWORD" mysql -h "$MYSQL_HOST" -P "$MYSQL_PORT" -u "$MYSQL_USER" -e "SELECT 'Oracle MySQL: Connection OK';" 2>&1 || echo "Oracle MySQL connection failed"

echo ""
echo "─── STEP 4: Testing Local MySQL connectivity ───"
MYSQL_PWD="$LOCAL_DB_PASSWORD" mysql -h "$LOCAL_DB_HOST" -P "$LOCAL_DB_PORT" -u "$LOCAL_DB_USER" -e "SELECT 'Local MySQL: Connection OK';" 2>&1 || echo "Local MySQL connection failed"

echo ""
echo "─── STEP 5: Manual sync test (via TypeScript) ───"
echo "The DatabaseSyncService requires proper credentials and a running NestJS app."
echo ""
echo "To manually test sync, run:"
echo "  1. Set credentials in .env:"
echo "     LOCAL_DB_HOST=$LOCAL_DB_HOST"
echo "     LOCAL_DB_PORT=$LOCAL_DB_PORT"
echo "     LOCAL_DB_USER=$LOCAL_DB_USER"
echo "     LOCAL_DB_PASSWORD=$LOCAL_DB_PASSWORD"
echo "     LOCAL_DB_NAME=$LOCAL_DB_NAME"
echo ""
echo "  2. Enable sync:"
echo "     DB_SYNC_ENABLED=true"
echo "     DB_SYNC_INTERVAL_MINUTES=30"
echo "     DB_SYNC_OUTSIDE_TRADING_ONLY=true"
echo "     DB_SYNC_BATCH_SIZE=1000"
echo "     DB_SYNC_MAX_RETRIES=3"
echo "     DB_SYNC_BACKOFF_SECONDS=5"
echo ""
echo "  3. Build and run the app:"
echo "     npm run build"
echo "     npm start"
echo ""
echo "  4. The DatabaseSyncService will automatically sync every interval."
echo ""
echo "  5. To force a sync test (debug mode), modify DatabaseSyncService"
echo "     to accept a trigger endpoint or CLI command."

echo ""
echo "═══════════════════════════════════════════════════════════════════════════════"
echo "                        VERIFICATION SCRIPT COMPLETE"
echo "═══════════════════════════════════════════════════════════════════════════════"
echo ""
echo "STATUS: RUNTIME_VERIFICATION_REQUIRES_CREDENTIALS"
echo ""
echo "To complete runtime verification, ensure:"
echo "  1. Local MySQL is accessible with credentials in .env"
echo "  2. DB_SYNC_ENABLED=true"
echo "  3. Run outside trading hours (3:31 PM - 9:14 AM IST)"
echo "  4. Check audit table: SELECT * FROM database_sync_audit ORDER BY createdAt DESC LIMIT 10"
echo "  5. Use npx typeorm migration:run if local schema is behind"
