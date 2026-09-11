/**
 * market-data-canonical-status.js — READ-ONLY diagnostic for the canonical
 * market-data pipeline.
 *
 * Why this exists: the canonical tick interpreter is permanently in the
 * production path (provider raw payload -> adapter -> interpreter -> validation
 * -> canonical persistence -> desks) and has NO operating mode. Its measurement
 * counters are the evidence a live verification reads: how many ticks were
 * accepted, which rejection codes fired and how often, what was persisted, what
 * the producer's own gate withheld, what was ignored as a provider control
 * record, and the measured broker lag percentiles.
 *
 * The endpoint lives behind the app's normal operator auth wall, so this uses the
 * same server-to-server header the gate tooling uses (never /auth/login, which is
 * rate limited to 10/15 min). It writes nothing and changes nothing.
 *
 *   npm run market-data:canonical            # pretty read-out
 *   npm run market-data:canonical -- --json  # raw JSON
 *
 * Note on scope: the web app answers for ITS OWN process (it owns the Upstox REST
 * producer). The FYERS socket is owned by the headless `trading-agent`, which runs
 * no HTTP server and instead logs a compact `[CANONICAL] …` summary every
 * CANONICAL_SUMMARY_MS (default 5 min) — read that with `pm2 logs trading-agent`.
 */
const path = require('path');
const ROOT = '/home/swarna-sekhar-dhar/projects/my-job-agent';
require(path.join(ROOT, 'node_modules/dotenv')).config({ path: path.join(ROOT, '.env') });

const BASE = process.env.PROJECT_STATUS_BASE || process.env.DESK_API_BASE || 'http://127.0.0.1:3010';

(async () => {
	const gateAuth = require('./lib/gate-auth');
	const headers = await gateAuth.authHeaders();
	let res;
	try {
		res = await fetch(`${BASE}/market-data/canonical`, { headers });
	} catch (error) {
		console.error(`FAILED: cannot reach ${BASE}/market-data/canonical — ${error.message}`);
		process.exit(1);
	}
	if (res.status === 401) {
		console.error('FAILED: operator auth refused (x-operator-password) — check portal_users.passwordEnc vs ENCRYPTION_KEY.');
		process.exit(1);
	}
	if (!res.ok) {
		console.error(`FAILED: HTTP ${res.status} ${await res.text()}`);
		process.exit(1);
	}
	const body = await res.json();
	if (process.argv.includes('--json')) {
		console.log(JSON.stringify(body, null, 2));
		return;
	}
	console.log('\ncanonical market-data pipeline (app process)\n');
	console.log(`  pipeline   ${body.pipeline}`);
	console.log(`  asOf       ${body.asOf}`);
	console.log(`  accepted   ${body.accepted}   persisted ${body.persisted}   withheld ${body.withheld}   ignored ${body.ignored}   rejected ${body.rejected}`);
	const codes = Object.entries(body.rejectionsByCode ?? {});
	console.log(`  rejects    ${codes.length ? codes.map(([code, n]) => `${code}=${n}`).join(' ') : 'none'}`);
	const sources = Object.entries(body.rejectionsBySource ?? {});
	console.log(`  by source  ${sources.length ? sources.map(([source, n]) => `${source}=${n}`).join(' ') : 'none'}`);
	const latency = body.latency ?? {};
	console.log(`  latency    samples=${latency.samples ?? 0} p50=${latency.p50Ms ?? '-'}ms p95=${latency.p95Ms ?? '-'}ms max=${latency.maxMs ?? '-'}ms budgetBreaches=${body.latencyBudgetExceeded ?? 0}`);
	console.log(`  last       ${body.lastSample ? `${body.lastSample.source}:${body.lastSample.instrumentKey} accepted=${body.lastSample.accepted} lag=${body.lastSample.lagMs ?? '-'}ms` : '-'}`);
	console.log('\nFYERS-side counters come from the socket owner (headless trading-agent):  pm2 logs trading-agent | grep CANONICAL\n');
})().catch((error) => {
	console.error(`FAILED: ${error.message}`);
	process.exit(1);
});
