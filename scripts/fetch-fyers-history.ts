/**
 * fetch-fyers-history.ts — bulk historical candle fetch from the Fyers v3
 * history API into fnf_market_snapshots (source='fyers-history') through
 * FnfTradingService.ingestSnapshots(), so dedupe + OHLC mapping match the
 * live feed path exactly (always record every feed, tagged by provenance).
 *
 * Run from repo root (home box, MDS via 3307 tunnel):
 *   set -a; . ./.env; set +a
 *   npx ts-node --transpile-only scripts/fetch-fyers-history.ts
 *
 * Env knobs:
 *   FYERS_HIST_SYMBOLS  comma list (default NSE:NIFTY50-INDEX,NSE:NIFTYBANK-INDEX,NSE:SENSEX-INDEX)
 *   FYERS_HIST_RES      '5' minutes | 'D' daily (default '5')
 *   FYERS_HIST_DAYS     lookback calendar days (default 30)
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { TradingAgentModule } from '../src/trading-agent/trading-agent.module';
import { FnfTradingService } from '../src/trading/fnf-trading.service';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const IST_OFFSET_S = 5 * 3600 + 30 * 60; // +05:30

async function main(): Promise<void> {
  const appId = process.env.FYERS_APP_ID?.trim() ?? '';
  const token = process.env.FYERS_ACCESS_TOKEN?.trim() ?? '';
  if (!appId || !token) {
    console.error('[fyers-history] FYERS_ACCESS_TOKEN missing — exchange an auth code first (see FYERS_API_SETUP.md).');
    process.exit(2);
  }
  const symbols = (process.env.FYERS_HIST_SYMBOLS ?? 'NSE:NIFTY50-INDEX,NSE:NIFTYBANK-INDEX,NSE:SENSEX-INDEX')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const res = process.env.FYERS_HIST_RES ?? '5';
  const days = Number(process.env.FYERS_HIST_DAYS ?? 30);

  const app = await NestFactory.createApplicationContext(TradingAgentModule, { logger: ['error', 'warn'] });
  const trading = app.get(FnfTradingService);

  // day boundary of "today" in IST, as UTC epoch seconds
  const now = Math.floor(Date.now() / 1000);
  const istTodayStart = Math.floor((now + IST_OFFSET_S) / 86400) * 86400 - IST_OFFSET_S;

  const url = 'https://api-t1.fyers.in/data/history'; // GET — v3 data API (no /v3/ prefix on data paths)
  const auth = `${appId}:${token}`;
  const getHistory = (symbol: string, resolution: string, fromS: number, toS: number) => {
    const q = new URLSearchParams({
      symbol, resolution, date_format: '1',
      range_from: String(fromS), range_to: String(toS), cont_flag: '1',
    });
    return fetch(`${url}?${q}`, { method: 'GET', headers: { Authorization: auth } }).then((r) => r.json());
  };
  let fetched = 0;
  const rows = [];

  for (const symbol of symbols) {
    if (res === 'D') {
      const from = istTodayStart - days * 86400;
      const to = now;
      const j: any = await getHistory(symbol, res, from, to);
      if (!j.candles) throw new Error(`${symbol} D: ${j.code ?? ''} ${j.message ?? JSON.stringify(j)}`);
      for (const c of j.candles) {
        rows.push(mkRow(symbol, c));
        fetched++;
      }
      console.log(`[fyers-history] ${symbol} D  ${j.candles.length} candles`);
      continue;
    }
    // intraday: one request per IST trading day, 09:15-15:30
    for (let d = days - 1; d >= 0; d--) {
      const dayStart = istTodayStart - d * 86400;
      const dow = new Date((dayStart + IST_OFFSET_S) * 1000).getUTCDay();
      if (dow === 0 || dow === 6) continue;
      const from = dayStart + (9 * 3600 + 15 * 60);
      const to = dayStart + (15 * 3600 + 30 * 60);
      const j: any = await getHistory(symbol, res, from, to);
      if (!j.candles) {
        console.error(`[fyers-history] ${symbol} ${d}d: ${j.code ?? ''} ${j.message ?? JSON.stringify(j)}`);
        break;
      }
      for (const c of j.candles) {
        rows.push(mkRow(symbol, c));
        fetched++;
      }
      if (fetched % 1500 < 80) console.log(`[fyers-history] ${symbol} ...${fetched} candles so far`);
      await sleep(250);
    }
  }

  console.log(`[fyers-history] fetched ${fetched} candles — ingesting into fnf_market_snapshots …`);
  await trading.ingestSnapshots(rows);
  console.log(`[fyers-history] DONE: ${fetched} rows stored (source='fyers-history')`);
  await app.close();
}

function mkRow(symbol: string, c: number[]): any {
  const [ts, o, h, l, cl, v] = c;
  return {
    instrument: symbol,
    ts: new Date(ts * 1000).toISOString(),
    price: cl, open: o, high: h, low: l, close: cl,
    volume: v ?? 0,
    source: 'fyers-history',
  };
}

main().catch((e) => {
  console.error('[fyers-history] FAILED:', e?.message ?? e);
  process.exit(1);
});
