import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FnfOptionContract } from './fnf-option-contract.entity';
import { FnfOptionQuote } from './fnf-option-quote.entity';
import { UnifiedMarketDataService } from './unified-market-data/unified-market-data.service';
import { UnifiedOptionQuote } from './unified-market-data/unified-option-quote.entity';
import { normalizeOptionContract, normalizeOptionQuote, OptionContract } from './option-chain-parser';

const asNumberOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/**
 * Last segment of any broker/either-convention instrument key:
 * 'NSE:NIFTY26SEP23900CE' | 'BSE_INDEX|SENSEX26SEP74000PE' | 'NSE_FO|12345' →
 * the trailing symbol part. Producers differ in key shape (FYERS prefixes the
 * exchange, Upstox uses an index/token key), so symbol comparison is always
 * done on this tail.
 */
export const symbolKey = (value: unknown): string =>
  String(value ?? '')
    .trim()
    .split('|')
    .pop()!
    .split(':')
    .pop()!
    .trim()
    .toUpperCase();

/**
 * Producer-independent identity of one option contract: underlying + expiry +
 * strike + right. Lets an observation from ANOTHER feed be matched to this
 * desk's registered contract even when the instrument keys differ in shape.
 * Returns '' when the row lacks the metadata to be matched safely.
 */
export const contractMatchKey = (row: {
  underlying?: unknown;
  expiry?: unknown;
  strike?: unknown;
  optionType?: unknown;
}): string => {
  const underlying = String(row?.underlying ?? '').trim().toUpperCase();
  const expiry = String(row?.expiry ?? '').trim().slice(0, 10);
  const strike = Number(row?.strike);
  const optionType = String(row?.optionType ?? '').trim().toUpperCase().slice(0, 2);
  if (!underlying || !expiry || !Number.isFinite(strike) || !optionType) return '';
  return `${underlying}|${expiry}|${strike}|${optionType}`;
};

/**
 * Map a COMMON-store observation onto the chain-row shape the FnF readers
 * expect (candidate builder, position pricing, chain page). Pure + exported so
 * scripts/fnf-shared-quote-fallback.test.js can exercise it without DI.
 *
 * Provenance is preserved exactly: `provider` carries the TRUE producer
 * (FYERS_LIVE / UPSTOX_LIVE), never this desk's name — a consumer must never
 * relabel another producer's tick as its own (brief s12).
 */
export const sharedQuoteToChainRow = (
  row: UnifiedOptionQuote,
  symbolHint?: string | null,
): FnfOptionQuote => {
  const instrumentKey = String(row?.instrumentKey ?? '').trim();
  const symbol = String(symbolHint ?? symbolKey(instrumentKey)).trim().toUpperCase();
  const received = row?.receivedTimestamp ?? row?.ts ?? new Date();
  const ts = received instanceof Date ? received : new Date(String(received));
  return {
    id: `shared:${String(row?.id ?? instrumentKey)}`,
    contractSymbol: symbol,
    underlying: String(row?.underlying ?? '').trim().toUpperCase(),
    expiry: String(row?.expiry ?? '').trim().slice(0, 10),
    strike: asNumberOrNull(row?.strike) ?? 0,
    optionType: String(row?.optionType ?? '').trim().toUpperCase().slice(0, 2),
    ltp: asNumberOrNull(row?.ltp) ?? 0,
    bid: asNumberOrNull(row?.bid),
    ask: asNumberOrNull(row?.ask),
    volume: asNumberOrNull(row?.volume) ?? 0,
    openInterest: asNumberOrNull(row?.oi) ?? 0,
    impliedVolatility: asNumberOrNull(row?.iv),
    delta: asNumberOrNull(row?.delta),
    gamma: asNumberOrNull(row?.gamma),
    theta: asNumberOrNull(row?.theta),
    vega: asNumberOrNull(row?.vega),
    provider: String(row?.source ?? 'COMMON_STORE').trim().toUpperCase(),
    ts: Number.isNaN(ts.getTime()) ? new Date() : ts,
    createdAt: Number.isNaN(ts.getTime()) ? new Date() : ts,
  } as unknown as FnfOptionQuote;
};

export type OptionChainQuery = {
  symbol?: string;
  underlying?: string;
  expiry?: string;
  optionType?: 'CE' | 'PE';
  latestOnly?: boolean;
  limit: number;
};

/** One registered option contract, reduced to what the read path needs. */
export type RegisteredContract = {
  symbol: string;
  underlying: string;
  expiry: string;
  strike: number;
  optionType: string;
};

const limitParam = (value: string | undefined): number => {
  if (!value?.trim()) return 100;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new BadRequestException('limit must be a finite number');
  return Math.max(1, Math.min(500, Math.trunc(parsed)));
};

const boolParam = (value: string | undefined): boolean => /^(1|true|yes|on)$/i.test(value ?? '');

@Injectable()
export class FnfOptionChainService {
  private readonly logger = new Logger(FnfOptionChainService.name);
  /**
   * Read-path failover onto the COMMON normalized store (brief s2/s4/s12).
   * ON by default: when this desk's own broker feed has no fresh quote for an
   * instrument, the engine consumes the authoritative observation produced by
   * whichever OTHER feed is live, instead of treating the instrument as
   * unquoted. FNO_SHARED_QUOTE_FALLBACK=false keeps the read path purely local.
   */
  private readonly sharedFallbackEnabled: boolean;
  /** A local quote older than this is superseded by a fresher shared one. */
  private readonly sharedFallbackAfterMs: number;
  /** Max age accepted for a shared (other-producer) observation. */
  private readonly sharedFallbackMaxAgeMs: number;
  /** Registered contracts (symbol + match metadata), cached. */
  private contractsCache: { at: number; rows: RegisteredContract[] } | null = null;
  private readonly contractsCacheMs: number;
  private sharedFallbackLogAt = 0;

  constructor(
    @InjectRepository(FnfOptionContract)
    private readonly contracts: Repository<FnfOptionContract>,
    @InjectRepository(FnfOptionQuote)
    private readonly quotes: Repository<FnfOptionQuote>,
    private readonly unified?: UnifiedMarketDataService,
  ) {
    this.sharedFallbackEnabled = (process.env.FNO_SHARED_QUOTE_FALLBACK ?? 'true').toLowerCase() !== 'false';
    this.sharedFallbackAfterMs = Math.max(1_000, Number(process.env.FNO_SHARED_FALLBACK_AFTER_MS ?? 60_000));
    this.sharedFallbackMaxAgeMs = Math.max(1_000, Number(process.env.FNO_SHARED_QUOTE_MAX_AGE_MS ?? 60_000));
    this.contractsCacheMs = Math.max(30_000, Number(process.env.FNO_UNIVERSE_CACHE_MS ?? 300_000));
  }

  parseQuery(query: Record<string, string | undefined>): OptionChainQuery {
    const optionType = query.optionType?.trim().toUpperCase();
    if (optionType && optionType !== 'CE' && optionType !== 'PE') {
      throw new BadRequestException('optionType must be CE or PE');
    }
    return {
      symbol: query.symbol?.trim() || undefined,
      underlying: query.underlying?.trim().toUpperCase() || undefined,
      expiry: query.expiry?.trim() || undefined,
      optionType: optionType as 'CE' | 'PE' | undefined,
      latestOnly: boolParam(query.latestOnly),
      limit: limitParam(query.limit),
    };
  }

  async upsertContract(input: unknown): Promise<FnfOptionContract> {
    const contract = normalizeOptionContract(input);
    if (!contract) throw new BadRequestException('invalid option contract metadata');
    const existing = await this.contracts.findOne({ where: { symbol: contract.symbol } });
    const entity = this.contracts.create({
      ...(existing ?? {}),
      ...contract,
    });
    const saved = await this.contracts.save(entity);
    this.contractsCache = null; // a new contract/underlying may exist now
    return saved;
  }

  async ingestQuote(input: unknown): Promise<FnfOptionQuote> {
    const value = input !== null && typeof input === 'object' ? input as Record<string, unknown> : {};
    const symbol = String(value.contractSymbol ?? '').trim();
    if (!symbol) throw new BadRequestException('contractSymbol is required');
    const contract = await this.contracts.findOne({ where: { symbol } });
    if (!contract) throw new NotFoundException(`option contract ${symbol} is not registered`);
    const normalizedContract: OptionContract = {
      symbol: contract.symbol,
      underlying: contract.underlying,
      expiry: contract.expiry,
      strike: Number(contract.strike),
      optionType: contract.optionType as 'CE' | 'PE',
      lotSize: Number(contract.lotSize),
      tickSize: Number(contract.tickSize),
    };
    const quote = normalizeOptionQuote(input, normalizedContract);
    if (!quote) throw new BadRequestException('invalid option quote');
    return this.quotes.save(this.quotes.create(quote));
  }

  async findContractBySymbol(symbol: string): Promise<FnfOptionContract | null> {
    if (!symbol?.trim()) return null;
    return this.contracts.findOne({ where: { symbol: symbol.trim() } });
  }

  /** All registered contracts (used by the signal engine as the tradable universe). */
  async listAllContracts(): Promise<FnfOptionContract[]> {
    return this.contracts.find({ order: { underlying: 'ASC', expiry: 'ASC', strike: 'ASC' } });
  }

  /** Get the most recent quote for a contract symbol. */
  async getLatestQuote(symbol: string): Promise<FnfOptionQuote | null> {
    const rows = await this.quotes.find({ where: { contractSymbol: symbol }, order: { ts: 'DESC' }, take: 1 });
    return rows[0] ?? null;
  }

  async listContracts(query: Record<string, string | undefined> = {}): Promise<FnfOptionContract[]> {
    const parsed = this.parseQuery(query);
    const builder = this.contracts.createQueryBuilder('c').orderBy('c.underlying', 'ASC').addOrderBy('c.expiry', 'ASC').addOrderBy('c.strike', 'ASC').take(parsed.limit);
    if (parsed.symbol) builder.andWhere('LOWER(c.symbol) LIKE LOWER(:symbol)', { symbol: `%${parsed.symbol}%` });
    if (parsed.underlying) builder.andWhere('c.underlying = :underlying', { underlying: parsed.underlying });
    if (parsed.expiry) builder.andWhere('c.expiry = :expiry', { expiry: parsed.expiry });
    if (parsed.optionType) builder.andWhere('c.optionType = :optionType', { optionType: parsed.optionType });
    return builder.getMany();
  }

  async findChain(query: OptionChainQuery): Promise<{
    rows: FnfOptionQuote[];
    total: number;
    hasMore: boolean;
    filters: OptionChainQuery;
  }> {
    if (query.expiry && !/^\d{4}-\d{2}-\d{2}$/.test(query.expiry)) {
      throw new BadRequestException('expiry must be YYYY-MM-DD');
    }
    const builder = this.quotes.createQueryBuilder('q').orderBy('q.ts', 'DESC').take(Math.min(10_000, query.limit * (query.latestOnly ? 10 : 1)));
    if (query.symbol) builder.andWhere('LOWER(q.contractSymbol) LIKE LOWER(:symbol)', { symbol: `%${query.symbol}%` });
    if (query.underlying) builder.andWhere('q.underlying = :underlying', { underlying: query.underlying });
    if (query.expiry) builder.andWhere('q.expiry = :expiry', { expiry: query.expiry });
    if (query.optionType) builder.andWhere('q.optionType = :optionType', { optionType: query.optionType });
    const [candidates, total] = await builder.getManyAndCount();
    const rows = query.latestOnly
      ? [...new Map(candidates.map((quote) => [quote.contractSymbol, quote])).values()].slice(0, query.limit)
      : candidates.slice(0, query.limit);
    const merged = await this.withSharedQuotes(rows, query);
    return { rows: merged, total, hasMore: total > merged.length, filters: query };
  }

  /**
   * Registered contracts (symbol + match metadata), cached — cheap on a 10s
   * engine tick. Drives both the arbitrated universes and symbol resolution
   * for observations produced by another feed.
   */
  private async registeredContracts(): Promise<RegisteredContract[]> {
    if (this.contractsCache && Date.now() - this.contractsCache.at <= this.contractsCacheMs) {
      return this.contractsCache.rows;
    }
    try {
      const raw = await this.contracts
        .createQueryBuilder('c')
        .select('c.symbol', 'symbol')
        .addSelect('c.underlying', 'underlying')
        .addSelect('c.expiry', 'expiry')
        .addSelect('c.strike', 'strike')
        .addSelect('c.optionType', 'optionType')
        .getRawMany<{ symbol: string; underlying: string; expiry: string; strike: string; optionType: string }>();
      const rows: RegisteredContract[] = raw
        .map((r) => ({
          symbol: String(r?.symbol ?? '').trim(),
          underlying: String(r?.underlying ?? '').trim().toUpperCase(),
          expiry: String(r?.expiry ?? '').trim().slice(0, 10),
          strike: Number(r?.strike),
          optionType: String(r?.optionType ?? '').trim().toUpperCase().slice(0, 2),
        }))
        .filter((r) => r.symbol && r.underlying && r.expiry && Number.isFinite(r.strike) && r.optionType);
      this.contractsCache = { at: Date.now(), rows };
      return rows;
    } catch (error) {
      this.logger.warn(`registeredContracts lookup failed: ${(error as Error).message}`);
      return this.contractsCache?.rows ?? [];
    }
  }

  /**
   * Overlay the COMMON normalized store on a latest-only chain read (brief
   * s2/s4/s12). The engine wants the freshest observation OF AN INSTRUMENT; when
   * this desk's own broker feed has nothing fresh for a universe, that
   * observation is served by whichever other feed is producing it, so source
   * selection is per instrument and the engine is not coupled to one broker.
   *
   * Never invents data: only real rows from unified_option_quotes (or this
   * process's own ingest cache) within sharedFallbackMaxAgeMs qualify, each
   * carrying its true `provider`. Ours wins unless the shared observation is
   * strictly newer. History/latest=false reads are never altered.
   */
  private async withSharedQuotes(rows: FnfOptionQuote[], query: OptionChainQuery): Promise<FnfOptionQuote[]> {
    if (!this.sharedFallbackEnabled || !query.latestOnly || !this.unified) return rows;
    const now = Date.now();
    const ageOf = (row: FnfOptionQuote): number => {
      const at = new Date(row.ts).getTime();
      return Number.isNaN(at) ? Number.POSITIVE_INFINITY : now - at;
    };
    const contracts = await this.registeredContracts();
    const universes = (query.underlying ? [query.underlying] : [...new Set(contracts.map((c) => c.underlying))])
      .map((u) => String(u).trim().toUpperCase())
      .filter(Boolean);
    // Only universes where our own producer has nothing fresh are worth a read.
    const needed = universes.filter((universe) => {
      const mine = rows.filter((r) => String(r.underlying ?? '').toUpperCase() === universe);
      return mine.length === 0 || mine.every((r) => ageOf(r) > this.sharedFallbackAfterMs);
    });
    if (!needed.length) return rows;

    // Registered symbol per contract identity, so a foreign observation is
    // presented under the symbol THIS desk's callers look up.
    const symbolOf = new Map<string, string>();
    for (const contract of contracts) {
      const key = contractMatchKey(contract);
      if (key && !symbolOf.has(key)) symbolOf.set(key, contract.symbol);
    }
    const sharedBySymbol = new Map<string, FnfOptionQuote>();
    const sharedByContract = new Map<string, FnfOptionQuote>();
    for (const universe of needed) {
      let found: UnifiedOptionQuote[] = [];
      try {
        found = await this.unified.sharedQuotesForUnderlying(universe, { maxAgeMs: this.sharedFallbackMaxAgeMs });
      } catch (error) {
        this.logger.warn(`shared quote fallback failed for ${universe}: ${(error as Error).message}`);
        continue;
      }
      for (const row of found) {
        const tail = symbolKey(row.instrumentKey);
        if (!tail) continue;
        const key = contractMatchKey(row);
        const symbol = (key && symbolOf.get(key)) || tail;
        if (query.symbol && !symbolKey(symbol).includes(symbolKey(query.symbol))) continue;
        const mapped = sharedQuoteToChainRow(row, symbol);
        sharedBySymbol.set(symbolKey(symbol), mapped);
        if (key) sharedByContract.set(key, mapped);
      }
    }
    if (!sharedBySymbol.size) return rows;

    const merged = new Map<string, FnfOptionQuote>();
    const mergedContracts = new Set<string>();
    let substituted = 0;
    for (const row of rows) {
      const key = contractMatchKey(row);
      const candidate =
        sharedBySymbol.get(symbolKey(row.contractSymbol)) ?? (key ? sharedByContract.get(key) : undefined);
      // Our own row wins unless the shared observation is strictly newer.
      if (candidate && new Date(candidate.ts).getTime() > new Date(row.ts).getTime()) {
        merged.set(symbolKey(row.contractSymbol), candidate);
        substituted += 1;
      } else {
        merged.set(symbolKey(row.contractSymbol), row);
      }
      if (key) mergedContracts.add(key);
    }
    // Fill instruments the local store has nothing for at all (full failover).
    // Only instruments this desk actually trades are introduced.
    for (const [key, candidate] of sharedByContract) {
      if (mergedContracts.has(key)) continue;
      if (!query.symbol && !symbolOf.has(key)) continue;
      merged.set(symbolKey(candidate.contractSymbol), candidate);
      mergedContracts.add(key);
      substituted += 1;
    }
    if (!substituted) return rows;
    if (now - this.sharedFallbackLogAt > 300_000) {
      this.sharedFallbackLogAt = now;
      this.logger.log(
        `[FNF][MARKET_DATA] ${substituted} quote(s) read from the COMMON store (${needed.join(', ')}) — local producer has nothing fresh; per-row provenance kept`,
      );
    }
    return [...merged.values()]
      .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
      .slice(0, query.limit);
  }

  /** Load explicit provider metadata from JSON configuration without retaining credentials. */
  configuredContracts(raw = process.env.FNO_OPTION_CONTRACTS): OptionContract[] {
    if (!raw?.trim()) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.map(normalizeOptionContract).filter((value): value is OptionContract => value !== null);
    } catch {
      return [];
    }
  }
}
