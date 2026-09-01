const assert = require('node:assert/strict');
const {
  parseYahooChartResponse,
  parseYahooSymbolConfig,
} = require('../dist/trading/yahoo-finance-parser');

const sample = {
  chart: {
    result: [{
      meta: {
        symbol: '^NSEI',
        regularMarketPrice: 24124.15,
        regularMarketTime: 1788244694,
      },
      timestamp: [1788244500, 1788244560, 1788244620],
      indicators: {
        quote: [{
          open: [24120, 24121, null],
          high: [24125, 24126, null],
          low: [24118, 24119, null],
          close: [24122, null, 24124],
          volume: [0, 0, 0],
        }],
      },
    }],
  },
};

const tick = parseYahooChartResponse(sample, 'NSE:NIFTY50-INDEX');
assert.deepEqual(tick, {
  instrument: 'NSE:NIFTY50-INDEX',
  price: 24124.15,
  volume: 0,
  open: undefined,
  high: undefined,
  low: undefined,
  close: 24124,
  ts: new Date(1788244694 * 1000).toISOString(),
});

assert.equal(parseYahooChartResponse({ chart: { result: [] } }, 'NSE:NIFTY50-INDEX'), null);
assert.deepEqual(parseYahooSymbolConfig('^NSEI=NSE:NIFTY50-INDEX,^NSEBANK=NSE:NIFTYBANK-INDEX'), [
  { symbol: '^NSEI', instrument: 'NSE:NIFTY50-INDEX' },
  { symbol: '^NSEBANK', instrument: 'NSE:NIFTYBANK-INDEX' },
]);
assert.deepEqual(parseYahooSymbolConfig('^NSEI'), [{ symbol: '^NSEI', instrument: '^NSEI' }]);
console.log('Yahoo parser tests passed');
