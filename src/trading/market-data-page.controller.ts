import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';

@Controller('market-data')
export class MarketDataPageController {
  @Get()
  page(@Res() res: Response): void {
    res.send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>my-job-agent — Market Data Inspector</title>
<style>
:root{--bg:#0f1115;--card:#1a1d24;--line:#2a2e38;--fg:#e8eaed;--dim:#9aa0aa;--ok:#3fb96f;--warn:#e0a83c;--bad:#e05c5c;--accent:#6f8cff}
*{box-sizing:border-box}body{background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif;padding:24px;max-width:1500px;margin:auto}a{color:var(--accent)}h1{font-size:25px;margin:0}.meta,.hint{color:var(--dim);font-size:13px}.masthead{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;margin-bottom:20px}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:16px}.card-title{font-size:13px;font-weight:700;color:var(--dim);text-transform:uppercase;letter-spacing:.06em;margin-bottom:12px}.status{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.pill{border:1px solid var(--line);border-radius:99px;padding:4px 10px;font-size:12px}.pill.ok{border-color:var(--ok);color:var(--ok)}.pill.warn{border-color:var(--warn);color:var(--warn)}.grid{display:grid;grid-template-columns:repeat(4,minmax(150px,1fr));gap:12px}.field{display:flex;flex-direction:column;gap:5px}.field.wide{grid-column:span 2}label{font-size:12px;color:var(--dim)}input,select,button{font:inherit;color:var(--fg);background:#11141a;border:1px solid var(--line);border-radius:7px;padding:8px 9px}input:focus,select:focus{outline:1px solid var(--accent)}button{cursor:pointer;background:var(--accent);border-color:var(--accent);font-weight:600;padding:8px 14px}button.secondary{background:transparent;border-color:var(--line);font-weight:500}.actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:14px}.check{display:flex;align-items:center;gap:7px;color:var(--dim);font-size:13px}.check input{accent-color:var(--accent)}.summary{display:flex;gap:22px;flex-wrap:wrap;color:var(--dim);font-size:13px}.summary b{color:var(--fg)}.table-wrap{overflow:auto}table{border-collapse:collapse;width:100%;min-width:980px;font-size:13px}td,th{border:1px solid var(--line);padding:7px 9px;text-align:right;white-space:nowrap}th{text-align:right;background:#15181f;color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.04em}td:first-child,th:first-child,td:nth-child(2),th:nth-child(2){text-align:left}.positive{color:var(--ok)}.negative{color:var(--bad)}.empty{text-align:center;color:var(--dim);padding:30px}.footer{color:var(--dim);font-size:12px;margin-top:22px;border-top:1px solid var(--line);padding-top:14px}@media(max-width:850px){.grid{grid-template-columns:repeat(2,minmax(140px,1fr))}.field.wide{grid-column:span 2}}@media(max-width:500px){body{padding:14px}.grid{grid-template-columns:1fr}.field.wide{grid-column:span 1}}
</style>
</head>
<body>
<header class="masthead"><div><h1>🔎 Market Data Inspector</h1><div class="meta">Inspect the real market-data snapshots feeding the paper-only F&amp;O desk.</div></div><div class="meta"><a href="/">dashboard</a> · <a href="/option-trading">F&amp;O desk</a> · <a href="/docs">Swagger</a></div></header>
<section class="card"><div class="card-title">Feed status</div><div class="status"><span id="provider" class="pill">checking provider…</span><span id="connection" class="pill">checking connection…</span><span id="ticks" class="pill">ticks: —</span><span id="symbols" class="pill">symbols: —</span></div><p id="feedMessage" class="hint">Loading feed status…</p><p class="hint">Market data may be real or near-real-time. Orders, fills, P&amp;L, and execution remain simulated; this page never places trades. Yahoo Finance is an underlying/index proxy and is not a complete NSE option-chain feed.</p></section>
<section class="card"><div class="card-title">Filters</div><form id="filters"><div class="grid">
<div class="field wide"><label for="instrument">Instrument contains</label><input id="instrument" placeholder="e.g. NIFTY50 or BANK" autocomplete="off"></div>
<div class="field"><label for="preset">Time range</label><select id="preset"><option value="all">All available</option><option value="15m">Last 15 minutes</option><option value="1h">Last hour</option><option value="today">Today</option><option value="7d">Last 7 days</option></select></div>
<div class="field"><label for="from">From (optional)</label><input id="from" type="datetime-local"></div>
<div class="field"><label for="to">To (optional)</label><input id="to" type="datetime-local"></div>
<div class="field"><label for="minPrice">Minimum price</label><input id="minPrice" type="number" step="any" min="0" placeholder="No minimum"></div>
<div class="field"><label for="maxPrice">Maximum price</label><input id="maxPrice" type="number" step="any" min="0" placeholder="No maximum"></div>
<div class="field"><label for="minVolume">Minimum volume</label><input id="minVolume" type="number" step="any" min="0" placeholder="No minimum"></div>
<div class="field"><label for="maxVolume">Maximum volume</label><input id="maxVolume" type="number" step="any" min="0" placeholder="No maximum"></div>
<div class="field"><label for="ohlc">OHLC availability</label><select id="ohlc"><option value="">Any</option><option value="complete">Complete OHLC</option><option value="partial">Partial OHLC</option><option value="missing">Missing OHLC</option></select></div>
<div class="field"><label for="limit">Rows to show</label><select id="limit"><option>100</option><option>250</option><option>500</option></select></div>
</div><div class="actions"><button type="submit">Apply filters</button><button type="button" class="secondary" id="reset">Reset</button><label class="check"><input id="autoRefresh" type="checkbox" checked> refresh every 15 seconds</label><label class="check"><input id="latestOnly" type="checkbox"> latest row per instrument only</label></div></form></section>
<section class="card"><div class="summary"><span>Matching rows: <b id="count">—</b></span><span id="more"> </span><span>Last refreshed: <b id="refreshed">—</b></span><span>API: <code>GET /trading/market/snapshots</code></span></div><div class="table-wrap"><table><thead><tr><th>Timestamp (IST)</th><th>Instrument</th><th>Price</th><th>Open</th><th>High</th><th>Low</th><th>Close</th><th>Volume</th><th>OHLC</th></tr></thead><tbody id="rows"><tr><td colspan="9" class="empty">Loading snapshots…</td></tr></tbody></table></div></section>
<div class="footer">Data source is controlled by <code>FNO_MARKET_DATA_PROVIDER</code>. Historical rows do not invent a provider label; the current feed provider is shown above. Yahoo availability can be rate-limited.</div>
<script>
(function(){
  const byId=(id)=>document.getElementById(id);
  const esc=(value)=>String(value??'').replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const val=(id)=>byId(id).value.trim();
  const number=(id)=>{const x=val(id);return x===''?null:x};
  function isoFromLocal(id){const x=val(id);if(!x)return null;const d=new Date(x);return Number.isNaN(d.getTime())?null:d.toISOString()}
  function params(){
    const p=new URLSearchParams(); const instrument=val('instrument'); if(instrument)p.set('instrument',instrument);
    let from=isoFromLocal('from'), to=isoFromLocal('to'); const preset=val('preset'); const now=new Date();
    if(preset!=='all'&&!from&&!to){const start=new Date(now); if(preset==='15m')start.setMinutes(start.getMinutes()-15); if(preset==='1h')start.setHours(start.getHours()-1); if(preset==='7d')start.setDate(start.getDate()-7); if(preset==='today')start.setHours(0,0,0,0); from=start.toISOString();}
    if(from)p.set('from',from); if(to)p.set('to',to);
    ['minPrice','maxPrice','minVolume','maxVolume'].forEach((id)=>{const x=number(id);if(x!==null)p.set(id,x)});
    if(val('ohlc'))p.set('ohlc',val('ohlc')); if(byId('latestOnly').checked)p.set('latestOnly','true'); p.set('limit',val('limit')||'100'); return p;
  }
  function cell(row,value,cls){const td=document.createElement('td');td.textContent=value===null||value===undefined||value===''?'—':value;if(cls)td.className=cls;row.appendChild(td)}
  function fmt(value,digits){if(value===null||value===undefined||value==='')return '—';const n=Number(value);return Number.isFinite(n)?n.toLocaleString('en-IN',{minimumFractionDigits:digits,maximumFractionDigits:digits}):'—'}
  function render(data){const tbody=byId('rows');tbody.textContent='';byId('count').textContent=String(data.total??data.rows?.length??0);byId('more').textContent=data.hasMore?'(display capped; narrow the filters for a complete view)':'';const rows=data.rows||[];if(!rows.length){const tr=document.createElement('tr');const td=document.createElement('td');td.colSpan=9;td.className='empty';td.textContent='No snapshots match these filters.';tr.appendChild(td);tbody.appendChild(tr);return}rows.forEach((item)=>{const tr=document.createElement('tr');const date=new Date(item.ts);cell(tr,Number.isNaN(date.getTime())?'—':date.toLocaleString('en-IN',{timeZone:'Asia/Kolkata'}));cell(tr,item.instrument);cell(tr,fmt(item.price,2));cell(tr,fmt(item.open,2));cell(tr,fmt(item.high,2));cell(tr,fmt(item.low,2));cell(tr,fmt(item.close,2));cell(tr,fmt(item.volume,0));const values=[item.open,item.high,item.low,item.close].filter((x)=>x!==null&&x!==undefined&&x!=='').length;cell(tr,values===4?'complete':values===0?'missing':'partial');tbody.appendChild(tr)});}
  async function load(){try{const response=await fetch('/trading/market/snapshots?'+params().toString(),{cache:'no-store'});const data=await response.json();if(!response.ok)throw new Error(data.message||'snapshot request failed');render(data);byId('refreshed').textContent=new Date().toLocaleTimeString('en-IN',{timeZone:'Asia/Kolkata'})}catch(error){byId('rows').innerHTML='<tr><td colspan="9" class="empty">'+esc(error.message)+'</td></tr>';byId('count').textContent='error'}}
  async function status(){try{const response=await fetch('/trading/market-feed/status',{cache:'no-store'});const data=await response.json();const provider=byId('provider');provider.textContent='provider: '+data.provider;provider.className='pill '+(data.provider==='disabled'?'warn':'ok');const connection=byId('connection');connection.textContent=data.connected?'connected':'not connected';connection.className='pill '+(data.connected?'ok':'warn');byId('ticks').textContent='ticks: '+(data.ticksReceived??0);byId('symbols').textContent='symbols: '+(data.subscribedSymbols||[]).length;byId('feedMessage').textContent=data.lastError||data.lastMessage||'No feed message.'}catch(error){byId('feedMessage').textContent='Feed status unavailable: '+error.message}}
  byId('filters').addEventListener('submit',(event)=>{event.preventDefault();load()});byId('reset').addEventListener('click',()=>{byId('filters').reset();load()});byId('preset').addEventListener('change',()=>{if(val('preset')!=='all'){byId('from').value='';byId('to').value=''}});let timer=null;function timerUpdate(){if(timer)clearInterval(timer);if(byId('autoRefresh').checked)timer=setInterval(()=>{load();status()},15000)}byId('autoRefresh').addEventListener('change',timerUpdate);status();load();timerUpdate();
})();
</script>
</body></html>`);
  }
}
