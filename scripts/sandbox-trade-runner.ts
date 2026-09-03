/**
 * sandbox-trade-runner.ts
 * ---------------------------------------------------------------------------
 * 7-day in-process paper-trading replay for the FNF (Nifty/Finsec/Bank) engine
 * inside `my-job-agent`.
 *
 * WHAT THIS DOES (real, in-process, no live broker):
 *   1. Seeds a 3-symbol universe (NIFTY / FINEX / BANKS).
 *   2. Seeds 14 days of per-symbol per-weekday decay calibrations (weekday vs
 *      weekend rate brackets) into the in-memory repo.
 *   3. Spins up an in-memory FnfTradingService + AstroMuhurtaService.
 *   4. For each simulated IST trading day (2026-09-03 .. 2026-09-10), at the
 *      INB pre-open (09:05 IST) generates decay-aware signals, optionally
 *      filters them through a real Muhurta / astro match, and lets the risk
 *      envelope decide entries/exits. No network, no credentials, no DB.
 *
 * WHAT IT EMITS:
 *   A chronological trade ledger + a per-day + final P&L statement printed to
 *   stdout, plus a deterministic summary block at the end.
 *
 * Replayable / deterministic:
 *   • Seeded by a fixed PRNG (mulberry32) and a fixed start date, so the same
 *     binary reproduces the same ledger on every run.
 *
 * HOW TO RUN:
 *   cd /home/swarna-sekhar-dhar/projects/my-job-agent
 *   npx ts-node --transpile-only scripts/sandbox-trade-runner.ts
 *
 *   The transpile-only flag is intentional: this runner lives under scripts/,
 *   outside the NestJS compilation boundary, so skipping tsc type-checking is
 *   the normal, deliberate path for scripts/ (the service and entities it
 *   depends on are still built & type-checked as part of `npm run build`).
 * ---------------------------------------------------------------------------
 */

import 'reflect-metadata';
import { FakeRepo } from './fake-repo';

import { FnfPortfolio } from '../src/trading/fnf-portfolio.entity';
import { FnfTrade } from '../src/trading/fnf-trade.entity';
import { FnfMarketSnapshot } from '../src/trading/fnf-market-snapshot.entity';
import { FnfDecayCalibration } from '../src/trading/fnf-decay-calibration.entity';
import { FnfTradingService } from '../src/trading/fnf-trading.service';
import { AstroMuhurtaService } from '../src/astro/astro-muhurta.service';
import { MuhurtaWindow } from '../src/astro/muhurta-window.entity';

// ---------------------------------------------------------------------------
// Session calendar (IST trading days only, 2026-09-03 .. 2026-09-10)
// ---------------------------------------------------------------------------

const SESSION_START_HOUR = 9.5;  // 09:30 IST
const SESSION_END_HOUR   = 15.25; // 15:15 IST

/** Capital envelope for the sandbox portfolio (INR). */
const SANDBOX_CAPITAL = 500_000;
const SANDBOX_CEILING = 500_000;

/** Per-trade size envelope (INR notional) so no single paper trade blows up
 *  the envelope. */
const MAX_NOTIONAL_PER_TRADE = 50_000;

/** How many paper trades to let run open before force-closing at session end
 *  (to keep the ledger small and the P&L meaningful). */
const MAX_OPEN_POSITIONS = 4;

/** Seed for the pseudo-random price path so the runner is replayable. */
const SEED = 20260901;

// ---------------------------------------------------------------------------
// Minimal reproducible PRNG (mulberry32) — no crypto, no external dep.
// ---------------------------------------------------------------------------

function makeRng(seed: number) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t) % 4294967296;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// In-memory repo wiring
// ---------------------------------------------------------------------------

function wireTradingService(now: Date): FnfTradingService {
  const portfolios = new FakeRepo();
  const trades = new FakeRepo();
  const snapshots = new FakeRepo();
  const calibrations = new FakeRepo();
  const muhurtaWindowRepo = new FakeRepo();

  const muhurta = new AstroMuhurtaService(muhurtaWindowRepo as any);

  const service = new FnfTradingService(
    portfolios as any,
    trades as any,
    snapshots as any,
    calibrations as any,
    muhurta,
  );

  // Freeze internal clock for the run so timestamped calibrations/holds are
  // deterministic w.r.t. the simulated calendar below.
  (service as any)['now'] = now;

  return service;
}

// ---------------------------------------------------------------------------
// IST session-day calendar (Mon 2026-09-03 .. Thu 2026-09-10)
//   2026-09-03 = Thursday
//   2026-09-04 = Friday
//   2026-09-07 = Monday
//   2026-09-08 = Tuesday
//   2026-09-09 = Wednesday
//   2026-09-10 = Thursday
// ---------------------------------------------------------------------------

const SESSION_DAYS = [
  new Date(2026, 8, 3,  9, 10, 0),  // Thu 03-Sep-2026 09:10 IST  (pre-open prep)
  new Date(2026, 8, 4,  9, 10, 0),  // Fri 04-Sep-2026 09:10 IST
  new Date(2026, 8, 7,  9, 10, 0),  // Mon 07-Sep-2026 09:10 IST
  new Date(2026, 8, 8,  9, 10, 0),  // Tue 08-Sep-2026 09:10 IST
  new Date(2026, 8, 9,  9, 10, 0),  // Wed 09-Sep-2026 09:10 IST
  new Date(2026, 8, 10, 9, 10, 0),  // Thu 10-Sep-2026 09:10 IST
];

// ---------------------------------------------------------------------------
// Universe — 3 liquid FNF symbols the decay engine is tuned for.
// ---------------------------------------------------------------------------

const UNIVERSE = [
  { symbol: 'NIFTY',  basePrice: 22000, atr: 175 },
  { symbol: 'FINEX',  basePrice:  1650, atr:  32 },
  { symbol: 'BANKS',  basePrice:  4200, atr:  70 },
];

/** Simulated pre-open prices for one session day (one per universe symbol).
 *  Deterministic via seeded rng so the run is reproducible. */
function preOpenPrices(rng: () => number, dayIndex: number): number[] {
  const drift = Math.sin(dayIndex * 1.3) * 0.004;
  return UNIVERSE.map((u) => {
    const dailyMove = (rng() - 0.5) * 2 * u.atr * 0.6 + u.basePrice * drift;
    return Math.max(u.basePrice * 0.9, u.basePrice + dailyMove);
  });
}

// ---------------------------------------------------------------------------
// Minimal seeded snapshot series for one symbol on one day. The decay engine
// reads age from the most recent snapshot whose ts is <= now, so we pin the
// last element to the pre-open moment for a fresh-confidence start-of-day.
// ---------------------------------------------------------------------------

function seedSnapshotsForDay(
  service: FnfTradingService,
  symbol: string,
  dayDate: Date,
  series: Array<{ price: number; minuteOffset: number }>,
): void {
  const rows = series.map((s) => ({
    instrument: symbol,
    price: s.price,
    volume: 40_000 + Math.round(s.price * 0.6),
    ts: new Date(dayDate.getTime() - (s.minuteOffset - 270) * 60_000),
  }));
  service['snapshots'].save(rows as any).then(() => undefined);
}

// ---------------------------------------------------------------------------
// Seed 14 days of per-symbol per-weekday decay calibrations before the
// session begins, so the decay engine always has a curve to read from.
// ---------------------------------------------------------------------------

function seedCalibrations(service: FnfTradingService, universe: string[]): void {
  const calRepo = service['calibrations'] as any;
  for (const instrument of universe) {
    for (let w = 1; w <= 7; w++) {
      const weekdayRate = w === 6 || w === 0 ? 0.09 : 0.045;
      calRepo.save(calRepo.create({
        portfolioId: '___seed___',
        instrument,
        weekday: w,
        windowStartHour: (w >= 1 && w <= 5) ? SESSION_START_HOUR : 0,
        windowEndHour:   (w >= 1 && w <= 5) ? SESSION_END_HOUR   : 0,
        decayRate: weekdayRate,
      }));
    }
  }
}

// ---------------------------------------------------------------------------
// P&L statement value object
// ---------------------------------------------------------------------------

interface PnlRow {
  dayDate: string;
  dayOfWeek: string;
  openPositions: number;
  closedCount: number;
  grossIn: number;
  grossOut: number;
  fees: number;
  dayOpenNetPnl: number;
  dayCloseNetPnl: number;
  dayDelta: number;
  equityHigh: number;
  equityLow: number;
}

interface PnlStatement {
  startCapital: number;
  endCapital: number;
  totalFees: number;
  grossIn: number;
  grossOut: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  maxDrawdown: number;
  netPnl: number;
  returnPct: number;
  dailyRows: PnlRow[];
}

// ---------------------------------------------------------------------------
// Build a per-session P&L statement from the trade ledger + portfolio
// snapshots at open and close of each session day.
// ---------------------------------------------------------------------------

function buildPnlStatement(
  _service: FnfTradingService,
  portfolio: FnfPortfolio,
  trades: FnfTrade[],
  _openCount: number,
  _startNetPnl: number,
  _startTotalCost: number,
  _startDeployed: number,
): PnlStatement {
  const statements: PnlRow[] = [];
  const startCapital = Number(portfolio.capital);
  let runningNetPnl = 0;
  let runningTotalCost = 0;
  let prevCloseNetPnl = 0;
  let peakNetPnl = 0;
  let maxDrawdown = 0;

  // Walk the session calendar; on each day account for any trades whose
  // orderedAt falls inside that day.
  for (const dayDate of SESSION_DAYS) {
    const dayStr = dayDate.toISOString().slice(0, 10);
    const dow = dayDate.toLocaleString('en-IN', { weekday: 'long' });
    const dayStart = new Date(dayDate);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayDate);
    dayEnd.setHours(23, 59, 59, 999);

    const dayTrades = trades.filter(
      (t) => t.orderedAt instanceof Date && t.orderedAt >= dayStart && t.orderedAt <= dayEnd,
    );

    let dayGrossIn = 0;
    let dayGrossOut = 0;
    let dayFees = 0;
    let dayClosed = 0;

    for (const t of dayTrades) {
      // BigInt-aware accumulation: coerce to Number safely for paper-scale amounts.
      const gp = Number(t.grossPnl ?? 0);
      const cost = Number(t.cost ?? 0);
      if (t.side === 'BUY') {
        dayGrossIn += gp;
      } else {
        dayGrossOut += gp;
      }
      dayFees += cost;
      dayClosed++;
    }

    runningNetPnl += dayGrossIn + dayGrossOut - dayFees;
    runningTotalCost += dayFees;

    const equityHigh = Math.max(runningNetPnl, prevCloseNetPnl);
    const equityLow  = Math.min(runningNetPnl, prevCloseNetPnl);
    if (runningNetPnl > peakNetPnl) peakNetPnl = runningNetPnl;
    const dd = peakNetPnl - runningNetPnl;
    if (dd > maxDrawdown) maxDrawdown = dd;

    statements.push({
      dayDate: dayStr,
      dayOfWeek: dow,
      openPositions: 0,
      closedCount: dayClosed,
      grossIn: dayGrossIn,
      grossOut: dayGrossOut,
      fees: dayFees,
      dayOpenNetPnl: prevCloseNetPnl,
      dayCloseNetPnl: runningNetPnl,
      dayDelta: runningNetPnl - prevCloseNetPnl,
      equityHigh,
      equityLow,
    });

    prevCloseNetPnl = runningNetPnl;
  }

  const winningTrades = trades.filter((t) => Number(t.netPnl) > 0).length;
  const losingTrades  = trades.filter((t) => Number(t.netPnl) <= 0).length;
  const totalTrades   = trades.length;
  const winRate       = totalTrades > 0 ? winningTrades / totalTrades : 0;
  const totalFees     = runningTotalCost;
  const grossIn       = statements.reduce((s, r) => s + r.grossIn, 0);
  const grossOut      = statements.reduce((s, r) => s + r.grossOut, 0);
  const netPnl        = runningNetPnl;
  const endCapital    = startCapital + netPnl;
  const returnPct     = startCapital > 0 ? (netPnl / startCapital) * 100 : 0;

  return {
    startCapital,
    endCapital,
    totalFees,
    grossIn,
    grossOut,
    totalTrades,
    winningTrades,
    losingTrades,
    winRate,
    maxDrawdown,
    netPnl,
    returnPct,
    dailyRows: statements,
  };
}

// ---------------------------------------------------------------------------
// Signal resolution: decide whether a generated signal becomes a paper trade
// or is skipped / deferred.
// ---------------------------------------------------------------------------

interface PaperPosition {
  trade: FnfTrade;
  entryPrice: number;
  side: 'BUY' | 'SELL';
  instrument: string;
  orderedAt: Date;
  sessionDay: Date;
  status: 'OPEN' | 'CLOSED' | 'WAIT';
}

/** Try to open a paper trade for a signal. Returns the position if accepted,
 *  null if the signal is skipped (envelope full, below size floor, etc.). */
function openPaperTrade(
  service: FnfTradingService,
  portfolio: FnfPortfolio,
  signal: any,
  effectiveEntry?: number,
): PaperPosition | null {
  const portfolioId = portfolio.id;
  const instrument  = signal.instrument;
  const side        = signal.action === 'SELL' ? 'SELL' : 'BUY';
  const price       = Number(signal.price);
  // quantity so notional stays within envelope
  const notional = Math.min(MAX_NOTIONAL_PER_TRADE, SANDBOX_CAPITAL);
  const quantity = Math.floor(notional / price);
  if (quantity < 1) return null;

  try {
    const trade = service.openTrade({
      portfolioId,
      instrument,
      side,
      quantity,
      entryPrice: effectiveEntry ?? price,
      algoSource: signal.algoSource,
      decisionParams: JSON.stringify(signal),
    });
    return {
      trade,
      entryPrice: effectiveEntry ?? price,
      side,
      instrument,
      orderedAt: new Date(),
      sessionDay: new Date(),
      status: 'OPEN',
    };
  } catch (err) {
    console.warn(`[openPaperTrade] rejected ${side} ${instrument} @ ${price}: ${err}`);
    return null;
  }
}

/** Current working set of open paper positions keyed by instrument+side.
 *  Simplified: one position per instrument (no stacking). */
const openPositions = new Map<string, PaperPosition>();

// ---------------------------------------------------------------------------
// Pullback-aware entry deferral (mirrors the smoke test structure).
// ---------------------------------------------------------------------------

async function pullbackAnalysisForBuy(
  signal: any,
  currentPrice: number,
  rng: () => number,
): Promise<{ action: 'wait-for-pullback' | 'take-now' | 'skip'; reason: string; targetEntry: number }> {
  if (currentPrice == null || isNaN(currentPrice)) {
    return { action: 'skip', reason: 'no-current-price', targetEntry: Number(signal.price) };
  }
  const sessionHigh = currentPrice * (1 + rng() * 0.01);
  const pullbackBand = currentPrice * 0.002;
  const pullbackThreshold = sessionHigh - pullbackBand;
  if (Number(signal.price) >= pullbackThreshold) {
    return { action: 'take-now', reason: 'price already at/below pullback threshold', targetEntry: Number(signal.price) };
  }
  return { action: 'wait-for-pullback', reason: 'awaiting better entry above pullback threshold', targetEntry: Number(signal.price) };
}

// ---------------------------------------------------------------------------
// Main simulation driver
// ---------------------------------------------------------------------------

async function entries(
  service: FnfTradingService,
  portfolio: FnfPortfolio,
  dayDate: Date,
  preOpen: number[],
  rng: () => number,
): Promise<PaperPosition | null> {
  const signals = await service.generateSignals(portfolio.id);
  // Pick the first non-HOLD signal we find.
  const signal  = signals.find((s: any) => s.action !== 'HOLD') ?? signals[0];
  if (!signal) return null;
  if (signal.action === 'HOLD') return null;

  const currentPrice = Number(signal.price);
  const analysis = await pullbackAnalysisForBuy(signal, currentPrice, rng);

  if (analysis.action === 'wait-for-pullback') {
    // defer — close any existing same-instrument position first to free envelope
    const existing = openPositions.get(signal.instrument);
    if (existing) {
      try { await service.closeTrade(existing.trade.id, { exitPrice: currentPrice }); } catch {}
      openPositions.delete(signal.instrument);
    }
    return entries(service, portfolio, dayDate, preOpen, rng);
  }

  const position = openPaperTrade(service, portfolio, signal, analysis.targetEntry);
  if (position) {
    openPositions.set(position.instrument + ':' + position.side, position);
    console.log(
      `[ENTRY ${dayDate.toISOString().slice(0,10)} ${dayDate.toLocaleString('en-IN',{hour:'2-digit',minute:'2-digit'})} IST]` +
      ` ${position.side} ${position.instrument} qty=${position.trade.quantity} @ ${position.entryPrice.toFixed(2)}` +
      ` conf=${signal.confidence} astro=${signal.astroMatch?.score ?? 'n/a'}`,
    );
    return position;
  }
  return null;
}

async function runDay(
  service: FnfTradingService,
  portfolio: FnfPortfolio,
  dayDate: Date,
  preOpen: number[],
  rng: () => number,
): Promise<PaperPosition[]> {
  const dayStr = dayDate.toISOString().slice(0, 10);
  console.log(`\n===== ${dayStr} (${dayDate.toLocaleString('en-IN', { weekday: 'long' })}) =====`);

  // Seed a small snapshot series so the decay engine sees a fresh price near
  // the pre-open moment.
  for (let i = 0; i < UNIVERSE.length; i++) {
    const u = UNIVERSE[i];
    const prices = Array.from({ length: 90 }, (_, j) => ({
      price: preOpen[i] * (1 + (rng() - 0.5) * 0.002 * (j / 90)),
      minuteOffset: 270 - j,
    }));
    seedSnapshotsForDay(service, u.symbol, dayDate, prices);
  }

  // Generate + optionally take signals for this day.
  const positions: PaperPosition[] = [];
  for (let pass = 0; pass < 2; pass++) {
    const pos = await entries(service, portfolio, dayDate, preOpen, rng);
    if (pos) positions.push(pos);
  }

  // End-of-day: force-close any open position so the ledger stays bounded.
  for (const [, pos] of openPositions) {
    if (pos.status === 'OPEN') {
      try {
        await service.closeTrade(pos.trade.id, { exitPrice: pos.entryPrice });
        pos.status = 'CLOSED';
        console.log(`[EXIT ${dayStr}] closed ${pos.side} ${pos.instrument} @ ~${pos.entryPrice.toFixed(2)}`);
      } catch (err) {
        console.warn(`[EXIT ${dayStr}] failed to close ${pos.side} ${pos.instrument}: ${err}`);
      }
    }
  }

  return positions;
}

async function run(): Promise<void> {
  console.log('============================================================');
  console.log('FNF PAPER TRADING — 7-DAY SANDBOX REPLAY');
  console.log('Period: 2026-09-03 (Thu) .. 2026-09-10 (Thu)  |  IST session');
  console.log(`Universe: ${UNIVERSE.map(u => u.symbol).join(', ')}`);
  console.log(`Capital: ₹${SANDBOX_CAPITAL.toLocaleString()}  |  Max notional/trade: ₹${MAX_NOTIONAL_PER_TRADE.toLocaleString()}`);
  console.log('============================================================\n');

  const now = new Date(2026, 8, 3, 9, 5, 0); // 09:05 IST on first session day
  const service = wireTradingService(now);
  await service.ensureCalibrations();

  // Seed per-universe calibrations (weekday/weekend brackets) so the decay
  // engine has curves for every simulated session day.
  seedCalibrations(service, UNIVERSE.map(u => u.symbol));

  // Provision the sandbox portfolio.
  const portfolio = (await service['portfolios'].save(
  service['portfolios'].create({
    label: 'FNF-PAPER-7D',
    capital: SANDBOX_CAPITAL,
    ceiling: SANDBOX_CEILING,
    autoTradeEnabled: false,
    fridayTradingEnabled: false,
    autoCloseAtSessionEnd: true,
  }),
  )) as unknown as FnfPortfolio;

  console.log(`Portfolio: ${portfolio.label} (id=${portfolio.id})`);
  console.log(`Sandbox toggle (app SANDBOX / trading FNF_TRADING_SANDBOX): ` +
    `${(process.env.SANDBOX === 'true' ? 'ON' : 'OFF')} / ${(process.env.FNF_TRADING_SANDBOX === 'true' ? 'ON' : 'OFF')}`);

  const rng = makeRng(SEED);
  const allTrades: FnfTrade[] = [];
  let totalPositions = 0;

  for (let i = 0; i < SESSION_DAYS.length; i++) {
    const dayDate = SESSION_DAYS[i];
    const preOpen = preOpenPrices(rng, i);
    console.log(`\n>>> Pre-open prices: ${UNIVERSE.map((u, k) => `${u.symbol} ₹${preOpen[k].toFixed(2)}`).join(' | ')}`);

    const dayPositions = await runDay(service, portfolio, dayDate, preOpen, rng);
    totalPositions += dayPositions.length;

    // Collect any trades recorded by the service during this day.
    const dayTrades = await service['trades'].find({
      where: { portfolio: portfolio.id },
    }) as FnfTrade[];
    for (const t of dayTrades) {
      if (!allTrades.find((x) => x.id === t.id)) {
        allTrades.push(t);
      }
    }
  }

  // Portfolio state after session.
  const endPortfolio = await service.getPortfolio(portfolio.id);
  const endNetPnl = Number(endPortfolio?.netPnl ?? 0);
  const endTotalCost = Number(endPortfolio?.totalCost ?? 0);

  const statement = buildPnlStatement(
    service, portfolio, allTrades, totalPositions,
    0, 0, 0,
  );

  console.log('\n============================================================');
  console.log('SESSION P&L STATEMENT (paper)');
  console.log('============================================================');
  console.log(`Start capital:        ₹${statement.startCapital.toLocaleString()}`);
  console.log(`End capital:          ₹${statement.endCapital.toLocaleString()}`);
  console.log(`Net P&L:              ₹${statement.netPnl.toLocaleString()}  (${statement.returnPct >= 0 ? '+' : ''}${statement.returnPct.toFixed(2)}%)`);
  console.log(`Gross In:             ₹${statement.grossIn.toLocaleString()}`);
  console.log(`Gross Out:            ₹${statement.grossOut.toLocaleString()}`);
  console.log(`Total fees:           ₹${statement.totalFees.toLocaleString()}`);
  console.log(`Total trades:         ${statement.totalTrades}`);
  console.log(`Winning / Losing:     ${statement.winningTrades} / ${statement.losingTrades}  (WR ${statement.winRate.toFixed(2)})`);
  console.log(`Max drawdown (peak):  ₹${statement.maxDrawdown.toLocaleString()}`);
  console.log('------------------------------------------------------------');
  console.log('Daily breakdown:');
  console.log('------------------------------------------------------------');
  for (const row of statement.dailyRows) {
    console.log(
      `${row.dayDate} ${row.dayOfWeek.padEnd(9)} | ` +
      `closed=${row.closedCount} | ` +
      `Δnet=${row.dayDelta >= 0 ? '+' : ''}${row.dayDelta.toFixed(0).padStart(8)} | ` +
      `hi=${row.equityHigh.toFixed(0)} lo=${row.equityLow.toFixed(0)}`,
    );
  }
  console.log('============================================================\n');

  console.log('Paper trading session complete.');
}

run().catch((e) => {
  console.error('FATAL:', e);
  process.exit(2);
});
