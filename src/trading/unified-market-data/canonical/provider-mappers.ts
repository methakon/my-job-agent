import { RawObservation, TickSourceSemantics } from './canonical-tick';

/**
 * Broker adapters: translate a provider's NATIVE payload into the provider-neutral
 * `RawObservation`. This is the ONLY place provider field names, symbol forms and
 * timestamp units may appear — desks and the common store never see them.
 *
 * Every mapper is pure and deterministic: same payload ⇒ same observation. Field
 * names follow each broker's documented feed (FYERS WS SymbolUpdate, Upstox v3
 * market-quote, Kite Connect ticker), and a field that is absent stays absent
 * (null) instead of being defaulted.
 */

export type ResolvedInstrument = { symbol: string; exchange?: string | null };

/**
 * Identity the ADAPTER already knows from the SAME provider response and may
 * hand to the mapper when the record itself is silent about it — the instrument
 * key a chain row was requested for (`instrument_key=NSE_INDEX|Nifty 50`), or
 * the contract metadata (expiry/strike/right) that lives on the envelope rather
 * than on the leg. It is provider data, never a guess, and a mapper uses it ONLY
 * for a field the payload did not carry: a value present in the payload always
 * wins, so nothing is ever overridden.
 */
export type MapperIdentity = {
  providerInstrumentId?: string | null;
  providerSymbol?: string | null;
  underlying?: string | null;
  exchange?: string | null;
  segment?: string | null;
  instrumentType?: string | null;
  expiry?: string | null;
  strike?: number | null;
  optionType?: string | null;
};

export type MapperContext = {
  receivedAt: Date;
  /**
   * Deterministic token → symbol resolution (Kite/Upstox ticks can carry only a
   * numeric instrument_token). Supplied from the broker instrument master; when it
   * cannot resolve, the mapper says so instead of inventing a symbol.
   */
  resolveSymbol?: (providerInstrumentId: string) => ResolvedInstrument | string | null;
  /** Adapter-supplied identity fallback (see MapperIdentity). */
  identity?: MapperIdentity;
};

export type MappedObservation =
  | { ok: true; observation: RawObservation }
  /**
   * `skip` marks a provider CONTROL/ack/heartbeat record: it is not a tick at all,
   * so it is ignored rather than counted as invalid market data. A record that
   * carries tick values but no identity is NOT skipped — it is a malformed tick and
   * is rejected.
   */
  | { ok: false; reason: string; skip?: boolean };
export type ProviderMapper = (payload: unknown, ctx: MapperContext) => MappedObservation;

const record = (payload: unknown): Record<string, unknown> =>
  payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};

const pick = (source: Record<string, unknown>, ...keys: string[]): unknown => {
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null && source[key] !== '') return source[key];
  }
  return null;
};

/** Did the record carry any tick VALUE? (control/ack record vs malformed tick) */
const hasTickValue = (source: Record<string, unknown>, keys: readonly string[]): boolean =>
  keys.some((key) => {
    const value = source[key];
    if (value === undefined || value === null || value === '') return false;
    if (typeof value === 'object') return Array.isArray(value) ? value.length > 0 : Object.keys(value).length > 0;
    return true;
  });

const FYERS_TICK_FIELDS = [
  'ltp', 'lp', 'last_traded_price', 'vol_traded_today', 'volume', 'volume_traded', 'oi', 'open_interest',
  'bid', 'ask', 'bid_price', 'ask_price', 'exch_feed_time', 'last_traded_time', 'open_price', 'high_price', 'low_price',
] as const;

const UPSTOX_TICK_FIELDS = [
  'last_price', 'ltp', 'volume', 'volume_traded', 'oi', 'open_interest', 'bid', 'ask', 'bid_price', 'ask_price',
  'underlying_spot_price', 'ohlc', 'depth', 'market_data', 'timestamp', 'last_trade_time',
] as const;

const KITE_TICK_FIELDS = [
  'last_price', 'ltp', 'volume_traded', 'volume', 'oi', 'open_interest', 'depth', 'ohlc', 'exchange_timestamp', 'last_trade_time',
] as const;

/** Normalize a resolver result into { symbol, exchange }. */
const resolved = (
  value: ResolvedInstrument | string | null | undefined,
): ResolvedInstrument | null => {
  if (!value) return null;
  if (typeof value === 'string') return { symbol: value };
  return value.symbol ? value : null;
};

/** Best bid/ask + sizes from either a flat pair or a depth array (Kite/Upstox). */
const fromDepth = (
  depth: unknown,
): { bid: unknown; ask: unknown; bidQty: unknown; askQty: unknown } => {
  const books = record(depth);
  const buy = Array.isArray(books.buy) ? books.buy : [];
  const sell = Array.isArray(books.sell) ? books.sell : [];
  const best = (entries: unknown[]): Record<string, unknown> => record(entries[0]);
  const bestBuy = best(buy);
  const bestSell = best(sell);
  return {
    bid: pick(bestBuy, 'price', 'bid', 'bidPrice'),
    ask: pick(bestSell, 'price', 'ask', 'askPrice'),
    bidQty: pick(bestBuy, 'quantity', 'qty', 'bidQty'),
    askQty: pick(bestSell, 'quantity', 'qty', 'askQty'),
  };
};

/**
 * FYERS WebSocket (v3) SymbolUpdate tick. Fields as the SDK publishes them:
 * symbol, ltp, vol_traded_today, oi, bid, ask, bid_size, ask_size,
 * last_traded_time, exch_feed_time (epoch SECONDS), plus OHLC; the client may
 * wrap records in `d`/`data` arrays, and lite mode nests prices under `v`.
 * exch_feed_time is the exchange feed (quote) time; last_traded_time describes
 * the last trade, so it is labelled LAST_TRADE when used.
 */
export const fyersMapper: ProviderMapper = (payload, ctx) => {
  const tick = record(payload);
  const v = record(tick.v);
  const providerInstrumentId = pick(tick, 'symbol', 'n', 'symbolName', 'fyToken', 'instrument') as string | null;
  if (!providerInstrumentId) {
    // The data socket also carries connection/subscription control records ("socket
    // is disconnected", subscribe acks): those are not ticks and are ignored. A
    // record that DOES carry tick values but no symbol is a malformed tick.
    return hasTickValue(tick, FYERS_TICK_FIELDS) || Object.keys(v).length
      ? { ok: false, reason: 'FYERS payload has no symbol' }
      : { ok: false, reason: 'FYERS control/ack record (not a tick)', skip: true };
  }
  const feedTime = pick(tick, 'exch_feed_time', 'exchFeedTime', 'exchange_timestamp', 'timestamp', 'ts');
  const tradeTime = pick(tick, 'last_traded_time', 'lastTradedTime');
  const sourceTimestamp = feedTime ?? tradeTime;
  const semantics: TickSourceSemantics = feedTime ? 'QUOTE' : tradeTime ? 'LAST_TRADE' : 'QUOTE';
  // Values are passed through exactly as the provider sent them (unknown-ish) and
  // validated by the interpreter; the cast only reflects that the adapter does not
  // pre-judge them.
  return {
    ok: true,
    observation: ({
      providerInstrumentId: String(providerInstrumentId),
      providerSymbol: String(providerInstrumentId),
      underlying: (pick(tick, 'underlying', 'underlyingSymbol') as string | null) ?? null,
      exchange: providerInstrumentId.startsWith('BSE') ? 'BSE' : 'NSE',
      segment: 'FO',
      ltp: pick(tick, 'ltp', 'lp', 'last_traded_price') ?? pick(v, 'lp', 'ltp'),
      volume: pick(tick, 'vol_traded_today', 'volume', 'volume_traded') ?? pick(v, 'vol_traded_today', 'volume'),
      oi: pick(tick, 'oi', 'open_interest', 'openInterest') ?? pick(v, 'oi'),
      bid: pick(tick, 'bid', 'bid_price') ?? pick(v, 'bid'),
      ask: pick(tick, 'ask', 'ask_price') ?? pick(v, 'ask'),
      bidQty: pick(tick, 'bid_size', 'bidQty', 'bid_qty') ?? pick(v, 'bid_size'),
      askQty: pick(tick, 'ask_size', 'askQty', 'ask_qty') ?? pick(v, 'ask_size'),
      open: pick(tick, 'open_price'),
      high: pick(tick, 'high_price'),
      low: pick(tick, 'low_price'),
      close: pick(tick, 'prev_close_price'),
      sourceTimestamp: sourceTimestamp as string | number | null,
      sourceTimestampSemantics: semantics,
      raw: payload,
    } as RawObservation),
  } as MappedObservation;
};

/**
 * Upstox v3 market-quote entry: instrument_token / instrument_key, last_price,
 * volume, oi, prev_oi, ohlc{open,high,low,close}, depth{buy[],sell[]}, timestamp.
 * Upstox keys are `EXCHANGE_SEGMENT|SYMBOL` (or a numeric token), so the key is
 * kept as provenance and the symbol part becomes the canonical identity.
 */
export const upstoxMapper: ProviderMapper = (payload, ctx) => {
  const envelope = record(payload);
  // A v3 quote row is flat; an option-chain leg nests the same market fields under
  // `market_data`. Merge deterministically: the nested market data wins for prices,
  // the outer row supplies the instrument identity.
  const nested = record(envelope.market_data);
  const quote = Object.keys(nested).length ? { ...envelope, ...nested } : envelope;
  // Identity order: the record's own key, then the numeric-token master, then the
  // key the adapter REQUESTED this row with (same provider call — see MapperIdentity).
  const providerInstrumentId = (pick(envelope, 'instrument_token', 'instrumentKey', 'instrument_key', 'trading_symbol', 'symbol')
    ?? ctx.identity?.providerInstrumentId
    ?? null) as string | null;
  if (!providerInstrumentId) {
    return hasTickValue(quote, UPSTOX_TICK_FIELDS)
      ? { ok: false, reason: 'Upstox payload has no instrument key/token' }
      : { ok: false, reason: 'Upstox control/ack record (not a tick)', skip: true };
  }
  const ohlc = record(quote.ohlc);
  const depth = fromDepth(quote.depth);
  const rawKey = String(providerInstrumentId);
  const tail = rawKey.split('|').pop() ?? rawKey;
  const tokenIsNumeric = /^\d+$/.test(tail);
  const fromMaster = tokenIsNumeric ? resolved(ctx.resolveSymbol?.(rawKey)) : null;
  if (tokenIsNumeric && !fromMaster) {
    return { ok: false, reason: `Upstox token ${rawKey} is unresolved (no instrument master entry)` };
  }
  // Keyed form NSE_FO|SYMBOL carries the symbol itself; a numeric token needs the
  // master. The payload/its own key always wins over any adapter identity hint.
  const providerSymbol = fromMaster?.symbol ?? (tokenIsNumeric ? null : tail);
  const exchange = fromMaster?.exchange
    ?? (rawKey.includes('_') ? rawKey.split('_')[0] : null)
    ?? ctx.identity?.exchange
    ?? null;
  // Values are passed through exactly as the provider sent them (unknown-ish) and
  // validated by the interpreter; the cast only reflects that the adapter does not
  // pre-judge them.
  return {
    ok: true,
    observation: ({
      providerInstrumentId: rawKey,
      providerSymbol,
      underlying: (pick(quote, 'underlying', 'underlying_symbol') as string | null) ?? ctx.identity?.underlying ?? null,
      exchange: exchange as string | null,
      segment: (String(providerInstrumentId).includes('|') ? String(providerInstrumentId).split('|')[0].split('_').pop() : null) as string | null,
      // Upstox declares the contract kind on the instrument (OPT/FUT/INDEX/EQ).
      instrumentType: (pick(quote, 'instrument_type', 'instrumentType') as string | null) ?? ctx.identity?.instrumentType ?? null,
      // An INDEX chain row publishes its tape as `underlying_spot_price` (the row's
      // own price field), not as `last_price`.
      ltp: pick(quote, 'last_price', 'ltp') ?? pick(quote, 'underlying_spot_price') ?? null,
      // Contract metadata rides on the envelope/request for a chain leg, so the
      // adapter may supply it; the payload always wins when it carries its own.
      expiry: (pick(quote, 'expiry', 'expiry_date') as string | null) ?? ctx.identity?.expiry ?? null,
      strike: pick(quote, 'strike_price', 'strike') ?? ctx.identity?.strike ?? null,
      optionType: (pick(quote, 'option_type', 'instrument_type') as string | null) ?? ctx.identity?.optionType ?? null,
      volume: pick(quote, 'volume', 'volume_traded'),
      oi: pick(quote, 'oi', 'open_interest'),
      previousOi: pick(quote, 'prev_oi', 'previous_oi'),
      bid: pick(quote, 'bid', 'bid_price') ?? depth.bid,
      ask: pick(quote, 'ask', 'ask_price') ?? depth.ask,
      bidQty: pick(quote, 'bid_qty', 'bid_size') ?? depth.bidQty,
      askQty: pick(quote, 'ask_qty', 'ask_size') ?? depth.askQty,
      open: pick(ohlc, 'open'),
      high: pick(ohlc, 'high'),
      low: pick(ohlc, 'low'),
      close: pick(ohlc, 'close') ?? pick(quote, 'close_price'),
      depth: quote.depth ?? null,
      sourceTimestamp: pick(quote, 'timestamp', 'last_trade_time') as string | number | null,
      sourceTimestampSemantics: 'QUOTE',
      raw: payload,
    } as RawObservation),
  } as MappedObservation;
};

/**
 * Zerodha Kite Connect ticker: instrument_token (numeric only), last_price,
 * last_quantity, volume_traded, oi, oi_day_high/low, change, timestamp (epoch ms
 * when last_price/volume change, epoch seconds for the oi mode), depth{buy,sell},
 * last_trade_time. A numeric token MUST be resolved from the instrument master
 * (symbol, expiry, strike, right); nothing is guessed if it cannot be.
 */
export const zerodhaMapper: ProviderMapper = (payload, ctx) => {
  const tick = record(payload);
  const token = pick(tick, 'instrument_token', 'instrumentToken', 'token');
  if (token === null) {
    return hasTickValue(tick, KITE_TICK_FIELDS)
      ? { ok: false, reason: 'Kite payload has no instrument_token' }
      : { ok: false, reason: 'Kite control/ack record (not a tick)', skip: true };
  }
  const providerInstrumentId = String(token);
  // A Kite tick carries only the numeric token: the instrument master is the ONLY
  // deterministic source of the symbol + exchange. Unresolved ⇒ reject, never guess.
  const fromMaster = resolved(ctx.resolveSymbol?.(providerInstrumentId)) ?? resolved(pick(tick, 'tradingsymbol', 'symbol') as string | null);
  if (!fromMaster) {
    return { ok: false, reason: `Kite token ${providerInstrumentId} is unresolved (no instrument master entry)` };
  }
  const depth = fromDepth(tick.depth);
  const tradeTime = pick(tick, 'last_trade_time');
  const timestamp = pick(tick, 'exchange_timestamp', 'timestamp');
  // Values are passed through exactly as the provider sent them (unknown-ish) and
  // validated by the interpreter; the cast only reflects that the adapter does not
  // pre-judge them.
  return {
    ok: true,
    observation: ({
      providerInstrumentId,
      providerSymbol: fromMaster.symbol,
      exchange: (fromMaster.exchange ?? null) as string | null,
      // Kite sends expiry on the instrument dump, not on the tick; the symbol
      // carries it for options, so the parser derives it there.
      expiry: (pick(tick, 'expiry', 'expiry_date') as string | null) ?? null,
      strike: pick(tick, 'strike'),
      instrumentType: pick(tick, 'instrument_type', 'instrumentType') as string | null,
      optionType: pick(tick, 'instrument_type', 'option_type') as string | null,
      ltp: pick(tick, 'last_price', 'ltp'),
      volume: pick(tick, 'volume_traded', 'volume'),
      oi: pick(tick, 'oi', 'open_interest'),
      bid: pick(tick, 'bid', 'bid_price') ?? depth.bid,
      ask: pick(tick, 'ask', 'ask_price') ?? depth.ask,
      bidQty: pick(tick, 'bid_quantity') ?? depth.bidQty,
      askQty: pick(tick, 'ask_quantity') ?? depth.askQty,
      close: pick(tick, 'close', 'ohlc_close'),
      depth: tick.depth ?? null,
      sourceTimestamp: (timestamp ?? tradeTime) as string | number | null,
      sourceTimestampSemantics: timestamp ? 'EXCHANGE' : 'LAST_TRADE',
      raw: payload,
    } as RawObservation),
  } as MappedObservation;
};

/** Supported providers. Unknown ids are rejected, never silently accepted. */
export const PROVIDER_MAPPERS: Record<string, ProviderMapper> = {
  FYERS: fyersMapper,
  FYERS_LIVE: fyersMapper,
  FYERS_WS: fyersMapper,
  UPSTOX: upstoxMapper,
  UPSTOX_LIVE: upstoxMapper,
  UPSTOX_REST: upstoxMapper,
  ZERODHA: zerodhaMapper,
  ZERODHA_KITE: zerodhaMapper,
  KITE: zerodhaMapper,
};

export const supportedProviders = (): string[] => Object.keys(PROVIDER_MAPPERS).sort();

export const mapperFor = (source: string): ProviderMapper | null =>
  PROVIDER_MAPPERS[String(source ?? '').trim().toUpperCase()] ?? null;

/** One provider message can carry several ticks; unwrap them deterministically. */
export type ProviderEnvelope = (payload: unknown) => unknown[];

const collectRecords = (payload: unknown, depth = 0): unknown[] => {
  if (depth > 3) return [];
  if (Array.isArray(payload)) return payload.flatMap((entry) => collectRecords(entry, depth + 1));
  const rec = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null;
  if (!rec) return [];
  const nested = rec.d ?? rec.data;
  if (nested && (Array.isArray(nested) || typeof nested === 'object')) {
    const inner = collectRecords(nested, depth + 1);
    if (inner.length) return inner;
  }
  return [rec];
};

const single = (payload: unknown): unknown[] => [payload];

/** FYERS/Upstox/Kite wrap ticks differently (arrays, `d`/`data`, one row each). */
export const PROVIDER_ENVELOPES: Record<string, ProviderEnvelope> = {
  FYERS: (payload) => collectRecords(payload),
  FYERS_LIVE: (payload) => collectRecords(payload),
  FYERS_WS: (payload) => collectRecords(payload),
  ZERODHA: (payload) => collectRecords(payload),
  ZERODHA_KITE: (payload) => collectRecords(payload),
  KITE: (payload) => collectRecords(payload),
};

export const envelopeFor = (source: string): ProviderEnvelope =>
  PROVIDER_ENVELOPES[String(source ?? '').trim().toUpperCase()] ?? single;
