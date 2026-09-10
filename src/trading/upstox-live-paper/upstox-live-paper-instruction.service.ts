import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron } from '@nestjs/schedule';
import { Repository } from 'typeorm';
import { UpstoxLivePaperInstruction } from './upstox-live-paper-instruction.entity';
import {
  InstructionLike, InstructionPlan, SESSION_LAST_ENTRY_MINUTES, SESSION_OPEN_MINUTES,
  isInstructionDue, istClockLabel, istDateOf, planInstruction, sessionWindowLabel, withinSessionWindow,
} from './upstox-live-paper-instruction.rules';
import { UpstoxLivePaperService } from './upstox-live-paper.service';
import { UpstoxLivePaperPortfolio } from './upstox-live-paper-portfolio.entity';
import { UpstoxLivePaperConfig } from './upstox-live-paper.config';
import { trackedUniversesFromSymbols } from '../unified-market-data/feed-arbitration.state';

export class CreateUpstoxLivePaperInstructionDto {
  label?: string;
  portfolioId?: string | null;
  instrument!: string;
  underlying?: string | null;
  optionType?: 'CE' | 'PE' | null;
  expiry?: string | null;
  strike?: number | null;
  side?: 'BUY' | 'SELL';
  lots?: number | null;
  lotSize?: number | null;
  maxCapital?: number | null;
  sessionDate?: string | null;
  enabled?: boolean;
  notes?: string | null;
}

/**
 * Pre-cleared instruction runner — the desk's AUTO-START.
 *
 * The operator writes an instruction ONCE (contract + side + capital cap). At
 * 09:15 IST on every trading day the desk evaluates it and opens the position by
 * itself, so the session is never lost to re-issuing the same line by hand.
 *
 * What it deliberately does NOT do:
 *  - it invents nothing: no strike, no expiry, no level, no lot size. Every one
 *    of those either comes from the instruction or from the broker's own contract
 *    master, and an unresolved value skips the order with a reason;
 *  - it does not touch the FNF desk, FNF funds or FNF records;
 *  - it does not enable anything: the portfolio's own `autoTradeEnabled` must be
 *    on, and each instruction must be `enabled`;
 *  - it opens at most ONE position per instruction per session.
 */
@Injectable()
export class UpstoxLivePaperInstructionService {
  private readonly logger = new Logger(UpstoxLivePaperInstructionService.name);

  constructor(
    @InjectRepository(UpstoxLivePaperInstruction)
    private readonly instructions: Repository<UpstoxLivePaperInstruction>,
    @InjectRepository(UpstoxLivePaperPortfolio)
    private readonly portfolios: Repository<UpstoxLivePaperPortfolio>,
    private readonly config: UpstoxLivePaperConfig,
    private readonly desk: UpstoxLivePaperService,
  ) {}

  // ── read / write ────────────────────────────────────────────────────────────

  async list(): Promise<UpstoxLivePaperInstruction[]> {
    return this.instructions.find({ order: { createdAt: 'ASC' } });
  }

  async get(id: string): Promise<UpstoxLivePaperInstruction> {
    const row = await this.instructions.findOne({ where: { id } });
    if (!row) throw new BadRequestException(`instruction ${id} not found`);
    return row;
  }

  async create(dto: CreateUpstoxLivePaperInstructionDto): Promise<UpstoxLivePaperInstruction> {
    const instrument = String(dto.instrument ?? '').trim().toUpperCase();
    if (!instrument) throw new BadRequestException('instrument is required');
    if (!/(CE|PE)$/.test(instrument)) {
      throw new BadRequestException(`instrument ${instrument} does not end in CE/PE — the desk trades option contracts only`);
    }
    const row = this.instructions.create({
      label: dto.label ?? 'pre-cleared instruction',
      portfolioId: dto.portfolioId ?? null,
      instrument,
      underlying: dto.underlying ? String(dto.underlying).toUpperCase() : null,
      optionType: dto.optionType ?? (instrument.endsWith('PE') ? 'PE' : 'CE'),
      expiry: dto.expiry ?? null,
      strike: dto.strike ?? null,
      side: dto.side ?? 'BUY',
      lots: dto.lots ?? null,
      lotSize: dto.lotSize ?? null,
      maxCapital: dto.maxCapital ?? null,
      sessionDate: dto.sessionDate ?? null,
      enabled: dto.enabled ?? true,
      notes: dto.notes ?? null,
      executions: 0,
      lastExecutedSession: null,
      lastExecutedAt: null,
      lastResult: null,
    });
    const saved = await this.instructions.save(row);
    this.logger.log(`[UPSTOX-LIVE-PAPER] instruction armed: ${saved.instrument} ${saved.side} · cap ₹${saved.maxCapital ?? 'unset'} · ${saved.sessionDate ? `one-shot ${saved.sessionDate}` : 'every session'}`);
    return saved;
  }

  async update(id: string, dto: Partial<CreateUpstoxLivePaperInstructionDto>): Promise<UpstoxLivePaperInstruction> {
    const row = await this.get(id);
    if (dto.instrument !== undefined) {
      const instrument = String(dto.instrument).trim().toUpperCase();
      if (!/(CE|PE)$/.test(instrument)) throw new BadRequestException(`instrument ${instrument} does not end in CE/PE`);
      row.instrument = instrument;
    }
    if (dto.label !== undefined) row.label = dto.label;
    if (dto.portfolioId !== undefined) row.portfolioId = dto.portfolioId;
    if (dto.underlying !== undefined) row.underlying = dto.underlying ? String(dto.underlying).toUpperCase() : null;
    if (dto.optionType !== undefined) row.optionType = dto.optionType;
    if (dto.expiry !== undefined) row.expiry = dto.expiry;
    if (dto.strike !== undefined) row.strike = dto.strike;
    if (dto.side !== undefined) row.side = dto.side;
    if (dto.lots !== undefined) row.lots = dto.lots;
    if (dto.lotSize !== undefined) row.lotSize = dto.lotSize;
    if (dto.maxCapital !== undefined) row.maxCapital = dto.maxCapital;
    if (dto.sessionDate !== undefined) row.sessionDate = dto.sessionDate;
    if (dto.enabled !== undefined) row.enabled = dto.enabled;
    if (dto.notes !== undefined) row.notes = dto.notes;
    return this.instructions.save(row);
  }

  async remove(id: string): Promise<{ removed: true }> {
    await this.get(id);
    await this.instructions.delete({ id });
    return { removed: true };
  }

  /**
   * Clear the once-per-session guard so an instruction can fire again TODAY (the
   * next tick, or the next manual run). Needed when the operator corrects the
   * contract after a failed attempt — it does not bypass any other guard.
   */
  async rearm(id: string): Promise<UpstoxLivePaperInstruction> {
    const row = await this.get(id);
    row.lastExecutedSession = null;
    return this.instructions.save(row);
  }

  // ── status ──────────────────────────────────────────────────────────────────

  /** What the desk is armed with, for the UI / operator. */
  async status(): Promise<Record<string, unknown>> {
    const [rows, portfolios] = await Promise.all([this.list(), this.portfolios.find({ order: { createdAt: 'ASC' } })]);
    const todayIst = istDateOf(Date.now());
    return {
      todayIst,
      withinSessionWindow: withinSessionWindow(Date.now()),
      window: { openIst: istClockLabel(SESSION_OPEN_MINUTES), lastEntryIst: istClockLabel(SESSION_LAST_ENTRY_MINUTES) },
      universes: this.universes(),
      contractMaster: this.desk.contractMasterStatus(),
      armedPortfolios: portfolios.map((p) => ({ id: p.id, label: p.label, capital: Number(p.capital), autoTradeEnabled: Boolean(p.autoTradeEnabled), fridayTradingEnabled: Boolean(p.fridayTradingEnabled) })),
      instructions: rows.map((r) => ({
        id: r.id, label: r.label, instrument: r.instrument, side: r.side, enabled: Boolean(r.enabled),
        lots: r.lots, lotSize: r.lotSize, maxCapital: r.maxCapital === null ? null : Number(r.maxCapital),
        sessionDate: r.sessionDate, executions: r.executions, lastExecutedSession: r.lastExecutedSession,
        dueToday: isInstructionDue(this.asLike(r), todayIst), lastResult: r.lastResult,
      })),
      note: 'Nothing executes unless BOTH the instruction is enabled AND its portfolio has autoTradeEnabled=true (POST /upstox-live-paper/portfolios/:id/auto).',
    };
  }

  // ── the auto-start ──────────────────────────────────────────────────────────

  /**
   * Every 5 minutes during the session, from 09:15 IST to 15:20 IST, on trading
   * days. The window guard is explicit so the runner cannot open an entry into
   * the close, and each instruction opens at most one position per session.
   */
  @Cron('*/5 9-15 * * 1-5', { name: 'upstox-live-paper-instruction-autostart' })
  async scheduledAutoStart(): Promise<void> {
    if (!withinSessionWindow(Date.now())) return;
    try {
      const results = await this.runDue('scheduled');
      const executed = results.filter((r) => r.executed);
      if (executed.length) this.logger.log(`[UPSTOX-LIVE-PAPER] auto-start: ${executed.length} instruction(s) executed`);
    } catch (error) {
      this.logger.error(`[UPSTOX-LIVE-PAPER] auto-start failed: ${(error as Error).message}`);
    }
  }

  /** Evaluate every due instruction once (used by the scheduler and by the API). */
  async runDue(trigger = 'manual'): Promise<Array<Record<string, unknown>>> {
    const todayIst = istDateOf(Date.now());
    const rows = await this.instructions.find({ where: { enabled: true } });
    const out: Array<Record<string, unknown>> = [];
    for (const row of rows) {
      if (!isInstructionDue(this.asLike(row), todayIst)) continue;
      out.push(await this.execute(row, trigger, false));
    }
    return out;
  }

  /** Run ONE instruction now (operator-driven). force also ignores the guards. */
  async runNow(id: string, force = false): Promise<Record<string, unknown>> {
    const row = await this.get(id);
    return this.execute(row, force ? 'manual-force' : 'manual', force);
  }

  private async execute(
    row: UpstoxLivePaperInstruction,
    trigger: string,
    force: boolean,
  ): Promise<Record<string, unknown>> {
    const todayIst = istDateOf(Date.now());
    const portfolio = await this.resolvePortfolio(row);

    const finish = async (result: Record<string, unknown>, executed: boolean): Promise<Record<string, unknown>> => {
      const stamp = {
        ...result,
        trigger,
        at: new Date().toISOString(),
        todayIst,
        portfolioId: portfolio?.id ?? null,
      };
      row.lastResult = stamp;
      if (executed) {
        row.executions += 1;
        if (!force) row.lastExecutedSession = todayIst;
        row.lastExecutedAt = new Date();
      }
      await this.instructions.save(row).catch((error) => {
        this.logger.warn(`[UPSTOX-LIVE-PAPER] instruction ${row.id} result not saved: ${(error as Error).message}`);
      });
      return { instructionId: row.id, instrument: row.instrument, executed, ...stamp };
    };

    if (!row.enabled && !force) return finish({ skipped: 'instruction is disabled' }, false);
    if (!force && !withinSessionWindow(Date.now())) {
      return finish({ skipped: `outside the entry window (${sessionWindowLabel()})` }, false);
    }
    if (!force && row.lastExecutedSession === todayIst) {
      return finish({ skipped: `already executed for session ${todayIst}` }, false);
    }
    if (!portfolio) return finish({ skipped: 'no Upstox paper portfolio available' }, false);
    if (!portfolio.autoTradeEnabled) {
      return finish({
        skipped: `auto-trade is OFF for portfolio ${portfolio.id} — arm it with POST /upstox-live-paper/portfolios/${portfolio.id}/auto {"enabled":true}`,
      }, false);
    }

    // Lot size: instruction → env → the broker's own contract master. Never guessed.
    const resolved = this.desk.lotSizeFor(row.instrument, row.lotSize);
    // Premium: the same fill-side computation openTrade will use.
    const preview = await this.desk.previewEntry(row.instrument, row.side ?? 'BUY');
    const plan: InstructionPlan = planInstruction(this.asLike(row), {
      todayIst,
      universes: this.universes(),
      lotSize: resolved.lotSize,
      lotSizeSource: resolved.source,
      premium: preview.premium,
    });

    if (!plan.execute) {
      return finish({
        skipped: plan.skipped,
        lotSizeSource: resolved.source,
        quote: { source: preview.source, ageMs: preview.ageMs, stale: preview.stale, premium: preview.premium },
      }, false);
    }
    if (preview.stale) {
      return finish({
        skipped: `quote for ${row.instrument} is stale (${preview.ageMs === null ? 'no timestamp' : `${Math.round(preview.ageMs / 1000)}s`} > ${this.config.staleQuoteMaxAgeMs / 1000}s) — cannot open an honest fill`,
        quote: { source: preview.source, quoteTs: preview.quoteTs, ageMs: preview.ageMs },
      }, false);
    }

    try {
      const trade = await this.desk.openTrade({
        portfolioId: portfolio.id,
        instrument: row.instrument,
        side: row.side ?? 'BUY',
        quantity: plan.lots,
        lotSize: plan.lotSize,
        // Pin the fill to the premium the order was SIZED at; openTrade still
        // records the real spread and slippage from the live quote.
        entryPrice: plan.expected,
        algoSource: 'pre-cleared-instruction',
        decisionParams: JSON.stringify({
          instructionId: row.id, label: row.label, trigger,
          lots: plan.lots, lotSize: plan.lotSize, units: plan.units,
          outlay: plan.outlay, capitalCap: plan.capitalCap, premium: plan.expected,
          lotSizeSource: resolved.source, quoteSource: preview.source, quoteTs: preview.quoteTs,
        }),
        decisionId: row.id,
      });
      this.logger.log(`[UPSTOX-LIVE-PAPER] pre-cleared entry ${row.instrument} ${row.side} ${plan.lots}x${plan.lotSize} @ ~${plan.expected} (trade ${(trade as { id?: string })?.id ?? '?'})`);
      return finish({
        ok: true,
        tradeId: (trade as { id?: string })?.id ?? null,
        lots: plan.lots, lotSize: plan.lotSize, units: plan.units, outlay: plan.outlay,
        premium: plan.expected, lotSizeSource: resolved.source,
        quote: { source: preview.source, quoteTs: preview.quoteTs, spreadPct: preview.spreadPct },
      }, true);
    } catch (error) {
      const message = (error as Error).message;
      this.logger.warn(`[UPSTOX-LIVE-PAPER] pre-cleared entry ${row.instrument} failed: ${message}`);
      // Deliberately NOT stamped as executed: a quote/token failure should retry
      // on the next tick, and the once-per-session guard stays open.
      return finish({ ok: false, error: message, lotSizeSource: resolved.source }, false);
    }
  }

  private async resolvePortfolio(row: UpstoxLivePaperInstruction): Promise<UpstoxLivePaperPortfolio | null> {
    if (row.portfolioId) {
      const explicit = await this.portfolios.findOne({ where: { id: row.portfolioId } });
      if (explicit) return explicit;
      this.logger.warn(`[UPSTOX-LIVE-PAPER] instruction ${row.id} names portfolio ${row.portfolioId}, which does not exist`);
    }
    const first = await this.portfolios.find({ order: { createdAt: 'ASC' }, take: 1 });
    return first[0] ?? null;
  }

  /** Universes this desk is registered to trade (from its own configuration). */
  private universes(): string[] {
    return [...new Set(trackedUniversesFromSymbols(this.config.liveInstruments))];
  }

  /** Narrow an entity onto the pure rule shape (keeps the rules DB-free). */
  private asLike(row: UpstoxLivePaperInstruction): InstructionLike {
    return {
      enabled: Boolean(row.enabled),
      side: (row.side ?? 'BUY') as 'BUY' | 'SELL',
      instrument: row.instrument,
      underlying: row.underlying ?? null,
      lots: row.lots === null || row.lots === undefined ? null : Number(row.lots),
      lotSize: row.lotSize === null || row.lotSize === undefined ? null : Number(row.lotSize),
      maxCapital: row.maxCapital === null || row.maxCapital === undefined ? null : Number(row.maxCapital),
      sessionDate: row.sessionDate ? String(row.sessionDate).slice(0, 10) : null,
      lastExecutedSession: row.lastExecutedSession ?? null,
    };
  }
}
