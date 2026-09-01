import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FnfMarketSnapshot } from './fnf-market-snapshot.entity';
import { filterMarketSnapshots, MarketSnapshotFilters } from './market-data-filter';

export type MarketSnapshotQuery = MarketSnapshotFilters & {
  limit: number;
};

const numberParam = (value: string | undefined, name: string): number | undefined => {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new BadRequestException(`${name} must be a finite number`);
  return parsed;
};

const dateParam = (value: string | undefined, name: string): Date | undefined => {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new BadRequestException(`${name} must be a valid ISO date`);
  return parsed;
};

const boolParam = (value: string | undefined): boolean => /^(1|true|yes|on)$/i.test(value ?? '');

@Injectable()
export class MarketDataInspectionService {
  constructor(
    @InjectRepository(FnfMarketSnapshot)
    private readonly snapshots: Repository<FnfMarketSnapshot>,
  ) {}

  parseQuery(query: Record<string, string | undefined>): MarketSnapshotQuery {
    const rawLimit = numberParam(query.limit, 'limit');
    const limit = Math.max(1, Math.min(500, Math.trunc(rawLimit ?? 100)));
    const ohlc = query.ohlc === 'complete' || query.ohlc === 'partial' || query.ohlc === 'missing'
      ? query.ohlc
      : undefined;
    return {
      instrument: query.instrument?.trim() || undefined,
      from: dateParam(query.from, 'from'),
      to: dateParam(query.to, 'to'),
      minPrice: numberParam(query.minPrice, 'minPrice'),
      maxPrice: numberParam(query.maxPrice, 'maxPrice'),
      minVolume: numberParam(query.minVolume, 'minVolume'),
      maxVolume: numberParam(query.maxVolume, 'maxVolume'),
      ohlc,
      latestOnly: boolParam(query.latestOnly),
      limit,
    };
  }

  async find(query: MarketSnapshotQuery): Promise<{
    rows: FnfMarketSnapshot[];
    total: number;
    hasMore: boolean;
    filters: Omit<MarketSnapshotQuery, 'from' | 'to'> & { from?: string; to?: string };
  }> {
    if (query.from && query.to && query.from > query.to) {
      throw new BadRequestException('from must be earlier than or equal to to');
    }
    if (query.minPrice !== undefined && query.maxPrice !== undefined && query.minPrice > query.maxPrice) {
      throw new BadRequestException('minPrice must be less than or equal to maxPrice');
    }
    if (query.minVolume !== undefined && query.maxVolume !== undefined && query.minVolume > query.maxVolume) {
      throw new BadRequestException('minVolume must be less than or equal to maxVolume');
    }

    // Bound the DB read. latestOnly needs more than one row per instrument;
    // the cap prevents an accidental unbounded history scan from the UI.
    const readLimit = Math.min(10_000, Math.max(query.limit * (query.latestOnly ? 10 : 1), query.limit));
    const builder = this.snapshots.createQueryBuilder('s').orderBy('s.ts', 'DESC').take(readLimit);
    if (query.instrument) builder.andWhere('LOWER(s.instrument) LIKE LOWER(:instrument)', { instrument: `%${query.instrument}%` });
    if (query.from) builder.andWhere('s.ts >= :from', { from: query.from });
    if (query.to) builder.andWhere('s.ts <= :to', { to: query.to });
    if (query.minPrice !== undefined) builder.andWhere('s.price >= :minPrice', { minPrice: query.minPrice });
    if (query.maxPrice !== undefined) builder.andWhere('s.price <= :maxPrice', { maxPrice: query.maxPrice });
    if (query.minVolume !== undefined) builder.andWhere('s.volume >= :minVolume', { minVolume: query.minVolume });
    if (query.maxVolume !== undefined) builder.andWhere('s.volume <= :maxVolume', { maxVolume: query.maxVolume });

    const candidates = await builder.getMany();
    const matches = filterMarketSnapshots(candidates, query);
    const rows = matches.slice(0, query.limit);
    return {
      rows,
      total: matches.length,
      hasMore: matches.length > rows.length,
      filters: {
        ...query,
        from: query.from?.toISOString(),
        to: query.to?.toISOString(),
      },
    };
  }
}
