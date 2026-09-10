import { Injectable, Logger } from '@nestjs/common';
import { UpstoxLivePaperTokenService } from '../upstox-live-paper/upstox-live-paper-auth.service';
import { PreOpenSourceValues } from './pre-open-features';
import { PreOpenFetchResult, PreOpenQuoteSource } from './pre-open-source.interface';

/**
 * Upstox pre-open / auction adapter (v3 market-quote).
 *
 * WHY v3 AND NOT v2 (measured 2026-09-11, real API, read-only probe):
 *   /v2/market-quote/quotes carries ONLY ohlc/last_price/volume/oi/close_price.
 *   /v3/market-quote/quotes additionally carries the auction fields:
 *     indicative_equilibrium_price, indicative_equilibrium_quantity,
 *     reference_price, indicative_imbalance_quantity_total,
 *     indicative_imbalance_quantity_market, total_buy_quantity,
 *     total_sell_quantity, 5-level depth, prev_close_price, ohlc.ts
 *   The desk's existing REST poll uses v2 for option chains; this adapter adds
 *   the v3 read for pre-open intelligence and does NOT change any desk path.
 *
 * FIELD AVAILABILITY IS PER INSTRUMENT CLASS (measured, not assumed):
 *   - NSE_EQ instruments publish reference_price / prev_close_price /
 *     total_sell_quantity outside the auction window, and use
 *     0 as the "no auction" sentinel for indicative_equilibrium_price.
 *   - INDEX keys (BSE_INDEX|SENSEX, NSE_INDEX|Nifty 50) returned null for every
 *     auction field at 00:32 IST. That is recorded as UNAVAILABLE, never guessed.
 *   normalizeUpstoxQuote() therefore preserves the difference between a key the
 *   payload did NOT carry (ABSENT) and one carried as null (MISSING).
 *
 * Token: always through UpstoxLivePaperTokenService (never .env, never logged).
 */
const UPSTOX_LIVE_API_BASE = 'https://api.upstox.com';
const UPSTOX_V3_QUOTE = '/v3/market-quote/quotes';
const UPSTOX_V2_MARKET_STATUS = '/v2/market/status';
const MAX_KEYS_PER_CALL = 50;

export const AUCTION_FIELD_KEYS = [
  'indicative_equilibrium_price',
  'indicative_equilibrium_quantity',
  'reference_price',
  'indicative_imbalance_quantity_total',
  'indicative_imbalance_quantity_market',
  'total_buy_quantity',
  'total_sell_quantity',
  'prev_close_price',
  'last_price',
  'volume',
] as const;

/** 'NSE_INDEX:Nifty 50' (response key) and 'NSE_INDEX|Nifty 50' (request key). */
export const instrumentKeyAlias = (key: string): string => String(key ?? '').replace(/:/g, '|').trim();

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const parseEventTime = (raw: unknown): Date | null => {
  if (raw === null || raw === undefined || raw === '') return null;
  const d = new Date(String(raw));
  return Number.isNaN(d.getTime()) ? null : d;
};

type DepthLevel = { price: number | null; quantity: number | null } | null;

/** Best resting level with a usable price (> 0); empty levels are ignored. */
const bestLevel = (levels: unknown): DepthLevel => {
  if (!Array.isArray(levels)) return null;
  const usable = levels
    .map((l) => l as Record<string, unknown>)
    .map((l) => ({ price: num(l?.price), quantity: num(l?.quantity) }))
    .filter((l) => l.price !== null && (l.price as number) > 0);
  if (!usable.length) return null;
  return usable[0];
};

/**
 * PURE normalizer: broker payload → PreOpenSourceValues. Exported so the
 * deterministic replay test can feed recorded payloads without any network.
 */
export function normalizeUpstoxQuote(instrumentKey: string, raw: Record<string, unknown> | null | undefined): PreOpenSourceValues {
  const p = (raw ?? {}) as Record<string, unknown>;
  const depth = (p.depth ?? {}) as Record<string, unknown>;
  const ohlc = (p.ohlc ?? {}) as Record<string, unknown>;
  return {
    instrumentKey,
    symbol: p.symbol === undefined || p.symbol === null || p.symbol === 'NA' ? null : String(p.symbol),
    underlying: null,
    exchange: instrumentKeyAlias(instrumentKey).split('|')[0] ?? null,
    eventTime: parseEventTime(p.timestamp) ?? parseEventTime(ohlc.ts),
    previousClose: num(p.prev_close_price),
    referencePrice: num(p.reference_price),
    indicativePrice: num(p.indicative_equilibrium_price),
    indicativeQuantity: num(p.indicative_equilibrium_quantity),
    imbalanceTotal: num(p.indicative_imbalance_quantity_total),
    imbalanceMarket: num(p.indicative_imbalance_quantity_market),
    buyQuantity: num(p.total_buy_quantity),
    sellQuantity: num(p.total_sell_quantity),
    lastPrice: num(p.last_price),
    volume: num(p.volume),
    depthBestBid: bestLevel(depth.buy),
    depthBestAsk: bestLevel(depth.sell),
    presentKeys: Object.keys(p),
  };
}

@Injectable()
export class UpstoxPreOpenSource implements PreOpenQuoteSource {
  readonly sourceName = 'UPSTOX_V3_LIVE';
  private readonly logger = new Logger(UpstoxPreOpenSource.name);
  private headersCache: Record<string, string> | null = null;
  private headersUntilMs = 0;

  constructor(private readonly tokens: UpstoxLivePaperTokenService) {}

  /** v3 auth headers from the SINGLE active token row (cached ~5 min). */
  private async authHeaders(): Promise<Record<string, string> | null> {
    const now = Date.now();
    if (this.headersCache && now < this.headersUntilMs) return this.headersCache;
    try {
      const { token } = await this.tokens.getValidUpstoxAccessToken();
      if (!token) return null;
      const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json' };
      const apiKey = (process.env.UPSTOX_LIVE_API_KEY ?? '').trim();
      if (apiKey) headers['x-api-key'] = apiKey;
      headers['Authorization'] = `Bearer ${token}`;
      this.headersCache = headers;
      this.headersUntilMs = now + 5 * 60_000;
      return headers;
    } catch (err) {
      this.headersCache = null;
      this.headersUntilMs = 0;
      this.logger.warn(`[PRE-OPEN] token unavailable: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  async fetchPreOpen(instrumentKeys: string[]): Promise<PreOpenFetchResult> {
    const keys = Array.from(new Set(instrumentKeys.map((k) => String(k).trim()).filter(Boolean)));
    const values: Record<string, PreOpenSourceValues> = {};
    const result: PreOpenFetchResult = { ok: false, error: null, values, marketStatus: null, marketStatusError: null };

    const headers = await this.authHeaders();
    if (!headers) {
      result.error = 'AUTH_REQUIRED — no valid Upstox access token';
      return result;
    }

    let anyOk = false;
    const errors: string[] = [];
    for (let i = 0; i < keys.length; i += MAX_KEYS_PER_CALL) {
      const chunk = keys.slice(i, i + MAX_KEYS_PER_CALL);
      const url = `${UPSTOX_LIVE_API_BASE}${UPSTOX_V3_QUOTE}?instrument_key=${encodeURIComponent(chunk.join(','))}`;
      try {
        const res = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(15000) });
        const body = (await res.json().catch(() => null)) as { status?: string; data?: Record<string, Record<string, unknown>>; message?: string } | null;
        if (res.status !== 200 || !body || body.status !== 'success' || !body.data) {
          errors.push(`HTTP ${res.status}${body?.message ? ` ${body.message}` : ''}`);
          continue;
        }
        anyOk = true;
        // Response keys use ':' where requests use '|'; instrument_token is authoritative.
        const byAlias = new Map<string, Record<string, unknown>>();
        for (const [k, v] of Object.entries(body.data)) byAlias.set(instrumentKeyAlias(k), v);
        for (const requested of chunk) {
          const alias = instrumentKeyAlias(requested);
          const payload = byAlias.get(alias) ?? null;
          if (!payload) continue;
          const token = typeof payload.instrument_token === 'string' ? instrumentKeyAlias(payload.instrument_token) : alias;
          values[token] = normalizeUpstoxQuote(token, payload);
        }
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }

    result.ok = anyOk;
    result.error = errors.length ? errors.join('; ').slice(0, 400) : null;

    // Exchange status is provenance for the phase label (never the data itself).
    try {
      const exchange = (keys[0] ? instrumentKeyAlias(keys[0]).split('|')[0] : 'NSE') || 'NSE';
      const res = await fetch(`${UPSTOX_LIVE_API_BASE}${UPSTOX_V2_MARKET_STATUS}/${encodeURIComponent(exchange)}`, {
        method: 'GET', headers, signal: AbortSignal.timeout(15000),
      });
      const body = (await res.json().catch(() => null)) as { data?: { status?: string } } | null;
      result.marketStatus = res.status === 200 ? (body?.data?.status ?? null) : null;
    } catch (err) {
      result.marketStatusError = err instanceof Error ? err.message : String(err);
    }
    return result;
  }
}
