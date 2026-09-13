#!/usr/bin/env node
/**
 * PAPER accounting path + option cost model — focused regression tests.
 *
 * Proves the approved accounting convention end-to-end against the REAL
 * UpstoxLivePaperService (in-memory repositories, no DB, no network):
 *
 *  A. OPEN charges the entry-leg cost EXACTLY ONCE;
 *  B. CLOSE books gross P&L minus the EXIT-leg cost (entry leg already charged);
 *  C. the round-trip net is grossPnl - entryCost - exitCost, and the portfolio
 *     aggregate equals SUM(closed trade netPnl) — the roll's own source;
 *  D. recordPnlEvent writes its ledger/audit row and does NOT mutate netPnl;
 *  E. the first completed trade no longer contradicts the week roll;
 *  F. the cost model: STT 0.15% sell-side, GST on brokerage+txn+SEBI only.
 *
 * DIST_ROOT selects the compiled output (default ../dist).
 */
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DIST = process.env.DIST_ROOT || path.join(ROOT, 'dist');
const svcMod = require(path.join(DIST, 'trading/upstox-live-paper/upstox-live-paper.service.js'));
const { calculateOptionCost } = svcMod;
const UpstoxLivePaperService = svcMod.UpstoxLivePaperService;
const { computeWeekCloseEquity } = require(path.join(DIST, 'trading/upstox-live-paper/upstox-live-paper-capital-continuity.service.js'));

let pass = 0;
const ok = (label) => { pass++; console.log(`  ${pass} ${label} ok`); };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));

// ── in-memory repositories ────────────────────────────────────────────────────
function makeHarness() {
  const state = {
    portfolio: {
      id: 'P1', label: 'main-live-paper', capital: 5000, ceiling: 5000, deployed: 0,
      netPnl: 0, unrealisedPnl: 0, openPositionCount: 0, totalCost: 0,
      fridayTradingEnabled: true, autoTradeEnabled: false,
    },
    trades: [], orders: [], positions: [], events: [],
  };
  const matches = (row, where) => Object.entries(where || {}).every(([k, v]) => row[k] === v);

  const portfolios = {
    findOne: async ({ where }) => (matches(state.portfolio, where) ? state.portfolio : null),
    update: async (id, patch) => { Object.assign(state.portfolio, patch); return { affected: 1 }; },
    create: (o) => o,
    save: async (o) => o,
  };
  const trades = {
    create: (o) => { const t = { id: `T${state.trades.length + 1}`, ...o }; state.trades.push(t); return t; },
    save: async (t) => t,
    findOne: async ({ where, relations }) => {
      const t = state.trades.find((x) => matches(x, where)) || null;
      if (t && relations && relations.portfolio) t.portfolio = state.portfolio;
      return t;
    },
    count: async ({ where }) => state.trades.filter((x) => matches(x, where)).length,
    find: async () => state.trades,
  };
  const orders = { create: (o) => o, save: async (o) => o };
  const positions = {
    findOne: async ({ where }) => state.positions.find((x) => matches(x, where)) || null,
    create: (o) => o,
    save: async (o) => { state.positions.push(o); return o; },
  };
  const pnlEvents = {
    create: (o) => o,
    save: async (e) => { state.events.push(e); return e; },
    find: async () => state.events,
  };
  const empty = { find: async () => [], create: (o) => o, save: async (o) => o };

  const market = {
    isStale: () => false,
    incrementStaleBlocked: () => {},
    fetchOptionChain: async () => ({ fetched: true, quotes: [] }),
    lotSizeForSymbol: () => null,
    contractMasterStatus: () => ({ underlyings: {}, note: null }),
  };
  const config = {
    defaultSlippageBps: 0, safetyLockActive: true, realOrderAllowed: false,
    staleQuoteMaxAgeMs: 60000, abnormalSpreadPctThreshold: 5, paperCapital: 5000,
  };

  const svc = new UpstoxLivePaperService(
    config, market, portfolios, trades, orders, positions, pnlEvents, empty, empty, empty,
  );
  return { svc, state };
}

const CERT = 'NSE:NIFTY26SEP25000CE';
const quote = (ltp) => ({ contractSymbol: CERT, ts: new Date(), ltp, bid: ltp - 0.05, ask: ltp + 0.05 });

(async () => {
  console.log('upstox-paper-accounting');

  // ── the full round trip through the real service ────────────────────────────
  const { svc, state } = makeHarness();
  const ENTRY = 100;
  const EXIT = 1100;                       // gross = (1100 - 100) * 1 unit = ₹1,000
  const entryCost = calculateOptionCost(ENTRY, 1, 'BUY', 0).total;
  const exitCost = calculateOptionCost(EXIT, 1, 'SELL', 0).total;

  const opened = await svc.openTrade({
    portfolioId: 'P1', instrument: CERT, side: 'BUY', lotSize: 1, quantity: 1,
    entryPrice: ENTRY, quoteSnapshot: quote(ENTRY),
  });

  // A. OPEN charges the entry leg exactly once.
  assert.equal(opened.status, 'OPEN');
  assert.ok(near(Number(state.portfolio.netPnl), -entryCost),
    `OPEN must charge the entry leg once (netPnl ${state.portfolio.netPnl} vs -${entryCost})`);
  assert.ok(near(Number(opened.cost), entryCost), 'the trade records the entry-leg cost');
  assert.equal(state.events.length, 1, 'OPEN writes exactly one ledger event');
  assert.ok(near(state.events[0].pnlDelta, -entryCost), 'the ledger event carries the entry-leg delta');
  ok('OPEN charges the entry-leg cost exactly once (no second mutation)');

  // D. the ledger is record-only.
  const before = Number(state.portfolio.netPnl);
  await svc.recordPnlEvent('P1', null, 12345, 'ADJUSTMENT', 'ledger-only probe');
  assert.equal(Number(state.portfolio.netPnl), before, 'recordPnlEvent must NOT mutate portfolio.netPnl');
  assert.equal(state.events.length, 2, 'recordPnlEvent still writes its audit row');
  ok('recordPnlEvent writes the ledger row but does not move equity');

  // B. CLOSE books gross minus the exit leg — never the entry leg twice.
  const closed = await svc.closeTrade({ tradeId: opened.id, exitPrice: EXIT });
  const grossPnl = (EXIT - ENTRY) * 1;
  const roundTripNet = grossPnl - entryCost - exitCost;

  assert.ok(near(Number(closed.grossPnl), grossPnl), 'gross P&L is (exit - entry) * units');
  assert.ok(near(Number(closed.cost), entryCost + exitCost), 'the trade records the full round-trip cost');
  assert.ok(near(Number(closed.netPnl), roundTripNet), 'the trade netPnl is gross - entry - exit');
  assert.equal(closed.status, 'CLOSED');

  const expectedNet = -entryCost + (grossPnl - exitCost);
  assert.ok(near(Number(state.portfolio.netPnl), expectedNet),
    `portfolio must book OPEN(-entry) + CLOSE(gross - exit) = ${expectedNet}, got ${state.portfolio.netPnl}`);
  ok('CLOSE books gross minus the exit-leg cost only (entry leg not charged again)');

  // C. one economic path: the portfolio aggregate equals the trade's own net.
  assert.ok(near(Number(state.portfolio.netPnl), Number(closed.netPnl)),
    'portfolio.netPnl must equal SUM(closed trade netPnl) — the roll cross-check');
  assert.ok(near(Number(state.portfolio.totalCost), entryCost + exitCost), 'accumulated cost is the round trip');
  ok('rolling equity agrees with SUM(closed trade netPnl) — single accounting path');

  // E. the first completed trade no longer contradicts the week roll.
  const roll = computeWeekCloseEquity({
    capitalAtWeekStart: 5000,
    closedTradeNetPnl: Number(closed.netPnl),
    closedTradeCosts: Number(closed.cost),
    openPositions: [],
    portfolioNetPnl: Number(state.portfolio.netPnl),
    portfolioUnrealisedPnl: 0,
    weekEnd: new Date(),
  });
  assert.equal(roll.ok, true, `the roll must not be blocked: ${(roll.blockers || []).join('; ')}`);
  const expectedEquity = Math.round((5000 + roundTripNet) * 100) / 100;   // the roll rounds equity to 2 dp
  assert.ok(near(roll.equity, expectedEquity), `closing equity ${roll.equity} vs ${expectedEquity}`);
  assert.ok(roll.equity > 5000, 'a profitable round trip RAISES the next week capital');
  ok('first completed trade yields a clean roll (no contradiction)');

  // A cost-dominated losing round trip lowers the next week's capital, and by
  // MORE than the gross loss — proof the costs are inside the realised net.
  {
    const h2 = makeHarness();
    const opened2 = await h2.svc.openTrade({
      portfolioId: 'P1', instrument: CERT, side: 'BUY', lotSize: 1, quantity: 1,
      entryPrice: 1000, quoteSnapshot: quote(1000),
    });
    const closed2 = await h2.svc.closeTrade({ tradeId: opened2.id, exitPrice: 900 });
    assert.ok(near(Number(closed2.grossPnl), -100), 'gross loss is -₹100');
    assert.ok(Number(closed2.netPnl) < -100, 'net is worse than gross — the cost stack is deducted');

    const roll2 = computeWeekCloseEquity({
      capitalAtWeekStart: 5000,
      closedTradeNetPnl: Number(closed2.netPnl),
      closedTradeCosts: Number(closed2.cost),
      openPositions: [],
      portfolioNetPnl: Number(h2.state.portfolio.netPnl),
      portfolioUnrealisedPnl: 0,
      weekEnd: new Date(),
    });
    assert.equal(roll2.ok, true, 'the losing roll is also not blocked');
    assert.ok(roll2.equity < 5000, 'a losing round trip LOWERS the next week capital');
    assert.ok(near(roll2.equity, Math.round((5000 + Number(closed2.netPnl)) * 100) / 100),
      'capital moves by the NET realised P&L, never the gross');
    ok('losing round trip lowers capital by the net (costs inside)');
  }

  // ── the documented convention example: 1000 gross, 25 + 25 costs → 950 ──────
  {
    const netOf = (gross, entry, exit) => gross - entry - exit;
    assert.equal(netOf(1000, 25, 25), 950, 'final net P&L = grossPnl - entryCost - exitCost');
    ok('documented convention: ₹1,000 gross - ₹25 entry - ₹25 exit = ₹950');
  }

  // ── F. cost model ───────────────────────────────────────────────────────────
  {
    const notional = 1000;
    const sell = calculateOptionCost(notional, 1, 'SELL', 0);
    const buy = calculateOptionCost(notional, 1, 'BUY', 0);

    // STT: 0.15% of premium, sell side only (Finance Act 2026, eff 1-Apr-2026).
    assert.ok(near(sell.stt, notional * 0.0015), `STT must be 0.15% of premium, got ${sell.stt}`);
    assert.equal(buy.stt, 0, 'STT is sell-side only');
    ok('STT on option sale is 0.15% of premium, sell side only');

    // GST: brokerage + exchange txn + SEBI, NOT STT/stamp.
    const gstBase = buy.brokerage + buy.exchangeTxn + buy.sebi;
    assert.ok(near(buy.gst, gstBase * 0.18), 'GST must be 18% of brokerage + txn + SEBI');
    const wrongBase = buy.brokerage + buy.stt + buy.exchangeTxn + buy.stamp + buy.sebi;
    assert.ok(!near(buy.gst, wrongBase * 0.18), 'GST must NOT be charged on STT or stamp duty');
    assert.ok(near(sell.gst, (sell.brokerage + sell.exchangeTxn + sell.sebi) * 0.18),
      'the GSTable base excludes STT on the sell side too');
    ok('GST applies to brokerage + exchange txn + SEBI only');

    // Other components.
    assert.equal(buy.brokerage, 20, 'brokerage is the configured flat ₹20');
    assert.ok(near(buy.exchangeTxn, notional * 0.0003552), 'exchange txn is ₹3,552/cr = 0.03552%, each side');
    assert.ok(near(buy.sebi, notional * 0.000001), 'SEBI charge is ₹10 per crore');
    assert.ok(near(buy.stamp, notional * 0.00003), 'stamp duty is 0.003%, buy side');
    assert.equal(sell.stamp, 0, 'stamp duty is buy-side only');
    assert.ok(near(buy.total,
      buy.brokerage + buy.stt + buy.exchangeTxn + buy.gst + buy.sebi + buy.stamp + buy.slippage),
      'total is the sum of every component');
    const slip = calculateOptionCost(100, 1, 'BUY', 10);
    assert.ok(near(slip.slippage, 0.1), 'slippage is notional * bps/10000');
    ok('brokerage / exchange / SEBI / stamp / slippage components intact');
  }

  console.log(`\nupstox-paper-accounting: ${pass} passed, 0 failed`);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
