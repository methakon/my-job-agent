/**
 * GIFT NIFTY / Global Equity Futures Features (Item 282)
 *
 * Adapter for GIFT NIFTY (NSE IFSC), S&P 500 futures (ES), Nikkei 225
 * futures (NKD), Hang Seng futures (HSI).
 *
 * Provides:
 *   - Real-time / snapshot data for global futures
 *   - Pre-market gap signals from overnight moves
 *   - Cross-market correlation features
 *
 * Modes:
 *   - mock: generates realistic synthetic data with configurable drift
 *   - live: stubbed (requires FYERS/Upstox global segment credentials)
 *   - disabled: returns nulls
 *
 * PURE where possible: computation functions take data in, return results.
 * Adapter wrapper adds I/O boundary.
 */

import {
  AdapterMode,
  AdapterHealth,
  ExternalDataAdapter,
} from './types';

// ─── Types ──────────────────────────────────────────────────────────────────

export type GlobalFutureSymbol =
  | 'GIFT_NIFTY'
  | 'SP500_FUTURES'
  | 'NIKKEI_FUTURES'
  | 'HANG_SENG_FUTURES';

export type GlobalFutureSnapshot = {
  symbol: GlobalFutureSymbol;
  ltp: number;              // last traded price
  change: number;           // absolute change
  changePct: number;        // percentage change
  open: number;
  high: number;
  low: number;
  prevClose: number;
  volume: number;
  timestamp: number;
};

export type GiftNiftyGapSignal = {
  impliedNiftyOpen: number;
  gapPct: number;           // vs NIFTY prev close
  gapDirection: 'UP' | 'DOWN' | 'FLAT';
  confidence: number;       // 0-1, based on liquidity/volume
  crossMarketAlignment: number; // -1 to 1, correlation with other futures
};

export type GiftNiftyFeatures = {
  snapshots: GlobalFutureSnapshot[];
  gapSignal: GiftNiftyGapSignal;
  spreadVsNifty: number;    // GIFT NIFTY - spot NIFTY (basis)
  vixFromGift: number;      // implied vol from GIFT NIFTY options
  timestamp: number;
};

// ─── Default values ─────────────────────────────────────────────────────────

const GIFT_NIFTY_BASELINE = 24500;
const SP500_BASELINE = 5600;
const NIKKEI_BASELINE = 38500;
const HANG_SENG_BASELINE = 18200;

const BASELINES: Record<GlobalFutureSymbol, number> = {
  GIFT_NIFTY: GIFT_NIFTY_BASELINE,
  SP500_FUTURES: SP500_BASELINE,
  NIKKEI_FUTURES: NIKKEI_BASELINE,
  HANG_SENG_FUTURES: HANG_SENG_BASELINE,
};

// ─── Mock generator ─────────────────────────────────────────────────────────

function mockSnapshot(symbol: GlobalFutureSymbol, refTime: number): GlobalFutureSnapshot {
  const base = BASELINES[symbol];
  // Deterministic pseudo-random using simple hash of timestamp + symbol
  const seed = (refTime * 31 + symbol.length * 13) % 10000;
  const drift = ((seed % 200) - 100) / 10000;  // ±1%
  const ltp = base * (1 + drift);
  const prevClose = base;
  const open = base * (1 + drift * 0.3);
  const high = Math.max(open, ltp) * (1 + Math.abs(drift) * 0.15);
  const low = Math.min(open, ltp) * (1 - Math.abs(drift) * 0.15);
  const change = ltp - prevClose;
  const changePct = (change / prevClose) * 100;
  const volume = 10000 + (seed % 50000);

  return {
    symbol,
    ltp: round2(ltp),
    change: round2(change),
    changePct: round4(changePct),
    open: round2(open),
    high: round2(high),
    low: round2(low),
    prevClose,
    volume,
    timestamp: refTime,
  };
}

// ─── Pure computation functions ──────────────────────────────────────────────

/** Implied NIFTY open from GIFT NIFTY */
export function computeGiftNiftyGap(
  giftLtp: number,
  niftyPrevClose: number,
): GiftNiftyGapSignal {
  const impliedOpen = giftLtp;
  const gapPct = ((impliedOpen - niftyPrevClose) / niftyPrevClose) * 100;
  const gapDirection: GiftNiftyGapSignal['gapDirection'] =
    Math.abs(gapPct) < 0.05 ? 'FLAT' : gapPct > 0 ? 'UP' : 'DOWN';
  return {
    impliedNiftyOpen: round2(impliedOpen),
    gapPct: round4(gapPct),
    gapDirection,
    confidence: 0.7,
    crossMarketAlignment: 0,
  };
}

/** Basis = GIFT NIFTY - underlying NIFTY */
export function computeBasis(giftLtp: number, niftySpot: number): number {
  return round2(giftLtp - niftySpot);
}

/** Cross-market correlation: simplified sign-agreement across futures */
export function computeCrossMarketAlignment(
  snapshots: GlobalFutureSnapshot[],
): number {
  if (snapshots.length === 0) return 0;
  const signs = snapshots.map((s) => Math.sign(s.changePct));
  const avg = signs.reduce((a, b) => a + b, 0) / signs.length;
  return round4(avg);
}

// ─── Adapter ────────────────────────────────────────────────────────────────

export class GiftNiftyAdapter implements ExternalDataAdapter {
  readonly name = 'gift-nifty-features';
  private mode: AdapterMode;
  private health: AdapterHealth = { ok: true, lastFetchAt: null, errorCount: 0, mode: 'mock' };

  constructor(mode: AdapterMode = 'mock') {
    this.mode = mode;
    this.health.mode = mode;
  }

  getMode(): AdapterMode { return this.mode; }
  getHealth(): AdapterHealth { return { ...this.health }; }
  dispose(): void { /* nothing to clean up in mock */ }

  /** Fetch current global-futures snapshot */
  fetchSnapshots(niftyPrevClose: number = GIFT_NIFTY_BASELINE): GiftNiftyFeatures {
    if (this.mode === 'disabled') {
      return this.emptyResult();
    }

    const refTime = Date.now();

    if (this.mode === 'mock') {
      const symbols: GlobalFutureSymbol[] = [
        'GIFT_NIFTY', 'SP500_FUTURES', 'NIKKEI_FUTURES', 'HANG_SENG_FUTURES',
      ];
      const snapshots = symbols.map((s) => mockSnapshot(s, refTime));
      const giftSnap = snapshots[0];
      const gapSignal = computeGiftNiftyGap(giftSnap.ltp, niftyPrevClose);
      const alignment = computeCrossMarketAlignment(snapshots);
      gapSignal.crossMarketAlignment = alignment;
      const features: GiftNiftyFeatures = {
        snapshots,
        gapSignal,
        spreadVsNifty: computeBasis(giftSnap.ltp, niftyPrevClose),
        vixFromGift: round4(14 + (giftSnap.changePct * 2)),
        timestamp: refTime,
      };
      this.health.lastFetchAt = refTime;
      return features;
    }

    // live mode: placeholder
    this.health.errorCount++;
    this.health.ok = false;
    return this.emptyResult();
  }

  private emptyResult(): GiftNiftyFeatures {
    return {
      snapshots: [],
      gapSignal: { impliedNiftyOpen: 0, gapPct: 0, gapDirection: 'FLAT', confidence: 0, crossMarketAlignment: 0 },
      spreadVsNifty: 0,
      vixFromGift: 0,
      timestamp: 0,
    };
  }
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function createGiftNiftyAdapter(mode: AdapterMode = 'mock'): GiftNiftyAdapter {
  return new GiftNiftyAdapter(mode);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function round2(n: number): number { return Math.round(n * 100) / 100; }
function round4(n: number): number { return Math.round(n * 10000) / 10000; }
