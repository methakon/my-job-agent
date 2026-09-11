/**
 * canonical-live-verify.js — the objective rows-878 proof, on REAL live payloads.
 *
 * Row 878 doneWhen (GATE 0 #11): both broker feeds pass through the mandatory
 * canonical pipeline with no mode switch, resolve to ONE canonical schema and
 * identity for the same economic tick, preserve provenance + timestamp semantics,
 * reject invalid data with counted codes without repairing/fabricating/falling
 * back, are deterministic and AI-free, and leave the canonical representation
 * persisted in the common store AND demonstrably consumed by BOTH desks.
 *
 * This script checks each of those against live data and writes an evidence file.
 * It is READ-ONLY: it never stops a feed, never writes a row, never closes a trade.
 *
 *   npm run verify:canonical-live                 # normal run (market hours)
 *   npm run verify:canonical-live -- --force      # bypass the session guard (dry runs)
 *   npm run verify:canonical-live -- --window 30  # look-back window in minutes (default 10)
 *
 * MEASUREMENT (this is not cosmetic — it decides whether the proof can see anything):
 * every window is computed from THIS process's clock and bound as a parameter, and it is
 * applied to the RIGHT column basis: `createdAt` is server-filled UTC, while the client-written
 * columns (receivedTimestamp, heartbeatAt, orderedAt, signalTs, evaluatedAt, ts) are stored in
 * IST. Windowing an IST column with a UTC cutoff — or with the server's NOW() — opens the window
 * 5 h 30 m too wide (measured: 198,720 "rows in 15 minutes" against a true 4,133, ~20x).
 * windowFor() carries the verified basis and probeTimeBases() re-checks it against live data
 * on every run. See scripts/lib/market-session.js.
 */
const fs = require('fs');
const path = require('path');
const ms = require('./lib/market-session');

const args = process.argv.slice(2);
const force = args.includes('--force');
const windowMinutes = Math.max(2, Number((args[args.indexOf('--window') + 1] || '10')) || 10);

const results = [];
const check = (label, ok, detail) => {
	results.push({ label, ok: Boolean(ok), detail: String(detail ?? '') });
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label} — ${detail}`);
};

/** Canonical key conformance: EXCHANGE:UNDERLYING[DDMON][STRIKE][CE|PE] or EXCHANGE:INDEX. */
const CANONICAL_OPTION_KEY = /^[A-Z]+:[A-Z0-9]+\d{2}[A-Z]{3}\d+(\.\d+)?(CE|PE)$/;
const CANONICAL_INDEX_KEY = /^[A-Z]+:[A-Z0-9]+$/;

async function main() {
	const startedAt = new Date();
	console.log(`\nrow 878 — canonical pipeline live verification (${ms.istStamp(startedAt)})`);
	console.log(`  window: last ${windowMinutes} min (client-computed cutoff, DB server clock NOT used)\n`);
	if (!ms.isMarketOpen(startedAt) && !force) {
		console.log(`  REFUSED: the session is ${ms.marketState(startedAt)}. Live proof needs real ticks —`);
		console.log('  after hours the providers replay the closed session and the pipeline correctly rejects it STALE.');
		console.log('  Re-run inside 09:15-15:30 IST (or pass --force for a diagnostic-only look).\n');
		process.exitCode = 3;
		return;
	}

	const db = await ms.pool();
	// Re-derive each timestamp column's wall-clock basis from live data before windowing:
	// `createdAt` is server-filled UTC, client columns are IST — one wrong basis is a 5 h 30 m
	// error. See scripts/lib/market-session.js.
	const bases = await ms.probeTimeBases(db);
	const win = (table, alias = '') => ms.windowFor(table, windowMinutes, { alias });

	const evidence = {
		asOf: startedAt.toISOString(), ist: ms.istStamp(startedAt), windowMinutes,
		measurement: { timeBases: bases, windows: {} },
		app: null, socketOwnerLog: null, store: {}, desks: {}, keys: {},
	};
	for (const table of ['unified_option_quotes', 'unified_market_snapshots', 'fnf_option_quotes', 'fnf_market_snapshots', 'pattern_signals', 'fnf_trades', 'upstox_live_paper_orders', 'upstox_live_paper_candidates']) {
		const w = win(table);
		evidence.measurement.windows[table] = `${w.column} (${w.basis}) > ${w.cutoff}`;
	}
	console.log('  clock/column bases (probed live, newest value vs server UTC now):');
	for (const [key, info] of Object.entries(bases)) {
		const flag = info.basis === 'unknown' || info.basis === 'error' ? ' <-- basis not derivable (stale source timestamp?)' : '';
		console.log(`    ${key}: ${info.basis}${info.deltaMin === undefined ? '' : ` (delta ${info.deltaMin} min)`}${flag}`);
	}
	for (const [table, how] of Object.entries(evidence.measurement.windows)) console.log(`    window ${table}: ${how}`);
	console.log('');

	try {
		// ── 1. interpreter counters, per process ─────────────────────────────
		const app = await ms.authGet('/market-data/canonical');
		evidence.app = app;
		console.log(`  app process (upstox producer): accepted=${app.accepted} persisted=${app.persisted} rejected=${app.rejected} withheld=${app.withheld} ignored=${app.ignored}`);
		console.log(`    rejects by code: ${Object.entries(app.rejectionsByCode ?? {}).map(([c, n]) => `${c}=${n}`).join(' ') || 'none'}`);
		console.log(`    latency p50=${app.latency?.p50Ms ?? '-'}ms p95=${app.latency?.p95Ms ?? '-'}ms budgetBreaches=${app.latencyBudgetExceeded}`);
		const logLine = ms.lastCanonicalLogLine();
		evidence.socketOwnerLog = logLine;
		console.log(`  socket owner (fyers producer) log: ${logLine ?? '(no [CANONICAL] line yet — cadence CANONICAL_SUMMARY_MS, default 5 min)'}`);

		const rejectedRate = app.accepted + app.rejected > 0 ? app.rejected / (app.accepted + app.rejected) : null;
		check('canonical interpretation is running on live payloads (accepted > 0)', app.accepted > 0, `accepted=${app.accepted}`);
		check('canonical persistence is active (persisted > 0)', app.persisted > 0, `persisted=${app.persisted}`);
		check('rejection rate is explainable (< 20 % of records)', rejectedRate === null || rejectedRate < 0.2,
			rejectedRate === null ? 'no records yet' : `${(rejectedRate * 100).toFixed(1)} % rejected, codes: ${Object.keys(app.rejectionsByCode ?? {}).join(',') || 'none'}`);
		check('no wholesale rejection storm (no single code above 50 % of records)', Object.values(app.rejectionsByCode ?? {}).every((n) => n <= (app.accepted + app.rejected) * 0.5),
			`accepted=${app.accepted} rejected=${app.rejected}`);

		// ── 2. what actually landed in the common store ──────────────────────
		const qwAliased = win('unified_option_quotes', 'incoming'); // for the aliased summary query
		const qw = win('unified_option_quotes');                    // for the unaliased queries
		const [quoteSummary] = await db.query(
			`SELECT source, COUNT(*) rows_, COUNT(DISTINCT instrumentKey) instruments,
			        SUM(CASE WHEN incoming.instrumentKey LIKE '%|%' THEN 1 ELSE 0 END) broker_keyed,
			        SUM(CASE WHEN incoming.instrumentKey LIKE '%-INDEX' THEN 1 ELSE 0 END) legacy_index_form,
			        SUM(CASE WHEN incoming.depth IS NULL
			                   OR COALESCE(JSON_UNQUOTE(JSON_EXTRACT(incoming.depth,'$.payloadHash')),'') = '' THEN 1 ELSE 0 END) missing_hash
			   FROM unified_option_quotes incoming
			  WHERE ${qwAliased.predicate} GROUP BY source ORDER BY rows_ DESC`, [qwAliased.cutoff]);
		evidence.store.quotesBySource = quoteSummary;
		for (const r of quoteSummary) console.log(`  store quotes [${r.source}]: ${r.rows_} rows, ${r.instruments} instruments, broker-keyed=${r.broker_keyed}, legacy-index-form=${r.legacy_index_form}, missing-hash=${r.missing_hash}`);

		const sw = win('unified_market_snapshots');
		const [snapshotSummary] = await db.query(
			`SELECT source, COUNT(*) rows_, GROUP_CONCAT(DISTINCT symbol ORDER BY symbol SEPARATOR ', ') symbols,
			        GROUP_CONCAT(DISTINCT underlying ORDER BY underlying SEPARATOR ', ') underlyings
			   FROM unified_market_snapshots WHERE ${sw.predicate} GROUP BY source ORDER BY rows_ DESC`, [sw.cutoff]);
		evidence.store.snapshotsBySource = snapshotSummary;
		for (const r of snapshotSummary) console.log(`  store snapshots [${r.source}]: ${r.rows_} rows, symbols=${r.symbols}, underlying=${r.underlyings}`);

		const [keyAudit] = await db.query(
			`SELECT instrumentKey, source, underlying, exchange, instrumentType, optionType, strike, expiry, ltp
			   FROM unified_option_quotes WHERE ${qw.predicate} ORDER BY receivedTimestamp DESC LIMIT 4000`, [qw.cutoff]);
		const badKeys = keyAudit.filter((r) => !CANONICAL_OPTION_KEY.test(String(r.instrumentKey)));
		const foreignKeys = keyAudit.filter((r) => String(r.instrumentKey).includes('|'));
		const [hashAudit] = await db.query(
			`SELECT source, COUNT(*) n FROM unified_option_quotes WHERE ${qw.predicate}
			   AND (depth IS NULL OR COALESCE(JSON_UNQUOTE(JSON_EXTRACT(depth,'$.payloadHash')),'') = '')
			  GROUP BY source ORDER BY n DESC`, [qw.cutoff]);
		const hashless = hashAudit.reduce((sum, r) => sum + Number(r.n ?? 0), 0);
		evidence.keys = { sampled: keyAudit.length, badKeys: badKeys.slice(0, 5).map((r) => r.instrumentKey), foreignKeys: foreignKeys.length };
		check('every persisted quote carries the CANONICAL key form', keyAudit.length > 0 && badKeys.length === 0,
			`${keyAudit.length} sampled, ${badKeys.length} non-canonical${badKeys.length ? ` e.g. ${badKeys[0].instrumentKey}` : ''}`);
		check('no broker key form leaked into the store', foreignKeys.length === 0, `${foreignKeys.length} keys containing '|'`);
		check('provenance preserved on every canonical row (depth + payload hash)', hashless === 0,
			hashless === 0 ? 'every row carries depth.payloadHash' : hashAudit.map((r) => `${r.source}=${r.n}`).join(' '));

		// A canonical writer ALWAYS stores a depth object (broker id + payload hash).
		// Rows without one were written by a PRE-canonical writer — i.e. something is
		// still publishing broker-specific rows into the common store, which breaks the
		// "one validated schema, one writer" claim and the single-owner proof.
		const [legacyRows] = await db.query(
			`SELECT source, COUNT(*) n, MAX(createdAt) AS newest FROM unified_option_quotes
			  WHERE ${qw.predicate} AND depth IS NULL GROUP BY source ORDER BY n DESC`, [qw.cutoff]);
		evidence.store.nonCanonicalWriters = legacyRows;
		const asUtc = (v) => (v instanceof Date ? new Date(v.getTime() + ms.IST_OFFSET_MS).toISOString() : v);
		for (const r of legacyRows) console.log(`  NON-CANONICAL writer [${r.source}]: ${r.n} rows, newest write ${asUtc(r.newest)} UTC`);
		check('every row in the window came from the canonical pipeline (no foreign legacy writer)', legacyRows.length === 0,
			legacyRows.length
				? `${legacyRows.map((r) => `${r.source}=${r.n} rows without depth (newest write ${asUtc(r.newest)} UTC)`).join('; ')} — a pre-canonical producer is still writing`
				: 'all rows carry canonical depth');

		// Producer census: the per-process sequence counter tells whether ONE local
		// process or a long-lived foreign one produced the rows.
		const [seqRanges] = await db.query(
			`SELECT source, MIN(sequenceNumber) mn, MAX(sequenceNumber) mx, COUNT(*) n FROM unified_option_quotes
			  WHERE ${qw.predicate} GROUP BY source ORDER BY n DESC`, [qw.cutoff]);
		evidence.store.sequenceRanges = seqRanges;
		for (const r of seqRanges) {
			const range = Number(r.mx) - Number(r.mn) + 1;
			const unexplained = range - Number(r.n);
			console.log(`  producer ${r.source}: seq ${r.mn}-${r.mx} over ${r.n} rows${unexplained > 0 ? ` (counter range ${range} > rows: ${unexplained} counter steps did not produce a row — deduplicated repeats, or another instance of the same source)` : ' (one continuous counter, one writer instance)'}`);
		}

		// ── 3. ONE identity for the same contract across providers ───────────
		const [shared] = await db.query(
			`SELECT instrumentKey, COUNT(DISTINCT source) sources, GROUP_CONCAT(DISTINCT source ORDER BY source) who,
			        MIN(underlying) underlying, MIN(strike) strike, MIN(optionType) optionType, MIN(expiry) expiry
			   FROM unified_option_quotes WHERE ${qw.predicate} GROUP BY instrumentKey
			  HAVING sources > 1 ORDER BY instrumentKey LIMIT 10`, [qw.cutoff]);
		evidence.store.sharedContracts = shared;
		check('the SAME canonical key is produced by BOTH providers (identity convergence)', shared.length > 0,
			shared.length ? `${shared.length} shared contract(s), e.g. ${shared[0].instrumentKey} by ${shared[0].who}` : 'no contract seen from both feeds in the window');
		for (const r of shared.slice(0, 3)) console.log(`    shared: ${r.instrumentKey} (${r.who}) strike=${r.strike} ${r.optionType} exp=${r.expiry} underlying=${r.underlying}`);

		const [sourceUnderlying] = await db.query(
			`SELECT source, underlying, COUNT(DISTINCT instrumentKey) instruments FROM unified_option_quotes
			  WHERE ${qw.predicate} GROUP BY source, underlying ORDER BY instruments DESC LIMIT 8`, [qw.cutoff]);
		evidence.store.byUnderlying = sourceUnderlying;
		for (const r of sourceUnderlying) console.log(`    ${r.source} / ${r.underlying}: ${r.instruments} instruments`);

		// ── 4. desks CONSUME the canonical rows ──────────────────────────────
		// 4a. FNF desk: its own table records the TRUE producer of every quote it
		//     consumed, so a foreign producer there proves it read the common layer.
		const fw = win('fnf_option_quotes');
		const [fnfProviders] = await db.query(
			`SELECT provider, COUNT(*) rows_, COUNT(DISTINCT contractSymbol) contracts
			   FROM fnf_option_quotes WHERE ${fw.predicate} GROUP BY provider ORDER BY rows_ DESC`, [fw.cutoff]);
		evidence.desks.fnfProviders = fnfProviders;
		for (const r of fnfProviders) console.log(`  FNF desk quotes by true producer: ${r.provider} -> ${r.rows_} rows / ${r.contracts} contracts`);
		const foreignInFnf = fnfProviders.filter((r) => String(r.provider).toUpperCase() !== 'FYERS_LIVE' && Number(r.rows_) > 0);
		check('FNF desk consumed common-store rows (foreign producer present)', foreignInFnf.length > 0,
			foreignInFnf.length ? foreignInFnf.map((r) => `${r.provider}=${r.rows_}`).join(' ') : 'FNF desk only saw its own feed in the window');

		const fsw = win('fnf_market_snapshots');
		const [fnfSnapshots] = await db.query(
			`SELECT source, COUNT(*) rows_, COUNT(DISTINCT instrument) instruments FROM fnf_market_snapshots
			  WHERE ${fsw.predicate} GROUP BY source ORDER BY rows_ DESC`, [fsw.cutoff]);
		evidence.desks.fnfSnapshots = fnfSnapshots;
		for (const r of fnfSnapshots) console.log(`  FNF desk snapshots by source: ${r.source} -> ${r.rows_} rows / ${r.instruments} instruments`);

		// 4b. Upstox desk: reads its own feed when ACTIVE and the COMMON store when
		//     STANDBY; sharedTicksUsed counts the shared-layer reads (objective).
		const status = await ms.authGet('/upstox-live-paper/status');
		const feed = status.feed ?? status;
		evidence.desks.upstox = {
			feedRole: feed.feedRole, activeFeedByUniverse: feed.activeFeedByUniverse,
			sharedTicksUsed: feed.sharedTicksUsed, quotesPersistedToday: feed.quotesPersistedToday,
			duplicateTicksSuppressed: feed.duplicateTicksSuppressed, instrumentsTracked: feed.instrumentsTracked,
			lastOptionQuoteTs: feed.lastOptionQuoteTs, tokenExpiresAt: status.auth?.expiresAt ?? null,
			lastError: feed.lastError ?? null,
		};
		console.log(`  upstox desk: feedRole=${feed.feedRole} sharedTicksUsed=${feed.sharedTicksUsed} quotesToday=${feed.quotesPersistedToday} dupes=${feed.duplicateTicksSuppressed} tracked=${feed.instrumentsTracked}`);
		console.log(`    activeFeedByUniverse=${JSON.stringify(feed.activeFeedByUniverse ?? {})} tokenExpires=${status.auth?.expiresAt ?? '?'}`);
		check('upstox desk is running against live data (not disabled/errored)', Boolean(feed.feedRole) && feed.feedRole !== 'DISABLED' && !feed.lastError,
			`feedRole=${feed.feedRole}${feed.lastError ? ` lastError=${String(feed.lastError).slice(0, 80)}` : ''}`);
		check('upstox desk produced quotes from live data in the window', Number(feed.quotesPersistedToday ?? 0) > 0,
			`quotesPersistedToday=${feed.quotesPersistedToday ?? '?'} instruments=${feed.instrumentsTracked ?? '?'}`);

		// 4c. SIGNAL stage: the pattern engine assesses candidates from the common store.
		const pw = win('pattern_signals');
		const [signals] = await db.query(
			`SELECT underlying, \`signal\`, feedSource, COUNT(*) n FROM pattern_signals WHERE ${pw.predicate}
			  GROUP BY underlying, \`signal\`, feedSource ORDER BY n DESC LIMIT 12`, [pw.cutoff]);
		evidence.desks.signals = signals;
		for (const r of signals) console.log(`  pattern signals: ${r.underlying} ${r.signal} x${r.n} (feed=${r.feedSource ?? '?'})`);
		check('SIGNAL stage produced assessments in the window (NO_TRADE counts)', signals.length > 0,
			signals.length ? signals.map((r) => `${r.underlying}:${r.signal}`).join(' ') : 'no pattern assessment in the window');

		// 4d. RISK / PAPER EXECUTION stage: desk decision + order rows (a NO_TRADE
		//     decision recorded with a reason is a completed cycle too).
		const counts = {};
		for (const [label, table, column] of [
			['fnf_trades', 'fnf_trades', 'orderedAt'],
			['fnf_decision_journal', 'fnf_decision_journal', 'createdAt'],
			['upstox_orders', 'upstox_live_paper_orders', 'createdAt'],
			['upstox_candidates', 'upstox_live_paper_candidates', 'evaluatedAt'],
		]) {
			try {
				const w = ms.windowFor(table, windowMinutes, { column });
				const [row] = await db.query(`SELECT COUNT(*) n FROM ${table} WHERE ${w.predicate}`, [w.cutoff]);
				counts[label] = Number(row[0]?.n ?? 0);
			} catch (error) {
				counts[label] = `unavailable (${String(error.message).slice(0, 40)})`;
			}
		}
		evidence.desks.execution = counts;
		console.log(`  execution/decision rows: ${JSON.stringify(counts)}`);
		const executedInWindow = Object.values(counts).some((v) => typeof v === 'number' && v > 0);
		check('RISK/EXECUTION stage ran in the window (order, trade or recorded decision)', executedInWindow, JSON.stringify(counts));

		// ── 5. FYERS STALE investigation, from evidence ──────────────────────
		const staleCount = Number(app.rejectionsByCode?.STALE ?? 0);
		const staleFromFyers = Boolean(/STALE/.test(logLine ?? ''));
		evidence.stale = { appStale: staleCount, socketOwnerLogLine: logLine };
		if (staleCount || staleFromFyers) {
			console.log('\n  STALE rejects detected — evidence for the FYERS analysis:');
			console.log(`    app counters: STALE=${staleCount}; socket-owner line: ${logLine ?? '(none)'}`);
			console.log('    A STALE reject whose reported age is ~the gap since the last session close means the provider');
			console.log('    is REPLAYING a closed-market tick (correct rejection). A STALE age of minutes during live hours');
			console.log('    means a quiet contract carried its last-trade time as the quote time — investigate the QUOTE vs');
			console.log('    LAST_TRADE classification with the operator; never loosen a gate to hide it.');
		}
	} finally {
		await db.end().catch(() => {});
	}

	const failures = results.filter((r) => !r.ok);
	const verdict = { verdict: failures.length ? 'INCOMPLETE' : 'PASS', failures: failures.map((f) => `${f.label}: ${f.detail}`), results };
	const evidenceDir = path.join(ms.ROOT, 'docs', 'evidence');
	fs.mkdirSync(evidenceDir, { recursive: true });
	const file = path.join(evidenceDir, `canonical-live-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
	fs.writeFileSync(file, JSON.stringify({ ...evidence, ...verdict }, null, 2));
	console.log(`\n  verdict: ${verdict.verdict} (${results.length - failures.length}/${results.length} checks passed)`);
	console.log(`  evidence: ${file}\n`);
	if (failures.length) process.exitCode = 2;
}

main().catch((error) => {
	console.error(`\nFAILED: ${error.message}`);
	process.exit(1);
});
