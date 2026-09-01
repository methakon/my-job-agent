export type OptionType = 'CE' | 'PE';

export type OptionContract = {
  symbol: string;
  underlying: string;
  expiry: string;
  strike: number;
  optionType: OptionType;
  lotSize: number;
  tickSize: number;
};

export type OptionQuote = {
  contractSymbol: string;
  underlying: string;
  expiry: string;
  strike: number;
  optionType: OptionType;
  ltp: number;
  bid?: number;
  ask?: number;
  volume: number;
  openInterest: number;
  impliedVolatility?: number;
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  ts: string;
  provider: string;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;

const finite = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
};

const optionalNonNegative = (value: unknown): number | undefined => {
  const number = finite(value);
  return number !== undefined && number >= 0 ? number : undefined;
};

const isoDate = (value: unknown): string | undefined => {
  const text = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return undefined;
  const date = new Date(`${text}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text ? undefined : text;
};

/** Normalize explicit contract metadata; symbols are never guessed into contracts. */
export const normalizeOptionContract = (input: unknown): OptionContract | null => {
  const value = asRecord(input);
  if (!value) return null;
  const symbol = String(value.symbol ?? '').trim();
  const underlying = String(value.underlying ?? '').trim().toUpperCase();
  const expiry = isoDate(value.expiry);
  const strike = finite(value.strike);
  const lotSize = finite(value.lotSize);
  const tickSize = finite(value.tickSize ?? 0.05);
  const optionType = String(value.optionType ?? '').trim().toUpperCase();
  if (!symbol || !underlying || !expiry || strike === undefined || strike < 0 || lotSize === undefined || lotSize < 1
    || tickSize === undefined || tickSize <= 0 || (optionType !== 'CE' && optionType !== 'PE')) return null;
  return {
    symbol,
    underlying,
    expiry,
    strike,
    optionType: optionType as OptionType,
    lotSize: Math.trunc(lotSize),
    tickSize,
  };
};

/** Normalize a quote against explicit contract metadata from the provider/configuration. */
export const normalizeOptionQuote = (input: unknown, contract: OptionContract): OptionQuote | null => {
  const value = asRecord(input);
  if (!value || !contract) return null;
  const ltp = optionalNonNegative(value.ltp ?? value.lp ?? value.lastTradedPrice);
  const tsValue = value.ts ?? value.timestamp;
  const timestamp = new Date(tsValue === undefined ? Date.now() : String(tsValue));
  if (ltp === undefined || Number.isNaN(timestamp.getTime())) return null;
  const provider = String(value.provider ?? 'unknown').trim().toLowerCase() || 'unknown';
  const optional = (field: string, ...aliases: string[]): number | undefined => {
    const raw = [field, ...aliases].map((key) => value[key]).find((candidate) => candidate !== undefined);
    return finite(raw);
  };
  return {
    contractSymbol: contract.symbol,
    underlying: contract.underlying,
    expiry: contract.expiry,
    strike: contract.strike,
    optionType: contract.optionType,
    ltp,
    bid: optionalNonNegative(optional('bid', 'bidPrice')),
    ask: optionalNonNegative(optional('ask', 'askPrice')),
    volume: optionalNonNegative(value.volume ?? value.vol) ?? 0,
    openInterest: optionalNonNegative(value.openInterest ?? value.oi) ?? 0,
    impliedVolatility: optional('impliedVolatility', 'iv'),
    delta: optional('delta'),
    gamma: optional('gamma'),
    theta: optional('theta'),
    vega: optional('vega'),
    ts: timestamp.toISOString(),
    provider,
  };
};
