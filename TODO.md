# Project Architecture Memorandum
## Oracle Cloud MySQL Connectivity — Read This First

**Last updated:** 2026-09-09  
**Why this exists:** Multiple models/agents have confused the MySQL connection topology. This memo prevents re-litigation.

---

### 1. Two MySQL Instances — Do Not Confuse Them

| | Local MySQL | Oracle Cloud MySQL |
|---|---|---|
| Host | 127.0.0.1 | 10.0.0.99 (reached via tunnel) |
| Port (direct) | 3306 | 3306 |
| Port (reachable) | 127.0.0.1:3306 | 127.0.0.1:3307 (SSH tunnel) |
| Auth user | root (pw: `wbsd99`) or mylife | mylife (pw: `rDJNh2...Aa1!`) |
| root can connect? | YES | NO (access denied for root@10.0.0.175) |
| Purpose | Local development / testing | Production DB for deployed app |

**The app (`my-job-agent`) runs on an Oracle Cloud VM.**  
**Oracle Cloud MySQL is at 10.0.0.99:3306, reached through an SSH tunnel on 127.0.0.1:3307.**

The SSH tunnel is alive: PID 3104, forwarding 127.0.0.1:3307 → 10.0.0.99:3306.  
Verify: `mysql -h 127.0.0.1 -P 3307 -u mylife -p"rDJNh2...Aa1!" -D myjob_agent -e "SELECT 1;"`

---

### 2. How the App Connects — Single .env Block

`.env` has ONE MySQL connection block. There is NO separate "oracle" / "cloud" / "local" split:

```
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3307        ← THIS is the only switch: 3307 = Oracle Cloud (via tunnel), 3306 = local
MYSQL_USER=mylife
MYSQL_PASSWORD=rDJNh2...Aa1!
```

**`MYSQL_PORT` is the entire environment switch.**  
- `3307` → app connects to Oracle Cloud MySQL through the SSH tunnel (correct for deployed VM).  
- `3306` → app connects to local MySQL (only correct if you are on the Oracle Cloud VM doing local dev, OR on a local dev machine that has its own MySQL).

There are NO `ORACLE_DB_*` or `LOCAL_DB_*` variables in `.env`. Do not add them unless you are refactoring the connection config — the current single-block design works because the tunnel makes Oracle MySQL look like a local port.

---

### 3. `database-sync.service.ts` — "ORACLE" Labels Are NOT Oracle Cloud

The file `src/database-sync/database-sync.service.ts` uses labels `ORACLE_AUTHORITATIVE`, `LOCAL_AUTHORITATIVE`, `SHARED_APPEND_ONLY`, `EXCLUDED` for a **two-local-MySQL sync topology**.

Both `ORACLE_DB_HOST` and `LOCAL_DB_HOST` default to `127.0.0.1`. Both are local. The word "oracle" here is a **sync-role label** (the authoritative source in a replica pair), NOT a reference to Oracle Cloud.

Do NOT read `ORACLE_DB_HOST` in that file as "Oracle Cloud MySQL host." It is not. It is part of a separate sync-architecture concept that predates or is independent of the Oracle Cloud deployment.

---

### 4. The SSH Tunnel Is Infrastructure, Not App Config

The tunnel (127.0.0.1:3307 → 10.0.0.99:3306) is set up at the OS level (systemd user service or shell), NOT in the Node.js app. The app has no idea it is talking to Oracle Cloud — it just connects to 127.0.0.1:3307 like any local MySQL.

The tunnel status is documented in `DB_SYNC_STATUS_REPORT.txt` (untracked file). That file is the only place the Oracle Cloud MySQL reality is written down in a way the app doesn't read.

---

### 5. What Happened on 2026-09-09 (Do Not Repeat)

- The assistant changed `MYSQL_PORT` from 3307 to 3306, assuming "the app should talk to local DB."
- This broke the Oracle Cloud MySQL connection because the deployed app is supposed to use the tunnel (3307).
- The assistant also ran `ALTER USER mylife@localhost` much earlier (not today) to fix a MySQL auth error where `127.0.0.1` resolved to hostname `10.0.0.175`. This set an explicit password on `mylife@localhost`. **The user's `MYSQL_PASSWORD` (`rDJNh2...Aa1!`) was NEVER changed.** Only the localhost-side grant was adjusted. Both `mylife@localhost` and `mylife@127.0.0.1` use `caching_sha2_password`.

**Lesson:** Before touching `MYSQL_PORT`, check whether you are on the deployed Oracle Cloud VM or a local dev machine. The correct default for the deployed VM is 3307.

---

### 6. Correct Configuration for Deployed Oracle Cloud VM

```
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3307
MYSQL_USER=mylife
MYSQL_PASSWORD=rDJNh2...Aa1!
```

The tunnel must be alive: `ps aux | grep ssh | grep 3307` should show PID 3104 (or equivalent).

---

### 7. What Is NOT in .env (And Why)

- No `ORACLE_DB_HOST`, `ORACLE_DB_PORT`, `ORACLE_DB_USER`, `ORACLE_DB_PASSWORD` — because Oracle MySQL is reached through the tunnel port (3307), not a separate host variable.
- No `LOCAL_DB_*` vars — local MySQL is not the production target; if you need a local-dev override, use a separate `.env.local` or change `MYSQL_PORT` temporarily.

---

### 8. Documents to Read Before Touching DB Config

1. `DB_SYNC_STATUS_REPORT.txt` — tunnel topology snapshot
2. `src/database-sync/database-sync.service.ts` — read the FULL file; understand the sync-role labels are NOT Oracle Cloud
3. `.env` — current MYSQL_PORT and credentials
4. `ps aux | grep ssh` and `ps aux | grep cloudflared` — verify infrastructure is alive before assuming config is wrong
5. `~/.ssh/config` — check for the Oracle Cloud VM SSH entry

---

### 9. Quick Diagnostic Checklist

If the app can't connect to MySQL:
1. Is the SSH tunnel alive? `ps aux | grep 'ssh.*3307'`
2. Can `mylife` auth via tunnel? `mysql -h 127.0.0.1 -P 3307 -u mylife -p"rDJNh2...Aa1!" -D myjob_agent -e "SELECT 1;"`
3. What does `.env` say for `MYSQL_PORT`? (3307 = cloud, 3306 = local)
4. Are you on the Oracle Cloud VM or a local dev machine?
5. Did someone change `MYSQL_PORT` recently? `git diff HEAD -- .env`

---

### 10. The Confusion in One Sentence

**"oracle" in `database-sync.service.ts` is a sync-role label for a two-local-MySQL topology. Oracle Cloud MySQL is a real separate database at 10.0.0.99:3306 reached via SSH tunnel on 127.0.0.1:3307. Both are true. They are not the same thing. The app's `.env` has no ORACLE_* vars because the tunnel makes Oracle MySQL reachable on a local port.**
