import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { DECAY_DEFAULTS, FnfTradingService, WEEKDAY_NAMES } from './fnf-trading.service';
import { FnoMarketDataService } from './fno-market-data.service';

const esc = (s: unknown): string =>
  String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c] as string));

const fmt = (n: unknown, digits = 2): string => {
  const v = Number(n ?? 0);
  return Number.isNaN(v) ? '—' : v.toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
};

const pct = (n: unknown): string => {
  const v = Number(n);
  return Number.isNaN(v) ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
};

const badge = (label: string, cls: string): string => `<span class="badge ${cls}">${esc(label)}</span>`;

/**
 * F&O paper-trading desk. This is deliberately a separate page from the
 * existing FNF page while it consumes the same guarded trading read models.
 * The planner is client-side only until an option-chain adapter is added.
 */
@Controller('option-trading')
export class OptionTradingPageController {
  constructor(private readonly trading: FnfTradingService, private readonly feed: FnoMarketDataService) {}

  @Get()
  async page(@Res() res: Response) {
    const [portfolios, trades, market, signals, learning, astro, calibrations] = await Promise.all([
      this.trading.listPortfolios(),
      this.trading.listTrades(undefined, 200),
      this.trading.marketTable(),
      this.trading.generateSignals(),
      this.trading.learningSummary(),
      this.trading.astroMatch(),
      this.trading.listCalibrations(),
    ]);

    const portfolio = portfolios[0] ?? null;
    const feedStatus = this.feed.status();
    const isFriday = new Date().getDay() === 5;
    const headroom = portfolio
      ? (Number(portfolio.ceiling) || Number(portfolio.capital)) - Number(portfolio.deployed)
      : 0;
    const capPct = portfolio && Number(portfolio.ceiling || portfolio.capital)
      ? Math.round((Number(portfolio.deployed) / Number(portfolio.ceiling || portfolio.capital)) * 100)
      : 0;

    const portfolioHtml = portfolio
      ? `<div class="grid2">
  <section class="card">
    <div class="card-title">💰 Shared F&amp;O risk envelope</div>
    <div class="kv">
      <div><span>Portfolio</span><b>${esc(portfolio.label)}</b></div>
      <div><span>Capital</span><b>₹ ${fmt(portfolio.capital, 0)}</b></div>
      <div><span>Hard ceiling</span><b>₹ ${fmt(portfolio.ceiling, 0)}</b></div>
      <div><span>Deployed</span><b>₹ ${fmt(portfolio.deployed, 0)} <small class="${capPct > 90 ? 'bad' : 'dim'}">${capPct}%</small></b></div>
      <div><span>Available headroom</span><b>₹ ${fmt(headroom, 0)}</b></div>
      <div><span>Lifetime net P&amp;L</span><b class="${Number(portfolio.netPnl) >= 0 ? 'ok' : 'bad'}">₹ ${fmt(portfolio.netPnl)}</b></div>
    </div>
  </section>
  <section class="card">
    <div class="card-title">🛡️ Inherited FNF/F&amp;O controls</div>
    <div class="kv">
      <div><span>Execution mode</span><b class="ok">PAPER ONLY</b></div>
      <div><span>Auto-trade</span><b class="${portfolio.autoTradeEnabled ? 'warn' : 'ok'}">${portfolio.autoTradeEnabled ? 'ON — blocked here' : 'OFF'}</b></div>
      <div><span>Friday rule</span><b class="${portfolio.fridayTradingEnabled ? 'ok' : 'warn'}">${portfolio.fridayTradingEnabled ? 'override enabled' : 'blocked by default'}</b></div>
      <div><span>Today</span><b>${isFriday ? 'Friday — ' + (portfolio.fridayTradingEnabled ? 'allowed by portfolio' : 'blocked') : 'not Friday'}</b></div>
      <div><span>Astro muhurta</span><b class="${astro.shubh ? 'ok' : 'warn'}">${astro.shubh ? '🕉 shubh' : 'not shubh'}</b></div>
      <div><span>Broker orders</span><b class="ok">never called</b></div>
    </div>
    <div class="hint">This page cannot place live orders. Option plans stay local until the contract, chain, Greeks, margin, and paper-ledger adapters are implemented.</div>
  </section>
</div>`
      : `<div class="card"><div class="empty">No shared portfolio yet. Create it through <code>POST /trading/portfolios</code>; F&amp;O will use the same capital ceiling.</div></div>`;

    const marketRows = market.length
      ? market.map((m) => {
          const cls = m.changePct === null ? 'dim' : m.changePct >= 0 ? 'ok' : 'bad';
          return `<tr><td><b>${esc(m.instrument)}</b></td><td>${fmt(m.price)}</td><td class="${cls}">${pct(m.changePct)}</td><td class="dim">${fmt(m.volume, 0)}</td><td class="dim">${new Date(m.ts).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</td></tr>`;
        }).join('')
      : `<tr><td colspan="5" class="dim">No underlying snapshots yet — ingest real market data through <code>POST /trading/market/ingest</code>.</td></tr>`;

    const signalRows = signals.length
      ? signals.map((s) => {
          const actionCls = s.action === 'BUY' ? 'ok' : s.action === 'SELL' ? 'bad' : 'warn';
          const decayCls = s.decayedConfidence < DECAY_DEFAULTS.confidenceFloor ? 'warn' : s.decay.timingFactor === 1 ? 'ok' : 'warn';
          return `<tr><td>${esc(s.instrument)}</td><td class="${actionCls}"><b>${s.action}</b></td><td>${fmt(s.price)}</td><td>${fmt(s.target)}</td><td>${fmt(s.stopLoss)}</td><td>${s.confidence}% → <b>${s.decayedConfidence}%</b></td><td>${s.astroMatch.shubh ? badge('🕉 shubh', 'ok') : badge('astro: no window', 'dim')} ${s.fridayBlocked ? badge('Friday block', 'warn') : badge('Friday ok', 'ok')}<br>${badge(`decay ${s.decay.ageHours.toFixed(1)}h ×${s.decay.rate.toFixed(3)}`, decayCls)}</td><td class="dim small">${esc(s.reasons.join('; '))}</td></tr>`;
        }).join('')
      : `<tr><td colspan="8" class="dim">No signals — the shared engine needs at least five snapshots per instrument.</td></tr>`;

    const decayRows = calibrations.map((c) => {
      const today = c.weekday === new Date().getDay();
      return `<tr class="${today ? 'today' : ''}"><td>${esc(WEEKDAY_NAMES[c.weekday] ?? c.weekday)}${today ? ' <b class="ok">← today</b>' : ''}</td><td>${fmt(c.decayRate, 4)}/h</td><td>${Number(c.windowStartHour).toFixed(2)} – ${Number(c.windowEndHour).toFixed(2)} IST</td><td>${c.samples}</td><td class="dim">${c.lastRectifiedAt ? new Date(c.lastRectifiedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never'}</td></tr>`;
    }).join('');

    const tradeRows = trades.length
      ? trades.map((t) => {
          let decision = '';
          if (t.decisionParams) {
            try {
              decision = `<div class="small dim">${esc(JSON.stringify(JSON.parse(t.decisionParams))).slice(0, 220)}</div>`;
            } catch {
              decision = `<div class="small dim">${esc(t.decisionParams).slice(0, 220)}</div>`;
            }
          }
          const pnl = t.status === 'CLOSED' ? `<span class="${Number(t.netPnl) >= 0 ? 'ok' : 'bad'}">₹ ${fmt(t.netPnl)}</span>` : '—';
          return `<tr><td class="dim">${new Date(t.orderedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</td><td>${esc(t.instrument)}</td><td>${t.side}</td><td>${t.quantity}</td><td>${fmt(t.entryPrice)}</td><td>${t.status === 'CLOSED' ? fmt(t.exitPrice) : '—'}</td><td>${t.cost ? '₹ ' + fmt(t.cost) : '—'}</td><td>${pnl}</td><td>${esc(t.status)}</td><td class="dim small">${esc(t.algoSource ?? 'manual')}${decision}</td></tr>`;
        }).join('')
      : `<tr><td colspan="10" class="dim">No trades yet. The option planner below does not write trades.</td></tr>`;

    const learningHtml = `<div class="kv"><div><span>Closed trades</span><b>${learning.total}</b></div><div><span>Win rate</span><b>${learning.winRate}%</b></div><div><span>Net P&amp;L</span><b class="${learning.netPnl >= 0 ? 'ok' : 'bad'}">₹ ${fmt(learning.netPnl)}</b></div><div><span>Winning trades</span><b>${learning.winners}</b></div></div>`;

    res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>my-job-agent — F&amp;O Options</title>
<style>
:root{--bg:#0f1115;--card:#1a1d24;--line:#2a2e38;--fg:#e8eaed;--dim:#9aa0aa;--ok:#3fb96f;--warn:#e0a83c;--bad:#e05c5c;--accent:#8d78ff}
*{box-sizing:border-box}body{background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,sans-serif;padding:24px;max-width:1280px;margin:auto}a{color:var(--accent)}h1{font-size:24px;margin:0}.masthead{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;margin-bottom:16px}.meta,.hint,.dim{color:var(--dim)}.meta{font-size:13px}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:16px}.card-title{font-size:14px;font-weight:600;color:var(--dim);text-transform:uppercase;letter-spacing:.05em;margin-bottom:12px}.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}@media(max-width:900px){.grid2{grid-template-columns:1fr}}.kv{display:grid;grid-template-columns:1fr 1fr;gap:8px 24px}.kv>div{display:flex;justify-content:space-between;gap:8px;border-bottom:1px dashed var(--line);padding:4px 0}.kv span{color:var(--dim)}table{border-collapse:collapse;width:100%;margin:6px 0 10px;font-size:13px}td,th{border:1px solid var(--line);padding:6px 10px;text-align:left;vertical-align:top}th{background:var(--card);color:var(--dim);font-weight:600;text-transform:uppercase;font-size:11px;letter-spacing:.05em}.mini{max-width:600px}.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}.small{font-size:12px}.badge{font-size:11px;padding:2px 9px;border-radius:99px;background:var(--line);color:var(--dim);display:inline-block;margin:2px 3px 2px 0}.badge.ok{background:rgba(63,185,111,.18);color:var(--ok)}.badge.warn{background:rgba(224,168,60,.18);color:var(--warn)}.today td{background:rgba(141,120,255,.1)}.empty{border:1px dashed var(--line);border-radius:10px;padding:20px;text-align:center;color:var(--dim)}code{font:12px/1.5 ui-monospace,monospace;color:var(--warn);background:rgba(224,168,60,.1);padding:1px 4px;border-radius:4px}.hero{border-color:rgba(141,120,255,.55);background:linear-gradient(135deg,rgba(141,120,255,.12),var(--card) 48%)}.notice{border-left:4px solid var(--ok);padding:10px 12px;background:rgba(63,185,111,.1);margin:10px 0}.formgrid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}@media(max-width:900px){.formgrid{grid-template-columns:repeat(2,1fr)}}@media(max-width:560px){.formgrid{grid-template-columns:1fr}}label{display:grid;gap:4px;color:var(--dim);font-size:12px}input,select{width:100%;background:#11141a;color:var(--fg);border:1px solid var(--line);border-radius:7px;padding:8px;font:inherit}button{background:var(--accent);color:#fff;border:0;border-radius:7px;padding:9px 14px;font-weight:600;cursor:pointer}.result{margin-top:14px;padding:12px;border:1px solid var(--line);border-radius:8px;min-height:44px}.footer{margin-top:24px;padding-top:16px;border-top:1px solid var(--line);color:var(--dim);font-size:13px}
</style></head><body>
<div class="masthead"><div><h1>🟣 F&amp;O Options Trading</h1><div class="meta">Dedicated option desk · shared FNF/F&amp;O risk envelope · decay-adjusted signals · astro timing · learning and P&amp;L</div></div><div class="meta">Paper-only · API <code>/trading/...</code> · <a href="/docs">Swagger</a></div></div>
<section class="card hero"><div class="card-title">🛑 Safety boundary · live market input</div><div class="notice"><b>REAL MARKET DATA IN → SIMULATED PLAN OUT.</b> ${feedStatus.provider === 'yahoo' ? 'Yahoo Finance chart polling' : 'FYERS market-data WebSocket'}: <b id="feedState" class="${feedStatus.connected ? 'ok' : 'warn'}">${feedStatus.connected ? 'CONNECTED' : 'NOT CONNECTED'}</b> · <span id="feedTicks">${feedStatus.ticksReceived}</span> tick(s) received · <a href="/trading/market-feed/status">feed status JSON</a></div><div class="hint">Subscribed symbols: ${feedStatus.subscribedSymbols.map((symbol) => `<code>${esc(symbol)}</code>`).join(' ') || 'none'}. This page has no live broker order path. Nothing here submits an order or changes the trade ledger.</div><div class="hint">Option execution remains disabled until the contract, chain, Greeks, margin, and paper-fill adapters are validated. <span id="feedMessage">${feedStatus.lastError ? `Feed error: ${esc(feedStatus.lastError)}` : esc(feedStatus.lastMessage ?? '')}</span></div></section>
${portfolioHtml}
<section class="card"><div class="card-title">🧮 Option contract planner — local calculation only</div><div class="formgrid"><label>Underlying<select id="underlying"><option>NIFTY</option><option>SENSEX</option><option>BANKNIFTY</option></select></label><label>Expiry<input id="expiry" type="date"></label><label>Strike<input id="strike" type="number" min="0" step="0.05" placeholder="e.g. 25000"></label><label>Type<select id="optionType"><option>CE</option><option>PE</option></select></label><label>Action<select id="action"><option>BUY</option><option>SELL</option></select></label><label>Premium (₹)<input id="premium" type="number" min="0" step="0.05" placeholder="0.00"></label><label>Lot size<input id="lotSize" type="number" min="1" step="1" value="1"></label><label>Lots<input id="lots" type="number" min="1" step="1" value="1"></label></div><div style="margin-top:14px"><button id="planButton" type="button">Calculate paper plan</button></div><div id="planResult" class="result dim">Enter contract details. This calculation never sends an order.</div></section>
<div class="grid2"><section class="card"><div class="card-title">📈 Shared learning / P&amp;L</div>${learningHtml}<div class="hint">Closed-trade learning is currently shared with the existing FNF ledger. Option-specific calibration will be separated after the option adapter lands.</div></section><section class="card"><div class="card-title">🕉 Timing and risk gates</div><div class="kv"><div><span>Muhurta</span><b class="${astro.shubh ? 'ok' : 'warn'}">${astro.shubh ? 'shubh' : 'not shubh'}</b></div><div><span>Score</span><b>${astro.score}/100</b></div><div><span>Next window</span><b>${esc(astro.label)}</b></div><div><span>Decay floor</span><b>${DECAY_DEFAULTS.confidenceFloor}%</b></div><div><span>Timing factor</span><b>${DECAY_DEFAULTS.timingPenalty} outside window</b></div><div><span>Max envelope used</span><b>₹ ${fmt(portfolio?.ceiling ?? 0, 0)}</b></div></div></section></div>
<section class="card"><div class="card-title">📡 Underlying market feed — real snapshots used by the shared engine</div><table><tr><th>Instrument</th><th>Price</th><th>Change</th><th>Volume</th><th>As of</th></tr>${marketRows}</table><div class="hint">An option-chain provider is intentionally not faked. The option adapter must map real chain quotes to contracts before paper execution is enabled.</div></section>
<section class="card"><div class="card-title">🤖 Shared prediction engine — raw → decay-adjusted confidence</div><table><tr><th>Underlying</th><th>Action</th><th>Price</th><th>Target</th><th>Stop-loss</th><th>Confidence</th><th>Gates</th><th>Reasons</th></tr>${signalRows}</table></section>
<section class="card"><div class="card-title">⏳ Day-wise decay calibration — inherited from FNF</div><table class="mini"><tr><th>Weekday</th><th>Rate</th><th>Entry window</th><th>Samples</th><th>Last rectified</th></tr>${decayRows}</table><div class="hint">The same self-rectifying decay model, timing window, confidence floor, Friday guard, and astro gate apply to option signals.</div></section>
<section class="card"><div class="card-title">📒 Shared trade ledger / P&amp;L</div><table><tr><th>Opened</th><th>Instrument</th><th>Side</th><th>Qty</th><th>Entry</th><th>Exit</th><th>Cost</th><th>Net P&amp;L</th><th>Status</th><th>Decision context</th></tr>${tradeRows}</table></section>
<section class="card"><div class="card-title">🧱 Option implementation status</div><div class="grid2"><div><b class="ok">Page live</b><p class="hint">Contract planner, safety boundary, inherited controls, market feed, signals, decay, learning, and ledger are rendered from the application services.</p></div><div><b class="warn">Backend still gated</b><p class="hint">TODO: real option-chain feed, contract metadata/expiry, Greeks, margin and lot-size validation, option-specific paper ledger, costs, and end-to-end tests.</p></div></div></section>
<div class="footer"><a href="/">← dashboard</a> · <a href="/fnf-trading">FNF trading</a> · <a href="/applications-page">applications</a> · <a href="/docs">swagger</a><br>F&amp;O options page is paper-only and reuses the existing guarded FNF trading read models.</div>
<script>
(function(){
  function refreshFeedStatus(){
    fetch('/trading/market-feed/status').then(function(response){ return response.json(); }).then(function(data){
      var state=document.getElementById('feedState');
      var ticks=document.getElementById('feedTicks');
      var message=document.getElementById('feedMessage');
      if(state){ state.textContent=data.connected?'CONNECTED':'NOT CONNECTED'; state.className=data.connected?'ok':'warn'; }
      if(ticks){ ticks.textContent=String(data.ticksReceived || 0); }
      if(message){ message.textContent=data.lastError ? 'Feed error: '+data.lastError : (data.lastMessage || ''); }
    }).catch(function(){ /* keep the last known status on transient UI errors */ });
  }
  refreshFeedStatus();
  window.setInterval(refreshFeedStatus,5000);
})();
(function(){
  var button=document.getElementById('planButton');
  var result=document.getElementById('planResult');
  button.addEventListener('click',function(){
    var underlying=document.getElementById('underlying').value;
    var expiry=document.getElementById('expiry').value || 'expiry not set';
    var strike=Number(document.getElementById('strike').value);
    var type=document.getElementById('optionType').value;
    var action=document.getElementById('action').value;
    var premium=Number(document.getElementById('premium').value);
    var lotSize=Number(document.getElementById('lotSize').value);
    var lots=Number(document.getElementById('lots').value);
    if(!strike || premium < 0 || !lotSize || !lots){ result.textContent='Enter strike, premium, lot size, and lots.'; result.className='result warn'; return; }
    var quantity=lotSize*lots;
    var notional=premium*quantity;
    var risk=action==='BUY' ? notional : 'margin required after backend validation';
    result.className='result';
    result.innerHTML='<b>PAPER PLAN — not submitted</b><br>'+underlying+' '+expiry+' '+strike+' '+type+' · '+action+' · '+quantity+' units ('+lots+' lot'+(lots===1?'':'s')+') · premium ₹ '+premium.toFixed(2)+' · premium notional ₹ '+notional.toFixed(2)+' · max premium risk: '+(typeof risk==='number'?'₹ '+risk.toFixed(2):risk);
  });
})();
</script></body></html>`);
  }
}
