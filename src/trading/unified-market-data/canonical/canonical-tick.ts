import { createHash } from 'node:crypto';

/**
 * Canonical market-data schema and its deterministic interpreter rules.
 *
 * ONE schema for every broker (FYERS, Upstox, Zerodha, future feeds). Provider
 * adapters only TRANSLATE their native payload into a `RawObservation`; every
 * judgement about what a tick MEANS — instrument identity, units, timestamps,
 * validity — is made here, in pure functions, with no AI and no randomness.
 *
 * Rules that matter:
 *  - Nothing is ever invented. A field the provider did not send stays null; it
 *    is never defaulted to 0, to a previous value, or to a guess.
 *  - Invalid / impossible / too-late values are REJECTED with a machine-readable
 *    code, never repaired into something plausible.
 *  - Provenance is preserved: the source name, the provider's own instrument id,
 *    the provider payload hash, the source timestamp and its SEMANTICS (a quote
 *    time is not a last-trade time) all travel with the canonical tick.
 *  - Same economic tick from two brokers ⇒ identical canonical core, so a desk
 *    never needs broker-specific interpretation again.
 */

/** What the provider's timestamp actually means (set by the adapter, never guessed). */
export type TickSourceSemantics = 'QUOTE' | 'LAST_TRADE' | 'EXCHANGE';

export type InstrumentType = 'OPTION' | 'FUTURE' | 'INDEX' | 'EQUITY' | 'UNKNOWN';

/** Provider-neutral observation produced by an adapter. */
export type RawObservation = {
  /** Broker's own instrument identity, e.g. NSE:NIFTY26SEP23000PE or an Upstox key. */
  providerInstrumentId?: string | null;
  /** Broker's symbol text when it differs from the id (Kite sends token + symbol). */
  providerSymbol?: string | null;
  underlying?: string | null;
  exchange?: string | null;
  segment?: string | null;
  instrumentType?: string | null;
  expiry?: string | null;
  strike?: number | null;
  optionType?: string | null;
  ltp?: number | null;
  bid?: number | null;
  ask?: number | null;
  bidQty?: number | null;
  askQty?: number | null;
  volume?: number | null;
  oi?: number | null;
  previousOi?: number | null;
  changeOi?: number | null;
  iv?: number | null;
  delta?: number | null;
  gamma?: number | null;
  theta?: number | null;
  vega?: number | null;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  close?: number | null;
  depth?: unknown;
  /** Provider timestamp in any documented form (ISO string, epoch ms/seconds, Date). */
  sourceTimestamp?: string | number | Date | null;
  sourceTimestampSemantics?: TickSourceSemantics;
  /** The provider payload exactly as received (raw semantics preserved). */
  raw: unknown;
  rawPayloadHash?: string;
};

export type CanonicalTick = {
  /** Canonical identity every desk keys on, e.g. NSE:NIFTY26SEP23000PE. */
  instrumentKey: string;
  source: string;
  providerInstrumentId: string;
  underlying: string | null;
  exchange: string | null;
  segment: string | null;
  instrumentType: InstrumentType;
  expiry: string | null;
  strike: number | null;
  optionType: 'CE' | 'PE' | null;
  ltp: number | null;
  bid: number | null;
  ask: number | null;
  bidQty: number | null;
  askQty: number | null;
  volume: number | null;
  oi: number | null;
  previousOi: number | null;
  changeOi: number | null;
  iv: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  depth: unknown;
  sourceTimestamp: Date | null;
  sourceTimestampKind: TickSourceSemantics;
  receivedTimestamp: Date;
  /** receivedTimestamp − sourceTimestamp for QUOTE/EXCHANGE ticks (broker lag). */
  sourceLagMs: number | null;
  /** Whether that lag is inside the configured budget (a flag, never a repair). */
  latencyWithinBudget: boolean;
  dataQuality: 'GOOD' | 'STALE';
  /** Provider payload exactly as received + its deterministic hash (audit/replay). */
  raw: unknown;
  rawPayloadHash: string;
};

export type RejectionCode =
  | 'UNSUPPORTED_PROVIDER'
  | 'SCHEMA'
  | 'UNRESOLVED_INSTRUMENT'
  | 'INVALID_VALUE'
  | 'IMPOSSIBLE_VALUE'
  | 'INVALID_TIMESTAMP'
  | 'FUTURE_TIMESTAMP'
  | 'STALE';

export type TickRejection = { ok: false; code: RejectionCode; reason: string; source: string };
/**
 * A provider CONTROL/ack record (connection, subscription, heartbeat): not a
 * tick, so it is neither persisted nor counted as invalid market data.
 */
export type TickIgnored = { ok: false; skipped: true; reason: string; source: string };
export type InterpreterResult = { ok: true; tick: CanonicalTick } | TickRejection | TickIgnored;

export type TickBudgets = {
  /** Max broker lag for QUOTE/EXCHANGE ticks before rejection (default 60 s). */
  maxQuoteLagMs: number;
  /** Max age of a LAST_TRADE timestamp before rejection (default 15 min). */
  maxLastTradeAgeMs: number;
  /** Clock skew tolerated on a source timestamp ahead of our receive time. */
  maxFutureSkewMs: number;
  /** Broker lag considered healthy (flag only — never repairs the tick). */
  latencyBudgetMs: number;
};

export const DEFAULT_TICK_BUDGETS: TickBudgets = {
  maxQuoteLagMs: 60_000,
  maxLastTradeAgeMs: 900_000,
  maxFutureSkewMs: 5_000,
  latencyBudgetMs: 5_000,
};

export const budgetsFromEnv = (env: NodeJS.ProcessEnv = process.env): TickBudgets => {
  const num = (key: string, fallback: number): number => {
    const value = Number(env[key]);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  };
  return {
    maxQuoteLagMs: num('TICK_MAX_QUOTE_LAG_MS', DEFAULT_TICK_BUDGETS.maxQuoteLagMs),
    maxLastTradeAgeMs: num('TICK_MAX_LAST_TRADE_AGE_MS', DEFAULT_TICK_BUDGETS.maxLastTradeAgeMs),
    maxFutureSkewMs: num('TICK_MAX_FUTURE_SKEW_MS', DEFAULT_TICK_BUDGETS.maxFutureSkewMs),
    latencyBudgetMs: num('TICK_LATENCY_BUDGET_MS', DEFAULT_TICK_BUDGETS.latencyBudgetMs),
  };
};

/** Stable JSON (sorted keys, recursively) so a payload hash is reproducible. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export function payloadHash(raw: unknown): string {
  return createHash('sha256').update(stableStringify(raw)).digest('hex');
}

const MARKET_MONTHS: Record<string, string> = {
  JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
  JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
};

const MONTH_NAMES = Object.keys(MARKET_MONTHS).join('|');

/** 2026-09-26 | 26SEP2026 | 26SEP | 26SEP26 -> YYYY-MM-DD (deterministic, else null). */
export function normalizeExpiry(value: unknown, now = new Date()): string | null {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim().toUpperCase();
  let match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  match = text.match(new RegExp(`^(\\d{1,2})(${MONTH_NAMES})(\\d{4})$`));
  if (match) {
    const day = match[1].padStart(2, '0');
    return `${match[3]}-${MARKET_MONTHS[match[2]]}-${day}`;
  }
  match = text.match(new RegExp(`^(\\d{1,2})(${MONTH_NAMES})(\\d{2})$`));
  if (match) {
    const day = match[1].padStart(2, '0');
    return `20${match[3]}-${MARKET_MONTHS[match[2]]}-${day}`;
  }
  // Month-only (26SEP) — the concrete day is NOT derivable, so nothing is invented.
  void now;
  return null;
}

export function normalizeOptionType(value: unknown): 'CE' | 'PE' | null {
  const text = String(value ?? '').trim().toUpperCase();
  if (text === 'CE' || text === 'CALL' || text === 'C') return 'CE';
  if (text === 'PE' || text === 'PUT' || text === 'P') return 'PE';
  return null;
}

/**
 * Option contract identity from any provider's symbol text.
 *
 * NSE/BSE symbology as these feeds actually carry it: UNDERLYING + DD + MON +
 * STRIKE + CE|PE (e.g. NIFTY26SEP23000PE, BANKNIFTY26SEP58500CE, SENSEX26SEP74000CE)
 * — the contract's YEAR is not in the symbol. It is therefore taken from the
 * contract metadata when the adapter supplies the expiry (authoritative), and
 * otherwise rolled forward from the tick's own date with the calendar: a contract
 * that is being streamed cannot have expired, so the next occurrence of that
 * day/month is the only consistent reading. Everything else stays null.
 */
export function parseOptionSymbol(symbol: unknown, now = new Date()): {
  underlying: string | null; expiry: string | null; strike: number | null; optionType: 'CE' | 'PE' | null;
} {
  const tail = String(symbol ?? '').trim().split('|').pop()!.split(':').pop()!;
  const match = tail.toUpperCase().match(new RegExp(`^([A-Z]+?)(\\d{2})(${MONTH_NAMES})(\\d+(?:\\.\\d+)?)(CE|PE)$`));
  if (!match) {
    // The other documented broker order puts the right BEFORE the date and spells
    // the year out: UNDERLYING + STRIKE + CE|PE + DD + MON + YY (Upstox BSE F&O
    // trading symbols, e.g. SENSEX73900CE17SEP26). Still not a guess: every part is
    // present in the symbol, and an unparseable tail stays null.
    const alternate = tail.toUpperCase().match(new RegExp(`^([A-Z]+?)(\\d+(?:\\.\\d+)?)(CE|PE)(\\d{2})(${MONTH_NAMES})(\\d{2})$`));
    if (!alternate) return { underlying: null, expiry: null, strike: null, optionType: null };
    const alternateStrike = Number(alternate[2]);
    return {
      underlying: alternate[1],
      expiry: `20${alternate[6]}-${MARKET_MONTHS[alternate[5]]}-${alternate[4]}`,
      strike: Number.isFinite(alternateStrike) ? alternateStrike : null,
      optionType: alternate[3] as 'CE' | 'PE',
    };
  }
  const strike = Number(match[4]);
  const day = match[2].padStart(2, '0');
  const month = MARKET_MONTHS[match[3]];
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  let year = now.getUTCFullYear();
  if (Date.parse(`${year}-${month}-${day}T00:00:00Z`) < today) year += 1;
  return {
    underlying: match[1],
    expiry: `${year}-${month}-${day}`,
    strike: Number.isFinite(strike) ? strike : null,
    optionType: match[5] as 'CE' | 'PE',
  };
}

/**
 * Canonical identity for every provider's form of the same instrument:
 *   NSE:NIFTY26SEP23000PE | NSE_FO|NIFTY26SEP23000PE | NIFTY26SEP23000PE (+exchange
 *   NSE)                        -> NSE:NIFTY26SEP23000PE
 *   NSE:NIFTY50-INDEX | NSE_INDEX|Nifty 50 -> NSE:NIFTY50
 * A numeric broker token carries no identity of its own: it is returned verbatim
 * and the caller must resolve it first (never guessed).
 */
export function canonicalInstrumentKey(symbolOrId: unknown, exchange?: unknown): string | null {
  const source = String(symbolOrId ?? '').trim();
  if (!source) return null;
  const head = source.includes('|') ? source.split('|')[0] : source.includes(':') ? source.split(':')[0] : '';
  const declaredExchange = String(exchange ?? '').trim().toUpperCase() || (head ? head.split('_')[0] : '');
  const tailRaw = source.split('|').pop()!.split(':').pop()!.trim().toUpperCase();
  if (!tailRaw) return null;
  if (/^\d+$/.test(tailRaw)) return tailRaw; // unresolved token — caller's problem, never a guess
  const tail = tailRaw.replace(/-INDEX$/, '').replace(/-EQ$/, '').replace(/\s+/g, '');
  return declaredExchange ? `${declaredExchange}:${tail}` : tail;
}

/**
 * The canonical SYMBOL form for an option contract, rebuilt from the contract's
 * own fields: `EXCHANGE:UNDERLYING + DD + MON + STRIKE + CE|PE`.
 *
 * Brokers spell the same contract differently — Upstox writes
 * `SENSEX73900CE17SEP26`, FYERS writes `SENSEX17SEP73900CE` — so a key taken from
 * the provider's own symbol text is NOT comparable across providers. Rebuilding it
 * from underlying/expiry/strike/right gives BOTH providers the same canonical key
 * (this is what makes one contract one identity). NSE/BSE symbology carries no
 * year, so the canonical key carries none either.
 */
export function canonicalOptionSymbol(
  exchange: string | null | undefined,
  underlying: string | null | undefined,
  expiry: string | null | undefined,
  strike: number | null | undefined,
  optionType: 'CE' | 'PE' | null | undefined,
): string | null {
  const name = String(underlying ?? '').trim().toUpperCase();
  const exchangeName = String(exchange ?? '').trim().toUpperCase();
  if (!name || !exchangeName || strike === null || strike === undefined || !Number.isFinite(Number(strike)) || !optionType) return null;
  const iso = String(expiry ?? '').trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!iso) return null;
  const month = Object.entries(MARKET_MONTHS).find(([, m]) => m === iso[2])?.[0];
  if (!month) return null;
  return `${exchangeName}:${name}${iso[3]}${month}${Number(strike)}${optionType}`;
}

/** Index/equity/option classification from the identity text alone. */
export function classifyInstrument(instrumentKey: string, declared?: unknown): InstrumentType {
  const declaredType = String(declared ?? '').trim().toUpperCase();
  // Brokers declare option-ness differently: FYERS/Upstox 'OPT', Kite 'CE'/'PE'.
  if (declaredType.startsWith('OPT') || ['CE', 'PE', 'CALL', 'PUT'].includes(declaredType)) return 'OPTION';
  if (declaredType.startsWith('FUT')) return 'FUTURE';
  if (declaredType.startsWith('IDX') || declaredType === 'INDEX') return 'INDEX';
  if (declaredType.startsWith('EQ')) return 'EQUITY';
  const tail = instrumentKey.split(':').pop() ?? instrumentKey;
  if (/(CE|PE)$/.test(tail)) return 'OPTION';
  // The alternate broker order puts the right before the date: SENSEX73900CE17SEP26.
  if (/\d(CE|PE)\d{2}[A-Z]{3}\d{2}$/.test(tail)) return 'OPTION';
  if (/(FUT)$/.test(tail)) return 'FUTURE';
  if (/INDEX|^NIFTY50$|^SENSEX$|^BANKNIFTY$/.test(tail.replace(/[^A-Z0-9]/g, ''))) return 'INDEX';
  return 'UNKNOWN';
}

/** A quote time is not a last-trade time: both are normalized, neither is faked. */
export function parseSourceTimestamp(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number' || /^\d+$/.test(String(value).trim())) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    // Broker epoch stamps are seconds (< 1e11) or milliseconds.
    const ms = numeric < 1e11 ? numeric * 1_000 : numeric;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

const num = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** Was the field actually SENT? (0 is a value; absent is not.) */
const present = (value: unknown): boolean => value !== null && value !== undefined && value !== '';

const reject = (code: RejectionCode, reason: string, source: string): TickRejection => ({
  ok: false, code, reason, source,
});

/**
 * Bounded, provider-neutral dump of the timestamp-ish fields a record carries —
 * the evidence needed to judge a STALE/FUTURE rejection at the source (was the
 * provider replaying a closed-market tick, or is a quiet contract's last-trade
 * time being read as its quote time?). Never dumps the whole payload.
 */
export function describeRecordTimestamps(raw: unknown): string {
  if (raw === null || raw === undefined) return '(no payload)';
  if (typeof raw !== 'object') return String(raw).slice(0, 48);
  const parts: string[] = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/time|ts$|date|stamp|epoch/i.test(key)) continue;
    if (value === null || value === undefined || typeof value === 'object') continue;
    parts.push(`${key}=${String(value).slice(0, 22)}`);
    if (parts.length >= 6) break;
  }
  return parts.join(' ') || '(record carries no timestamp field)';
}

/**
 * Deterministically turn a provider observation into a canonical tick, or reject
 * it. Pure: same inputs ⇒ same output (receivedAt is passed in, never read here).
 */
export function interpretObservation(
  source: string,
  observation: RawObservation,
  receivedAt: Date,
  budgets: TickBudgets = DEFAULT_TICK_BUDGETS,
): InterpreterResult {
  const name = String(source ?? '').trim().toUpperCase();
  if (!name) return reject('SCHEMA', 'source identity is required', String(source ?? ''));
  if (!observation || typeof observation !== 'object') {
    return reject('SCHEMA', 'payload did not map to an observation', name);
  }

  // Identity comes from the SYMBOL when the provider sends one (Kite sends only a
  // token plus a resolved symbol); the broker's own key/token stays as provenance.
  const instrumentKey = canonicalInstrumentKey(
    observation.providerSymbol || observation.providerInstrumentId,
    observation.exchange,
  );
  if (!instrumentKey) return reject('UNRESOLVED_INSTRUMENT', 'no instrument identity in payload', name);

  const parsed = parseOptionSymbol(instrumentKey, receivedAt);
  const instrumentType = classifyInstrument(instrumentKey, observation.instrumentType);
  const optionType = normalizeOptionType(observation.optionType) ?? parsed.optionType;
  const strike = num(observation.strike) ?? parsed.strike;
  const expiry = normalizeExpiry(observation.expiry) ?? parsed.expiry;
  // For an OPTION the contract's own SYMBOL is the strongest identity evidence:
  // brokers spell the same contract differently and a desk's own label is not the
  // exchange's underlying name, so the parsed underlying wins where it exists.
  const declaredUnderlying = String(observation.underlying ?? '').trim().toUpperCase();
  const underlying = instrumentType === 'OPTION'
    ? parsed.underlying ?? declaredUnderlying ?? null
    : declaredUnderlying || parsed.underlying || null;
  // Segment: what the provider declares, else the definitional consequence of the
  // instrument type (an option/future IS an F&O contract) — never a guess.
  const declaredSegment = String(observation.segment ?? '').trim().toUpperCase();
  const exchange = String(observation.exchange ?? '').trim().toUpperCase() || instrumentKey.split(':')[0] || null;
  const segment =
    declaredSegment ||
    (instrumentType === 'OPTION' || instrumentType === 'FUTURE'
      ? 'FO'
      : instrumentType === 'INDEX'
        ? 'INDEX'
        : instrumentType === 'EQUITY'
          ? 'EQ'
          : null);
  // ONE identity per contract across providers: rebuild the option key from the
  // contract's own fields (see canonicalOptionSymbol) instead of keeping whichever
  // spelling the provider happened to send.
  const canonicalKey = instrumentType === 'OPTION' ? canonicalOptionSymbol(exchange, underlying, expiry, strike, optionType) : null;
  const effectiveKey = canonicalKey ?? instrumentKey;

  // An OPTION without its identity parts cannot be placed on a chain: reject
  // rather than persist a contract that desks would have to guess about.
  if (instrumentType === 'OPTION' && (!expiry || strike === null || !optionType)) {
    return reject('SCHEMA', `option ${effectiveKey} is missing expiry/strike/right`, name);
  }

  const ltp = num(observation.ltp);
  const bid = num(observation.bid);
  const ask = num(observation.ask);
  const bidQty = num(observation.bidQty);
  const askQty = num(observation.askQty);
  const volume = num(observation.volume);
  const oi = num(observation.oi);
  const previousOi = num(observation.previousOi);
  const changeOi = num(observation.changeOi);
  const iv = num(observation.iv);

  if (!present(observation.ltp) && !present(observation.bid) && !present(observation.ask)) {
    return reject('INVALID_VALUE', 'no price in payload (ltp/bid/ask all absent)', name);
  }
  for (const [field, value] of [['ltp', ltp], ['bid', bid], ['ask', ask]] as const) {
    if (value !== null && value <= 0) {
      return reject('IMPOSSIBLE_VALUE', `${field} must be > 0 (got ${value})`, name);
    }
  }
  for (const [field, value] of [['volume', volume], ['oi', oi], ['previousOi', previousOi], ['bidQty', bidQty], ['askQty', askQty]] as const) {
    if (value !== null && value < 0) {
      return reject('IMPOSSIBLE_VALUE', `${field} cannot be negative (got ${value})`, name);
    }
  }
  if (strike !== null && strike <= 0) return reject('IMPOSSIBLE_VALUE', `strike must be > 0 (got ${strike})`, name);
  if (bid !== null && ask !== null && bid > ask) {
    return reject('IMPOSSIBLE_VALUE', `crossed book: bid ${bid} > ask ${ask}`, name);
  }

  const sourceTimestamp = parseSourceTimestamp(observation.sourceTimestamp);
  if (observation.sourceTimestamp !== null && observation.sourceTimestamp !== undefined && !sourceTimestamp) {
    return reject('INVALID_TIMESTAMP', `unparseable source timestamp: ${String(observation.sourceTimestamp)}`, name);
  }
  const kind: TickSourceSemantics = observation.sourceTimestampSemantics ?? 'QUOTE';
  const effectiveSourceTs = sourceTimestamp ?? receivedAt;
  const sourceLagMs = sourceTimestamp ? receivedAt.getTime() - sourceTimestamp.getTime() : null;

  if (sourceTimestamp) {
    if (sourceLagMs! < -budgets.maxFutureSkewMs) {
      return reject('FUTURE_TIMESTAMP', `source timestamp is ${Math.round(-sourceLagMs!)}ms in the future; record timestamps: ${describeRecordTimestamps(observation.raw)}`, name);
    }
    const budget = kind === 'LAST_TRADE' ? budgets.maxLastTradeAgeMs : budgets.maxQuoteLagMs;
    if (sourceLagMs! > budget) {
      return reject('STALE', `${kind} tick is ${Math.round(sourceLagMs! / 1000)}s old (> ${Math.round(budget / 1000)}s budget); record timestamps: ${describeRecordTimestamps(observation.raw)}`, name);
    }
  }

  return {
    ok: true,
    tick: {
      instrumentKey: effectiveKey,
      source: name,
      providerInstrumentId: String(observation.providerInstrumentId ?? observation.providerSymbol ?? instrumentKey).trim(),
      underlying,
      exchange,
      segment,
      instrumentType,
      expiry,
      strike,
      optionType,
      ltp,
      bid,
      ask,
      bidQty,
      askQty,
      volume,
      oi,
      previousOi,
      changeOi,
      iv,
      delta: num(observation.delta),
      gamma: num(observation.gamma),
      theta: num(observation.theta),
      vega: num(observation.vega),
      open: num(observation.open),
      high: num(observation.high),
      low: num(observation.low),
      close: num(observation.close),
      depth: observation.depth ?? null,
      sourceTimestamp,
      sourceTimestampKind: kind,
      receivedTimestamp: receivedAt,
      sourceLagMs: sourceTimestamp ? Math.max(0, sourceLagMs!) : null,
      latencyWithinBudget: sourceTimestamp === null || Math.max(0, sourceLagMs!) <= budgets.latencyBudgetMs,
      dataQuality: 'GOOD',
      raw: observation.raw,
      rawPayloadHash: observation.rawPayloadHash ?? payloadHash(observation.raw),
    },
  };
}
