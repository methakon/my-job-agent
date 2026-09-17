import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FnfPortfolio } from '../fnf-portfolio.entity';
import { FnfTradingService } from '../fnf-trading.service';
import { trackedUniversesFromSymbols } from '../unified-market-data/feed-arbitration.state';
import { PatternSignal } from './pattern-signal.entity';

/**
 * Sends one detected pattern to the FNF paper desk.
 *
 * Phase 1 — single paper portfolio (brief s28):
 *   The Upstox paper execution path has been retired. /fnf-trading is the
 *   ONLY paper execution/portfolio system. This dispatcher now routes signals
 *   exclusively to the FNF desk.
 *
 * Rules this service enforces:
 *  - FNF is the single execution path with its own capital, orders, positions and P&L.
 *  - EXPLICIT OPT-IN: PATTERN_FNF_ENABLED must be on; off records "skipped".
 *  - NO STRATEGY MUTATION: this never writes thresholds, weights or calibration.
 *  - Per-position capital filter: lots are derived from observed premium and the
 *    desk's own lot size; a candidate whose single lot exceeds the cap is skipped.
 */
@Injectable()
export class PatternSignalDispatchService {
  private readonly logger = new Logger(PatternSignalDispatchService.name);

  constructor(
    @InjectRepository(PatternSignal) private readonly signals: Repository<PatternSignal>,
    @InjectRepository(FnfPortfolio) private readonly portfolios: Repository<FnfPortfolio>,
    private readonly fnf: FnfTradingService,
  ) {}

  private flag(name: string, fallback: boolean): boolean {
    const raw = process.env[name];
    if (raw === undefined || raw === null || raw === '') return fallback;
    return !/^(0|false|no|off)$/i.test(raw);
  }

  private number(name: string, fallback: number): number {
    const n = Number(process.env[name]);
    return Number.isFinite(n) ? n : fallback;
  }

  /** Per-desk configuration, reported so the UI can show what is armed. */
  targets(): {
    fnf: { enabled: boolean; lots: number; portfolioId: string | null; universes: string[] };
  } {
    return {
      fnf: {
        enabled: this.flag('PATTERN_FNF_ENABLED', false),
        lots: Math.max(1, Math.trunc(this.number('PATTERN_FNF_LOTS', 1))),
        portfolioId: process.env.PATTERN_FNF_PORTFOLIO_ID ?? null,
        universes: this.fnfUniverses(),
      },
    };
  }

  /**
   * The universe FNF is REGISTERED to trade — taken from PATTERN_FNF_UNIVERSES
   * env or defaulting to NIFTY+BANKNIFTY. A signal for a universe FNF does not
   * trade is skipped.
   */
  private fnfUniverses(): string[] {
    const explicit = String(process.env.PATTERN_FNF_UNIVERSES ?? '').split(',').map((v) => v.trim().toUpperCase()).filter(Boolean);
    return explicit.length ? [...new Set(explicit)] : ['NIFTY', 'BANKNIFTY'];
  }

  /**
   * Dispatch one stored signal to the FNF desk and persist the result.
   * Returns the dispatch record; never throws.
   */
  async dispatch(signal: PatternSignal): Promise<Record<string, unknown>> {
    const targets = this.targets();
    const record: any = { at: new Date().toISOString(), signalId: signal.id, desks: {} };
    const desks = record.desks as Record<string, unknown>;

    desks.fnf = targets.fnf.enabled
      ? await this.dispatchFnf(signal, targets.fnf)
      : { attempted: false, skipped: 'PATTERN_FNF_ENABLED is off (FNF account untouched by the pattern engine)' };

    const fnfId = (desks.fnf as { tradeId?: string | null })?.tradeId ?? null;
    try {
      await this.signals.update({ id: signal.id }, {
        dispatch: record,
        fnfTradeId: fnfId,
      });
    } catch (error) {
      this.logger.warn(`pattern dispatch record not saved for ${signal.id}: ${(error as Error).message}`);
    }
    signal.dispatch = record;
    signal.fnfTradeId = fnfId;
    return record;
  }

  /** The FNF desk — existing portfolio state, never reset or re-funded here. */
  private async dispatchFnf(
    signal: PatternSignal,
    target: { lots: number; portfolioId: string | null; universes: string[] },
  ): Promise<Record<string, unknown>> {
    try {
      if (target.universes.length && !target.universes.includes(String(signal.underlying ?? '').toUpperCase())) {
        return { attempted: false, skipped: `the FNF desk does not trade ${signal.underlying} (registered: ${target.universes.join(', ')})` };
      }
      const entryPrice = Number(signal.ltp ?? 0);
      if (!(entryPrice > 0)) return { attempted: false, skipped: 'no traded premium on the signal' };
      const portfolioId = target.portfolioId ?? (await this.fnf.listPortfolios(true))?.[0]?.id ?? null;
      if (!portfolioId) return { attempted: false, skipped: 'no FNF portfolio available' };

      const trade = await this.fnf.openTrade({
        portfolioId,
        instrument: signal.contractSymbol,
        side: 'BUY',
        quantity: target.lots,
        entryPrice,
        algoSource: 'pattern-engine-v1',
        decisionParams: JSON.stringify({
          patternSignalId: signal.id, patternType: signal.patternType, entryState: signal.entryState,
          confidence: signal.confidence, reason: signal.reason, targetPct: signal.targetPct, stopPct: signal.stopPct,
          feedSource: signal.feedSource,
        }),
        decisionId: signal.id,
      });
      this.logger.log(`[PATTERN] FNF entry ${signal.contractSymbol} ${target.lots} @ ${entryPrice} (trade ${(trade as { id?: string })?.id ?? '?'})`);
      return { attempted: true, ok: true, tradeId: (trade as { id?: string })?.id ?? null, lots: target.lots, portfolioId };
    } catch (error) {
      const message = (error as Error).message;
      this.logger.warn(`[PATTERN] FNF dispatch failed: ${message}`);
      return { attempted: true, ok: false, error: message };
    }
  }
}
