const assert = require('node:assert/strict');
const { shouldAcceptTick } = require('../dist/trading/market-feed-guard');

assert.equal(
  shouldAcceptTick('yahoo', '2026-09-02T09:30:00.000Z', '2026-09-02T09:30:00.000Z'),
  false,
  'a repeated Yahoo candle timestamp must be ignored',
);
assert.equal(
  shouldAcceptTick('yahoo', '2026-09-02T09:31:00.000Z', '2026-09-02T09:30:00.000Z'),
  true,
  'a newer Yahoo candle timestamp must be accepted',
);
assert.equal(
  shouldAcceptTick('yahoo', '2026-09-02T09:30:00.000Z', undefined),
  true,
  'the same candle timestamp for another instrument must be accepted',
);
assert.equal(
  shouldAcceptTick('fyers', '2026-09-02T09:30:00.000Z', '2026-09-02T09:30:00.000Z'),
  true,
  'FYERS ticks are not deduplicated by the Yahoo candle rule',
);
console.log('Market-feed guard tests passed');
