/**
 * Macro Features Adapter (Item 285)
 *
 * USDINR spot, Brent Crude, India 10Y G-Sec yield, India VIX.
 * Provides macro regime context for option strategy selection.
 *
 * Modes:
 *   - mock: realistic synthetic data with regime-aware drift
 *   - live: stubbed (requires Yahoo Finance / NSE API credentials)
 *   - disabled: returns nulls
 */

import {
  AdapterMode,
  AdapterHealth,
  ExternalDataAdapter,
} from './types';

// ─── Types ──────────────────────────────────────────────────────────────────

export type MacroSymbol =
  | 'USDINR'
  | 'BRENT_CRUDE'
  | 'INDIA_10Y'
  | 'INDIA_VIX';

export type MacroSnapshot = {
  symbol: MacroSymbol;
  value: number;
  prevClose: number;
  change: number;
  changePct: number;
  dayHigh: number;
  dayLow: number;
  timestamp: number;
};

export type MacroRegime = {
  usdInrTrend: 'STRENGTHENING' | 'WEAKENING' | 'STABLE';
  crudeImpact: 'TAILWIND' | 'HEADWIND' | 'NEUTRAL';
  yieldPressure: 'RISING' | 'FALLING' | 'STABLE';
  vixRegime: 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';
  compositeRisk: number; // -1 (risk-off) to +1 (risk-on)
};

export type MacroFeatures = {
  snapshots: MacroSnapshot[];
  regime: MacroRegime;
  timestamp: number;
};

// ─── Default baselines ──────────────────────────────────────────────────────

const BASELINES: Record<MacroSymbol, number> = {
  USDINR: 83.5,
  BRENT_CRUDE: 82.0,
  INDIA_10Y: 7.15,
  INDIA_VIX: 14.5,
};

// ─── Mock generator ─────────────────────────────────────────────────────────

function mockMacroSnapshot(symbol: MacroSymbol, refTime: number): MacroSnapshot {
  const base = BASELINES[symbol];
  const seed = (refTime * 37 + symbol.length * 17) % 10000;
  const drift = ((seed % 100) - 50) / 10000;  // ±0.5%
  const value = base * (1 + drift);
  const prevClose = base;
  const dayRange = base * 0.008;
  return {
    symbol,
    value: round4(value),
    prevClose,
    change: round4(value - prevClose),
    changePct: round4(((value - prevClose) / prevClose) * 100),
    dayHigh: round4(value + dayRange * 0.3),
    dayLow: round4(value - dayRange * 0.3),
    timestamp: refTime,
  };
}

// ─── Pure computation functions ──────────────────────────────────────────────

export function classifyRegime(snapshots: MacroSnapshot[]): MacroRegime {
  const bySymbol = new Map<MacroSymbol, MacroSnapshot>();
  for (const s of snapshots) bySymbol.set(s.symbol, s);

  const usdInr = bySymbol.get('USDINR');
  const crude = bySymbol.get('BRENT_CRUDE');
  const yield10y = bySymbol.get('INDIA_10Y');
  const vix = bySymbol.get('INDIA_VIX');

  const usdInrTrend: MacroRegime['usdInrTrend'] =
    !usdInr ? 'STABLE' :
    usdInr.changePct > 0.1 ? 'WEAKENING' :
    usdInr.changePct < -0.1 ? 'STRENGTHENING' : 'STABLE';

  const crudeImpact: MacroRegime['crudeImpact'] =
    !crude ? 'NEUTRAL' :
    crude.changePct > 0.5 ? 'HEADWIND' :
    crude.changePct < -0.5 ? 'TAILWIND' : 'NEUTRAL';

  const yieldPressure: MacroRegime['yieldPressure'] =
    !yield10y ? 'STABLE' :
    yield10y.changePct > 0.3 ? 'RISING' :
    yield10y.changePct < -0.3 ? 'FALLING' : 'STABLE';

  const vixVal = vix?.value ?? 14.5;
  const vixRegime: MacroRegime['vixRegime'] =
    vixVal < 12 ? 'LOW' :
    vixVal < 18 ? 'MEDIUM' :
    vixVal < 25 ? 'HIGH' : 'EXTREME';

  // Composite risk: positive = risk-on
  let riskSum = 0;
  if (usdInrTrend === 'STRENGTHENING') riskSum += 0.2;
  if (usdInrTrend === 'WEAKENING') riskSum -= 0.2;
  if (crudeImpact === 'TAILWIND') riskSum += 0.15;
  if (crudeImpact === 'HEADWIND') riskSum -= 0.15;
  if (yieldPressure === 'FALLING') riskSum += 0.1;
  if (yieldPressure === 'RISING') riskSum -= 0.1;
  if (vixRegime === 'LOW') riskSum += 0.25;
  if (vixRegime === 'EXTREME') riskSum -= 0.3;

  return {
    usdInrTrend,
    crudeImpact,
    yieldPressure,
    vixRegime,
    compositeRisk: round4(Math.max(-1, Math.min(1, riskSum))),
  };
}

// ─── Adapter ────────────────────────────────────────────────────────────────

export class MacroFeaturesAdapter implements ExternalDataAdapter {
  readonly name = 'macro-features';
  private mode: AdapterMode;
  private health: AdapterHealth = { ok: true, lastFetchAt: null, errorCount: 0, mode: 'mock' };

  constructor(mode: AdapterMode = 'mock') {
    this.mode = mode;
    this.health.mode = mode;
  }

  getMode(): AdapterMode { return this.mode; }
  getHealth(): AdapterHealth { return { ...this.health }; }
  dispose(): void { /* nothing to clean up */ }

  fetch(): MacroFeatures {
    if (this.mode === 'disabled') return this.emptyResult();

    const refTime = Date.now();

    if (this.mode === 'mock') {
      const symbols: MacroSymbol[] = ['USDINR', 'BRENT_CRUDE', 'INDIA_10Y', 'INDIA_VIX'];
      const snapshots = symbols.map((s) => mockMacroSnapshot(s, refTime));
      const regime = classifyRegime(snapshots);
      this.health.lastFetchAt = refTime;
      return { snapshots, regime, timestamp: refTime };
    }

    this.health.errorCount++;
    this.health.ok = false;
    return this.emptyResult();
  }

  private emptyResult(): MacroFeatures {
    return {
      snapshots: [],
      regime: {
        usdInrTrend: 'STABLE',
        crudeImpact: 'NEUTRAL',
        yieldPressure: 'STABLE',
        vixRegime: 'MEDIUM',
        compositeRisk: 0,
      },
      timestamp: 0,
    };
  }
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function createMacroFeaturesAdapter(mode: AdapterMode = 'mock'): MacroFeaturesAdapter {
  return new MacroFeaturesAdapter(mode);
}

function round4(n: number): number { return Math.round(n * 10000) / 10000; }
