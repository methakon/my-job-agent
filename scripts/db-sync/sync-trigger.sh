#!/bin/bash
# Trigger database sync and run test-runtime.mjs

cd /home/swarna-sekhar-dhar/projects/my-job-agent

# Set env vars for this session
export DB_SYNC_ENABLED=true
export DB_SYNC_INTERVAL_MINUTES=30
export DB_SYNC_OUTSIDE_TRADING_ONLY=true
export DB_SYNC_BATCH_SIZE=1000
export DB_SYNC_MAX_RETRIES=3
export DB_SYNC_BACKOFF_SECONDS=5

# Run the sync
node scripts/db-sync/test-runtime.mjs
