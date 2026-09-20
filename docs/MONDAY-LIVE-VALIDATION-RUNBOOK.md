# Monday Live Validation Runbook

> **PAPER TRADING ONLY** — `REAL_ORDER_ALLOWED=false` enforced. No live orders ever.
> **Last updated:** 2026-09-19

---

## Quick Reference

| Item | Status | When |
|------|--------|------|
| 109 (latency model) | LIVE-MARKET ONLY | 9:15–15:30 IST |
| 115 (missed opportunities) | LIVE-MARKET ONLY | 9:15–15:30 IST |
| 353 (fill comparison) | LIVE-MARKET ONLY | 9:15–15:30 IST |
| 892 (TA-14 end-to-end tick) | LIVE-MARKET ONLY | 9:15–15:30 IST |
| 894 (TA-16 production reliability) | 24-HOUR UPTIME | Starts post-market |

---

## 1. PRE-OPEN (before 9:15 AM IST)

### 1.1 PM2 Health Baseline

```bash
pm2 list
```

**Expected:** `trading-agent` shows `online`. Record uptime, CPU%, and memory.

```bash
pm2 show trading-agent
```

**Record for later comparison:**
- PID
- Memory (RSS)
- Uptime
- Restart count

### 1.2 Provider / Token Check

Verify Upstox access token is valid:

```bash
# Check token age and validity from logs
pm2 logs trading-agent --lines 50 --nostream 2>&1 | grep -i "token\|oauth\|auth\|expired"
```

If token is expired or auth fails:
1. Check if cloudflared tunnel to `http://localhost:3010` is active
2. Hit Upstox OAuth callback to refresh token
3. Verify new token is picked up by the service

### 1.3 DB / Pool Check

**SSH tunnel must be up first:**

```bash
# Check if tunnel to 127.0.0.1:3307 exists
ss -tlnp | grep 3307
```

If tunnel is down:
```bash
# Restart tunnel (adjust host/port as needed)
ssh -L 3307:10.0.0.99:3306 oracle-host -N -f
```

**Verify DB connectivity and latency:**

```bash
cd ~/projects/my-job-agent-trading
node -e "
const mysql = require('mysql2/promise');
(async () => {
  const start = Date.now();
  const conn = await mysql.createConnection({
    host: '127.0.0.1', port: 3307,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE || 'fnf_trading'
  });
  const [rows] = await conn.execute('SELECT 1 AS ok');
  console.log('DB OK, latency:', Date.now() - start, 'ms');
  await conn.end();
})();
"
```

**Acceptable:** < 100ms round-trip. If > 500ms, investigate tunnel or Oracle MySQL HeatWave instance.

### 1.4 CPU / RAM Baseline

```bash
# Record baseline before market open
echo "=== PRE-OPEN BASELINE $(date) ==="
pm2 show trading-agent | grep -E "memory|cpu|pid|uptime"
free -m
uptime
```

Save these values. You will compare against post-market readings.

### 1.5 WebSocket Connectivity Check

```bash
# Watch for WS connection logs
pm2 logs trading-agent --lines 100 --nostream 2>&1 | grep -i "websocket\|ws.*connect\|subscribe\|tick"
```

**Expected:** Logs show WebSocket connected to Upstox V3, subscribed to NIFTY options chain, first tick received.

If WS fails:
- Check Upstox API status
- Verify access token is not expired (step 1.2)
- Check network connectivity

### 1.6 Run Gate Checks

```bash
cd ~/projects/my-job-agent-trading
node scripts/gate-checks/gate-474-all-gates-pass.js
```

**Expected:** All gates pass. If any fail, investigate before market open. This is a hard blocker.

Individual gates (run if 474 fails to identify which gate):
```bash
node scripts/gate-checks/gate-362-regime-stability.js
node scripts/gate-checks/gate-365-release-artifact.js
node scripts/gate-checks/gate-368-killswitch-dedup.js
node scripts/gate-checks/gate-371-micro-capital.js
node scripts/gate-checks/gate-374-review-process.js
```

### 1.7 Negative Test Suite

```bash
cd ~/projects/my-job-agent-trading
node scripts/negative-testing-suite.js
```

> **Note:** Script not yet created. If missing, manually run individual negative tests:
> ```bash
> node scripts/negative-test-execution-adjusted-labels.js
> node scripts/negative-test-holdout-protection.js
> node scripts/negative-test-indefinite-hold.js
> node scripts/negative-test-market-making-excluded.js
> ```

### 1.8 Performance Monitor

```bash
cd ~/projects/my-job-agent-trading
node scripts/performance-monitor.js
```

> **Note:** Script not yet created. Use PM2 monitoring as fallback:
> ```bash
> pm2 monit
> ```
> Or check process stats directly:
> ```bash
> pm2 show trading-agent | grep -E "memory|cpu|restarts"
> ```

---

## 2. MARKET HOURS (9:15 AM – 3:30 PM IST)

### 2.1 Live Tick Observation

Open a dedicated terminal for continuous monitoring:

```bash
# Follow live tick flow
pm2 logs trading-agent --lines 0
```

**Watch for:**
- Ticks arriving regularly (NIFTY options chain updates)
- Canonical interpreter processing ticks without errors
- No repeated error patterns

**Key log patterns to monitor:**
```bash
# In a second terminal, filter for important events
pm2 logs trading-agent --lines 0 2>&1 | grep -iE "tick|error|warn|STALE|FRESH|provider|arbitration|flush|latency"
```

### 2.2 Feed Arbitration Check

Verify only one provider owns each universe:

```bash
pm2 logs trading-agent --lines 200 --nostream 2>&1 | grep -i "arbitration\|provider.*claim\|provider.*release"
```

**Expected:** Clean ownership, no duplicate provider claims for the same instrument universe.

### 2.3 Feed Health Check

Verify all feeds are FRESH:

```bash
pm2 logs trading-agent --lines 200 --nostream 2>&1 | grep -iE "STALE|FRESH|feed.*health|liveness"
```

**Any STALE feed:** Trigger recovery verification (step 2.4).

### 2.4 Recovery Verification

If a feed goes STALE, verify automatic recovery:

```bash
# Watch for STALE -> FRESH transition
pm2 logs trading-agent --lines 0 2>&1 | grep -iE "STALE|FRESH|recover|reconnect"
```

**Expected:** Provider reconnection within 30 seconds, feed returns to FRESH.

### 2.5 Persistence Health

Check write-behind queue and DB flush:

```bash
pm2 logs trading-agent --lines 200 --nostream 2>&1 | grep -iE "flush|queue|persist|write.*behind|batch"
```

**Watch for:** Growing queue depth (writes falling behind), flush errors.

### 2.6 Item 109 — Latency Model (requires live ticks)

```bash
cd ~/projects/my-job-agent-trading
node scripts/test-latency-model.js
```

**Prerequisite:** Live tick data must be flowing. Run after confirming ticks in step 2.1.

### 2.7 Item 115 — Missed Opportunities (requires live option chain)

```bash
cd ~/projects/my-job-agent-trading
node scripts/test-missed-opps.js
```

**Prerequisite:** Live option chain data flowing with multiple strikes visible.

### 2.8 Item 353 — Fill Comparison (requires live order fills)

```bash
cd ~/projects/my-job-agent-trading
node scripts/test-fill-comparison.js
```

**Prerequisite:** At least one paper order fill has occurred during the session. May need to wait for signal generation.

### 2.9 Item 892 — TA-14 End-to-End Tick (requires live provider data)

```bash
cd ~/projects/my-job-agent-trading
node scripts/test-e2e-tick.js
```

**Prerequisite:** Full provider → interpreter → persistence pipeline active with live data.

### 2.10 Continuous Monitoring

During market hours, watch for:

| Signal | Threshold | Action |
|--------|-----------|--------|
| Tick rate drop | > 60s gap between ticks | Check provider health |
| Provider switch | Any provider change event | Verify arbitration logic |
| High latency | > 500ms tick-to-persist | Check DB / network |
| Error spike | > 10 errors/min | Review logs, check pool |
| Memory growth | > 200MB above baseline | Possible leak (see post-market) |

---

## 3. POST-MARKET (after 3:30 PM IST)

### 3.1 Research Pipeline

```bash
cd ~/projects/my-job-agent-trading
# Kick off off-hours research if applicable
node scripts/category-c-research.test.js
```

Or check if adaptation engine should run:
```bash
pm2 logs trading-agent --lines 50 --nostream 2>&1 | grep -i "research\|adaptation\|off-hours"
```

### 3.2 Error Review

```bash
# Review error logs from the session
pm2 logs trading-agent --err --lines 200 --nostream 2>&1 | tail -50
```

**Check for:**
- Canonical interpreter rejections (malformed ticks)
- DB connection errors
- Provider disconnections
- Auth/token errors

### 3.3 Performance Review

```bash
echo "=== POST-MARKET BASELINE $(date) ==="
pm2 show trading-agent | grep -E "memory|cpu|pid|uptime|restarts"
free -m
uptime
```

**Compare against step 1.4 pre-open baseline:**

| Metric | Pre-Open | Post-Market | Acceptable Δ |
|--------|----------|-------------|---------------|
| Memory (RSS) | ___ MB | ___ MB | < +50 MB |
| Restart count | ___ | ___ | 0 new restarts |
| CPU avg | ___ % | ___ % | < +5% |

### 3.4 Item 894 — TA-16 Production Reliability (24-Hour Uptime)

```bash
# Record the start time
echo "24-hour uptime window started: $(date -Iseconds)" >> ~/projects/my-job-agent-trading/docs/evidence/item-894-uptime.log
```

**Rules:**
- Start time must be recorded post-market (after 15:30 IST)
- Do NOT mark 894 DONE until 24 continuous hours verified
- Check uptime at intervals:
  ```bash
  pm2 show trading-agent | grep uptime
  ```
- If `trading-agent` restarted during the 24-hour window, the window resets
- Verification command (run after 24h):
  ```bash
  echo "24-hour uptime verified: $(date -Iseconds)" >> ~/projects/my-job-agent-trading/docs/evidence/item-894-uptime.log
  ```

### 3.5 Resource Leak Check

```bash
cd ~/projects/my-job-agent-trading
node scripts/resource-leak-check.js
```

> **Note:** Script not yet created. Manual leak check:
> ```bash
> # Take memory snapshot at intervals
> pm2 show trading-agent | grep memory
> # Wait 10 minutes, check again
> # RSS should stabilize, not grow continuously
> 
> # Check Node.js heap via process
> node -e "const v8 = require('v8'); const s = v8.getHeapStatistics(); console.log(JSON.stringify(s, null, 2));"
> 
> # Check for file descriptor leaks
> ls /proc/$(pm2 pid trading-agent)/fd 2>/dev/null | wc -l
> ```

---

## 4. SAFETY RULES

### Hard Constraints (NEVER violate)

| Rule | Enforcement |
|------|-------------|
| `REAL_ORDER_ALLOWED=false` | Code-locked in `upstox-live-paper.config.ts`; cannot be toggled at runtime |
| No risk control modification during live session | Do not edit risk params, position limits, or kill-switches while market is open |
| No destructive DB failures | Never inject faults into production DB during live hours |
| No data deletion | Never delete tick data, trade records, or position history |

### Emergency Procedures

**Stop all trading activity immediately:**
```bash
pm2 stop trading-agent
```

**Restart after resolving issue:**
```bash
pm2 restart trading-agent
```

**SSH tunnel failure (causes crash-loop):**
```bash
# 1. Kill stale tunnel
pkill -f "ssh -L 3307"

# 2. Restart tunnel
ssh -L 3307:10.0.0.99:3306 oracle-host -N -f

# 3. Restart agent
pm2 restart trading-agent
```

**Provider auth failure:**
1. Check if cloudflared tunnel to `http://localhost:3010` is active
2. Verify Upstox OAuth endpoint is reachable
3. Refresh token via OAuth flow
4. Restart trading-agent if token refresh requires service restart

---

## 5. CHECKLIST SUMMARY

### Pre-Open Checklist

- [ ] PM2 `trading-agent` is `online`
- [ ] Upstox access token is valid (not expired)
- [ ] WebSocket connects and receives first tick
- [ ] SSH tunnel to 3307 is up
- [ ] MySQL connection pool healthy, latency < 100ms
- [ ] Baseline CPU/RAM recorded
- [ ] Gate 474 (all gates) passes
- [ ] Negative tests pass
- [ ] Performance baseline recorded

### Market Hours Checklist

- [ ] Live ticks observed flowing
- [ ] Feed arbitration clean (one provider per universe)
- [ ] All feeds FRESH
- [ ] Write-behind queue depth normal
- [ ] Item 109 (latency model) — run and pass
- [ ] Item 115 (missed opps) — run and pass
- [ ] Item 353 (fill comparison) — run and pass
- [ ] Item 892 (e2e tick) — run and pass
- [ ] No error spikes during session

### Post-Market Checklist

- [ ] Error logs reviewed
- [ ] Performance compared to pre-open baseline
- [ ] Item 894 uptime window start time recorded
- [ ] Resource leak check completed
- [ ] Research pipeline kicked off (if applicable)

---

## 6. ESCALATION CONTACTS

| Issue | First Step | Escalation |
|-------|-----------|------------|
| Provider auth fails | Check OAuth at `http://localhost:3010` (cloudflared) | Upstox support / manual token refresh |
| DB unreachable | Check SSH tunnel (`ss -tlnp | grep 3307`) | Check Oracle MySQL HeatWave instance status |
| Memory leak suspected | Run resource-leak-check, check PM2 memory | Profile with `--inspect`, review heap dumps |
| Process crash-loop | Check `pm2 logs trading-agent --err --lines 50` | Fix root cause, `pm2 restart` |
| Market data stale | Check provider WebSocket connection | Restart provider, verify network |

---

## 7. SCRIPTS REFERENCE

| Script | Exists | Purpose |
|--------|--------|---------|
| `scripts/gate-checks/gate-474-all-gates-pass.js` | ✅ | Run all gate checks |
| `scripts/gate-checks/gate-362-regime-stability.js` | ✅ | Regime stability gate |
| `scripts/gate-checks/gate-365-release-artifact.js` | ✅ | Release artifact gate |
| `scripts/gate-checks/gate-368-killswitch-dedup.js` | ✅ | Kill-switch dedup gate |
| `scripts/gate-checks/gate-371-micro-capital.js` | ✅ | Micro capital gate |
| `scripts/gate-checks/gate-374-review-process.js` | ✅ | Review process gate |
| `scripts/test-latency-model.js` | ✅ | Item 109: latency model test |
| `scripts/test-missed-opps.js` | ✅ | Item 115: missed opportunities |
| `scripts/test-fill-comparison.js` | ✅ | Item 353: fill comparison |
| `scripts/test-e2e-tick.js` | ✅ | Item 892: end-to-end tick |
| `scripts/negative-testing-suite.js` | ❌ | Negative test suite (use individual scripts as fallback) |
| `scripts/performance-monitor.js` | ❌ | Performance monitor (use `pm2 monit` as fallback) |
| `scripts/resource-leak-check.js` | ❌ | Resource leak check (use manual steps as fallback) |
