/**
 * Event Calendar Adapter (Item 288)
 *
 * Ingests macro and corporate event data: RBI policy, GDP, inflation,
 * FII/DII flows, earnings, budget, and other scheduled market-moving events.
 *
 * In mock mode, generates a realistic 30-day calendar of Indian macro events.
 * Live mode would pull from NSE/BSE event feeds or economic calendars.
 *
 * Modes:
 *   - mock: generates deterministic event calendar with known event types
 *   - live: stubbed
 *   - disabled: returns empty calendar
 */

import {
  AdapterMode,
  AdapterHealth,
  ExternalDataAdapter,
} from './types';

// ─── Types ──────────────────────────────────────────────────────────────────

export type EventType =
  | 'RBI_POLICY'
  | 'GDP_RELEASE'
  | 'INFLATION_CPI'
  | 'INFLATION_WPI'
  | 'FII_FLOW'
  | 'DII_FLOW'
  | 'EARNINGS_NIFTY50'
  | 'BUDGET'
  | 'FOMC_MINUTES'
  | 'US_CPI'
  | 'US_NFP'
  | 'CRUDE_INVENTORY'
  | 'DIVIDEND_EX'
  | 'INDEX_REBALANCE'
  | 'OTHER';

export type MarketEvent = {
  id: string;
  type: EventType;
  title: string;
  description: string;
  scheduledAt: number;      // epoch ms
  importance: 'HIGH' | 'MEDIUM' | 'LOW';
  expectedImpact: 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'UNKNOWN';
  affectedSymbols: string[];
  source: string;
};

export type EventCalendar = {
  events: MarketEvent[];
  asOf: number;
  source: string;
};

// ─── Mock event templates ───────────────────────────────────────────────────

const MOCK_EVENTS: Array<Omit<MarketEvent, 'id' | 'scheduledAt'>> = [
  { type: 'RBI_POLICY', title: 'RBI Monetary Policy Statement', description: 'RBI MPC interest rate decision', importance: 'HIGH', expectedImpact: 'UNKNOWN', affectedSymbols: ['NSE:NIFTY50-INDEX', 'NSE:BANKNIFTY-INDEX'], source: 'mock' },
  { type: 'GDP_RELEASE', title: 'India GDP QoQ', description: 'Quarterly GDP growth rate release', importance: 'HIGH', expectedImpact: 'UNKNOWN', affectedSymbols: ['NSE:NIFTY50-INDEX'], source: 'mock' },
  { type: 'INFLATION_CPI', title: 'India CPI (YoY)', description: 'Consumer Price Index year-on-year', importance: 'HIGH', expectedImpact: 'UNKNOWN', affectedSymbols: ['NSE:NIFTY50-INDEX'], source: 'mock' },
  { type: 'FII_FLOW', title: 'FII Net Investment Data', description: 'Foreign Institutional Investor net flows', importance: 'MEDIUM', expectedImpact: 'UNKNOWN', affectedSymbols: ['NSE:NIFTY50-INDEX'], source: 'mock' },
  { type: 'DII_FLOW', title: 'DII Net Investment Data', description: 'Domestic Institutional Investor net flows', importance: 'MEDIUM', expectedImpact: 'UNKNOWN', affectedSymbols: ['NSE:NIFTY50-INDEX'], source: 'mock' },
  { type: 'EARNINGS_NIFTY50', title: 'NIFTY50 Major Earnings', description: 'Quarterly earnings of top NIFTY50 constituents', importance: 'HIGH', expectedImpact: 'UNKNOWN', affectedSymbols: ['NSE:NIFTY50-INDEX'], source: 'mock' },
  { type: 'FOMC_MINUTES', title: 'FOMC Meeting Minutes', description: 'US Federal Reserve meeting minutes', importance: 'MEDIUM', expectedImpact: 'UNKNOWN', affectedSymbols: ['NSE:NIFTY50-INDEX'], source: 'mock' },
  { type: 'US_CPI', title: 'US CPI (MoM)', description: 'US Consumer Price Index month-on-month', importance: 'HIGH', expectedImpact: 'UNKNOWN', affectedSymbols: ['NSE:NIFTY50-INDEX'], source: 'mock' },
  { type: 'US_NFP', title: 'US Non-Farm Payrolls', description: 'US employment data', importance: 'MEDIUM', expectedImpact: 'UNKNOWN', affectedSymbols: ['NSE:NIFTY50-INDEX'], source: 'mock' },
  { type: 'INDEX_REBALANCE', title: 'NIFTY50 Rebalancing', description: 'Quarterly NIFTY50 index rebalancing', importance: 'LOW', expectedImpact: 'NEUTRAL', affectedSymbols: ['NSE:NIFTY50-INDEX'], source: 'mock' },
];

// ─── Mock generator ─────────────────────────────────────────────────────────

function generateMockCalendar(refTimeMs: number): MarketEvent[] {
  const events: MarketEvent[] = [];
  const dayMs = 86400000;

  for (let offset = -15; offset <= 30; offset++) {
    // Skip weekends
    const dayDate = new Date(refTimeMs + offset * dayMs);
    const dow = dayDate.getUTCDay();
    if (dow === 0 || dow === 6) continue;

    // Place 1-2 events per trading day deterministically
    const daySeed = Math.abs((offset * 31 + 7) % MOCK_EVENTS.length);
    const numEvents = 1 + (Math.abs(offset * 13) % 2);

    for (let e = 0; e < numEvents; e++) {
      const template = MOCK_EVENTS[(daySeed + e) % MOCK_EVENTS.length];
      const hour = 9 + (Math.abs(offset * 3 + e * 5) % 8); // 09:00-16:59 IST
      const minute = Math.abs(offset * 7 + e * 11) % 60;
      const scheduledAt = refTimeMs + offset * dayMs + hour * 3600000 + minute * 60000;

      events.push({
        ...template,
        id: `mock-${offset}-${e}-${template.type}`,
        scheduledAt,
      });
    }
  }

  return events.sort((a, b) => a.scheduledAt - b.scheduledAt);
}

// ─── Adapter ────────────────────────────────────────────────────────────────

export class EventCalendarAdapter implements ExternalDataAdapter {
  readonly name = 'event-calendar';
  private mode: AdapterMode;
  private health: AdapterHealth = { ok: true, lastFetchAt: null, errorCount: 0, mode: 'mock' };
  private cachedCalendar: EventCalendar | null = null;

  constructor(mode: AdapterMode = 'mock') {
    this.mode = mode;
    this.health.mode = mode;
  }

  getMode(): AdapterMode { return this.mode; }
  getHealth(): AdapterHealth { return { ...this.health }; }
  dispose(): void { this.cachedCalendar = null; }

  /** Fetch or return cached calendar for the given reference time */
  fetchCalendar(refTimeMs?: number): EventCalendar {
    if (this.mode === 'disabled') {
      return { events: [], asOf: 0, source: 'disabled' };
    }

    const now = refTimeMs ?? Date.now();

    if (this.mode === 'mock') {
      if (!this.cachedCalendar || Math.abs(this.cachedCalendar.asOf - now) > 60000) {
        this.cachedCalendar = {
          events: generateMockCalendar(now),
          asOf: now,
          source: 'mock',
        };
      }
      this.health.lastFetchAt = now;
      return this.cachedCalendar;
    }

    this.health.errorCount++;
    this.health.ok = false;
    return { events: [], asOf: 0, source: 'error' };
  }

  /** Get events within a time window */
  fetchEventsInRange(startMs: number, endMs: number): MarketEvent[] {
    const cal = this.fetchCalendar();
    return cal.events.filter((e) => e.scheduledAt >= startMs && e.scheduledAt <= endMs);
  }

  /** Get events of a specific type */
  fetchEventsByType(type: EventType): MarketEvent[] {
    const cal = this.fetchCalendar();
    return cal.events.filter((e) => e.type === type);
  }

  /** Get high-importance events only */
  fetchHighImportanceEvents(): MarketEvent[] {
    const cal = this.fetchCalendar();
    return cal.events.filter((e) => e.importance === 'HIGH');
  }
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function createEventCalendarAdapter(mode: AdapterMode = 'mock'): EventCalendarAdapter {
  return new EventCalendarAdapter(mode);
}
