import { Injectable, Logger } from '@nestjs/common';

/**
 * Upstox Option Chain Discovery Service
 *
 * Discovers and fetches option chain data for NIFTY, BANKNIFTY, SENSEX.
 * Uses Upstox V2 REST endpoints:
 * - /v2/option/contract - Get available option contracts
 * - /v2/option/chain - Get option chain with Greeks/OI
 */

export interface UpstoxOptionContract {
  instrumentKey: string;
  tradingSymbol: string;
  expiry: string;
  strike: number;
  optionType: 'CE' | 'PE';
  lotSize: number;
}

export interface UpstoxOptionChainLeg {
  instrumentKey: string;
  tradingSymbol: string;
  strike: number;
  optionType: 'CE' | 'PE';
  ltp: number;
  bid: number;
  ask: number;
  bidQty: number;
  askQty: number;
  volume: number;
  openInterest: number;
  oiChange: number;
  iv: number | null;
  delta: number | null;
  theta: number | null;
  gamma: number | null;
  vega: number | null;
  rho: number | null;
  ts: Date;
}

export interface UpstoxOptionChainResult {
  underlying: string;
  underlyingKey: string;
  underlyingPrice: number;
  expiry: string;
  legs: UpstoxOptionChainLeg[];
  fetchedAt: Date;
}

@Injectable()
export class UpstoxOptionChainDiscoveryService {
  private readonly logger = new Logger(UpstoxOptionChainDiscoveryService.name);

  // Upstox instrument keys for major underlyings
  static readonly UNDERLYING_KEYS = {
    NIFTY: 'NSE_INDEX|Nifty 50',
    BANKNIFTY: 'NSE_INDEX|Nifty Bank',
    SENSEX: 'BSE_INDEX|SENSEX',
  } as const;

  // Underlying short names for universe mapping
  static readonly SHORT_NAMES: Record<string, string> = {
    'NSE_INDEX|Nifty 50': 'NIFTY',
    'NSE_INDEX|Nifty Bank': 'BANKNIFTY',
    'BSE_INDEX|SENSEX': 'SENSEX',
  };

  /**
   * Fetch option contracts for an underlying.
   * Returns all available expiries and strikes.
   */
  async fetchOptionContracts(
    instrumentKey: string,
    headers: Record<string, string>,
    expiry?: string,
  ): Promise<UpstoxOptionContract[]> {
    try {
      const params = new URLSearchParams({ instrument_key: instrumentKey });
      if (expiry) params.set('expiry', expiry);

      const url = `https://api.upstox.com/v2/option/contract?${params}`;
      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        const text = await response.text();
        this.logger.error(`[UPSTOX-OPTION-CHAIN] fetchOptionContracts failed: HTTP ${response.status} - ${text}`);
        return [];
      }

      const data = await response.json() as { data?: any[] };
      const rows = data?.data ?? [];

      return rows.map((row: any) => ({
        instrumentKey: String(row.instrument_key ?? ''),
        tradingSymbol: String(row.trading_symbol ?? ''),
        expiry: String(row.expiry ?? ''),
        strike: Number(row.strike_price ?? 0),
        optionType: String(row.option_type ?? '').toUpperCase() as 'CE' | 'PE',
        lotSize: Number(row.lot_size ?? 0),
      })).filter((c: UpstoxOptionContract) => c.instrumentKey && c.strike > 0);
    } catch (err) {
      this.logger.error(`[UPSTOX-OPTION-CHAIN] fetchOptionContracts error: ${err}`);
      return [];
    }
  }

  /**
   * Fetch option chain with live quotes for an underlying.
   * Returns all legs with Greeks, OI, and live prices.
   */
  async fetchOptionChain(
    instrumentKey: string,
    expiry: string,
    headers: Record<string, string>,
    strike?: number,
  ): Promise<UpstoxOptionChainResult | null> {
    try {
      const params = new URLSearchParams({
        instrument_key: instrumentKey,
        expiry: expiry,
      });
      if (strike) params.set('strike_price', String(strike));

      const url = `https://api.upstox.com/v2/option/chain?${params}`;
      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(20000),
      });

      if (!response.ok) {
        const text = await response.text();
        this.logger.error(`[UPSTOX-OPTION-CHAIN] fetchOptionChain failed: HTTP ${response.status} - ${text}`);
        return null;
      }

      const data = await response.json() as {
        data?: {
          underlying_key?: string;
          underlying_ltp?: number;
          expiry?: string;
          option_chain?: any[];
        };
      };

      const chainData = data?.data;
      if (!chainData?.option_chain?.length) {
        this.logger.warn(`[UPSTOX-OPTION-CHAIN] No option chain data for ${instrumentKey} expiry ${expiry}`);
        return null;
      }

      const shortName = UpstoxOptionChainDiscoveryService.SHORT_NAMES[instrumentKey] ?? instrumentKey.split('|').pop() ?? instrumentKey;
      const legs: UpstoxOptionChainLeg[] = chainData.option_chain.map((leg: any) => ({
        instrumentKey: String(leg.instrument_key ?? ''),
        tradingSymbol: String(leg.trading_symbol ?? ''),
        strike: Number(leg.strike_price ?? 0),
        optionType: String(leg.option_type ?? '').toUpperCase() as 'CE' | 'PE',
        ltp: Number(leg.last_price ?? 0),
        bid: Number(leg.best_bid_price ?? 0),
        ask: Number(leg.best_ask_price ?? 0),
        bidQty: Number(leg.best_bid_qty ?? 0),
        askQty: Number(leg.best_ask_qty ?? 0),
        volume: Number(leg.volume ?? 0),
        openInterest: Number(leg.open_interest ?? 0),
        oiChange: Number(leg.oi_change ?? 0),
        iv: leg.implied_volatility ?? null,
        delta: leg.greeks?.delta ?? null,
        theta: leg.greeks?.theta ?? null,
        gamma: leg.greeks?.gamma ?? null,
        vega: leg.greeks?.vega ?? null,
        rho: leg.greeks?.rho ?? null,
        ts: new Date(),
      }));

      return {
        underlying: shortName,
        underlyingKey: instrumentKey,
        underlyingPrice: Number(chainData.underlying_ltp ?? 0),
        expiry: String(chainData.expiry ?? expiry),
        legs,
        fetchedAt: new Date(),
      };
    } catch (err) {
      this.logger.error(`[UPSTOX-OPTION-CHAIN] fetchOptionChain error: ${err}`);
      return null;
    }
  }

  /**
   * Discover available expiries for an underlying.
   */
  async discoverExpiries(
    instrumentKey: string,
    headers: Record<string, string>,
  ): Promise<string[]> {
    try {
      const contracts = await this.fetchOptionContracts(instrumentKey, headers);
      const expiries = [...new Set(contracts.map(c => c.expiry))].sort();
      return expiries;
    } catch (err) {
      this.logger.error(`[UPSTOX-OPTION-CHAIN] discoverExpiries error: ${err}`);
      return [];
    }
  }

  /**
   * Get the nearest expiry for an underlying.
   */
  async getNearestExpiry(
    instrumentKey: string,
    preferToday: boolean,
    headers: Record<string, string>,
  ): Promise<string | null> {
    const expiries = await this.discoverExpiries(instrumentKey, headers);
    if (expiries.length === 0) return null;

    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);

    if (preferToday) {
      const today = expiries.find(e => e.startsWith(todayStr));
      if (today) return today;
    }

    // Find nearest future expiry
    const future = expiries.find(e => e >= todayStr);
    return future ?? expiries[expiries.length - 1];
  }

  /**
   * Fetch option chain for all configured underlyings (NIFTY, BANKNIFTY, SENSEX).
   */
  async fetchAllOptionChains(
    headers: Record<string, string>,
    preferTodayExpiry: boolean = true,
  ): Promise<UpstoxOptionChainResult[]> {
    const results: UpstoxOptionChainResult[] = [];

    for (const [name, key] of Object.entries(UpstoxOptionChainDiscoveryService.UNDERLYING_KEYS)) {
      try {
        const expiry = await this.getNearestExpiry(key, preferTodayExpiry, headers);
        if (!expiry) {
          this.logger.warn(`[UPSTOX-OPTION-CHAIN] No expiry found for ${name}`);
          continue;
        }

        const chain = await this.fetchOptionChain(key, expiry, headers);
        if (chain) {
          results.push(chain);
          this.logger.log(`[UPSTOX-OPTION-CHAIN] ${name}: ${chain.legs.length} legs, price=${chain.underlyingPrice}`);
        }
      } catch (err) {
        this.logger.error(`[UPSTOX-OPTION-CHAIN] Failed for ${name}: ${err}`);
      }
    }

    return results;
  }
}
