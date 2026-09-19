#!/usr/bin/env node
/**
 * ITEM 109: Model signal-to-order and order-to-fill latency.
 *
 * Runs the latency model against synthetic data and verifies:
 * - Budget computation invariants (mean < p95 < p99)
 * - Bottleneck identification
 * - Pipeline simulation determinism
 * - Measurement classification and excessive detection
 * - Budget threshold enforcement
 *
 * doneWhen: "A reviewer can determine exactly what the item does and
 *            a replay/test demonstrates the behavior"
 */

const { execSync } = require('child_process');
const path = require('path');

// ── Helpers ──────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const errors = [];

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    const msg = `  FAIL ${name} :: ${detail}`;
    console.log(msg);
    errors.push(msg);
  }
}

// ── Load compiled module ─────────────────────────────────────────────
const mod = require(path.resolve(__dirname, '../dist/trading/research/latency-model'));

const {
  computeLatencyBudget,
  classifyMeasurement,
  isExcessiveLatency,
  simulateLatencyPipeline,
  identifyBottleneck,
} = mod;

// ── Synthetic latency components for testing ──────────────────────────
const FAST_COMPONENTS = [
  { name: 'signal_generation', meanMs: 1, p95Ms: 2, p99Ms: 3, description: 'Fast signal' },
  { name: 'risk_check',        meanMs: 0.5, p95Ms: 1, p99Ms: 1.5, description: 'Fast risk' },
];

const SLOW_COMPONENTS = [
  { name: 'signal_generation', meanMs: 2, p95Ms: 5, p99Ms: 10, description: 'Signal' },
  { name: 'broker_api_latency', meanMs: 200, p95Ms: 500, p99Ms: 800, description: 'Slow broker' },
];

// ── Tests ────────────────────────────────────────────────────────────
async function main() {
  console.log('=== ITEM 109: Latency Model Verification ===\n');

  // T1: Default budget computation invariants
  {
    console.log('Test 1: Default latency budget invariants');
    const budget = computeLatencyBudget();
    check('totalMeanMs > 0', budget.totalMeanMs > 0, `got ${budget.totalMeanMs}`);
    check('totalP95Ms > 0', budget.totalP95Ms > 0, `got ${budget.totalP95Ms}`);
    check('totalP99Ms > 0', budget.totalP99Ms > 0, `got ${budget.totalP99Ms}`);
    check('mean < p95', budget.totalMeanMs < budget.totalP95Ms,
      `${budget.totalMeanMs} >= ${budget.totalP95Ms}`);
    check('p95 < p99', budget.totalP95Ms < budget.totalP99Ms,
      `${budget.totalP95Ms} >= ${budget.totalP99Ms}`);
    check('budgetRemainingMs computed', typeof budget.budgetRemainingMs === 'number',
      `got ${typeof budget.budgetRemainingMs}`);
    check('withinBudget is boolean', typeof budget.withinBudget === 'boolean',
      `got ${typeof budget.withinBudget}`);
    check('components array length', budget.components.length === 5,
      `got ${budget.components.length}`);
  }

  // T2: Custom fast components — within 100ms budget
  {
    console.log('\nTest 2: Fast components within 100ms budget');
    const budget = computeLatencyBudget(FAST_COMPONENTS, 100);
    check('withinBudget true', budget.withinBudget === true,
      `got ${budget.withinBudget}, p99=${budget.totalP99Ms}`);
    check('budgetRemainingMs > 0', budget.budgetRemainingMs > 0,
      `got ${budget.budgetRemainingMs}`);
  }

  // T3: Custom slow components — exceeds 500ms budget
  {
    console.log('\nTest 3: Slow components exceed budget');
    const budget = computeLatencyBudget(SLOW_COMPONENTS, 500);
    check('withinBudget false', budget.withinBudget === false,
      `got ${budget.withinBudget}, p99=${budget.totalP99Ms}`);
    check('budgetRemainingMs < 0', budget.budgetRemainingMs < 0,
      `got ${budget.budgetRemainingMs}`);
  }

  // T4: Bottleneck identification
  {
    console.log('\nTest 4: Bottleneck identification');
    const bottleneck = identifyBottleneck();
    check('bottleneck is broker_api_latency',
      bottleneck.name === 'broker_api_latency',
      `got ${bottleneck.name}`);
    check('bottleneck p99 is highest',
      bottleneck.p99Ms === 300,
      `got ${bottleneck.p99Ms}`);

    const customBottleneck = identifyBottleneck(SLOW_COMPONENTS);
    check('custom bottleneck is broker_api_latency',
      customBottleneck.name === 'broker_api_latency',
      `got ${customBottleneck.name}`);
  }

  // T5: Pipeline simulation determinism
  {
    console.log('\nTest 5: Pipeline simulation determinism');
    const m1 = simulateLatencyPipeline(42);
    const m2 = simulateLatencyPipeline(42);
    check('same length', m1.length === m2.length, `${m1.length} vs ${m2.length}`);
    let allMatch = true;
    for (let i = 0; i < m1.length; i++) {
      if (m1[i].deltaMs !== m2[i].deltaMs) { allMatch = false; break; }
    }
    check('deterministic output', allMatch, 'mismatch found');
    check('non-zero deltas', m1.every(m => m.deltaMs > 0), 'zero delta found');
    check('start < end for all', m1.every(m => m.endMs > m.startMs), 'inversion found');
  }

  // T6: Different seeds produce different results
  {
    console.log('\nTest 6: Different seeds produce different results');
    const m1 = simulateLatencyPipeline(42);
    const m2 = simulateLatencyPipeline(99);
    const anyDifferent = m1.some((m, i) => m.deltaMs !== m2[i].deltaMs);
    check('different seeds diverge', anyDifferent, 'outputs identical');
  }

  // T7: Measurement classification
  {
    console.log('\nTest 7: Measurement classification');
    const m1 = { componentName: 'risk_check', startMs: 1000, endMs: 1001, deltaMs: 1 };
    check('classify risk_check', classifyMeasurement(m1) === 'risk_check',
      `got ${classifyMeasurement(m1)}`);
    const m2 = { componentName: 'nonexistent', startMs: 0, endMs: 1, deltaMs: 1 };
    check('unknown returns null', classifyMeasurement(m2) === null,
      `got ${classifyMeasurement(m2)}`);
  }

  // T8: Excessive latency detection
  {
    console.log('\nTest 8: Excessive latency detection');
    const ok = { componentName: 'risk_check', startMs: 0, endMs: 2, deltaMs: 2 };
    check('normal not excessive', isExcessiveLatency(ok) === false,
      `got ${isExcessiveLatency(ok)}`);
    const bad = { componentName: 'risk_check', startMs: 0, endMs: 100, deltaMs: 100 };
    check('100ms is excessive (p99=5)', isExcessiveLatency(bad) === true,
      `got ${isExcessiveLatency(bad)}`);
    const unknown = { componentName: 'xyz', startMs: 0, endMs: 1, deltaMs: 1 };
    check('unknown component is excessive', isExcessiveLatency(unknown) === true,
      `got ${isExcessiveLatency(unknown)}`);
  }

  // T9: Synthetic signal→order pipeline replay
  {
    console.log('\nTest 9: Synthetic signal→order pipeline replay');
    const measurements = simulateLatencyPipeline(42);
    const budget = computeLatencyBudget();
    const totalSimMs = measurements.reduce((s, m) => s + m.deltaMs, 0);
    check('total simulated < budget p99', totalSimMs < budget.totalP99Ms,
      `${totalSimMs.toFixed(2)} >= ${budget.totalP99Ms}`);
    check('5 stages measured', measurements.length === 5, `got ${measurements.length}`);
    const stages = measurements.map(m => m.componentName);
    check('includes signal_generation', stages.includes('signal_generation'), stages.join(','));
    check('includes broker_api_latency', stages.includes('broker_api_latency'), stages.join(','));
    check('includes exchange_latency', stages.includes('exchange_latency'), stages.join(','));
  }

  // T10: DB historical quote timestamps for latency proxy
  {
    console.log('\nTest 10: Historical data latency proxy (DB)');
    const mysql = require('mysql2/promise');
    require('dotenv').config();
    const DB_CONFIG = {
      host: process.env.MYSQL_HOST,
      port: parseInt(process.env.MYSQL_PORT || '3306'),
      user: process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD,
      database: process.env.MYSQL_DATABASE || 'myjob_agent',
    };
    const conn = await mysql.createConnection(DB_CONFIG);
    try {
      const [rows] = await conn.query(`
        SELECT source, COUNT(*) as cnt,
               MIN(createdAt) as earliest,
               MAX(createdAt) as latest
        FROM unified_option_quotes_history
        GROUP BY source
        ORDER BY cnt DESC
      `);
      check('DB has quote data', rows.length > 0, `0 sources found`);
      const totalQuotes = rows.reduce((s, r) => s + Number(r.cnt), 0);
      check('total quotes > 1M', totalQuotes > 1000000, `got ${totalQuotes}`);

      // Compute approximate inter-quote intervals per source (latency proxy)
      for (const row of rows) {
        const [intervals] = await conn.query(`
          SELECT AVG(interval_ms) as avg_interval_ms
          FROM (
            SELECT TIMESTAMPDIFF(MICROSECOND,
              LAG(createdAt) OVER (ORDER BY createdAt),
              createdAt) / 1000.0 as interval_ms
            FROM unified_option_quotes_history
            WHERE source = ?
            ORDER BY createdAt
            LIMIT 10000
          ) sub
          WHERE interval_ms IS NOT NULL AND interval_ms > 0
        `, [row.source]);
        if (intervals[0] && intervals[0].avg_interval_ms) {
          const avgMs = Number(intervals[0].avg_interval_ms);
          check(`${row.source} avg interval > 0`, avgMs > 0, `got ${avgMs.toFixed(2)}ms`);
          console.log(`    ${row.source}: ${Number(row.cnt)} quotes, avg interval ${avgMs.toFixed(1)}ms`);
        }
      }
    } finally {
      await conn.end();
    }
  }

  // ── Summary ────────────────────────────────────────────────────────
  console.log(`\n=== ITEM 109 Results: ${passed} passed, ${failed} failed ===`);
  if (errors.length > 0) {
    console.log('\nErrors:');
    errors.forEach(e => console.log(`  ${e}`));
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
