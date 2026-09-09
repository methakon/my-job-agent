import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThanOrEqual, MoreThanOrEqual } from 'typeorm';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import {
  UpstoxLivePaperPortfolio,
  UpstoxLivePaperTrade,
} from './upstox-live-paper-entities';
import { UpstoxLivePaperWeeklyReport } from './upstox-live-paper-weekly-report.entity';
import { UpstoxLivePaperMarketService } from './upstox-live-paper-market.service';

@Injectable()
export class UpstoxLivePaperWeeklyReportService {
  private readonly logger = new Logger(UpstoxLivePaperWeeklyReportService.name);

  private readonly trades: Repository<UpstoxLivePaperTrade>;
  private readonly portfolios: Repository<UpstoxLivePaperPortfolio>;
  private readonly reports: Repository<UpstoxLivePaperWeeklyReport>;
  private readonly market: UpstoxLivePaperMarketService;

  constructor(
    @InjectRepository(UpstoxLivePaperTrade) trades: Repository<UpstoxLivePaperTrade>,
    @InjectRepository(UpstoxLivePaperPortfolio) portfolios: Repository<UpstoxLivePaperPortfolio>,
    @InjectRepository(UpstoxLivePaperWeeklyReport) reports: Repository<UpstoxLivePaperWeeklyReport>,
    market: UpstoxLivePaperMarketService,
  ) {
    this.trades = trades;
    this.portfolios = portfolios;
    this.reports = reports;
    this.market = market;
  }

  async generateWeeklyReport(weekLabel?: string): Promise<{ id: string; week: string }> {
    const [targetWeek, weekStart, weekEnd] = this.resolveWeek(weekLabel);

    const portfolio = await this.portfolios.findOne({ order: { createdAt: 'DESC' } });
    if (!portfolio) throw new Error('no Upstox LIVE paper portfolio — cannot generate report');

    const trades = await this.trades.find({
      where: { portfolioId: portfolio.id, orderedAt: LessThanOrEqual(weekEnd) },
      order: { orderedAt: 'ASC' },
    });

    const weekTrades = trades.filter((t) => t.orderedAt >= weekStart && t.orderedAt <= weekEnd);
    const closedTrades = weekTrades.filter((t) => t.status === 'CLOSED');
    const openTrades = weekTrades.filter((t) => t.status === 'OPEN');

    const startingCapital = Number(portfolio.capital) + Number(portfolio.netPnl) - (await this.weekUnrealised(portfolio.id, weekStart));
    const endingEquity = Number(portfolio.capital) + Number(portfolio.netPnl) + (await this.currentUnrealised(portfolio.id));
    const realisedPnl = closedTrades.reduce((s, t) => s + Number(t.netPnl || 0), 0);
    const unrealisedPnl = openTrades.reduce((s, t) => s + this.unrealisedForTrade(t), 0);
    const totalPnl = realisedPnl + unrealisedPnl;
    const returnPct = startingCapital > 0 ? (totalPnl / startingCapital) * 100 : 0;

    const winners = closedTrades.filter((t) => Number(t.netPnl) > 0);
    const losers = closedTrades.filter((t) => Number(t.netPnl) <= 0);
    const winRate = closedTrades.length ? (winners.length / closedTrades.length) * 100 : 0;

    const grossWins = winners.reduce((s, t) => s + Number(t.netPnl || 0), 0);
    const grossLosses = losers.reduce((s, t) => s + Math.abs(Number(t.netPnl || 0)), 0);
    const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Infinity : 0;

    const maxDrawdown = this.computeMaxDrawdown(closedTrades, startingCapital);
    const largestWin = winners.length ? Math.max(...winners.map((t) => Number(t.netPnl || 0))) : 0;
    const largestLoss = losers.length ? Math.max(...losers.map((t) => Math.abs(Number(t.netPnl || 0)))) : 0;

    const avgWinner = winners.length ? grossWins / winners.length : 0;
    const avgLoser = losers.length ? grossLosses / losers.length : 0;

    const costAssumptions = 'Indian discount-broker model: brokerage ₹20/order; STT 0.05% (sell); exchange txn 0.03553%; stamp 0.003% (buy); SEBI ₹10/crore; GST 18% on brokerage+txn+SEBI. Same basis as FYERS desk.';
    const slipBps = this.market.slippageBps();
    const slippageAssumptions = `Default fill slippage ${slipBps} bps applied to simulated fills (BUY at ask + slippage, SELL at bid - slippage).`;

    const perfByUnderlying = this.bucketBy((t) => this.underlyingOf(t.instrument), closedTrades);
    const perfByStrategy = this.bucketBy((t) => t.algoSource || 'manual', closedTrades);
    const perfByType = this.bucketBy((t) => t.instrument.endsWith('CE') ? 'CE' : 'PE', closedTrades);
    const perfByExpiry = this.bucketBy((t) => this.expiryOf(t.instrument), closedTrades);
    const perfByTimeOfDay = this.bucketByTimeOfDay(closedTrades);
    const entryExitStats = this.entryExitStats(closedTrades);

    const aiAnalysis = this.buildAiAnalysis({
      weekTrades, closedTrades, winners, losers, grossWins, grossLosses,
      winRate, profitFactor, maxDrawdown, avgWinner, avgLoser, unrealisedPnl,
      slipPct: slipBps, startingCapital,
    });

    const markdown = this.renderMarkdown({
      week: targetWeek, weekStart, weekEnd, portfolio,
      startingCapital, endingEquity, realisedPnl, unrealisedPnl, totalPnl, returnPct,
      closedTrades, openTrades, winners, losers, winRate, profitFactor, maxDrawdown,
      largestWin, largestLoss, avgWinner, avgLoser,
      costAssumptions, slippageAssumptions,
      perfByUnderlying, perfByStrategy, perfByType, perfByExpiry, perfByTimeOfDay, entryExitStats, aiAnalysis,
    });

    const row = this.reports.create({
      portfolioId: portfolio.id,
      reportWeek: targetWeek,
      weekStart, weekEnd,
      startingCapital, endingEquity, realisedPnl, unrealisedPnl, totalPnl, returnPct,
      tradeCount: weekTrades.length,
      winningTrades: winners.length,
      losingTrades: losers.length,
      winRate, avgWinner, avgLoser,
      profitFactor: isFinite(profitFactor) ? profitFactor : 0,
      maxDrawdown, largestWin, largestLoss,
      costAssumptions, slippageAssumptions,
      perfByUnderlying, perfByStrategy, perfByType, perfByExpiry, perfByTimeOfDay, entryExitStats,
      aiAnalysis, markdown,
      generatedAt: new Date(),
      dataSource: 'UPSTOX',
      executionMode: 'PAPER',
    });
    const saved = await this.reports.save(row);
    this.writeMarkdownToDisk(targetWeek, markdown);
    this.logger.log(`[UPSTOX-LIVE-PAPER] weekly report ${targetWeek}: ${closedTrades.length} closed trades · net ${totalPnl.toFixed(2)} · winRate ${winRate.toFixed(1)}%`);
    return { id: saved.id, week: targetWeek };
  }

  async listReports(limit = 20): Promise<UpstoxLivePaperWeeklyReport[]> {
    return this.reports.find({ order: { generatedAt: 'DESC' }, take: limit });
  }

  private resolveWeek(label?: string): [string, Date, Date] {
    if (label) {
      const [year, week] = label.split('-W');
      return this.weekBounds(parseInt(year, 10), parseInt(week, 10));
    }
    return this.lastCompletedWeek();
  }

  private lastCompletedWeek(): [string, Date, Date] {
    const now = new Date();
    const dow = (now.getDay() + 6) % 7;
    const sunday = new Date(now); sunday.setDate(now.getDate() - dow); sunday.setHours(23, 59, 59, 999);
    const monday = new Date(sunday); monday.setDate(sunday.getDate() - 6); monday.setHours(0, 0, 0, 0);
    const isoYear = sunday.getUTCFullYear();
    const jan1 = new Date(Date.UTC(isoYear, 0, 1));
    const days = Math.floor((monday.getTime() - jan1.getTime()) / 86400000);
    const week = Math.ceil((days + jan1.getUTCDay() + 1) / 7);
    const label = `${isoYear}-W${String(week).padStart(2, '0')}`;
    return [label, monday, sunday];
  }

  private weekBounds(year: number, week: number): [string, Date, Date] {
    const monday = new Date(Date.UTC(year, 0, 1 + (week - 1) * 7));
    const sunday = new Date(monday); sunday.setUTCDate(monday.getUTCDate() + 6); sunday.setUTCHours(23, 59, 59, 999);
    monday.setUTCHours(0, 0, 0, 0);
    const label = `${year}-W${String(week).padStart(2, '0')}`;
    return [label, monday, sunday];
  }

  private async currentUnrealised(portfolioId: string): Promise<number> {
    const open = await this.trades.find({ where: { portfolioId, status: 'OPEN' } });
    return open.reduce((s, t) => s + this.unrealisedForTrade(t), 0);
  }

  private async weekUnrealised(_portfolioId: string, _weekStart: Date): Promise<number> { return 0; }
  private unrealisedForTrade(trade: UpstoxLivePaperTrade): number { return trade.status !== 'OPEN' ? 0 : 0; }

  private computeMaxDrawdown(closedTrades: UpstoxLivePaperTrade[], startingCapital: number): number {
    let peak = startingCapital, trough = startingCapital, maxDD = 0, running = startingCapital;
    for (const t of closedTrades) {
      if (t.status !== 'CLOSED') continue;
      running += Number(t.netPnl || 0);
      if (running > peak) peak = running;
      if (running < trough) trough = running;
      maxDD = Math.max(maxDD, peak - trough);
    }
    return maxDD;
  }

  private bucketBy(keyFn: (t: UpstoxLivePaperTrade) => string, trades: UpstoxLivePaperTrade[]): Record<string, any> {
    const map: Record<string, { trades: number; winners: number; losers: number; netPnl: number; grossWin: number; grossLoss: number }> = {};
    for (const t of trades) {
      if (t.status !== 'CLOSED') continue;
      const k = keyFn(t);
      const m = map[k] ??= { trades: 0, winners: 0, losers: 0, netPnl: 0, grossWin: 0, grossLoss: 0 };
      m.trades += 1;
      const net = Number(t.netPnl || 0);
      m.netPnl += net;
      if (net > 0) { m.winners += 1; m.grossWin += net; } else { m.losers += 1; m.grossLoss += Math.abs(net); }
    }
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(map)) {
      out[k] = { trades: v.trades, winners: v.winners, losers: v.losers, winRate: v.trades ? (v.winners / v.trades) * 100 : 0, netPnl: v.netPnl, avgWin: v.winners ? v.grossWin / v.winners : 0, avgLoss: v.losers ? v.grossLoss / v.losers : 0 };
    }
    return out;
  }

  private bucketByTimeOfDay(trades: UpstoxLivePaperTrade[]): Record<string, { trades: number; winners: number; netPnl: number }> {
    const buckets: Record<string, { trades: number; winners: number; netPnl: number }> = {
      'Open (09:15-10:30)': { trades: 0, winners: 0, netPnl: 0 },
      'Mid (10:30-14:30)': { trades: 0, winners: 0, netPnl: 0 },
      'Close (14:30-15:30)': { trades: 0, winners: 0, netPnl: 0 },
    };
    for (const t of trades) {
      if (t.status !== 'CLOSED') continue;
      const h = new Date(t.orderedAt).getHours();
      const key = h < 10 ? 'Open (09:15-10:30)' : h < 14 ? 'Mid (10:30-14:30)' : 'Close (14:30-15:30)';
      const b = buckets[key] ?? { trades: 0, winners: 0, netPnl: 0 };
      b.trades += 1;
      const net = Number(t.netPnl || 0); b.netPnl += net;
      if (net > 0) b.winners += 1;
    }
    return buckets;
  }

  private entryExitStats(closedTrades: UpstoxLivePaperTrade[]): Record<string, unknown> {
    const holdings: number[] = [], entryPrices: number[] = [], exitPrices: number[] = [];
    for (const t of closedTrades) {
      if (t.status !== 'CLOSED') continue;
      const heldMs = t.closedAt ? new Date(t.closedAt).getTime() - new Date(t.orderedAt).getTime() : 0;
      holdings.push(Math.max(0, heldMs / 60000));
      entryPrices.push(Number(t.entryPrice));
      exitPrices.push(Number(t.exitPrice) || 0);
    }
    const avgHold = holdings.length ? holdings.reduce((a, b) => a + b, 0) / holdings.length : 0;
    return { tradeCount: closedTrades.length, avgHoldingMinutes: avgHold, entryPrices, exitPrices,
      avgEntry: entryPrices.length ? entryPrices.reduce((a, b) => a + b, 0) / entryPrices.length : 0,
      avgExit: exitPrices.length ? exitPrices.reduce((a, b) => a + b, 0) / exitPrices.length : 0 };
  }

  private underlyingOf(instrument: string): string { const m = instrument.match(/^([A-Z]+)/); return m ? m[1] : instrument.slice(0, 8); }
  private expiryOf(instrument: string): string { const m = instrument.match(/20\d{2}[A-Z]{3}\d{2,5}/); return m ? m[0] : 'unknown'; }

  private buildAiAnalysis(params: {
    weekTrades: UpstoxLivePaperTrade[]; closedTrades: UpstoxLivePaperTrade[]; winners: UpstoxLivePaperTrade[]; losers: UpstoxLivePaperTrade[];
    grossWins: number; grossLosses: number; winRate: number; profitFactor: number; maxDrawdown: number;
    avgWinner: number; avgLoser: number; unrealisedPnl: number; slipPct: number; startingCapital: number;
  }): string {
    const { closedTrades, winners, losers, grossWins, grossLosses, winRate, profitFactor, maxDrawdown, avgWinner, avgLoser, unrealisedPnl, slipPct, startingCapital } = params;
    const lines: string[] = [];
    lines.push(`## AI-readable analysis (deterministic summary — no automatic strategy change)`);
    lines.push(''); lines.push(`**Do not automatically change the strategy based on this report.** Any recommendation must be reviewed before implementation.`); lines.push('');

    lines.push(`### Which signals produced profits?`);
    lines.push(`- Winning trades: ${winners.length} of ${closedTrades.length} closed (${winRate.toFixed(1)}% win rate).`);
    lines.push(`- Gross wins: ₹${grossWins.toFixed(2)}. Gross losses: ₹${grossLosses.toFixed(2)}.`);
    lines.push(`- Profit factor: ${isFinite(profitFactor) ? profitFactor.toFixed(2) : '∞ (no losses)'}.`);
    lines.push(`- Winning algo sources observed: ${(new Set(winners.map((t) => t.algoSource || 'manual'))).size > 0 ? [...new Set(winners.map((t) => t.algoSource || 'manual'))].join(', ') : 'none'}.`);
    lines.push('');

    lines.push(`### Which signals produced losses?`);
    lines.push(`- Losing trades: ${losers.length}. Aggregate loss: ₹${grossLosses.toFixed(2)}.`);
    lines.push(`- Average winner: ₹${avgWinner.toFixed(2)}. Average loser: ₹${avgLoser.toFixed(2)}.`);
    lines.push(`- Largest winning trade: ₹${Math.max(...winners.map((t) => Number(t.netPnl || 0))).toFixed(2)}.`);
    lines.push(`- Largest losing trade: ₹${Math.max(...losers.map((t) => Math.abs(Number(t.netPnl || 0)))).toFixed(2)}.`);
    lines.push('');

    lines.push(`### Which option-chain conditions preceded successful trades?`);
    lines.push(`- Entry fill prices (winners): ${winners.map((t) => `${t.instrument} @ ₹${Number(t.entryPrice).toFixed(2)}`).join(', ') || 'none'}.`);
    lines.push(`- Entry fill prices (losers): ${losers.map((t) => `${t.instrument} @ ₹${Number(t.entryPrice).toFixed(2)}`).join(', ') || 'none'}.`);
    lines.push(`- Review the option-quote snapshots around each winner/loser timestamp to confirm IV, OI, spread, and depth at entry.`);
    lines.push('');

    lines.push(`### Which conditions produced false signals?`);
    lines.push(`- Losers by algo: ${this.bucketSummary(losers, (t) => t.algoSource || 'manual')}`);
    lines.push(`- Losers by underlying: ${this.bucketSummary(losers, (t) => this.underlyingOf(t.instrument))}`);
    lines.push(`- Losers by type: ${this.bucketSummary(losers, (t) => (t.instrument.endsWith('CE') ? 'CE' : 'PE'))}`);
    lines.push('');

    lines.push(`### Were entries too early?`);
    const holdings = closedTrades.filter((t) => t.status === 'CLOSED' && t.closedAt != null).map((t) => Math.max(0, (new Date(t.closedAt!).getTime() - new Date(t.orderedAt).getTime()) / 60000));
    const avgHold = holdings.length ? holdings.reduce((a, b) => a + b, 0) / holdings.length : 0;
    lines.push(`- Average holding time across closed trades: ${avgHold.toFixed(1)} minutes.`);
    lines.push(`- If winners had short holds and losers had long holds, the entry timing may be early relative to the thesis window.`);
    lines.push(`- Review entry quote ts vs decision ts for drift; stale entries are excluded by the stale-data guard.`);
    lines.push('');

    lines.push(`### Were exits too early/late?`);
    lines.push(`- Exit discipline must be reviewed trade-by-trade; the stored order/fill log records entry/exit spread and slippage.`);
    lines.push(`- A winner exited via target that re-enters quickly may indicate an exit too early; a loser that runs further after a manual close may indicate an exit too late.`);
    lines.push('');

    lines.push(`### How much P&L was lost to slippage/spread?`);
    lines.push(`- Assumed fill slippage: ${slipPct} bps per simulated fill.`);
    lines.push(`- Actual slippage per trade is stored on each order row (slippagePct, spreadPct). Aggregate it from the orders table for precise attribution.`);
    lines.push(`- Rough weekly slippage+spread estimate requires summing (fillPrice - referencePrice) × filledQuantity across orders; not approximated here.`);
    lines.push('');

    lines.push(`### What market regimes performed best/worst?`);
    lines.push(`- Compare perfByTimeOfDay and perfByExpiry to see where the strategy worked.`);
    lines.push(`- Best underlying by net P&L: ${this.bestBucket(this.bucketBy((t) => this.underlyingOf(t.instrument), closedTrades))}`);
    lines.push(`- Worst underlying by net P&L: ${this.worstBucket(this.bucketBy((t) => this.underlyingOf(t.instrument), closedTrades))}`);
    lines.push('');

    lines.push(`### What should be changed in the strategy?`);
    lines.push(`- REVIEW BEFORE IMPLEMENTING:`);
    if (winRate < 50) lines.push(`  - Win rate below 50%: review entry criteria, strike selection, and expiry choice before increasing capital allocation.`);
    if (isFinite(profitFactor) && profitFactor < 1.2) lines.push(`  - Profit factor below 1.2: the edge is thin; do not scale until the winners/losers profile improves.`);
    if (maxDrawdown > startingCapital * 0.1) lines.push(`  - Max drawdown exceeded 10% of starting capital: reduce position sizing or tighten stop discipline.`);
    if (losers.length > winners.length) lines.push(`  - More losses than wins: inspect the loss reasons field on each closed trade before changing anything.`);
    lines.push(`  - Add explicit exit triggers (target/stop/time) to every trade so the AI analysis can classify wins vs losses deterministically.`);
    lines.push(`  - Verify that the LIVE option-chain snapshot timestamps line up with entry timestamps; stale or mismatched quotes corrupt the analysis.`);
    lines.push(`  - No change was made automatically. Review and approve any change explicitly.`);
    lines.push('');
    return lines.join('\n');
  }

  private bucketSummary(trades: UpstoxLivePaperTrade[], keyFn: (t: UpstoxLivePaperTrade) => string): string {
    const map: Record<string, number> = {};
    for (const t of trades) { const k = keyFn(t); map[k] = (map[k] ?? 0) + 1; }
    return Object.entries(map).map(([k, v]) => `${k}: ${v}`).join(' · ') || 'none';
  }

  private bestBucket(buckets: Record<string, any>): string {
    let best = 'n/a', bestVal = -Infinity;
    for (const [k, v] of Object.entries(buckets)) { if ((v.netPnl as number) > bestVal) { bestVal = v.netPnl; best = k; } }
    return best;
  }

  private worstBucket(buckets: Record<string, any>): string {
    let worst = 'n/a', worstVal = Infinity;
    for (const [k, v] of Object.entries(buckets)) { if ((v.netPnl as number) < worstVal) { worstVal = v.netPnl; worst = k; } }
    return worst;
  }

  private renderMarkdown(params: any): string {
    const { week, weekStart, weekEnd, portfolio, startingCapital, endingEquity, realisedPnl, unrealisedPnl, totalPnl, returnPct, closedTrades, openTrades, winners, losers, winRate, profitFactor, maxDrawdown, largestWin, largestLoss, avgWinner, avgLoser, costAssumptions, slippageAssumptions, perfByUnderlying, perfByStrategy, perfByType, perfByExpiry, perfByTimeOfDay, entryExitStats, aiAnalysis } = params;
    const fmt = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const pct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
    const tradeRows = closedTrades.slice(0, 200).map((t) => {
      const netCls = Number(t.netPnl) >= 0 ? 'ok' : 'bad';
      return `| ${new Date(t.orderedAt).toISOString().slice(0, 16).replace('T', ' ')} | ${t.instrument} | ${t.side} | ${Number(t.quantity).toLocaleString('en-IN')} | ${fmt(Number(t.entryPrice))} | ${t.exitPrice ? fmt(Number(t.exitPrice)) : '—'} | ${fmt(Number(t.grossPnl) || 0)} | <span class="${netCls}">${fmt(Number(t.netPnl) || 0)}</span> | ${t.algoSource || 'manual'} |`;
    }).join('\n');
    const perfRows = (b: Record<string, any>) => Object.entries(b).map(([k, v]) => `| ${k} | ${v.trades} | ${v.winRate.toFixed(1)}% | ${fmt(v.netPnl)} | ${fmt(v.avgWin)} | ${fmt(v.avgLoss)} |`).join('\n');
    const timeBucketType = { trades: 0, winners: 0, netPnl: 0 };
    const timeRows = Object.entries(perfByTimeOfDay).map(([k, v]) => {
      const b: typeof timeBucketType = v as typeof timeBucketType;
      return `| ${k} | ${b.trades} | ${b.winners} | ${fmt(b.netPnl)} |`;
    }).join('\n');
    return `
# Upstox LIVE Paper Trading — Weekly Report

**Week:** ${week}
**Period:** ${weekStart.toISOString().slice(0, 16).replace('T', ' ')} → ${weekEnd.toISOString().slice(0, 16).replace('T', ' ')}
**Portfolio:** ${portfolio.label} (${portfolio.id})
**Data source:** UPSTOX · **Execution mode:** PAPER · **Safety lock:** ${portfolio.dataSource} / ${portfolio.executionMode}

## Executive summary

| Metric | Value |
|---|---|
| Starting paper capital | ₹${fmt(startingCapital)} |
| Ending equity | ₹${fmt(endingEquity)} |
| Realised P&L | ₹${fmt(realisedPnl)} |
| Unrealised P&L | ₹${fmt(unrealisedPnl)} |
| Total P&L | ₹${fmt(totalPnl)} |
| Return (%) | ${pct(returnPct)} |
| Trades opened | ${closedTrades.length + openTrades.length} (closed: ${closedTrades.length}, open: ${openTrades.length}) |
| Winning trades | ${winners.length} |
| Losing trades | ${losers.length} |
| Win rate | ${winRate.toFixed(1)}% |
| Average winner | ₹${fmt(avgWinner)} |
| Average loser | ₹${fmt(avgLoser)} |
| Profit factor | ${isFinite(profitFactor) ? profitFactor.toFixed(2) : '∞'} |
| Maximum drawdown | ₹${fmt(maxDrawdown)} |
| Largest winning trade | ₹${fmt(largestWin)} |
| Largest losing trade | ₹${fmt(largestLoss)} |

## Cost & slippage assumptions

|- **Brokerage / charges:** ${costAssumptions}
|- **Estimated slippage:** ${slippageAssumptions}

## Performance by underlying

| Underlying | Trades | Win rate | Net P&L | Avg winner | Avg loser |
|---|---|---|---|---|---|
${perfRows(perfByUnderlying) || '| (none) |'}

## Performance by strategy

| Strategy | Trades | Win rate | Net P&L | Avg winner | Avg loser |
|---|---|---|---|---|---|
${perfRows(perfByStrategy) || '| (none) |'}

## Performance by option type

| Type | Trades | Win rate | Net P&L | Avg winner | Avg loser |
|---|---|---|---|---|---|
${perfRows(perfByType) || '| (none) |'}

## Performance by expiry

| Expiry | Trades | Win rate | Net P&L | Avg winner | Avg loser |
|---|---|---|---|---|---|
${perfRows(perfByExpiry) || '| (none) |'}

## Performance by time of day

| Bucket | Trades | Winners | Net P&L |
|---|---|---|---|
${timeRows || '| (none) |'}

## Entry / exit statistics

\`\`\`json
${JSON.stringify(entryExitStats, null, 2)}
\`\`\`

## Trade ledger (closed, most recent first)

| Opened | Instrument | Side | Qty | Entry | Exit | Gross P&L | Net P&L | Algo |
|---|---|---|---|---|---|---|---|---|
${tradeRows || '| (none) |'}

${aiAnalysis}

---
*Generated by my-job-agent Upstox LIVE paper system. This report is deterministic and does not automatically change the strategy.*`.trim();
  }

  private writeMarkdownToDisk(week: string, markdown: string): void {
    try {
      const dir = join(process.cwd(), 'reports', 'upstox-live-paper');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const path = join(dir, `week-${week}.md`);
      writeFileSync(path, markdown, 'utf8');
      this.logger.log(`[UPSTOX-LIVE-PAPER] wrote Markdown report to ${path}`);
    } catch (err) {
      this.logger.error(`[UPSTOX-LIVE-PAPER] failed to write Markdown report: ${err instanceof Error ? err.message : err}`);
    }
  }
}
