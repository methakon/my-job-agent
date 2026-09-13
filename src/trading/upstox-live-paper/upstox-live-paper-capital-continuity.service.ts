import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  UpstoxLivePaperPortfolio,
  UpstoxLivePaperTrade,
  UpstoxLivePaperPosition,
  UpstoxLivePaperPnlEvent,
} from './upstox-live-paper-entities';
import { UpstoxLivePaperRiskService } from './upstox-live-paper-risk.service';
import { UpstoxLivePaperAutoEntryService } from './upstox-live-paper-autoentry.service';
import { UpstoxLivePaperTokenService } from './upstox-live-paper-auth.service';
import { UpstoxLivePaperConfig } from './upstox-live-paper.config';
import { parseOptionSymbol } from '../unified-market-data/canonical/canonical-tick';

/**
 * PAPER capital continuity + carry-forward positions.
 *
 * The operator's rule (2026-09-13): the configured paper capital is the INITIAL
 * capital, never a permanent weekly ceiling. At the start of each trading week
 * the previous week's CLOSING PAPER EQUITY becomes the next week's available
 * PAPER capital — a profitable week raises it, a losing week lowers it, and it is
 * never reset to the initial amount merely because a new week started.
 *
 * Two decisions are deliberately separate and both are evidence-based:
 *   1. THE ROLL (accounting) — arithmetic over authoritative rows only. If any
 *      input is missing or contradicts another row, this service refuses to roll
 *      and reports BLOCKED. Nothing is ever reconstructed by guesswork.
 *   2. CARRY-FORWARD (positions) — every position still open at the previous
 *      close is re-evaluated with the desk's OWN exit policy, and HOLD or EXIT is
 *      decided and recorded with its reason. A position is never closed merely
 *      because the week changed, and never carried merely because it was open.
 *
 * LIVE account balance is a separate, read-only report: it is never mixed into
 * paper equity, never used for sizing, and never authorizes a real order.
 */

export const WEEK_CARRY_FORWARD_EVENT = 'WEEK_CARRY_FORWARD';
export const WEEK_CARRY_DECISION_EVENT = 'WEEK_CARRY_DECISION';
/** Below this, a roll would be silently snapped back to a default by clampCapital. */
export const MIN_ROLL_EQUITY = 100;
const MONEY_TOLERANCE = 0.01;
const LIVE_FUNDS_URL = 'https://api.upstox.com/v2/user/get-funds-and-margin';

export type TradingWeek = { label: string; start: Date; end: Date };

/**
 * Canonical ISO week label (`2026-W37`) for the Monday of a week — the rule is
 * "the week containing that week's Thursday". Used so a label and a set of bounds
 * are always two views of the same week.
 */
function isoWeekLabel(monday: Date): string {
  const mondayUtc = new Date(Date.UTC(monday.getFullYear(), monday.getMonth(), monday.getDate()));
  const thursday = new Date(mondayUtc);
  thursday.setUTCDate(mondayUtc.getUTCDate() + 3);
  const isoYear = thursday.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4IsoDow = (jan4.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - jan4IsoDow);
  const week = 1 + Math.round((mondayUtc.getTime() - week1Monday.getTime()) / (7 * 86_400_000));
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

/**
 * The most recently COMPLETED trading week for `now` — Monday 00:00 through
 * Sunday 23:59:59.999 on the host's IST clock.
 *
 * Called on a Sunday (the week-start case) this returns the week that just ended;
 * called on a weekday it returns the previous week. The label is the ISO label of
 * that same window, so passing it back to `tradingWeekFromLabel` returns identical
 * bounds.
 */
export function lastCompletedTradingWeek(now = new Date()): TradingWeek {
  const mondayOfThisWeek = new Date(now);
  const dow = (now.getDay() + 6) % 7; // Mon=0 … Sun=6
  mondayOfThisWeek.setDate(now.getDate() - dow);
  mondayOfThisWeek.setHours(0, 0, 0, 0);
  const start = new Date(mondayOfThisWeek);
  if (now.getDay() !== 0) start.setDate(mondayOfThisWeek.getDate() - 7);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  end.setHours(23, 59, 59, 999);
  return { label: isoWeekLabel(start), start, end };
}

/**
 * The Monday of ISO week `week` of `year` — the proper ISO week-date rule (week 1
 * is the week containing January 4th), so a label produced by
 * `lastCompletedTradingWeek` maps back to the SAME Monday→Sunday bounds. (The
 * weekly report's own label→bounds helper is an approximation that does not
 * round-trip; capital continuity must not inherit that.)
 */
function isoWeekMonday(year: number, week: number): Date {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4IsoDow = (jan4.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - jan4IsoDow);
  const monday = new Date(week1Monday);
  monday.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
  return monday;
}

/** The bounds of an ISO-style week label (`2026-W37`) in the host's IST clock. */
export function tradingWeekFromLabel(label: string): TradingWeek {
  const [yearText, weekText] = String(label ?? '').split('-W');
  const year = Number.parseInt(yearText, 10);
  const week = Number.parseInt(weekText, 10);
  if (!Number.isFinite(year) || !Number.isFinite(week) || week < 1 || week > 53) {
    throw new Error(`invalid week label "${String(label)}" — expected the form 2026-W37`);
  }
  const mondayUtc = isoWeekMonday(year, week);
  const monday = new Date(mondayUtc.getUTCFullYear(), mondayUtc.getUTCMonth(), mondayUtc.getUTCDate(), 0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);
  return { label: `${year}-W${String(week).padStart(2, '0')}`, start: monday, end: sunday };
}

/** A position as it stood at the previous week's close. */
export type OpenPositionAtClose = {
  instrument: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  averagePrice: number;
  /** Mark used for the close valuation — null when none is available. */
  markPrice: number | null;
  markPriceTs: Date | null;
};

export type WeekCloseInputs = {
  capitalAtWeekStart: number;
  /** Σ netPnl of trades CLOSED at or before the close (costs already deducted). */
  closedTradeNetPnl: number;
  /** Σ cost of those trades — reported for transparency, already inside netPnl. */
  closedTradeCosts: number;
  openPositions: OpenPositionAtClose[];
  /** The portfolio row's own running totals, cross-checked against the trades. */
  portfolioNetPnl: number;
  portfolioUnrealisedPnl: number;
  weekEnd: Date;
};

export type WeekCloseEquity =
  | {
      ok: true;
      capitalAtWeekStart: number;
      realizedNetPnl: number;
      costs: number;
      unrealizedPnl: number;
      /** capital + realised + mark-to-market − costs (costs are inside realised). */
      equity: number;
      openPositions: number;
    }
  | { ok: false; blockers: string[] };

/**
 * Pure. closing equity = starting capital + realised P&L + valid MTM of carried
 * positions, with simulated costs already inside each trade's netPnl.
 *
 * Refuses (rather than approximates) when a position has no valid mark at the
 * close, when a mark is timestamped AFTER the close, or when the trades and the
 * portfolio row disagree about realised/unrealised P&L.
 */
export function computeWeekCloseEquity(input: WeekCloseInputs): WeekCloseEquity {
  const blockers: string[] = [];
  const capital = Number(input.capitalAtWeekStart);
  if (!Number.isFinite(capital) || capital <= 0) {
    blockers.push(`configured capital is not a usable number (${String(input.capitalAtWeekStart)})`);
  }
  const realized = Number(input.closedTradeNetPnl);
  const costs = Number(input.closedTradeCosts);
  if (!Number.isFinite(realized)) blockers.push('closed-trade net P&L is not a number');
  if (!Number.isFinite(costs) || costs < 0) blockers.push('closed-trade cost total is not a usable number');

  const weekEndMs = new Date(input.weekEnd).getTime();
  let unrealized = 0;
  input.openPositions.forEach((p, index) => {
    const label = `position ${index + 1} (${p.instrument})`;
    const qty = Number(p.quantity);
    const avg = Number(p.averagePrice);
    let usable = true;
    if (!(qty > 0) || !Number.isFinite(avg) || avg <= 0) {
      blockers.push(`${label}: quantity/average price is not usable`);
      usable = false;
    }
    if (p.side !== 'BUY' && p.side !== 'SELL') {
      blockers.push(`${label}: side is neither BUY nor SELL`);
      usable = false;
    }
    if (!usable) return;
    const mark = p.markPrice === null || p.markPrice === undefined ? null : Number(p.markPrice);
    if (mark === null || !Number.isFinite(mark) || mark <= 0) {
      blockers.push(`${label}: no valid mark-to-market price at the week close — refusing to guess a valuation`);
      return;
    }
    if (p.markPriceTs && new Date(p.markPriceTs).getTime() > weekEndMs) {
      blockers.push(`${label}: last mark (${new Date(p.markPriceTs).toISOString()}) is AFTER the week close — not a close valuation`);
      return;
    }
    unrealized += (p.side === 'BUY' ? mark - avg : avg - mark) * qty;
  });

  const rowNetPnl = Number(input.portfolioNetPnl);
  const rowUnrealised = Number(input.portfolioUnrealisedPnl);
  if (!Number.isFinite(rowNetPnl) || !Number.isFinite(rowUnrealised)) {
    blockers.push('portfolio P&L columns are not numbers');
  } else {
    if (Math.abs(realized - rowNetPnl) > MONEY_TOLERANCE) {
      blockers.push(
        `contradictory records: closed trades total ₹${realized.toFixed(2)} but the portfolio row reports realised ₹${rowNetPnl.toFixed(2)} ` +
          '(a trade after the week close, or a partial ledger)',
      );
    }
    if (Math.abs(unrealized - rowUnrealised) > MONEY_TOLERANCE) {
      blockers.push(
        `contradictory records: position marks total ₹${unrealized.toFixed(2)} but the portfolio row reports unrealised ₹${rowUnrealised.toFixed(2)}`,
      );
    }
  }

  if (blockers.length) return { ok: false, blockers };
  const equity = capital + realized + unrealized;
  if (!Number.isFinite(equity)) return { ok: false, blockers: ['computed equity is not a number'] };
  return {
    ok: true,
    capitalAtWeekStart: capital,
    realizedNetPnl: realized,
    costs,
    unrealizedPnl: unrealized,
    equity: Math.round(equity * 100) / 100,
    openPositions: input.openPositions.length,
  };
}

/** Read-only LIVE account snapshot — a separate report, never paper equity. */
export type LiveWalletSnapshot = {
  label: 'LIVE ACCOUNT/WALLET BALANCE';
  available: boolean;
  reason: string | null;
  fetchedAt: string;
  asOf: string | null;
  currency: 'INR';
  equity: { net: number | null; availableMargin: number | null; usedMargin: number | null } | null;
  raw: unknown;
  affectsPaperEquity: false;
  authorizesRealOrders: false;
  usedForSizing: false;
  note: string;
};

export type WeekRollPreview = {
  portfolioId: string;
  week: { label: string; start: string; end: string };
  alreadyApplied: boolean;
  capitalNow: number;
  ceilingNow: number;
  nextAvailableCapital: number | null;
  breakdown: WeekCloseEquity;
  openPositionsAtClose: number;
  note: string;
};

@Injectable()
export class UpstoxLivePaperCapitalContinuityService {
  private readonly logger = new Logger(UpstoxLivePaperCapitalContinuityService.name);

  constructor(
    @InjectRepository(UpstoxLivePaperPortfolio) private readonly portfolios: Repository<UpstoxLivePaperPortfolio>,
    @InjectRepository(UpstoxLivePaperTrade) private readonly trades: Repository<UpstoxLivePaperTrade>,
    @InjectRepository(UpstoxLivePaperPosition) private readonly positions: Repository<UpstoxLivePaperPosition>,
    @InjectRepository(UpstoxLivePaperPnlEvent) private readonly pnlEvents: Repository<UpstoxLivePaperPnlEvent>,
    private readonly risk: UpstoxLivePaperRiskService,
    private readonly autoentry: UpstoxLivePaperAutoEntryService,
    private readonly tokens: UpstoxLivePaperTokenService,
    private readonly config: UpstoxLivePaperConfig,
  ) {}

  /** The account the desk trades: newest portfolio first, as the desk and report do. */
  private async activePortfolio(): Promise<UpstoxLivePaperPortfolio> {
    const portfolio = await this.portfolios.findOne({ order: { createdAt: 'DESC' } });
    if (!portfolio) throw new NotFoundException('no Upstox LIVE paper portfolio exists — nothing to carry forward');
    return portfolio;
  }

  /**
   * Previous week's closing PAPER equity, computed from authoritative rows.
   * Read-only: performs no writes and no state change.
   */
  async previewWeekRoll(week?: TradingWeek): Promise<WeekRollPreview> {
    const portfolio = await this.activePortfolio();
    const target = week ?? lastCompletedTradingWeek();
    const closed = await this.trades.find({
      where: { portfolioId: portfolio.id, status: 'CLOSED' },
      order: { orderedAt: 'ASC' },
    });
    const closedAtOrBefore = closed.filter((t) => t.closedAt && new Date(t.closedAt) <= target.end);
    const openNow = await this.trades.find({ where: { portfolioId: portfolio.id, status: 'OPEN' } });
    const carriedOpen = openNow.filter((t) => !t.orderedAt || new Date(t.orderedAt) <= target.end);
    const positionRows = carriedOpen.length
      ? await this.positions.find({ where: { portfolioId: portfolio.id, status: 'OPEN' } })
      : [];
    const byTradeId = new Map(positionRows.map((p) => [p.tradeId, p]));

    const openPositionsAtClose: OpenPositionAtClose[] = carriedOpen.map((t) => {
      const row = byTradeId.get(t.id);
      return {
        instrument: t.instrument,
        side: t.side as 'BUY' | 'SELL',
        quantity: Number(t.quantity),
        // Prefer the position row (it carries the mark); fall back to the entry.
        averagePrice: Number(row?.averagePrice ?? t.entryPrice),
        markPrice: row?.markPrice === null || row?.markPrice === undefined ? null : Number(row.markPrice),
        markPriceTs: row?.markPriceTs ?? null,
      };
    });

    const breakdown = computeWeekCloseEquity({
      capitalAtWeekStart: Number(portfolio.capital),
      closedTradeNetPnl: closedAtOrBefore.reduce((s, t) => s + Number(t.netPnl || 0), 0),
      closedTradeCosts: closedAtOrBefore.reduce((s, t) => s + Number(t.cost || 0), 0),
      openPositions: openPositionsAtClose,
      portfolioNetPnl: Number(portfolio.netPnl),
      portfolioUnrealisedPnl: Number(portfolio.unrealisedPnl),
      weekEnd: target.end,
    });

    return {
      portfolioId: portfolio.id,
      week: { label: target.label, start: target.start.toISOString(), end: target.end.toISOString() },
      alreadyApplied: await this.hasRollEvent(portfolio.id, target.label),
      capitalNow: Number(portfolio.capital),
      ceilingNow: Number(portfolio.ceiling),
      nextAvailableCapital: breakdown.ok ? breakdown.equity : null,
      breakdown,
      openPositionsAtClose: openPositionsAtClose.length,
      note:
        'Next week\'s available PAPER capital is this closing equity. The configured capital is the INITIAL amount and is never reset to it, and no ceiling is imposed at that level.',
    };
  }

  private async hasRollEvent(portfolioId: string, weekLabel: string): Promise<boolean> {
    const events = await this.pnlEvents.find({
      where: { portfolioId, eventType: WEEK_CARRY_FORWARD_EVENT },
      order: { ts: 'DESC' },
      take: 200,
    });
    return events.some((e) => {
      try {
        const parsed = e.context ? (JSON.parse(e.context) as { weekLabel?: string }) : null;
        return parsed?.weekLabel === weekLabel;
      } catch {
        return false;
      }
    });
  }

  /**
   * Apply the roll: the previous week's closing equity becomes this week's
   * available PAPER capital. Idempotent per week; refuses (BLOCKED) rather than
   * guessing when the records are incomplete or contradictory.
   */
  async applyWeekRoll(options: { week?: TradingWeek; actor?: string } = {}): Promise<WeekRollPreview> {
    const preview = await this.previewWeekRoll(options.week);
    if (preview.alreadyApplied) {
      this.logger.log(`[UPSTOX-CAPITAL] week ${preview.week.label} already carried forward — no-op`);
      return preview;
    }
    if (!preview.breakdown.ok) {
      this.logger.warn(`[UPSTOX-CAPITAL] BLOCKED — ${preview.breakdown.blockers.join(' | ')}`);
      return preview;
    }

    const equity = preview.breakdown.equity;
    // Never let a wiped-out week be silently restored to the default capital by
    // clampCapital: refuse and let the operator decide.
    if (equity < MIN_ROLL_EQUITY) {
      const blocked: WeekCloseEquity = {
        ok: false,
        blockers: [
          `computed closing equity ₹${equity.toFixed(2)} is below the minimum configurable capital ₹${MIN_ROLL_EQUITY} — ` +
            'refusing to roll (a clamp would silently restore the default capital); operator decision required',
        ],
      };
      this.logger.warn(`[UPSTOX-CAPITAL] BLOCKED — ${blocked.blockers[0]}`);
      return { ...preview, nextAvailableCapital: null, breakdown: blocked };
    }

    const actor = options.actor ?? 'capital-continuity';
    const previous = preview.capitalNow;

    // The carry-forward record is written FIRST and unconditionally: it is the
    // authoritative marker that this week was rolled (even when the value is
    // unchanged), and it keeps the full breakdown as evidence.
    await this.pnlEvents.save(
      this.pnlEvents.create({
        portfolioId: preview.portfolioId,
        tradeId: null,
        eventType: WEEK_CARRY_FORWARD_EVENT,
        pnlDelta: 0,
        runningNetPnl: Number((await this.activePortfolio()).netPnl),
        description:
          `Week ${preview.week.label} closed · equity ₹${equity.toFixed(2)} becomes available PAPER capital ` +
          `(₹${previous.toFixed(2)} → ₹${equity.toFixed(2)}) · by ${actor}`,
        context: JSON.stringify({
          weekLabel: preview.week.label,
          weekStart: preview.week.start,
          weekEnd: preview.week.end,
          capitalAtWeekStart: preview.breakdown.capitalAtWeekStart,
          realizedNetPnl: preview.breakdown.realizedNetPnl,
          costsAlreadyInsideRealized: preview.breakdown.costs,
          unrealizedMarkToMarket: preview.breakdown.unrealizedPnl,
          closingEquity: equity,
          previousAvailableCapital: previous,
          newAvailableCapital: equity,
          openPositionsAtClose: preview.openPositionsAtClose,
          actor,
          note: 'initial capital is a starting point only — never a weekly reset or a ceiling',
        }),
        dataSource: 'UPSTOX',
        executionMode: 'PAPER',
        ts: new Date(),
      }),
    );

    // Reuse the audited capital path: it sets ceiling = capital (no artificial
    // ₹5,000 cap), keeps history, and supersedes/reopens the session so every
    // limit scales from the capital actually in force.
    if (Number(equity.toFixed(2)) !== Number(previous.toFixed(2))) {
      await this.risk.updateCapital(preview.portfolioId, equity, {
        reason: `week ${preview.week.label} carry-forward (closing equity)`,
        actor,
      });
    }
    this.logger.log(`[UPSTOX-CAPITAL] week ${preview.week.label} carried forward: ₹${previous.toFixed(2)} → ₹${equity.toFixed(2)}`);
    return await this.previewWeekRoll(options.week);
  }

  /**
   * Every position that was legitimately open at the previous week's close, with
   * its authoritative identity re-verified. Nothing is invented; an unresolvable
   * expiry is reported rather than assumed.
   */
  async discoverCarriedPositions(week?: TradingWeek): Promise<{
    week: { label: string; start: string; end: string };
    positions: Array<Record<string, unknown>>;
    blockers: string[];
  }> {
    const portfolio = await this.activePortfolio();
    const target = week ?? lastCompletedTradingWeek();
    const openNow = await this.trades.find({ where: { portfolioId: portfolio.id, status: 'OPEN' } });
    const carried = openNow.filter((t) => !t.orderedAt || new Date(t.orderedAt) <= target.end);
    const rows = await this.positions.find({ where: { portfolioId: portfolio.id } });
    const blockers: string[] = [];

    const positions = carried.map((t) => {
      const row = rows.find((r) => r.tradeId === t.id);
      if (!row) {
        blockers.push(`trade ${t.id} (${t.instrument}) is OPEN but has no position row — contradictory records`);
      } else {
        if (row.instrument !== t.instrument) blockers.push(`trade ${t.id}: instrument differs between trade (${t.instrument}) and position (${row.instrument})`);
        if (row.side !== t.side) blockers.push(`trade ${t.id}: side differs between trade (${t.side}) and position (${row.side})`);
        if (Number(row.quantity) !== Number(t.quantity)) blockers.push(`trade ${t.id}: quantity differs between trade (${t.quantity}) and position (${row.quantity})`);
        if (row.status !== 'OPEN') blockers.push(`trade ${t.id}: position row status is ${row.status}`);
      }
      // Expiry is not stored on the trade: derive it from the contract symbol
      // deterministically. If the symbol does not carry one, say so — never guess.
      const parsed = parseOptionSymbol(t.instrument, new Date(t.orderedAt ?? Date.now()));
      if (!parsed.expiry) blockers.push(`trade ${t.id}: expiry is not derivable from the contract symbol ${t.instrument}`);
      return {
        tradeId: t.id,
        instrument: t.instrument,
        side: t.side,
        quantity: Number(t.quantity),
        entryPrice: Number(t.entryPrice),
        orderedAt: t.orderedAt ?? null,
        status: t.status,
        executionMode: t.executionMode,
        algoSource: t.algoSource,
        decisionId: t.decisionId,
        derivedExpiry: parsed.expiry,
        derivedStrike: parsed.strike,
        derivedOptionType: parsed.optionType,
        markPrice: row?.markPrice ?? null,
        markPriceTs: row?.markPriceTs ?? null,
        unrealisedPnl: row?.unrealisedPnl ?? null,
      };
    });
    return {
      week: { label: target.label, start: target.start.toISOString(), end: target.end.toISOString() },
      positions,
      blockers,
    };
  }

  /**
   * Re-evaluate every carried position with the desk's OWN exit policy and act.
   *
   * The evaluation and (on EXIT) the paper fill are the desk's existing
   * `manageOpenTrades` cycle — the same rules, the same data, the same execution
   * model — so a carried position is judged exactly as it would have been had the
   * week not changed. Each outcome is recorded as a decision with its reason.
   */
  async carryForwardPositions(options: { week?: TradingWeek; apply?: boolean; actor?: string } = {}): Promise<Record<string, unknown>> {
    const discovered = await this.discoverCarriedPositions(options.week);
    const apply = options.apply === true;
    if (!discovered.positions.length) {
      return {
        ...discovered,
        applied: false,
        decisions: [],
        note:
          discovered.blockers.length
            ? 'no carried positions could be verified — see blockers'
            : 'no legitimate PAPER position was open at the previous close: nothing to carry (this is a discovery result, not an assumption)',
      };
    }
    if (!apply) {
      return {
        ...discovered,
        applied: false,
        decisions: [],
        note: 'preview only — positions would be evaluated with the desk exit policy and either HELD (carried) or EXITed through the normal paper fill; nothing was changed',
      };
    }

    const portfolio = await this.activePortfolio();
    const before = await this.positions.find({ where: { portfolioId: portfolio.id, status: 'OPEN' } });
    const outcomes = await this.autoentry.manageCarriedPositions(portfolio.id);
    const actor = options.actor ?? 'capital-continuity';

    const decisions = outcomes.map((o) => {
      const tradeId = String(o.tradeId ?? '');
      const exited = o.exit === true;
      const reason = exited ? String(o.reason ?? 'EXIT') : 'HOLD';
      return {
        tradeId,
        decision: exited ? 'EXIT' : 'HOLD',
        reason,
        detail: o,
      };
    });
    for (const d of decisions) {
      await this.pnlEvents.save(
        this.pnlEvents.create({
          portfolioId: portfolio.id,
          tradeId: d.tradeId || null,
          eventType: WEEK_CARRY_DECISION_EVENT,
          pnlDelta: 0,
          runningNetPnl: Number((await this.activePortfolio()).netPnl),
          description: `Carry-forward ${discovered.week.label}: ${d.decision} (${d.reason}) · by ${actor}`,
          context: JSON.stringify({ weekLabel: discovered.week.label, actor, ...d.detail, decision: d.decision, reason: d.reason }),
          dataSource: 'UPSTOX',
          executionMode: 'PAPER',
          ts: new Date(),
        }),
      );
    }
    const after = await this.positions.find({ where: { portfolioId: portfolio.id, status: 'OPEN' } });
    this.logger.log(
      `[UPSTOX-CAPITAL] carry-forward ${discovered.week.label}: ${decisions.filter((d) => d.decision === 'HOLD').length} held, ` +
        `${decisions.filter((d) => d.decision === 'EXIT').length} exited · open positions ${before.length} → ${after.length}`,
    );
    return {
      week: discovered.week,
      applied: true,
      positions: discovered.positions,
      blockers: discovered.blockers,
      decisions,
      openPositionsBefore: before.length,
      openPositionsAfter: after.length,
      note: 'HELD positions stay in this portfolio with their capital usage counted once; EXITs used the normal paper fill and their costs are in the ledger',
    };
  }

  /**
   * LIVE account/wallet balance — a SEPARATE, read-only report.
   *
   * It is never added to paper equity, never used for sizing, and never
   * authorizes a real order (real execution stays behind the existing gates).
   * When no valid LIVE credential is available it reports that plainly.
   */
  async liveWallet(): Promise<LiveWalletSnapshot> {
    const base: Omit<LiveWalletSnapshot, 'available' | 'reason' | 'equity' | 'raw' | 'asOf'> = {
      label: 'LIVE ACCOUNT/WALLET BALANCE',
      fetchedAt: new Date().toISOString(),
      currency: 'INR',
      affectsPaperEquity: false,
      authorizesRealOrders: false,
      usedForSizing: false,
      note: 'Displayed for account/buying-power awareness only. PAPER equity is reported separately and is never mixed with this balance.',
    };
    if (!this.config.liveCredentialsPresent) {
      return { ...base, available: false, reason: 'no LIVE Upstox credentials configured', equity: null, raw: null, asOf: null };
    }
    let token: { token: string };
    try {
      token = await this.tokens.getValidUpstoxAccessToken();
    } catch (error) {
      return { ...base, available: false, reason: (error as Error).message, equity: null, raw: null, asOf: null };
    }
    try {
      const response = await fetch(LIVE_FUNDS_URL, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token.token}`,
          ...(this.config.liveApiKey ? { 'x-api-key': this.config.liveApiKey } : {}),
        },
        signal: AbortSignal.timeout(15_000),
      });
      const text = await response.text();
      if (!response.ok) {
        return { ...base, available: false, reason: `HTTP ${response.status} from ${LIVE_FUNDS_URL}`, equity: null, raw: text.slice(0, 500), asOf: null };
      }
      const parsed = JSON.parse(text) as { data?: { equity?: Record<string, number> } };
      const equity = parsed?.data?.equity ?? null;
      const num = (key: string): number | null => (equity && Number.isFinite(Number(equity[key])) ? Number(equity[key]) : null);
      return {
        ...base,
        available: equity !== null,
        reason: equity === null ? 'funds response carried no equity segment' : null,
        asOf: new Date().toISOString(),
        equity: equity === null ? null : { net: num('net'), availableMargin: num('available_margin'), usedMargin: num('used_margin') },
        raw: parsed,
      };
    } catch (error) {
      return { ...base, available: false, reason: (error as Error).message, equity: null, raw: null, asOf: null };
    }
  }
}
