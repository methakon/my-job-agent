#!/usr/bin/env node
'use strict';

/**
 * Import Yahoo Finance daily underlying/index history into the paper-trading
 * snapshot table through the app's existing ingest endpoint.
 *
 * This intentionally does not fetch or synthesize CE/PE option history.
 * Yahoo's chart feed is an interim underlying-only source.
 */

const DEFAULT_SYMBOLS = '^NSEI=NSE:NIFTY50-INDEX,^NSEBANK=NSE:NIFTYBANK-INDEX,^BSESN=NSE:SENSEX-INDEX';
const range = process.env.YAHOO_HISTORY_RANGE || '5y';
const interval = process.env.YAHOO_HISTORY_INTERVAL || '1d';
const baseUrl = (process.env.PAPER_TRADING_API_URL || `http://127.0.0.1:${process.env.PORT || 3010}`).replace(/\/$/, '');
const yahooBase = (process.env.YAHOO_FINANCE_CHART_URL || 'https://query1.finance.yahoo.com/v8/finance/chart').replace(/\/$/, '');
const batchSize = 100;

function parseSymbols(raw) {
  return raw.split(',').map((entry) => {
    const [symbol, instrument] = entry.split('=').map((part) => part.trim());
    if (!symbol || !instrument) throw new Error(`Invalid Yahoo symbol mapping: ${entry}`);
    return { symbol, instrument };
  }).filter(({ symbol, instrument }) => symbol && instrument).slice(0, 50);
}

async function fetchHistory({ symbol, instrument }) {
  const params = new URLSearchParams({ range, interval, includePrePost: 'false', events: 'div,splits' });
  const url = `${yahooBase}/${encodeURIComponent(symbol)}?${params}`;
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'my-job-agent-paper-history/1.0' },
  });
  if (!response.ok) throw new Error(`Yahoo HTTP ${response.status} for ${symbol}`);
  const payload = await response.json();
  const result = payload?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo returned no chart for ${symbol}`);
  const timestamps = Array.isArray(result.timestamp) ? result.timestamp : [];
  const quote = result.indicators?.quote?.[0] || {};
  const rows = [];
  for (let i = 0; i < timestamps.length; i += 1) {
    const close = quote.close?.[i];
    if (!Number.isFinite(close)) continue;
    const ts = new Date(Number(timestamps[i]) * 1000);
    if (Number.isNaN(ts.getTime())) continue;
    rows.push({
      instrument,
      price: close,
      volume: Number.isFinite(quote.volume?.[i]) ? quote.volume[i] : 0,
      open: Number.isFinite(quote.open?.[i]) ? quote.open[i] : undefined,
      high: Number.isFinite(quote.high?.[i]) ? quote.high[i] : undefined,
      low: Number.isFinite(quote.low?.[i]) ? quote.low[i] : undefined,
      close,
      ts: ts.toISOString(),
    });
  }
  return { symbol, instrument, rows };
}

async function ingest(rows) {
  let inserted = 0;
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    const response = await fetch(`${baseUrl}/trading/market/ingest`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ rows: batch }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`ingest HTTP ${response.status}: ${body.slice(0, 240)}`);
    }
    const count = await response.json();
    if (!Number.isFinite(Number(count))) throw new Error(`ingest returned unexpected result: ${JSON.stringify(count)}`);
    inserted += Number(count);
  }
  return inserted;
}

async function main() {
  const symbols = parseSymbols(process.env.YAHOO_FINANCE_SYMBOLS || DEFAULT_SYMBOLS);
  const summaries = [];
  for (const config of symbols) {
    const result = await fetchHistory(config);
    const inserted = await ingest(result.rows);
    summaries.push({ ...config, fetched: result.rows.length, inserted,
      firstTs: result.rows[0]?.ts || null, lastTs: result.rows.at(-1)?.ts || null });
  }
  console.log(JSON.stringify({ source: 'Yahoo Finance chart API', mode: 'underlying-only', range, interval,
    api: baseUrl, symbols: summaries, totalFetched: summaries.reduce((n, s) => n + s.fetched, 0),
    totalInserted: summaries.reduce((n, s) => n + s.inserted, 0) }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
