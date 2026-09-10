import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FnfPortfolio } from '../fnf-portfolio.entity';
import { FnfTradingService } from '../fnf-trading.service';
import { UpstoxLivePaperService } from '../upstox-live-paper/upstox-live-paper.service';
import { trackedUniversesFromSymbols } from '../unified-market-data/feed-arbitration.state';
import { PatternSignal } from './pattern-signal.entity';

/**
 * Sends one detected pattern to the two paper desks INDEPENDENTLY (brief s14).
 *
 * Rules this service enforces, in order of importance:
 *  - SEPARATION: FNF and Upstox get their own order, their own position, their
 *    own capital and their own P&L. Nothing is shared but the normalized market
 *    observation that produced the signal. Both sides keep their existing
 *    accounting (FNF: current account state; Upstox: its independent capital).
 *  - ONE SIDE FAILING NEVER TOUCHES THE OTHER: each desk is dispatched in its
 *    own try/catch and its own result is recorded.
 *  - EXPLICIT OPT-IN PER DESK: each desk has its own env flag. A desk with the
 *    flag off records "skipped" — the signal is still stored and displayed.
 *  - NO STRATEGY MUTATION (brief s18): this never writes thresholds, weights or
 *    calibration. It places an order or it does not.
 *
 * Sizing uses the per-position capital FILTER: lots are derived from the
 * observed premium and the desk's own lot size, so a candidate whose single lot
 * exceeds the cap is skipped rather than force-fitted.
 */
@Injectable()
export class PatternSignalDispatchService {
  private readonly logger = new Logger(PatternSignalDispatchService.name);

  constructor(
    @InjectRepository(PatternSignal) private readonly signals: Repository<PatternSignal>,
    @InjectRepository(FnfPortfolio) private readonly portfolios: Repository<FnfPortfolio>,
    private readonly fnf: FnfTradingService,
    private readonly upstox: UpstoxLivePaperService,
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
    upstox: { enabled: boolean; maxPositionCapital: number; lotSize: number | null; portfolioId: string | null; universes: string[] };
  } {
    return {
      fnf: {
        enabled: this.flag('PATTERN_FNF_ENABLED', false),
        lots: Math.max(1, Math.trunc(this.number('PATTERN_FNF_LOTS', 1))),
        portfolioId: process.env.PATTERN_FNF_PORTFOLIO_ID ?? null,
        universes: this.fnfUniverses(),
      },
      upstox: {
        enabled: this.flag('PATTERN_UPSTOX_ENABLED', true),
        maxPositionCapital: this.number('PATTERN_MAX_POSITION_CAPITAL', 5_000),
        lotSize: Number.isFinite(Number(process.env.PATTERN_LOT_SIZE)) ? Number(process.env.PATTERN_LOT_SIZE) : null,
        portfolioId: process.env.PATTERN_UPSTOX_PORTFOLIO_ID ?? null,
        universes: this.upstoxUniverses(),
      },
    };
  }

  /**
   * The universe a desk is REGISTERED to trade — taken from that desk's own
   * configuration, never from the engine's watch list. A signal for a universe
   * a desk does not trade is skipped there: the engine scans a wider field than
   * any single desk is allowed to touch (brief s14, and the ₹5,000 desk's
   * registered-universe rule).
   */
  private upstoxUniverses(): string[] {
    return trackedUniversesFromSymbols(String(process.env.UPSTOX_LIVE_INSTRUMENTS ?? '').split(',').map((v) => v.trim()).filter(Boolean));
  }

  private fnfUniverses(): string[] {
    const explicit = String(process.env.PATTERN_FNF_UNIVERSES ?? '').split(',').map((v) => v.trim().toUpperCase()).filter(Boolean);
    return explicit.length ? [...new Set(explicit)] : ['NIFTY', 'BANKNIFTY'];
  }

  /**
   * Dispatch one stored signal to every armed desk and persist the per-desk
   * result. Returns the dispatch record; never throws.
   */
  async dispatch(signal: PatternSignal): Promise<Record<string, unknown>> {
    const targets = this.targets();
    const record: any = { at: new Date().toISOString(), signalId: signal.id, desks: {} };
    const desks = record.desks as Record<string, unknown>;

    desks.upstox = targets.upstox.enabled
      ? await this.dispatchUpstox(signal, targets.upstox)
      : { attempted: false, skipped: 'PATTERN_UPSTOX_ENABLED is off' };
    desks.fnf = targets.fnf.enabled
      ? await this.dispatchFnf(signal, targets.fnf)
      : { attempted: false, skipped: 'PATTERN_FNF_ENABLED is off (existing FNF account untouched by the pattern engine)' };

    const upstoxId = (desks.upstox as { tradeId?: string | null })?.tradeId ?? null;
    const fnfId = (desks.fnf as { tradeId?: string | null })?.tradeId ?? null;
    try {
      await this.signals.update({ id: signal.id }, {
        dispatch: record,
        upstoxTradeId: upstoxId,
        fnfTradeId: fnfId,
      });
    } catch (error) {
      this.logger.warn(`pattern dispatch record not saved for ${signal.id}: ${(error as Error).message}`);
    }
    signal.dispatch = record;
    signal.upstoxTradeId = upstoxId;
    signal.fnfTradeId = fnfId;
    return record;
  }

  /** The Upstox Auto Trading paper desk — its own ₹5,000 book. */
  private async dispatchUpstox(
    signal: PatternSignal,
    target: { maxPositionCapital: number; lotSize: number | null; portfolioId: string | null; universes: string[] },
  ): Promise<Record<string, unknown>> {
    try {
      if (target.universes.length && !target.universes.includes(String(signal.underlying ?? '').toUpperCase())) {
        return { attempted: false, skipped: `the Upstox paper desk does not trade ${signal.underlying} (registered: ${target.universes.join(', ')})` };
      }
      const premium = Number(signal.ltp ?? 0);
      if (!(premium > 0)) return { attempted: false, skipped: 'no traded premium on the signal' };
      // Lot size: explicit env override, else the desk reads the broker's OWN
      // contract master. Never a hand-set constant and never guessed — an
      // unresolved size skips the order instead of mis-stating the position.
      const resolved = this.upstox.lotSizeFor(signal.contractSymbol, target.lotSize);
      const lotSize = resolved.lotSize ?? 0;
      if (!(lotSize > 0)) {
        return {
          attempted: false,
          skipped: `no lot size for ${signal.contractSymbol} — set PATTERN_LOT_SIZE or UPSTOX_LIVE_PAPER_LOT_SIZE, or let the desk read the broker contract master (source: ${resolved.source})`,
        };
      }
      const lots = Math.floor(target.maxPositionCapital / (premium * lotSize));
      if (lots < 1) {
        return {
          attempted: false,
          skipped: `one lot (${(premium * lotSize).toFixed(2)}) exceeds the per-position capital filter (${target.maxPositionCapital})`,
        };
      }
      const portfolioId = target.portfolioId ?? (await this.upstox.listPortfolios())?.[0]?.id ?? null;
      if (!portfolioId) return { attempted: false, skipped: 'no Upstox paper portfolio available' };

      const trade = await this.upstox.openTrade({
        portfolioId,
        instrument: signal.contractSymbol,
        side: 'BUY',
        quantity: lots,
        lotSize,
        algoSource: 'pattern-engine-v1',
        decisionParams: JSON.stringify({
          patternSignalId: signal.id, patternType: signal.patternType, entryState: signal.entryState,
          confidence: signal.confidence, reason: signal.reason, targetPct: signal.targetPct, stopPct: signal.stopPct,
          components: {
            reversal: signal.reversalScore, breakout: signal.breakoutScore, momentum: signal.momentumScore,
            volume: signal.volumeScore, oi: signal.oiScore, iv: signal.ivScore,
            underlying: signal.underlyingScore, liquidity: signal.liquidityScore, chain: signal.chainScore,
          },
        }),
        decisionId: signal.id,
      });
      this.logger.log(`[PATTERN] Upstox paper entry ${signal.contractSymbol} ${lots}x${lotSize} @ ~${premium} (trade ${trade?.id ?? '?'})`);
      return { attempted: true, ok: true, tradeId: trade?.id ?? null, lots, lotSize, lotSizeSource: resolved.source, portfolioId };
    } catch (error) {
      const message = (error as Error).message;
      this.logger.warn(`[PATTERN] Upstox dispatch failed: ${message}`);
      return { attempted: true, ok: false, error: message };
    }
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
