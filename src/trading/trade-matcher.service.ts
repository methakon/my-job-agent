import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Brackets, Raw } from 'typeorm';
import { FnfOptionQuote } from './fnf-option-quote.entity';
import { FnfMarketSnapshot } from './fnf-market-snapshot.entity';
import { TradeBookImport } from './trade-book.entity';
import { SandboxTick } from './sandbox-tick.entity';

/**
 * Trade matcher - matches imported trades against stored market data.
 * 
 * This service does NOT reconstruct market state - it only reports
 * whether market data existed at the trade's entry/exit times.
 */
@Injectable()
export class TradeMatcherService {
  private readonly logger = new Logger(TradeMatcherService.name);

  constructor(
    @InjectRepository(TradeBookImport)
    private readonly tradeBookRepo: Repository<TradeBookImport>,
    @InjectRepository(FnfOptionQuote)
    private readonly optionQuoteRepo: Repository<FnfOptionQuote>,
    @InjectRepository(FnfMarketSnapshot)
    private readonly marketSnapshotRepo: Repository<FnfMarketSnapshot>,
    @InjectRepository(SandboxTick)
    private readonly sandboxTickRepo: Repository<SandboxTick>,
  ) {}

  /**
   * Match a single trade against market data
   * @returns match details including quality and method
   */
  async matchTrade(trade: TradeBookImport): Promise<{
    matchStatus: 'MATCHED_EXACT' | 'MATCHED_SYMBOL_TIME' | 'MATCHED_CONTRACT_TIME' | 'PARTIAL' | 'NO_MATCH';
    matchMethod: string;
    entryDataFound: boolean;
    exitDataFound: boolean;
    timeDifferenceMs: number | null;
    dataCoverage: 'full' | 'partial' | 'minimal' | 'none';
    tickCount: number;
    quoteCount: number;
    underlyingSnapshots: number;
  }> {
    const matchResult: {
      matchStatus: 'MATCHED_EXACT' | 'MATCHED_SYMBOL_TIME' | 'MATCHED_CONTRACT_TIME' | 'PARTIAL' | 'NO_MATCH';
      matchMethod: string;
      entryDataFound: boolean;
      exitDataFound: boolean;
      timeDifferenceMs: number | null;
      dataCoverage: 'full' | 'partial' | 'minimal' | 'none';
      tickCount: number;
      quoteCount: number;
      underlyingSnapshots: number;
    } = {
      matchStatus: 'NO_MATCH',
      matchMethod: 'none',
      entryDataFound: false,
      exitDataFound: false,
      timeDifferenceMs: null,
      dataCoverage: 'none',
      tickCount: 0,
      quoteCount: 0,
      underlyingSnapshots: 0,
    };

    // Try exact instrument match first
    if (trade.instrumentKey) {
      const entryTick = await this.findTickByInstrument(trade.instrumentKey, trade.entryTimestamp, 60000); // 1 min window
      const exitTick = trade.exitTimestamp
        ? await this.findTickByInstrument(trade.instrumentKey, trade.exitTimestamp, 60000)
        : null;

      if (entryTick) {
        matchResult.entryDataFound = true;
        matchResult.tickCount = 1;
        matchResult.matchStatus = 'MATCHED_EXACT';
        matchResult.matchMethod = 'instrument_exact';
        matchResult.timeDifferenceMs = 0;
      }
      if (exitTick) {
        matchResult.exitDataFound = true;
      }

      if (entryTick || exitTick) {
        matchResult.dataCoverage = matchResult.entryDataFound && matchResult.exitDataFound
          ? 'full'
          : 'partial';
        await this.saveMatchResult(trade, matchResult);
        return matchResult;
      }
    }

    // Try contract-based match: underlying + expiry + strike + optionType
    if (trade.underlying && trade.expiry && trade.strike !== null && trade.optionType) {
      const entryQuote = await this.findQuoteByContract(
        trade.underlying,
        trade.expiry,
        trade.strike,
        trade.optionType,
        trade.entryTimestamp,
        60000,
      );
      const exitQuote = trade.exitTimestamp
        ? await this.findQuoteByContract(
            trade.underlying,
            trade.expiry,
            trade.strike,
            trade.optionType,
            trade.exitTimestamp,
            60000,
          )
        : null;

      if (entryQuote) {
        matchResult.entryDataFound = true;
        matchResult.quoteCount = 1;
        matchResult.matchStatus = 'MATCHED_CONTRACT_TIME';
        matchResult.matchMethod = 'contract_exact';
        matchResult.timeDifferenceMs = 0;
      }
      if (exitQuote) {
        matchResult.exitDataFound = true;
      }

      if (entryQuote || exitQuote) {
        matchResult.dataCoverage = matchResult.entryDataFound && matchResult.exitDataFound
          ? 'full'
          : 'partial';
        await this.saveMatchResult(trade, matchResult);
        return matchResult;
      }
    }

    // Try symbol + time proximity (lower quality)
    if (trade.symbol || trade.instrumentKey) {
      const symbol = trade.symbol || trade.instrumentKey;
      if (!symbol) {
        return matchResult;
      }
      const entryTick = await this.findTickByInstrument(symbol, trade.entryTimestamp, 300000); // 5 min window
      if (entryTick) {
        matchResult.entryDataFound = true;
        matchResult.tickCount = 1;
        matchResult.matchStatus = 'MATCHED_SYMBOL_TIME';
        matchResult.matchMethod = 'symbol_time';
        matchResult.timeDifferenceMs = null;
      }

      if (matchResult.entryDataFound) {
        matchResult.dataCoverage = 'partial';
        await this.saveMatchResult(trade, matchResult);
        return matchResult;
      }
    }

    // Fallback: only trade data available
    matchResult.matchStatus = 'NO_MATCH';
    matchResult.matchMethod = 'trade_only';
    matchResult.dataCoverage = 'none';

    await this.saveMatchResult(trade, matchResult);
    return matchResult;
  }

  /**
   * Match all unmatched trades
   */
  async matchAllUnmatched(limit: number = 100): Promise<{ matched: number; unmatched: number }> {
    const unmatchedTrades = await this.tradeBookRepo.find({
      where: { matchStatus: 'unmatched' },
      take: limit,
    });

    let matched = 0;
    let unmatched = 0;

    for (const trade of unmatchedTrades) {
      const result = await this.matchTrade(trade);
      if (result.matchStatus !== 'NO_MATCH') {
        matched++;
      } else {
        unmatched++;
      }
    }

    this.logger.log(`Matched ${matched}, unmatched ${unmatched} of ${unmatchedTrades.length} trades`);

    return { matched, unmatched };
  }

  /**
   * Find a tick by instrument and timestamp with tolerance
   */
  private async findTickByInstrument(
    instrument: string,
    timestamp: Date,
    toleranceMs: number,
  ): Promise<SandboxTick | null> {
    const timeMin = new Date(timestamp.getTime() - toleranceMs);
    const timeMax = new Date(timestamp.getTime() + toleranceMs);

    return this.sandboxTickRepo.findOne({
      where: {
        instrument: Raw((alias) => `${alias} LIKE '${instrument}%'`),
        ts: Raw((alias) => `${alias} >= :timeMin AND ${alias} <= :timeMax`, { timeMin, timeMax }),
      },
      order: { ts: 'ASC' },
    });
  }

  /**
   * Find an option quote by contract and timestamp with tolerance
   */
  private async findQuoteByContract(
    underlying: string,
    expiry: string,
    strike: number,
    optionType: string,
    timestamp: Date,
    toleranceMs: number,
  ): Promise<FnfOptionQuote | null> {
    const timeMin = new Date(timestamp.getTime() - toleranceMs);
    const timeMax = new Date(timestamp.getTime() + toleranceMs);

    return this.optionQuoteRepo.findOne({
      where: {
        underlying,
        expiry,
        strike,
        optionType,
        ts: Raw((alias) => `${alias} >= :timeMin AND ${alias} <= :timeMax`, { timeMin, timeMax }),
      },
      order: { ts: 'ASC' },
    });
  }

  /**
   * Find underlying/index snapshots for trade period
   */
  async findUnderlyingSnapshots(
    underlying: string,
    entryTimestamp: Date,
    exitTimestamp?: Date | null,
    intervalMinutes: number = 5,
  ): Promise<FnfMarketSnapshot[]> {
    let timeMax = exitTimestamp || new Date();
    const timeMin = new Date(entryTimestamp.getTime() - 30 * 60 * 1000); // 30 min before entry

    // If exit timestamp missing, look 1 hour after entry
    if (!exitTimestamp) {
      timeMax = new Date(entryTimestamp.getTime() + 60 * 60 * 1000);
    }

    const snapshots = await this.marketSnapshotRepo.find({
      where: {
        instrument: Raw((alias) => `${alias} LIKE '${underlying}%'`),
        ts: Raw((alias) => `${alias} >= :timeMin AND ${alias} <= :timeMax`, { timeMin, timeMax }),
      },
      order: { ts: 'ASC' },
    });

    return snapshots;
  }

  /**
   * Save match results to trade record
   */
  private async saveMatchResult(
    trade: TradeBookImport,
    result: {
      matchStatus: string;
      matchMethod: string | null;
      entryDataFound: boolean;
      exitDataFound: boolean;
      timeDifferenceMs: number | null;
      dataCoverage: string;
      tickCount: number;
      quoteCount: number;
      underlyingSnapshots: number;
    },
  ) {
    trade.matchStatus = result.matchStatus;
    trade.matchMethod = result.matchMethod;
    await this.tradeBookRepo.save(trade);
  }
}
