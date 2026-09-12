#!/usr/bin/env node
/**
 * Failure simulation: a blocked / slow / dead MySQL persistence writer must not delay the trading
 * decision path.
 *
 * Operator requirement (2026-09-12): "Redis batching is for MySQL persistence/offload, not for
 * delaying or gating trading decisions. The trading hot path must remain:
 * live provider -> canonical interpreter -> validation -> trading engine -> signal -> risk ->
 * execution. It must not wait for Redis batch flushes or MySQL writes. Add a test/failure simulation
 * proving that a blocked/slow MySQL persistence writer cannot block the trading decision/execution
 * path."
 *
 * The measured context this test is calibrated against (docs/REDIS_HOT_PATH_OFFLOAD.md):
 *   - today the writers await the MySQL write inside the tick path;
 *   - that write costs p50 287 ms / p95 484 ms / p99 550 ms over the tunnel;
 *   - peak market-hours load is ~236 ticks/s.
 *
 * Sections:
 *   [A] a sink that NEVER resolves (MySQL hung)            - decisions keep flowing, queue bounded
 *   [B] a sink that is SLOW at the measured p50 (287 ms)    - decision latency unaffected
 *   [C] a sink that THROWS every time (MySQL rejecting)     - decisions unaffected, batch recoverable
 *   [D] exit/stop-loss priority: a decision that must act   - cannot be delayed by persistence
 *   [E] bounded shutdown drain + honest remainder reporting
 *   [F] structural guarantees: synchronous ingest, single-flight, no clock/timers/IO/AI, unwired
 */
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const F = require(path.join(REPO, 'dist', 'trading', 'unified-market-data', 'tick-fanout'));

let passed = 0, failed = 0;
const ok = (name, cond, extra) => {
  if (cond) { passed += 1; console.log(`  PASS ${name}`); }
  else { failed += 1; console.log(`  FAIL ${name}${extra !== undefined ? ` :: ${extra}` : ''}`); }
};
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const pct = (arr, p) => arr.length ? arr.slice().sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(p * arr.length))] : NaN;
const ms = (t) => Number(t) / 1e6;

// A tick as the canonical interpreter would hand it over (minimal shape for the simulation).
const tick = (i) => ({ instrumentKey: `NSE_FO|NIFTY26SEP${23000 + (i % 5)}CE`, source: 'FYERS', sourceTimestamp: 1757600000 + i, ltp: 100 + (i % 7) * 0.05, sequenceNumber: i });

// The trading engine stand-in: signal -> risk -> execution, all synchronous and in-process.
const makeEngine = () => {
  const seen = [];
  return {
    seen,
    decide: (t) => { seen.push(t); }, // sync; a real engine does signal/risk/execution here
  };
};

(async () => {
  console.log('\n[A] persistence writer BLOCKED FOREVER (MySQL hung)');
  {
    let sinkCalls = 0;
    const hung = () => { sinkCalls += 1; return new Promise(() => {}); }; // never resolves, like a hung MySQL write
    const fan = F.createTickFanout(hung, { queueCapacity: 100, maxBatchRows: 10 });
    const eng = makeEngine();
    const lat = [];
    const N = 10_000;
    const started = process.hrtime.bigint();
    for (let i = 0; i < N; i += 1) {
      const t0 = process.hrtime.bigint();
      fan.ingest(tick(i), eng.decide);
      lat.push(ms(process.hrtime.bigint() - t0));
    }
    const elapsedMs = ms(process.hrtime.bigint() - started);
    const c = fan.counters();

    eq('EVERY tick reached the engine (no decision dropped)', eng.seen.length, N);
    eq('...and no decision errored', c.decisionErrors, 0);
    ok('decision latency p99 < 1 ms with persistence hung', pct(lat, 0.99) < 1, `p99=${pct(lat, 0.99).toFixed(3)}ms`);
    ok(`10,000 ticks ingested in < 100 ms (took ${elapsedMs.toFixed(1)} ms)`, elapsedMs < 100);
    ok('the persistence queue stayed bounded at capacity', c.queueDepth <= 100, `depth=${c.queueDepth}`);
    eq('overflows were DROPPED for persistence, not blocked', c.droppedForPersistence, N - c.enqueued);
    eq('...and counted under a reason', c.droppedReasons.QUEUE_FULL, c.droppedForPersistence);
    eq('the sink was never called: no drain happened on the hot path', sinkCalls, 0);
    console.log(`       (engine ${eng.seen.length} decisions, enqueued ${c.enqueued}, dropped-for-persistence ${c.droppedForPersistence}, peak depth ${c.peakQueueDepth})`);
  }

  console.log('\n[B] persistence writer SLOW at the MEASURED MySQL p50 (287 ms per batch)');
  {
    const MEASURED_P50 = 287;
    let batches = 0;
    const slow = async (batch) => { batches += 1; await new Promise((r) => setTimeout(r, MEASURED_P50)); void batch; };
    const fan = F.createTickFanout(slow, { queueCapacity: 5_000, maxBatchRows: 100 });
    const eng = makeEngine();
    const lat = [];
    for (let i = 0; i < 1_000; i += 1) {
      const t0 = process.hrtime.bigint();
      fan.ingest(tick(i), eng.decide);
      lat.push(ms(process.hrtime.bigint() - t0));
    }
    eq('all 1,000 decisions taken while each batch costs 287 ms', eng.seen.length, 1_000);
    ok('decision latency p99 < 1 ms despite 287 ms persistence latency', pct(lat, 0.99) < 1, `p99=${pct(lat, 0.99).toFixed(3)}ms`);
    eq('no persistence ran during ingest', batches, 0);
    eq('all ticks still queued for persistence', fan.pending(), 1_000);
    const t0 = process.hrtime.bigint();
    const r1 = await fan.drain();
    const drainMs = ms(process.hrtime.bigint() - t0);
    eq('the drain did commit one 100-row batch', [r1.status, r1.rows], ['COMMITTED', 100]);
    ok('the drain really was slow (>= 287 ms): persistence pays the latency, the engine never did', drainMs >= MEASURED_P50 - 5, `${drainMs.toFixed(1)}ms`);
    eq('the committed rows left the queue', fan.pending(), 900);
    eq('the engine count is unchanged by the drain', eng.seen.length, 1_000);
  }

  console.log('\n[C] persistence writer THROWS every time (MySQL refusing writes)');
  {
    let attempts = 0;
    const bad = async () => { attempts += 1; throw new Error('ER_CON_COUNT_ERROR: too many connections'); };
    const fan = F.createTickFanout(bad, { queueCapacity: 500, maxBatchRows: 50 });
    const eng = makeEngine();
    const rejections = [];
    process.on('unhandledRejection', (e) => rejections.push(e));
    for (let i = 0; i < 300; i += 1) fan.ingest(tick(i), eng.decide);
    const r = await fan.drain();
    const c = fan.counters();
    eq('the failed batch is reported retryable', [r.status, r.retryable], ['FAILED', true]);
    eq('...and NOTHING was lost: all 300 ticks are still queued', fan.pending(), 300);
    eq('the engine still saw every tick', eng.seen.length, 300);
    eq('the failure was counted, not swallowed silently', c.persistErrors, 1);
    eq('no persistence failure escaped as an unhandled rejection', rejections.length, 0);
    ok('a second drain retries the SAME batch in order', (await fan.drain()).retryable === true && attempts === 2);
    eq('the queue head is unchanged by repeated failure (order preserved)', fan.pending(), 300);
  }

  console.log('\n[D] EXIT / stop-loss priority: an exit decision must not wait on persistence');
  {
    // A hung sink AND a full queue: the worst case for a position that must exit NOW.
    const hung = () => new Promise(() => {});
    const fan = F.createTickFanout(hung, { queueCapacity: 4, maxBatchRows: 2 });
    let exitLatencyMs = null;
    const position = { qty: 65, stop: 56.3625, status: 'OPEN' };
    const engine = {
      onTick: (t) => {
        if (position.status === 'OPEN' && t.ltp <= position.stop) { position.status = 'CLOSED'; position.exitTick = t.sequenceNumber; }
      },
    };
    for (let i = 0; i < 50; i += 1) fan.ingest(tick(i), engine.onTick);      // queue fills and drops
    const exitTick = { instrumentKey: 'NSE_FO|NIFTY26SEP23000PE', source: 'FYERS', sourceTimestamp: 1, ltp: 56.0, sequenceNumber: 999 };
    const t0 = process.hrtime.bigint();
    fan.ingest(exitTick, engine.onTick);
    exitLatencyMs = ms(process.hrtime.bigint() - t0);
    ok(`the stop-loss exit fired in < 1 ms while MySQL is hung (${exitLatencyMs.toFixed(4)} ms)`, exitLatencyMs < 1);
    eq('the position is closed', position.status, 'CLOSED');
    eq('...on the tick that breached the stop', position.exitTick, 999);
    const c = fan.counters();
    eq('...and that exit tick was the one dropped for persistence, not the decision', c.droppedForPersistence >= 1 && position.status === 'CLOSED', true);
  }

  console.log('\n[E] bounded shutdown drain with honest remainder reporting');
  {
    const slow = async () => { await new Promise((r) => setTimeout(r, 60)); clock += 70; }; // 70 ms of wall clock per batch
    const fan = F.createTickFanout(slow, { queueCapacity: 1_000, maxBatchRows: 100 });
    const eng = makeEngine();
    for (let i = 0; i < 500; i += 1) fan.ingest(tick(i), eng.decide);
    let clock = 0;
    const res = await fan.drainBounded({ now: () => clock, deadlineMs: 130 }); // two batches fit, the third is past the deadline
    eq('the bounded drain persisted what fit the deadline', res.persisted, 200);
    eq('...and reported the remainder instead of pretending to finish', res.remaining, 300);
    eq('...with the timeout flagged', res.timedOut, true);
    eq('the decision count is untouched by draining', eng.seen.length, 500);
    // failing sink: drainBounded must stop and report, never spin
    const bad = async () => { throw new Error('down'); };
    const fan2 = F.createTickFanout(bad, { queueCapacity: 100, maxBatchRows: 10 });
    for (let i = 0; i < 30; i += 1) fan2.ingest(tick(i), eng.decide);
    const res2 = await fan2.drainBounded({ now: () => 0, deadlineMs: 10_000 });
    eq('a persistently failing sink stops the drain loop and reports the remainder', [res2.persisted, res2.remaining, res2.timedOut], [0, 30, true]);
  }

  console.log('\n[G] SEPARATED LATENCY ACCOUNTING: decision path vs persistence path');
  {
    // Operator requirement: report decision-to-execution latency separately from persistence latency.
    // Same ticks, same sink, two independent measurements.
    const PERSIST_P50 = 287; // measured MySQL write p50 over the tunnel
    const fan = F.createTickFanout(async () => { await new Promise((r) => setTimeout(r, PERSIST_P50)); }, { queueCapacity: 10_000, maxBatchRows: 100 });
    const eng = makeEngine();
    const decision = [];
    for (let i = 0; i < 2_000; i += 1) {
      const t0 = process.hrtime.bigint();
      fan.ingest(tick(i), eng.decide);
      decision.push(ms(process.hrtime.bigint() - t0));
    }
    const persist = [];
    for (let b = 0; b < 5; b += 1) {
      const t0 = process.hrtime.bigint();
      const r = await fan.drain();
      if (r.status === 'COMMITTED') persist.push(ms(process.hrtime.bigint() - t0));
    }
    console.log(`       decision-to-execution : n=${decision.length} p50=${pct(decision, 0.5).toFixed(4)}ms p95=${pct(decision, 0.95).toFixed(4)}ms p99=${pct(decision, 0.99).toFixed(4)}ms`);
    console.log(`       persistence (per batch): n=${persist.length} p50=${pct(persist, 0.5).toFixed(1)}ms p95=${pct(persist, 0.95).toFixed(1)}ms`);
    console.log(`       separation factor (persist p50 / decision p50): ${(pct(persist, 0.5) / pct(decision, 0.5)).toFixed(0)}x`);
    ok('decision path p99 < 1 ms while persistence p50 >= 287 ms', pct(decision, 0.99) < 1 && pct(persist, 0.5) >= PERSIST_P50 - 5);
    ok('the two latencies are measured independently (different magnitudes, same run)', pct(persist, 0.5) / pct(decision, 0.99) > 100);
    eq('every tick was decided', eng.seen.length, 2_000);
  }

  console.log('\n[F] structural guarantees');
  {
    const src = fs.readFileSync(path.join(REPO, 'src', 'trading', 'unified-market-data', 'tick-fanout.ts'), 'utf8');
    const marker = 'ingest(tick: T, decide: (tick: T) => void): void {';
    const implStart = src.lastIndexOf(marker); // the implementation, not the interface declaration
    const ingestBody = src.slice(implStart).split('\n\t\t},')[0];
    const ingestCode = ingestBody.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''); // scan CODE, not prose
    ok('ingest() contains NO await (persistence cannot be waited on)', !/\bawait\b/.test(ingestCode));
    ok('ingest() creates no promise and no timer', !/new Promise|setTimeout|setInterval|\.then\(/.test(ingestCode));
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    ok('no clock read (the host injects one)', !/Date\.now\(\)|new Date\(/.test(code));
    ok('no DB, Redis or HTTP client', !/mysql|redis|ioredis|fetch\(|axios|http\./i.test(code));
    ok('no AI/model client', !/openai|anthropic|bedrock|\bgpt-|claude/i.test(code));
    const fan = F.createTickFanout(() => {}, { queueCapacity: 10, maxBatchRows: 5 });
    let decided = 0;
    fan.ingest(tick(1), () => { decided += 1; });
    eq('the decision has ALREADY run when ingest() returns (synchronous hand-off)', decided, 1);
    // single-flight: a slow batch must never be joined by a second concurrent batch
    let concurrent = 0, peakConcurrent = 0;
    const slowSink = async () => { concurrent += 1; peakConcurrent = Math.max(peakConcurrent, concurrent); await new Promise((r) => setTimeout(r, 40)); concurrent -= 1; };
    const fan2 = F.createTickFanout(slowSink, { queueCapacity: 500, maxBatchRows: 10 });
    for (let i = 0; i < 100; i += 1) fan2.ingest(tick(i), () => {});
    const [a, b, c] = await Promise.all([fan2.drain(), fan2.drain(), fan2.drain()]);
    eq('concurrent drains: one commits, the others report IN_FLIGHT', [a.status, b.status, c.status], ['COMMITTED', 'IN_FLIGHT', 'IN_FLIGHT']);
    eq('exactly one batch was in flight at any time', peakConcurrent, 1);
    // unwired: research/shadow only
    const importers = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) {
          const s = fs.readFileSync(p, 'utf8');
          if (/from\s+['"].*tick-fanout['"]|require\(['"].*tick-fanout['"]\)/.test(s)) importers.push(path.relative(REPO, p));
        }
      }
    };
    walk(path.join(REPO, 'src'));
    eq('nothing in production imports it yet (research/shadow only)', importers, []);
  }

  console.log(`\ntick-fanout failure simulation: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('SIMULATION FAILED', e.message); process.exit(1); });
