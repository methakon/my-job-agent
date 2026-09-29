#!/usr/bin/env node
/**
 * VM RESILIENCE — diagnose and harden the ~90-minute wedge.
 *
 * Observed pattern (2026-09-28/29): the Oracle VM answers SSH for roughly
 * 90 minutes after boot, then stops completing the handshake (TCP 22 accepts,
 * no banner). OCI still reports RUNNING, so this is a guest-level failure, not
 * a platform stop. A soft reset restores it, temporarily.
 *
 * The box is VM.Standard.E2.1.Micro: 1 OCPU / 1 GB RAM with NO SWAP. The prime
 * suspect is memory pressure — an OOM-kill spree leaves the guest wedged rather
 * than killed, and pm2 restart storms amplify it.
 *
 * This script is READ-ONLY and local-first. It collects whatever evidence is
 * reachable and emits a concrete remediation plan; it never restarts, stops or
 * reconfigures anything without an explicit flag.
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const VM = '168.110.60.10';
const KEY = '/home/swarna-sekhar-dhar/.ssh/oci-vm-id_ed25519';
const OCID = 'ocid1.instance.oc1.ap-tokyo-1.anxhiljroegggcicwo6aew7qaff3aq6aew7qaff3aq6t72w3soovszjgr6t5ssqytic2dwaq'
  .replace('ocid1.instance.oc1.ap-tokyo-1.anxhiljroegggcicwo6aew7qaff3aq6a', 'ocid1.instance.oc1.ap-tokyo-1.anxhiljroegggcicwo6a');

const TUNNEL_SCRIPT = '/home/swarna-sekhar-dhar/mds-tunnel.sh';

function sh(cmd, opts = {}) {
  try { return { ok: true, out: execFileSync('bash', ['-lc', cmd], { encoding: 'utf8', timeout: opts.timeout ?? 20000, stdio: ['ignore', 'pipe', 'pipe'] }).trim() }; }
  catch (e) { return { ok: false, out: (e.stdout || '').trim(), err: (e.stderr || e.message || '').toString().trim() }; }
}

function ssh(cmd, timeout = 20000) {
	// The VM's login user is `ubuntu`. Without an explicit user, ssh falls back
	// to the local username and fails with "Permission denied (publickey)" —
	// which looks exactly like an unreachable VM and produced a false diagnosis.
	return sh(`timeout ${Math.ceil(timeout / 1000)} ssh -i ${KEY} -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=12 ubuntu@${VM} ${JSON.stringify(cmd)}`, { timeout: timeout + 5000 });
}

/** Probe A/B/C: VM reachability, tunnel, DB. */
function probe() {
  const vm = ssh('echo ALIVE');
  const vmUp = vm.ok && /ALIVE/.test(vm.out);
  const listen = sh("ss -ltn 2>/dev/null | grep -c ':3307'");
  const mysql = sh('cd /home/swarna-sekhar-dhar/projects/my-job-agent && set -a && . ./.env && set +a && MYSQL_PWD="$MYSQL_PASSWORD" timeout 12 mysql -h 127.0.0.1 -P 3307 -u "$MYSQL_USER" myjob_agent -N -B -e "SELECT 1;"', { timeout: 25000 });
  return {
    vmReachable: vmUp,
    vmDetail: vmUp ? vm.out : (vm.err || vm.out || 'unreachable'),
    tunnelListening: listen.ok && Number(listen.out) > 0,
    mysqlOk: mysql.ok && /1/.test(mysql.out),
  };
}

/** Remote diagnostics — only when the VM answers. */
function remoteDiagnostics() {
  const r = {};
  r.uptime = ssh("uptime -p");
  r.memory = ssh("free -m | awk 'NR==2{print \$3\" used / \"\$2\" MB total, avail \"\$7}'");
  r.swap = ssh("swapon --show 2>/dev/null | wc -l");
  r.oom = ssh("dmesg 2>/dev/null | grep -ciE 'out of memory|oom-kill|killed process' || echo 0");
  r.oomTail = ssh("dmesg 2>/dev/null | grep -iE 'out of memory|oom-kill' | tail -5");
  r.pm2 = ssh("pm2 jlist 2>/dev/null | python3 -c \"import json,sys; [print(p['name'],p['pm2_env']['status'],'restarts',p['pm2_env']['['\\\"'\\\"'restart_time'\\\"'\\\"']']) for p in json.load(sys.stdin)]\" 2>/dev/null || pm2 ls --no-color 2>/dev/null | head -6");
  r.journalDrops = ssh("journalctl -p err -n 15 --no-pager 2>/dev/null | tail -15");
  for (const k of Object.keys(r)) r[k] = r[k].ok ? r[k].out : `UNREACHABLE (${(r[k].err || '').slice(0, 60)})`;
  return r;
}

/** Local supervision state: how is the tunnel meant to stay up? */
function localSupervision() {
  return {
    tunnelScriptExists: fs.existsSync(TUNNEL_SCRIPT),
    tunnelScriptCron: sh(`grep -rl "mds-tunnel" /home/swarna-sekhar-dhar/.hermes/cron/jobs.json 2>/dev/null | head -1`),
    tunnelProcesses: sh("pgrep -af 'ssh .*3307' | wc -l").out,
    desktopPm2: sh("pm2 jlist 2>/dev/null | python3 -c \"import json,sys; [print(p['name'],p['pm2_env']['status']) for p in json.load(sys.stdin)]\" 2>/dev/null || echo 'pm2 unavailable'").out,
    cronTunnelJobs: (() => {
      try {
        const j = JSON.parse(fs.readFileSync('/home/swarna-sekhar-dhar/.hermes/cron/jobs.json', 'utf8'));
        const arr = Array.isArray(j) ? j : (j.jobs || []);
        return arr.filter((x) => /tunnel|mds|backup/i.test(JSON.stringify(x))).map((x) => ({ name: x.name, schedule: x.schedule, last: x.last_run_at, status: x.last_status }));
      } catch { return []; }
    })(),
  };
}

/**
 * Remediation plan. Every item is either implementable locally now, or needs
 * an explicit operator action. Nothing here executes on its own.
 */
function plan(p, diag) {
  const items = [];
  if (!p.vmReachable) {
    items.push({
      id: 'VM_WEDGE',
      severity: 'BLOCKER',
      needs: 'OPERATOR_OR_OCI_ACTION',
      action: 'Soft reset restores the guest; the 1GB/no-swap shape is the standing risk.',
      fix: 'Add swap on the VM (needs SSH — blocked while wedged) or resize the shape. I will not resize a VM without explicit approval.',
    });
  }
  items.push({
    id: 'TUNNEL_NO_SUPERVISION',
    severity: 'HIGH',
    needs: 'LOCAL_IMPLEMENTATION',
    action: 'The DB tunnel is a bare `ssh -N -f` process with no keepalive supervision and no auto-restart. When it dies (or the VM wedges), nothing re-establishes it.',
    fix: 'Run the tunnel under a supervised loop (systemd --user unit, or a pm2-managed wrapper) with ServerAliveInterval and restart-on-failure.',
  });
  if (diag && /UNREACHABLE/.test(String(diag.oom))) {
    items.push({ id: 'OOM_EVIDENCE', severity: 'UNKNOWN', needs: 'VM_REACHABLE', action: 'Confirm or rule out OOM kills as the wedge cause via dmesg/journalctl.', fix: 'Requires the VM to answer SSH.' });
  }
  items.push({
    id: 'DUP_INGESTION_GUARD',
    severity: 'MEDIUM',
    needs: 'LOCAL_IMPLEMENTATION',
    action: 'After a reconnect, the writer must not re-ingest ticks it already stored.',
    fix: 'Verify the canonical row-id / INSERT IGNORE path is active on the worker after restart, and that seq numbers stay monotonic.',
  });
  return items;
}

function report() {
  const p = probe();
  const diag = p.vmReachable ? remoteDiagnostics() : null;
  const local = localSupervision();
  return {
    schema: 'vm-resilience/v1',
    at: new Date().toISOString(),
    probe: p,
    remote: diag,
    localSupervision: local,
    plan: plan(p, diag),
    note: 'READ-ONLY. No restart, no resize, no reconfiguration is performed by this script.',
  };
}

module.exports = { probe, remoteDiagnostics, localSupervision, plan, report };

if (require.main === module) {
  console.log(JSON.stringify(report(), null, 2));
}
