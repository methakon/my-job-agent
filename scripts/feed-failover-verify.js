/**
 * feed-failover-verify.js — the objective rows-877 proof of provider failover and
 * controlled failback, on a REAL session.
 *
 * Row 877 doneWhen (GATE 0 #10): both providers registered as producers, exactly one
 * owner per instrument universe, and BOTH desks complete LIVE DATA -> DATABASE ->
 * SIGNAL -> RISK -> PAPER EXECUTION from the common normalized store, plus a REAL
 * provider outage that demonstrates automatic failover to the healthy provider and
 * controlled failback when the preferred provider recovers.
 *
 * The demo (the ONLY state-changing step in the whole verification, and the one the
 * operator authorised): a BOUNDED 100 s stop of the FYERS socket owner
 * (`pm2 stop trading-agent`) while sampling ownership and actual publication, then a
 * restart that must show the preferred provider reclaiming NIFTY. The restart runs
 * in a `finally` block: this script can never leave the feed stopped.
 *
 * Guards (all must hold or the script refuses and writes nothing):
 *   - the session is OPEN (09:15-15:30 IST, Mon-Fri);
 *   - the FYERS producer is ALREADY healthy: lease ACTIVE, heartbeat < 60 s old,
 *     FRESH NIFTY rows in the common store. The outage demo must never be used to
 *     "discover" a baseline that is already broken;
 *   - the socket owner is currently running (a pre-existing outage is recorded as
 *     the initial state, never claimed as the demonstration).
 *
 *   npm run verify:failover                # 100 s bounded outage (default)
 *   npm run verify:failover -- --seconds 100
 *
 * All windows use a client-computed UTC cutoff (the DB server clock is hours off).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ms = require('./lib/market-session');

const args = process.argv.slice(2);
const seconds = Math.min(180, Math.max(30, Number((args[args.indexOf('--seconds') + 1] || '100')) || 100));
const AGENT = 'trading-agent';
const SAMPLE_MS = 10_000;

const results = [];
const check = (label, ok, detail) => {
	results.push({ label, ok: Boolean(ok), detail: String(detail ?? '') });
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label} — ${detail}`);
};
const sleep = (ms_) => new Promise((r) => setTimeout(r, ms_));
const pm2 = (verb) => execFileSync('pm2', [verb, AGENT], { encoding: 'utf8' }).trim();

/** Ownership + liveness snapshot straight from the arbiter's DB leases. */
async function ownership(db) {
	const [rows] = await db.query('SELECT feedName, state, universes, heartbeatAt, host, pid FROM market_data_feed_leases');
	return rows.map((r) => {
		const at = ms.parseIst(r.heartbeatAt);
		return {
			feed: r.feedName, state: r.state, universes: String(r.universes ?? ''),
			heartbeatAgeS: at ? Math.round((Date.now() - at.getTime()) / 1000) : null, host: r.host ?? null,
		};
	});
}

/** Which producer actually PUBLISHED rows for a universe inside the last N seconds. */
async function publishers(db, universe, lookbackS = 60) {
	const cutoff = ms.utcWall(new Date(Date.now() - lookbackS * 1000));
	const [quotes] = await db.query(
		`SELECT source, COUNT(*) rows_, COUNT(DISTINCT instrumentKey) instruments FROM unified_option_quotes
		  WHERE underlying = ? AND createdAt > ? GROUP BY source ORDER BY rows_ DESC`, [universe, cutoff]);
	const [snaps] = await db.query(
		`SELECT source, COUNT(*) rows_ FROM unified_market_snapshots
		  WHERE (underlying = ? OR symbol IN (?, ?)) AND createdAt > ? GROUP BY source ORDER BY rows_ DESC`,
		[universe, `${universe}`, `NSE:${universe}`, cutoff]);
	return { quotes, snapshots: snaps };
}

const publishedBy = (pub, source) => pub.quotes.find((r) => String(r.source).toUpperCase() === source);

async function main() {
	const startedAt = new Date();
	console.log(`\nrow 877 — feed outage / failover / controlled-failback proof (${ms.istStamp(startedAt)})`);
	console.log(`  bounded outage: ${seconds}s · publication windows: client-computed UTC cutoffs\n`);
	if (!ms.isMarketOpen(startedAt)) {
		console.log(`  REFUSED: the session is ${ms.marketState(startedAt)}. This proof needs live ticks on both feeds —`);
		console.log('  a closed-market run would prove nothing (the canonical pipeline correctly rejects replayed ticks STALE).');
		console.log('  Re-run inside 09:15-15:30 IST.\n');
		process.exitCode = 3;
		return;
	}

	const db = await ms.pool();
	const evidence = { asOf: startedAt.toISOString(), ist: ms.istStamp(startedAt), seconds, stages: {}, arbitration: null };
	const stage = async (name, extra = {}) => {
		const [leases, arb, fyers, upstox] = await Promise.all([
			ownership(db),
			ms.authGet('/market-data/arbitration').catch((e) => ({ error: e.message })),
			publishers(db, 'NIFTY'),
			publishers(db, 'BANKNIFTY'),
		]);
		const snap = { at: ms.istStamp(), atIso: new Date().toISOString(), leases, arbitration: arb, publishedNifty: fyers, publishedBankNifty: upstox, ...extra };
		evidence.stages[name] = snap;
		const niftyOwner = (arb?.decisions ?? []).find((d) => String(d.universe).toUpperCase() === 'NIFTY') ?? null;
		console.log(`\n  [${name}] ${snap.at}`);
		for (const l of leases) console.log(`    lease ${l.feed}: ${l.state} hbAge=${l.heartbeatAgeS}s universes=[${l.universes}]`);
		if (niftyOwner) console.log(`    arbiter NIFTY owner: ${niftyOwner.owner}`);
		console.log(`    published NIFTY (60s): ${fyers.quotes.map((r) => `${r.source}=${r.rows_} rows/${r.instruments} instr`).join(' ') || 'none'}`);
		console.log(`    published BANKNIFTY (60s): ${upstox.quotes.map((r) => `${r.source}=${r.rows_}`).join(' ') || 'none'}`);
		return snap;
	};

	let restoreNeeded = false;
	try {
		// ── stage 1: healthy baseline (the gate the operator demanded) ───────
		const baseline = await stage('baseline');
		const fyersLease = baseline.leases.find((l) => l.feed === 'FYERS_WS') ?? null;
		const fyersPublishing = publishedBy(baseline.publishedNifty, 'FYERS_LIVE');
		const baselineHealthy = Boolean(
			fyersLease && fyersLease.state === 'ACTIVE' && fyersLease.heartbeatAgeS !== null && fyersLease.heartbeatAgeS <= 60 &&
			fyersPublishing && Number(fyersPublishing.rows_) > 0,
		);
		check('baseline: FYERS lease ACTIVE with a fresh heartbeat', Boolean(fyersLease && fyersLease.state === 'ACTIVE' && (fyersLease.heartbeatAgeS ?? 999) <= 60),
			fyersLease ? `${fyersLease.state} hbAge=${fyersLease.heartbeatAgeS}s` : 'no FYERS_WS lease row');
		check('baseline: FYERS is ACTUALLY publishing NIFTY into the common store', Boolean(fyersPublishing && Number(fyersPublishing.rows_) > 0),
			fyersPublishing ? `${fyersPublishing.rows_} rows / ${fyersPublishing.instruments} instruments in 60 s` : 'no FYERS_LIVE NIFTY rows in 60 s');
		check('baseline: FYERS owns the NIFTY universe', String((baseline.arbitration?.decisions ?? []).find((d) => d.universe === 'NIFTY')?.owner ?? '') === 'FYERS_WS',
			`owner=${(baseline.arbitration?.decisions ?? []).find((d) => d.universe === 'NIFTY')?.owner ?? 'unknown'}`);
		if (!baselineHealthy) {
			console.log('\n  REFUSED to run the outage demo: the baseline is not clean (see the FAIL lines above).');
			console.log('  The operator rule is explicit — prove a healthy baseline FIRST; never use the demo to discover a broken one.\n');
			await db.end().catch(() => {});
			fs.mkdirSync(path.join(ms.ROOT, 'docs', 'evidence'), { recursive: true });
			fs.writeFileSync(path.join(ms.ROOT, 'docs', 'evidence', `feed-failover-${new Date().toISOString().replace(/[:.]/g, '-')}.json`),
				JSON.stringify({ ...evidence, verdict: 'REFUSED_BASELINE_UNHEALTHY', results }, null, 2));
			process.exitCode = 3;
			return;
		}

		// ── stage 2: bounded outage of the preferred provider ────────────────
		console.log(`\n  >>> stopping ${AGENT} for ${seconds}s (FYERS socket owner; bounded, auto-restarted)`);
		const stoppedAt = Date.now();
		pm2('stop');
		restoreNeeded = true;
		const failoverStart = Date.now();
		let failoverSeen = null;
		let maxFyersRowsDuringOutage = 0;
		while ((Date.now() - failoverStart) / 1000 < seconds) {
			await sleep(SAMPLE_MS);
			const leases = await ownership(db);
			const pub = await publishers(db, 'NIFTY', 45);
			const upstox = publishedBy(pub, 'UPSTOX_LIVE');
			const [fyersAny] = await db.query(
				'SELECT COUNT(*) n FROM unified_option_quotes WHERE source = ? AND createdAt > ?',
				['FYERS_LIVE', ms.utcWall(new Date(Date.now() - 45_000))]);
			maxFyersRowsDuringOutage = Math.max(maxFyersRowsDuringOutage, Number(fyersAny[0]?.n ?? 0));
			const upstoxLease = leases.find((l) => l.feed === 'UPSTOX_REST');
			const ownedNifty = String(upstoxLease?.universes ?? '').includes('NIFTY');
			console.log(`    t+${Math.round((Date.now() - failoverStart) / 1000)}s: UPSTOX_REST ${upstoxLease?.state ?? '?'} hbAge=${upstoxLease?.heartbeatAgeS ?? '?'}s ownsNIFTY=${ownedNifty} publishedNIFTY=${upstox ? `${upstox.rows_} rows` : '0'} | FYERS rows still landing=${fyersAny[0]?.n ?? 0}`);
			if (ownedNifty && upstox && Number(upstox.rows_) > 0) failoverSeen = { at: ms.istStamp(), rows: Number(upstox.rows_), instruments: Number(upstox.instruments) };
		}
		evidence.stages.outage = { stoppedAt: new Date(stoppedAt).toISOString(), stoppedForS: seconds, failoverSeen, maxFyersRowsDuringOutage, finalLeases: await ownership(db), publishedNifty: await publishers(db, 'NIFTY', 60) };
		check('OUTAGE: the standby provider took the NIFTY universe', Boolean(failoverSeen), failoverSeen ? `${failoverSeen.rows} rows / ${failoverSeen.instruments} instruments at ${failoverSeen.at}` : 'UPSTOX_REST never owned+published NIFTY within the window');
		check('OUTAGE: no rows from the STOPPED producer (exactly one producer per instrument)',
			maxFyersRowsDuringOutage === 0,
			maxFyersRowsDuringOutage === 0
				? 'no FYERS_LIVE rows were written while the local FYERS owner was stopped'
				: `${maxFyersRowsDuringOutage} FYERS_LIVE rows still landed while the local owner was stopped — a SECOND producer is publishing FYERS ticks into the common store (single-owner violated at the producer level)`);

		// ── stage 3: restore + controlled failback ───────────────────────────
		console.log(`\n  >>> restarting ${AGENT} (controlled failback)`);
		pm2('start');
		restoreNeeded = false;
		const backStart = Date.now();
		let failbackSeen = null;
		while ((Date.now() - backStart) / 1000 < 180) {
			await sleep(SAMPLE_MS);
			const leases = await ownership(db);
			const pub = await publishers(db, 'NIFTY', 45);
			const fyers = publishedBy(pub, 'FYERS_LIVE');
			const owner = String((await ms.authGet('/market-data/arbitration').catch(() => ({ decisions: [] })))?.decisions?.find?.((d) => d.universe === 'NIFTY')?.owner ?? '');
			const fyersLease = leases.find((l) => l.feed === 'FYERS_WS');
			console.log(`    t+${Math.round((Date.now() - backStart) / 1000)}s: FYERS_WS ${fyersLease?.state ?? '?'} hbAge=${fyersLease?.heartbeatAgeS ?? '?'}s owner=${owner || '?'} publishedNIFTY=${fyers ? `${fyers.rows_} rows` : '0'}`);
			if (owner === 'FYERS_WS' && fyers && Number(fyers.rows_) > 0) { failbackSeen = { at: ms.istStamp(), rows: Number(fyers.rows_), instruments: Number(fyers.instruments), secondsAfterRestart: Math.round((Date.now() - backStart) / 1000) }; break; }
		}
		evidence.stages.failback = { seen: failbackSeen, finalLeases: await ownership(db), publishedNifty: await publishers(db, 'NIFTY', 60) };
		check('FAILBACK: the preferred provider reclaimed NIFTY and is publishing again', Boolean(failbackSeen),
			failbackSeen ? `${failbackSeen.rows} rows / ${failbackSeen.instruments} instruments ${failbackSeen.secondsAfterRestart}s after restart` : 'FYERS_WS did not reclaim + publish NIFTY within 180 s');

		// ── stage 4: both desks still complete the chain on the restored feed ─
		const deskAudit = execFileSync('node', [path.join(ms.ROOT, 'scripts/canonical-live-verify.js'), '--window', '15'], { encoding: 'utf8' });
		evidence.stages.deskAuditTail = deskAudit.split('\n').filter((l) => /PASS|FAIL|verdict/.test(l)).slice(-14);
		for (const line of evidence.stages.deskAuditTail) console.log(line);
		check('both desks still complete their chain after failback (see audit above)', /verdict: PASS/.test(deskAudit), 'canonical-live-verify verdict');
	} finally {
		if (restoreNeeded) {
			console.log(`\n  !! restoring ${AGENT} (guaranteed restart in finally)`);
			try { pm2('restart'); } catch (error) { console.error(`  RESTART FAILED — start ${AGENT} manually: ${error.message}`); process.exitCode = 4; }
		}
		await db.end().catch(() => {});
	}

	const failures = results.filter((r) => !r.ok);
	const verdict = { verdict: failures.length ? 'INCOMPLETE' : 'PASS', failures: failures.map((f) => `${f.label}: ${f.detail}`), results };
	const evidenceDir = path.join(ms.ROOT, 'docs', 'evidence');
	fs.mkdirSync(evidenceDir, { recursive: true });
	const file = path.join(evidenceDir, `feed-failover-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
	fs.writeFileSync(file, JSON.stringify({ ...evidence, ...verdict }, null, 2));
	console.log(`\n  verdict: ${verdict.verdict} (${results.length - failures.length}/${results.length} checks passed)`);
	console.log(`  evidence: ${file}\n`);
	if (failures.length) process.exitCode = 2;
}

main().catch((error) => {
	console.error(`\nFAILED: ${error.message}`);
	process.exit(1);
});
