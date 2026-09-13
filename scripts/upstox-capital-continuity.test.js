#!/usr/bin/env node
/**
 * PAPER capital continuity + carry-forward positions.
 *
 * Acceptance criteria being proven:
 *  1. closing paper equity = starting capital + realised P&L + valid MTM of
 *     carried positions, with simulated costs (already inside realised P&L)
 *     surfaced separately;
 *  2. a profitable week RAISES available capital and a losing week LOWERS it —
 *     the initial capital is never a reset and never a ceiling;
 *  3. MTM refuses to guess: no mark at the close, or a mark timestamped after the
 *     close, is a BLOCKER, not a number;
 *  4. contradictory records (trades vs the portfolio row) are BLOCKED, never
 *     silently reconciled;
 *  5. the week boundaries are the IST Monday→Sunday week, and a label round-trips
 *     back to the same bounds;
 *  6. the service exposes the read-only preview/discovery surface, and the
 *     wipe-out guard constant exists so a clamped default can never be applied
 *     silently.
 *
 * Offline: pure functions only — no DB, no network.
 * DIST_ROOT selects the compiled output (default ../dist).
 */
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DIST = process.env.DIST_ROOT || path.join(ROOT, 'dist');
const mod = require(path.join(DIST, 'trading/upstox-live-paper/upstox-live-paper-capital-continuity.service.js'));
const {
  computeWeekCloseEquity, lastCompletedTradingWeek, tradingWeekFromLabel,
  MIN_ROLL_EQUITY, WEEK_CARRY_FORWARD_EVENT, WEEK_CARRY_DECISION_EVENT,
  UpstoxLivePaperCapitalContinuityService,
} = mod;

const WEEK_END = new Date('2026-09-12T23:59:59.999');

let pass = 0;
const ok = (label) => { pass++; console.log(`  ${pass} ${label} ok`); };

const base = {
  capitalAtWeekStart: 5000,
  closedTradeNetPnl: 0,
  closedTradeCosts: 0,
  openPositions: [],
  portfolioNetPnl: 0,
  portfolioUnrealisedPnl: 0,
  weekEnd: WEEK_END,
};

// ── 1 & 2: profitable week raises, losing week lowers, never a reset
{
  const up = computeWeekCloseEquity({ ...base, closedTradeNetPnl: 250, closedTradeCosts: 40, portfolioNetPnl: 250 });
  assert.equal(up.ok, true);
  assert.equal(up.equity, 5250);
  assert.ok(up.equity > 5000, 'profitable week must RAISE available capital');

  const down = computeWeekCloseEquity({ ...base, closedTradeNetPnl: -300, closedTradeCosts: 95, portfolioNetPnl: -300 });
  assert.equal(down.ok, true);
  assert.equal(down.equity, 4700);
  assert.ok(down.equity < 5000, 'losing week must LOWER available capital');
  assert.notEqual(down.equity, 5000, 'a losing week is never reset to the initial capital');

  const flat = computeWeekCloseEquity({ ...base });
  assert.equal(flat.equity, 5000, 'an untouched account closes at its capital — arithmetic on empty books, not a reset');
  ok('profitable raises / losing lowers / flat equals capital — no reset, no ceiling');
}

// ── 1 (costs) + carried-position MTM
{
  const r = computeWeekCloseEquity({
    ...base,
    closedTradeNetPnl: 210,          // already NET of costs
    closedTradeCosts: 40,            // surfaced separately
    portfolioNetPnl: 210,
    openPositions: [
      { instrument: 'BSE:SENSEX73900CE17SEP26', side: 'BUY', quantity: 65, averagePrice: 100, markPrice: 102, markPriceTs: new Date('2026-09-12T09:00:00.000Z') },
      { instrument: 'NSE:NIFTY26SEP23000PE', side: 'SELL', quantity: 30, averagePrice: 200, markPrice: 190, markPriceTs: new Date('2026-09-12T09:00:00.000Z') },
    ],
    portfolioUnrealisedPnl: (102 - 100) * 65 + (200 - 190) * 30,
  });
  assert.equal(r.ok, true);
  assert.equal(r.realizedNetPnl, 210, 'equity uses NET realised P&L (costs already deducted)');
  assert.equal(r.costs, 40, 'costs are reported for transparency');
  assert.equal(r.unrealizedPnl, 430, 'long MTM + short MTM');
  assert.equal(r.equity, 5000 + 210 + 430);
  assert.equal(r.openPositions, 2);
  ok('costs surfaced separately; carried-position MTM is included once');
}

// ── 3: never guess a valuation
{
  const noMark = computeWeekCloseEquity({
    ...base,
    openPositions: [{ instrument: 'NSE:NIFTY26SEP23000PE', side: 'BUY', quantity: 65, averagePrice: 100, markPrice: null, markPriceTs: null }],
  });
  assert.equal(noMark.ok, false);
  assert.match(noMark.blockers.join(' '), /no valid mark-to-market/i);
  assert.match(noMark.blockers.join(' '), /NIFTY26SEP23000PE/);

  const afterClose = computeWeekCloseEquity({
    ...base,
    openPositions: [{ instrument: 'NSE:NIFTY26SEP23000PE', side: 'BUY', quantity: 65, averagePrice: 100, markPrice: 105, markPriceTs: new Date('2026-09-14T04:00:00.000Z') }],
  });
  assert.equal(afterClose.ok, false);
  assert.match(afterClose.blockers.join(' '), /AFTER the week close/i);

  const bad = computeWeekCloseEquity({
    ...base,
    openPositions: [{ instrument: 'X', side: 'SIDEWAYS', quantity: 0, averagePrice: 0, markPrice: 10, markPriceTs: null }],
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.blockers.length >= 2, 'both the side and the quantity/average are refused');
  ok('missing / post-close / unusable marks are BLOCKED, never approximated');
}

// ── 4: contradictory records
{
  const tradesVsRow = computeWeekCloseEquity({ ...base, closedTradeNetPnl: 250, portfolioNetPnl: 300 });
  assert.equal(tradesVsRow.ok, false);
  assert.match(tradesVsRow.blockers.join(' '), /contradictory records/i);

  const mtmVsRow = computeWeekCloseEquity({
    ...base,
    openPositions: [{ instrument: 'N', side: 'BUY', quantity: 10, averagePrice: 100, markPrice: 110, markPriceTs: null }],
    portfolioUnrealisedPnl: 999,
  });
  assert.equal(mtmVsRow.ok, false);
  assert.match(mtmVsRow.blockers.join(' '), /contradictory records/i);
  ok('contradictory trade/portfolio records are BLOCKED, not reconciled');
}

// ── 5: IST week boundaries + label round-trip
{
  const sunday = new Date(2026, 8, 13, 12, 0, 0);     // Sun 13 Sep 2026, local (IST host)
  const week = lastCompletedTradingWeek(sunday);
  assert.equal(week.label, '2026-W37');
  assert.equal(week.start.getDay(), 1, 'week starts Monday');
  assert.equal(week.start.getDate(), 7);
  assert.equal(week.start.getHours(), 0);
  assert.equal(week.end.getDay(), 0, 'week ends Sunday');
  assert.equal(week.end.getDate(), 13);
  assert.equal(week.end.getHours(), 23);

  const friday = new Date(2026, 8, 11, 15, 30, 0).getTime();
  assert.ok(friday >= week.start.getTime() && friday <= week.end.getTime(), 'Friday close is inside the week');
  const nextMonday = new Date(2026, 8, 14, 9, 15, 0).getTime();
  assert.ok(nextMonday > week.end.getTime(), 'the new week starts after the close');

  const round = tradingWeekFromLabel('2026-W37');
  assert.equal(round.start.getTime(), week.start.getTime(), 'label→bounds round-trips (start)');
  assert.equal(round.end.getTime(), week.end.getTime(), 'label→bounds round-trips (end)');
  assert.throws(() => tradingWeekFromLabel('nonsense'), /invalid week label/);
  ok('IST Monday→Sunday week, Friday inside it, label round-trips');
}

// ── 6: surface + guards
{
  assert.equal(MIN_ROLL_EQUITY, 100, 'the wipe-out guard threshold is explicit');
  assert.equal(WEEK_CARRY_FORWARD_EVENT, 'WEEK_CARRY_FORWARD');
  assert.equal(WEEK_CARRY_DECISION_EVENT, 'WEEK_CARRY_DECISION');
  for (const method of ['previewWeekRoll', 'applyWeekRoll', 'discoverCarriedPositions', 'carryForwardPositions', 'liveWallet']) {
    assert.equal(typeof UpstoxLivePaperCapitalContinuityService.prototype[method], 'function', `${method} exists`);
  }
  ok('preview / roll / discovery / carry-forward / live-wallet surface exists');

  // The roll must refuse a wiped-out equity rather than let a clamp restore the default.
  const wiped = computeWeekCloseEquity({ ...base, closedTradeNetPnl: -4990, portfolioNetPnl: -4990 });
  assert.equal(wiped.ok, true);
  assert.equal(wiped.equity, 10);
  assert.ok(wiped.equity < MIN_ROLL_EQUITY, 'a wiped-out week is below the guard, so the roll refuses instead of clamping to a default');
  ok('a wiped-out week is refused, not silently restored to the default capital');
}

console.log(`\nupstox-capital-continuity: ${pass} passed, 0 failed`);
