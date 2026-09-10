#!/usr/bin/env bash
# GATE 2 slice 1 — scheduled read-only PRE-OPEN WINDOW CAPTURE (Hermes cron entry).
#
# Runs the already-shipped src/trading/pre-open code path through its own window
# gate for one NSE pre-open/auction window and writes an evidence report.
#
# READ-ONLY with respect to trading: it instantiates only the pre-open providers
# (never UpstoxLivePaperModule), opens no HTTP listener, places/cancels no order,
# creates no fill, and touches no capital, position, P&L or FNF record. The
# harness asserts this before it polls (see scripts/pre-open-window-capture.js).
#
# Defaults: --wait --from=08:59 --to=09:21 IST (self-aligns to the window and
# refuses to run if fired after it). Any arguments are passed straight through,
# e.g.  scripts/pre-open-window-capture.sh --dry-run
set -u
REPO="/home/swarna-sekhar-dhar/projects/my-job-agent"
NODE="/home/swarna-sekhar-dhar/.local/bin/node"
cd "$REPO" || exit 1
export PATH="$(dirname "$NODE"):/usr/local/bin:/usr/bin:/bin:${PATH:-}"
if [ "$#" -eq 0 ]; then
  set -- --wait --from=08:59 --to=09:21 --label gate2-slice1-live-window
fi
exec "$NODE" scripts/pre-open-window-capture.js "$@"
