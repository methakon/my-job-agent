const assert = require('node:assert/strict');
const { filterMarketSnapshots, snapshotOhlcState } = require('../dist/trading/market-data-filter');

const rows = [
  { id: 'n-old', instrument: 'NSE:NIFTY50-INDEX', price: 24000, volume: 10, open: 23900, high: 24100, low: 23800, close: 24000, ts: '2026-09-01T09:30:00.000Z' },
  { id: 'n-new', instrument: 'NSE:NIFTY50-INDEX', price: 24100, volume: 20, open: 24000, high: 24200, low: 23950, close: 24100, ts: '2026-09-01T10:00:00.000Z' },
  { id: 'b-new', instrument: 'NSE:NIFTYBANK-INDEX', price: 52000, volume: 30, ts: '2026-09-01T10:00:00.000Z' },
];

assert.equal(filterMarketSnapshots(rows, { instrument: 'niftybank' }).length, 1);
assert.equal(filterMarketSnapshots(rows, { minPrice: 24100, maxPrice: 24100 })[0].id, 'n-new');
assert.equal(filterMarketSnapshots(rows, { minVolume: 20, maxVolume: 20 })[0].id, 'n-new');
assert.equal(filterMarketSnapshots(rows, { from: new Date('2026-09-01T09:45:00.000Z') }).length, 2);
assert.equal(filterMarketSnapshots(rows, { ohlc: 'complete' }).length, 2);
assert.equal(filterMarketSnapshots(rows, { ohlc: 'missing' }).length, 1);
assert.deepEqual(filterMarketSnapshots(rows, { latestOnly: true }).map((row) => row.id), ['n-new', 'b-new']);
assert.equal(snapshotOhlcState(rows[0]), 'complete');
assert.equal(snapshotOhlcState(rows[2]), 'missing');
console.log('Market-data filter tests passed');
