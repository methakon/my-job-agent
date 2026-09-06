#!/usr/bin/env bash
# ============================================================================
# sync-env-dhargent.sh — deploy local .env secrets to Dhargent (Oracle Cloud)
# ============================================================================
# WHY: .env files are NEVER committed to git (policy 2026-09-06). Real
# secrets live on the deploy hosts only. Dhargent (/home/ubuntu/trading-agent)
# has no git checkout, so this script is the deploy path for env secrets.
#
# SAFETY MODEL (key-wise merge — NEVER a blind copy):
#   local .env and remote .env are DIFFERENT files:
#     local  = portal env (this repo, ~33 keys) incl. FYERS creds kept in
#              sync manually ("persisted masked to local + Dhargent .env")
#     remote = trading-agent env (15 keys: FYERS_*, FNO_*, MYSQL_HOST=10.0.0.99
#              VCN-internal, DATABASE_NAME)
#   Therefore only keys present in BOTH files are updated; protected keys
#   (DB topology / trading config that must keep the remote's value) are
#   never overwritten; remote-only keys are never touched. Nothing is added.
#
# USAGE:
#   scripts/sync-env-dhargent.sh                 # dry-run: report only
#   scripts/sync-env-dhargent.sh --apply         # write merged .env (backup first)
#   scripts/sync-env-dhargent.sh --apply --restart   # ...and pm2 restart trading-agent
#   REMOTE=user@host SSH_KEY=~/.ssh/x scripts/sync-env-dhargent.sh --apply
#
# EXIT: 0 ok; 3 = nothing to do in dry-run mode; non-zero = failure.
# NEVER prints any secret value — key names only.
# ============================================================================
set -euo pipefail

REMOTE="${REMOTE:-ubuntu@168.110.60.10}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
REMOTE_DIR="${REMOTE_DIR:-/home/ubuntu/trading-agent}"
PM2_APP="${PM2_APP:-trading-agent}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_ENV="${LOCAL_ENV:-$REPO_ROOT/.env}"

# Keys that must KEEP the remote's value (DB topology, trading runtime config)
PROTECT_RE='^(MYSQL_HOST|MYSQL_PORT|MYSQL_USER|MYSQL_PASSWORD|DATABASE_NAME|FNO_MARKET_DATA_ENABLED|FNO_MARKET_DATA_PROVIDER|FNO_MARKET_DATA_SYMBOLS|FNO_MARKET_DATA_PERSIST_MS|FNO_OPTION_CONTRACTS|FNO_PAPER_QTY|YAHOO_FINANCE_[A-Z_]+)$'

MODE="dry"
RESTART=0
for arg in "$@"; do
  case "$arg" in
    --apply)   MODE="apply" ;;
    --restart) RESTART=1 ;;
    -h|--help) sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $arg (see --help)"; exit 2 ;;
  esac
done

[ -f "$LOCAL_ENV" ] || { echo "FATAL: local env not found: $LOCAL_ENV"; exit 1; }
[ -f "$SSH_KEY" ]  || { echo "FATAL: ssh key not found: $SSH_KEY"; exit 1; }

echo "== sync-env-dhargent =="
echo "   remote : $REMOTE:$REMOTE_DIR/.env  (pm2 app: $PM2_APP)"
echo "   local  : $LOCAL_ENV"
if [ "$MODE" = "apply" ] && [ "$RESTART" = "1" ]; then MODE_DISP="apply + restart"; else MODE_DISP="$MODE"; fi
echo "   mode   : $MODE_DISP"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "== fetching remote .env =="
ssh -o BatchMode=yes -o ConnectTimeout=15 -i "$SSH_KEY" "$REMOTE" \
  "cat '$REMOTE_DIR/.env'" > "$TMP_DIR/remote.env"

# ---- diff (key names only; values compared locally, never printed) ----
REPORT="$(python3 - "$LOCAL_ENV" "$TMP_DIR/remote.env" "$PROTECT_RE" <<'PY'
import re, sys
local_path, remote_path, protect_re = sys.argv[1], sys.argv[2], sys.argv[3]
protect = re.compile(protect_re)

def parse(p):
    d, order = {}, []
    for line in open(p, encoding='utf-8', errors='replace').read().splitlines():
        m = re.match(r'^\s*(export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$', line)
        if m:
            k = m.group(2)
            d[k] = m.group(3)
            if k not in order:
                order.append(k)
    return d, order

ld, _ = parse(local_path)
rd, rorder = parse(remote_path)

updated, protected, nochange, absent = [], [], [], []
for k in rorder:                     # remote order: stable, deterministic
    if k not in ld:
        continue                     # remote-only key -> untouched by design
    if protect.match(k):
        if ld[k] != rd[k]:
            protected.append(k)      # differs but protected -> never overwrite
        continue
    if ld[k] != rd[k]:
        updated.append(k)
    else:
        nochange.append(k)

local_only = sorted(set(ld) - set(rd))
print("UPDATED   :", " ".join(updated) or "(none)")
print("PROTECTED :", " ".join(protected) or "(none)")
print("NOCHANGE  :", str(len(nochange)) + " keys identical")
print("LOCAL_ONLY:", " ".join(local_only) or "(none)", "(not on remote -> skipped)")
PY
)"
echo "== diff summary =="
echo "$REPORT"

if [ "$MODE" = "dry" ]; then
  echo "== dry-run: nothing written. Re-run with --apply (add --restart to restart $PM2_APP) =="
  grep -q "^UPDATED   : (none)$" <<<"$REPORT" && exit 0 || exit 3
fi

UPDATED_KEYS="$(grep '^UPDATED' <<<"$REPORT" | sed 's/^UPDATED   : //')"
[ "$UPDATED_KEYS" = "(none)" ] && { echo "== nothing to sync — remote .env already matches =="; exit 0; }

# ---- apply: scp local env to remote tmp, merge remotely, atomic replace ----
echo "== applying (backup -> merge -> atomic replace) =="
scp -q -i "$SSH_KEY" "$LOCAL_ENV" "$REMOTE:/tmp/sync-env-local.env"
ssh -o BatchMode=yes -i "$SSH_KEY" "$REMOTE" REMOTE_DIR="$REMOTE_DIR" 'bash -s' <<'RMT'
set -euo pipefail
cd "$REMOTE_DIR"
python3 - /tmp/sync-env-local.env .env <<'PY'
import re, sys, shutil, time, os
src, dst = sys.argv[1], sys.argv[2]
keep = set()
for line in open(src, encoding='utf-8', errors='replace').read().splitlines():
    m = re.match(r'^\s*(export\s+)?([A-Za-z_][A-Za-z0-9_]*)=', line)
    if m:
        keep.add(m.group(2))
new = []
for line in open(dst, encoding='utf-8', errors='replace').read().splitlines():
    m = re.match(r'^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)=(.*)$', line)
    if m and m.group(2) in keep:
        # replace value from local source (preserve export-prefix style)
        for sl in open(src, encoding='utf-8', errors='replace').read().splitlines():
            sm = re.match(r'^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$', sl)
            if sm and sm.group(1) == m.group(2):
                new.append(f"{m.group(1)}{m.group(2)}={sm.group(2)}")
                break
    else:
        new.append(line)
bak = f"{dst}.bak-{time.strftime('%Y%m%d-%H%M%S')}"
shutil.copy2(dst, bak)
open(dst + ".sync-tmp", "w", encoding="utf-8").write("\n".join(new) + "\n")
os.chmod(dst + ".sync-tmp", 0o600)
os.replace(dst + ".sync-tmp", dst)
print(f"backup: {bak}")
PY
rm -f /tmp/sync-env-local.env
RMT

echo "== verifying remote .env =="
ssh -o BatchMode=yes -i "$SSH_KEY" "$REMOTE" \
  "sha256sum '$REMOTE_DIR/.env' | awk '{print \"remote sha256: \" \$1}'"

if [ "$RESTART" = "1" ]; then
  echo "== restarting $PM2_APP (env re-sourced) =="
  ssh -o BatchMode=yes -i "$SSH_KEY" "$REMOTE" \
    "cd '$REMOTE_DIR' && bash -c 'set -a; . ./.env; set +a; pm2 restart $PM2_APP --update-env >/dev/null' && sleep 3 && pm2 describe $PM2_APP | grep -E 'status|restarts'"
else
  echo "== NOT restarted. Run with --restart when ready (or next scheduled restart picks it up) =="
fi

echo "== synced keys: $UPDATED_KEYS =="
