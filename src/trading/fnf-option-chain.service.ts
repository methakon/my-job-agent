import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FnfOptionContract } from './fnf-option-contract.entity';
import { FnfOptionQuote } from './fnf-option-quote.entity';
import { normalizeOptionContract, normalizeOptionQuote, OptionContract } from './option-chain-parser';

export type OptionChainQuery = {
  symbol?: string;
  underlying?: string;
  expiry?: string;
  optionType?: 'CE' | 'PE';
  latestOnly?: boolean;
  limit: number;
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
  constructor(
    @InjectRepository(FnfOptionContract)
    private readonly contracts: Repository<FnfOptionContract>,
    @InjectRepository(FnfOptionQuote)
    private readonly quotes: Repository<FnfOptionQuote>,
  ) {}

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
    return this.contracts.save(entity);
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
    return { rows, total, hasMore: total > rows.length, filters: query };
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
