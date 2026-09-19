import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FnfTrade } from '../fnf-trade.entity';
import { TradeRecord } from './validation-engine.service';
import { AdaptationCandidate } from './adaptation-candidate.entity';

/**
 * Deterministic simulation/replay engine for validation pipeline.
 *
 * Replays historical trades through candidate parameter changes to produce
 * simulated candidate trades for validation. No broker calls, no real orders,
 * no modification of live trading state.
 *
 * Inputs are auditable: all candidate trades are derived deterministically
 * from historical baseline trades + proposed parameter changes.
 */

/** Known parameter semantics — only these can be simulated. */
const SIMULABLE_PARAMS = new Set(['decayRate', 'confidenceThreshold', 'confidenceFloor']);

@Injectable()
export class SimulationEngineService {
  private readonly logger = new Logger(SimulationEngineService.name);

  constructor(
    @InjectRepository(FnfTrade) private readonly trades: Repository<FnfTrade>,
    @InjectRepository(AdaptationCandidate) private readonly candidates: Repository<AdaptationCandidate>,
  ) {}

  /**
   * Load all CLOSED historical trades as baseline, converted to TradeRecord.
   * Bounded by table size (currently ~14 rows).
   */
  async loadBaseline(): Promise<TradeRecord[]> {
    const rows = await this.trades.find({ where: { status: 'CLOSED' } });
    return rows.map((r) => this.rowToTradeRecord(r));
  }

  /**
   * Simulate candidate trades by applying the candidate's proposed parameter
   * to the historical baseline. Returns the subset of baseline trades that
   * would survive under the proposed parameter — this IS the candidate set.
   *
   * Deterministic: same baseline + same candidate → same output.
   *
   * For unknown/un simulable parameters, returns empty array (candidate
   * will be rejected at validation gate for insufficient sample size).
   */
  simulateCandidateTrades(
    baselineTrades: TradeRecord[],
    candidate: AdaptationCandidate,
  ): TradeRecord[] {
    const paramName = candidate.paramName;
    const proposedValue = Number(candidate.proposedValue);
    const currentValue = Number(candidate.oldValue);

    if (!SIMULABLE_PARAMS.has(paramName)) {
      this.logger.warn(
        `Simulation: parameter '${paramName}' not simulable — returning empty candidate set`,
      );
      return [];
    }

    if (Number.isNaN(proposedValue) || Number.isNaN(currentValue)) {
      this.logger.warn(
        `Simulation: non-numeric value for '${paramName}' (proposed=${candidate.proposedValue}, old=${candidate.oldValue})`,
      );
      return [];
    }

    switch (paramName) {
      case 'confidenceThreshold':
        return this.simulateConfidenceThreshold(baselineTrades, proposedValue);
      case 'confidenceFloor':
        return this.simulateConfidenceFloor(baselineTrades, proposedValue);
      case 'decayRate':
        return this.simulateDecayRate(baselineTrades, currentValue, proposedValue);
      default:
        return [];
    }
  }

  // ── Parameter-specific simulations ──────────────────────────────────

  /**
   * confidenceThreshold: higher → tighter filter → fewer trades enter.
   * Trades whose raw confidence < proposed threshold are excluded.
   * Trades that survived under old threshold but not new are the
   * "what-if rejected" set — but for validation, we keep only the
   * ones that STILL pass (the surviving set shows the tighter filter's
   * performance on the same market data).
   *
   * If proposed threshold <= current (loosening), all baseline trades pass.
   */
  private simulateConfidenceThreshold(
    trades: TradeRecord[],
    proposedThreshold: number,
  ): TradeRecord[] {
    return trades.filter((t) => {
      const dp = this.parseDecisionParams(t);
      return dp.confidence >= proposedThreshold;
    });
  }

  /**
   * confidenceFloor: minimum confidence for entry consideration.
   * Similar to confidenceThreshold but represents the floor below
   * which trades are never considered.
   */
  private simulateConfidenceFloor(
    trades: TradeRecord[],
    proposedFloor: number,
  ): TradeRecord[] {
    return trades.filter((t) => {
      const dp = this.parseDecisionParams(t);
      return dp.decayedConfidence >= proposedFloor;
    });
  }

  /**
   * decayRate: controls how fast signal confidence decays with premium age.
   * Higher rate → faster decay → lower decayedConfidence → fewer trades enter.
   * Lower rate → slower decay → more trades enter.
   *
   * We re-derive the decayed confidence using the proposed rate and filter.
   */
  private simulateDecayRate(
    trades: TradeRecord[],
    currentRate: number,
    proposedRate: number,
  ): TradeRecord[] {
    if (proposedRate === currentRate) return [...trades];

    return trades.filter((t) => {
      const dp = this.parseDecisionParams(t);
      // The decayed confidence in decisionParams was computed with the old rate.
      // Re-derive: if proposedRate > currentRate, confidence decays faster,
      // so the effective decayedConfidence is lower proportionally.
      const ratio = proposedRate / currentRate;
      const adjustedConfidence = dp.confidence * ratio;
      return adjustedConfidence >= 50; // Default confidence floor
    });
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  private parseDecisionParams(
    trade: TradeRecord,
  ): { confidence: number; decayedConfidence: number } {
    // decisionParams is stored as JSON string in the entity
    const raw = (trade as any).decisionParams;
    if (!raw) return { confidence: 50, decayedConfidence: 50 };
    try {
      const dp = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return {
        confidence: typeof dp.confidence === 'number' ? dp.confidence : 50,
        decayedConfidence: typeof dp.decayedConfidence === 'number' ? dp.decayedConfidence : 50,
      };
    } catch {
      return { confidence: 50, decayedConfidence: 50 };
    }
  }

  private rowToTradeRecord(row: FnfTrade): TradeRecord {
    return {
      instrumentKey: row.instrument,
      underlying: row.instrument?.includes(':') ? row.instrument.split(':')[1]?.replace(/NSE:/g, '').replace(/NIFTY.*/, 'NIFTY') : 'NIFTY',
      optionType: row.instrument?.includes('CE') ? 'CE' : 'PE',
      strike: 0,
      expiry: '',
      netPnl: row.netPnl,
      entryPrice: row.entryPrice,
      exitPrice: row.exitPrice ?? row.entryPrice,
      orderedAt: row.orderedAt,
      closedAt: row.closedAt,
      entrySource: row.algoSource ?? 'unknown',
      // Carry decisionParams through for simulation — not part of TradeRecord
      // interface but accessed via (trade as any) in parseDecisionParams
      ...(row.decisionParams !== undefined && row.decisionParams !== null ? { decisionParams: row.decisionParams } : {}),
    } as TradeRecord;
  }
}
