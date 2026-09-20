/**
 * ITEM 109 — Model signal-to-order latency model.
 *
 * Models the latency pipeline from signal generation through order
 * placement, breaking it into measurable components. Pure model —
 * no actual orders placed, no I/O.
 *
 * RESEARCH / SHADOW ONLY: nothing in production imports this module.
 */

// ── Types ─────────────────────────────────────────────────────────────

export interface LatencyComponent {
  readonly name: string;
  readonly meanMs: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly description: string;
}

export interface LatencyBudget {
  readonly components: readonly LatencyComponent[];
  readonly totalMeanMs: number;
  readonly totalP95Ms: number;
  readonly totalP99Ms: number;
  readonly budgetRemainingMs: number;
  readonly withinBudget: boolean;
}

export interface LatencyMeasurement {
  readonly componentName: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly deltaMs: number;
  readonly metadata?: Record<string, number>;
}

// ── Default Latency Budget ────────────────────────────────────────────

const DEFAULT_COMPONENTS: readonly LatencyComponent[] = [
  {
    name: 'signal_generation',
    meanMs: 2,
    p95Ms: 5,
    p99Ms: 10,
    description: 'Time from tick to model prediction',
  },
  {
    name: 'risk_check',
    meanMs: 1,
    p95Ms: 3,
    p99Ms: 5,
    description: 'Risk engine validation (limits, position, exposure)',
  },
  {
    name: 'order_construction',
    meanMs: 0.5,
    p95Ms: 1,
    p99Ms: 2,
    description: 'Build order payload from signal + risk parameters',
  },
  {
    name: 'broker_api_latency',
    meanMs: 50,
    p95Ms: 150,
    p99Ms: 300,
    description: 'Network round-trip to broker API',
  },
  {
    name: 'exchange_latency',
    meanMs: 5,
    p95Ms: 15,
    p99Ms: 30,
    description: 'Exchange order processing + acknowledgment',
  },
];

const DEFAULT_TOTAL_BUDGET_MS = 500;

// ── Functions ─────────────────────────────────────────────────────────

/**
 * Compute total latency budget from component latencies.
 * Sum of means, p95s, p99s independently.
 */
export function computeLatencyBudget(
  components: readonly LatencyComponent[] = DEFAULT_COMPONENTS,
  totalBudgetMs: number = DEFAULT_TOTAL_BUDGET_MS,
): LatencyBudget {
  let totalMean = 0;
  let totalP95 = 0;
  let totalP99 = 0;

  for (const c of components) {
    totalMean += c.meanMs;
    totalP95 += c.p95Ms;
    totalP99 += c.p99Ms;
  }

  return {
    components,
    totalMeanMs: totalMean,
    totalP95Ms: totalP95,
    totalP99Ms: totalP99,
    budgetRemainingMs: totalBudgetMs - totalP99,
    withinBudget: totalP99 <= totalBudgetMs,
  };
}

/**
 * Classify a latency measurement into a component.
 * Returns the component name or null if no match.
 */
export function classifyMeasurement(
  measurement: LatencyMeasurement,
  components: readonly LatencyComponent[] = DEFAULT_COMPONENTS,
): string | null {
  for (const c of components) {
    if (c.name === measurement.componentName) return c.name;
  }
  return null;
}

/**
 * Check if a measurement exceeds its component's p99 budget.
 */
export function isExcessiveLatency(
  measurement: LatencyMeasurement,
  components: readonly LatencyComponent[] = DEFAULT_COMPONENTS,
): boolean {
  for (const c of components) {
    if (c.name === measurement.componentName) {
      return measurement.deltaMs > c.p99Ms;
    }
  }
  return true; // Unknown component = excessive
}

/**
 * Simulate a latency pipeline run with realistic timing.
 * Returns simulated measurements for each component.
 */
export function simulateLatencyPipeline(
  seed: number = 42,
): readonly LatencyMeasurement[] {
  const measurements: LatencyMeasurement[] = [];
  let currentMs = 1000000;

  for (const comp of DEFAULT_COMPONENTS) {
    // Deterministic pseudo-random within [mean * 0.5, mean * 1.5]
    const factor = 0.5 + ((seed * (measurements.length + 1) * 7) % 100) / 100;
    const deltaMs = comp.meanMs * factor;

    measurements.push({
      componentName: comp.name,
      startMs: currentMs,
      endMs: currentMs + deltaMs,
      deltaMs,
    });
    currentMs += deltaMs;
  }

  return measurements;
}

/**
 * Identify the bottleneck component (highest p99).
 */
export function identifyBottleneck(
  components: readonly LatencyComponent[] = DEFAULT_COMPONENTS,
): LatencyComponent {
  let maxP99 = 0;
  let bottleneck = components[0];
  for (const c of components) {
    if (c.p99Ms > maxP99) {
      maxP99 = c.p99Ms;
      bottleneck = c;
    }
  }
  return bottleneck;
}

// ── Test Harness ──────────────────────────────────────────────────────

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`FAIL: ${msg}`);
}

function assertPositive(val: number, label: string): void {
  assert(val > 0, `${label}: expected positive, got ${val}`);
}

// ── Tests ─────────────────────────────────────────────────────────────

export function runLatencyModelTests(): { passed: number; failed: number; errors: string[] } {
  const errors: string[] = [];
  let passed = 0;
  let failed = 0;

  const tests = [
    () => {
      console.log('Test 1: Latency budget computation');
      const budget = computeLatencyBudget();
      assertPositive(budget.totalMeanMs, 'totalMeanMs');
      assertPositive(budget.totalP95Ms, 'totalP95Ms');
      assertPositive(budget.totalP99Ms, 'totalP99Ms');
      assert(budget.totalMeanMs < budget.totalP95Ms, 'Mean < P95');
      assert(budget.totalP95Ms < budget.totalP99Ms, 'P95 < P99');
      console.log('  PASS');
    },
    () => {
      console.log('Test 2: Bottleneck identification');
      const bottleneck = identifyBottleneck();
      assert(bottleneck.name === 'broker_api_latency', `Bottleneck should be broker API, got ${bottleneck.name}`);
      console.log('  PASS');
    },
    () => {
      console.log('Test 3: Pipeline simulation');
      const measurements = simulateLatencyPipeline(42);
      assert(measurements.length === DEFAULT_COMPONENTS.length, 'Should have one measurement per component');
      for (const m of measurements) {
        assertPositive(m.deltaMs, `${m.componentName}.deltaMs`);
        assert(m.endMs > m.startMs, `${m.componentName}: end > start`);
      }
      console.log('  PASS');
    },
    () => {
      console.log('Test 4: Measurement classification');
      const m: LatencyMeasurement = {
        componentName: 'risk_check',
        startMs: 1000,
        endMs: 1001,
        deltaMs: 1,
      };
      const name = classifyMeasurement(m);
      assert(name === 'risk_check', `Should classify as risk_check, got ${name}`);
      console.log('  PASS');
    },
    () => {
      console.log('Test 5: Excessive latency detection');
      const ok: LatencyMeasurement = { componentName: 'risk_check', startMs: 0, endMs: 2, deltaMs: 2 };
      const bad: LatencyMeasurement = { componentName: 'risk_check', startMs: 0, endMs: 100, deltaMs: 100 };
      assert(!isExcessiveLatency(ok), 'Normal latency should not be excessive');
      assert(isExcessiveLatency(bad), '100ms risk check should be excessive');
      console.log('  PASS');
    },
    () => {
      console.log('Test 6: Determinism');
      const m1 = simulateLatencyPipeline(42);
      const m2 = simulateLatencyPipeline(42);
      for (let i = 0; i < m1.length; i++) {
        assert(m1[i].deltaMs === m2[i].deltaMs, `Component ${i} deterministic`);
      }
      console.log('  PASS');
    },
  ];

  for (const test of tests) {
    try {
      test();
      passed++;
    } catch (e) {
      failed++;
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  console.log(`\nLatency Model Test Results: ${passed} passed, ${failed} failed`);
  return { passed, failed, errors };
}

if (require.main === module) {
  const result = runLatencyModelTests();
  process.exit(result.failed > 0 ? 1 : 0);
}
