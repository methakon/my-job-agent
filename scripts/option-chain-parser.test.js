const assert = require('node:assert/strict');
const { normalizeOptionContract, normalizeOptionQuote } = require('../dist/trading/option-chain-parser');

const contract = normalizeOptionContract({
  symbol: ' NSE:NIFTY26SEP25000CE ',
  underlying: ' nifty ',
  expiry: '2026-09-24',
  strike: '25000',
  optionType: 'ce',
  lotSize: '65',
});
assert.deepEqual(contract, {
  symbol: 'NSE:NIFTY26SEP25000CE',
  underlying: 'NIFTY',
  expiry: '2026-09-24',
  strike: 25000,
  optionType: 'CE',
  lotSize: 65,
  tickSize: 0.05,
});

const quote = normalizeOptionQuote({
  symbol: 'NSE:NIFTY26SEP25000CE',
  ltp: '123.45',
  bid: '123.4',
  ask: '123.5',
  volume: '1000',
  openInterest: '2000',
  impliedVolatility: '18.2',
  delta: '0.51',
  gamma: '0.0002',
  theta: '-12.5',
  vega: '8.1',
  ts: '2026-09-01T10:15:00.000Z',
  provider: 'fyers',
}, contract);
assert.deepEqual(quote, {
  contractSymbol: 'NSE:NIFTY26SEP25000CE',
  underlying: 'NIFTY',
  expiry: '2026-09-24',
  strike: 25000,
  optionType: 'CE',
  ltp: 123.45,
  bid: 123.4,
  ask: 123.5,
  volume: 1000,
  openInterest: 2000,
  impliedVolatility: 18.2,
  delta: 0.51,
  gamma: 0.0002,
  theta: -12.5,
  vega: 8.1,
  ts: '2026-09-01T10:15:00.000Z',
  provider: 'fyers',
});

assert.equal(normalizeOptionContract({
  symbol: 'bad', underlying: 'NIFTY', expiry: 'not-a-date', strike: 1, optionType: 'CE', lotSize: 1,
}), null);
assert.equal(normalizeOptionQuote({ symbol: 'NSE:NIFTY26SEP25000CE', ltp: -1 }, contract), null);

console.log('option-chain-parser tests passed');
