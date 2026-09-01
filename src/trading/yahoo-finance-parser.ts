export type YahooSymbolConfig = {
  symbol: string;
  instrument: string;
};

export type YahooTick = {
  instrument: string;
  price: number;
  volume: number;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  ts: string;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;

const asFinite = (...values: unknown[]): number | undefined => {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
};

/** Parse comma-separated Yahoo symbols, optionally mapped to app instruments. */
export const parseYahooSymbolConfig = (value: string): YahooSymbolConfig[] => value
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => {
    const separator = entry.indexOf('=');
    if (separator < 0) return { symbol: entry, instrument: entry };
    const symbol = entry.slice(0, separator).trim();
    const instrument = entry.slice(separator + 1).trim();
    return { symbol, instrument: instrument || symbol };
  })
  .filter((entry) => Boolean(entry.symbol))
  .slice(0, 50);

/** Convert Yahoo Finance chart JSON into one normalized market snapshot tick. */
export const parseYahooChartResponse = (payload: unknown, instrument: string): YahooTick | null => {
  const root = asRecord(payload);
  const chart = asRecord(root?.chart);
  const resultValue = chart?.result;
  const result = Array.isArray(resultValue) ? asRecord(resultValue[0]) : null;
  if (!result) return null;

  const meta = asRecord(result.meta);
  const timestamps = Array.isArray(result.timestamp) ? result.timestamp : [];
  const indicators = asRecord(result.indicators);
  const quotes = indicators && Array.isArray(indicators.quote) ? indicators.quote : [];
  const quote = asRecord(quotes[0]);
  const closes = Array.isArray(quote?.close) ? quote.close : [];
  const latestIndex = closes.reduce((found, value, index) => asFinite(value) !== undefined ? index : found, -1);
  const price = asFinite(meta?.regularMarketPrice, latestIndex >= 0 ? closes[latestIndex] : undefined);
  if (price === undefined || price < 0) return null;

  const at = (field: string): number | undefined => {
    const values = Array.isArray(quote?.[field]) ? quote[field] as unknown[] : [];
    return latestIndex >= 0 ? asFinite(values[latestIndex]) : undefined;
  };
  const epoch = asFinite(meta?.regularMarketTime, latestIndex >= 0 ? timestamps[latestIndex] : undefined) ?? Date.now() / 1000;
  const date = new Date(epoch < 2_000_000_000 ? epoch * 1000 : epoch);
  if (Number.isNaN(date.getTime())) return null;

  return {
    instrument,
    price,
    volume: at('volume') ?? 0,
    open: at('open'),
    high: at('high'),
    low: at('low'),
    close: at('close'),
    ts: date.toISOString(),
  };
};
