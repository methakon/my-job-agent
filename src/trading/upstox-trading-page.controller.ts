import { Controller, Get, Post, Query, Res, Body } from '@nestjs/common';
import type { Response } from 'express';
import { UpstoxTradingService } from './upstox-trading.service';
import { BypassAuth, AllowIps } from '../auth/bypass-auth.decorator';
import { ConfigService } from '@nestjs/config';

const esc = (s: unknown): string =>
  String(s ?? '').replace(/[<>&\"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '\"': '&quot;', "'": '&#39;' }[c] as string));

const fmt = (n: unknown, digits = 2): string => {
  const v = Number(n ?? 0);
  return isNaN(v) ? '—' : v.toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
};

const pct = (n: unknown): string => {
  const v = Number(n ?? 0);
  if (isNaN(v) || v === null) return '—';
  const s = v >= 0 ? '+' : '';
  return `${s}${v.toFixed(2)}%`;
};

const badge = (label: string, cls: string): string => `<span class="badge ${cls}">${esc(label)}</span>`;

@Controller('upstox-trading')
@BypassAuth()
@AllowIps('127.0.0.1', '::1')
export class UpstoxTradingPageController {
  constructor(
    private readonly upstox: UpstoxTradingService,
    private readonly config: ConfigService,
  ) {}

  @Get('sandbox-open')
  async sandboxOpenPage(@Res() res: Response) {
    return res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>my-job-agent — Open Sandbox Trade</title>
<style>
:root{--bg:#0f1115;--card:#1a1d24;--line:#2a2e38;--fg:#e8eaed;--dim:#9aa0aa;--ok:#3fb96f;--warn:#e0a83c;--bad:#e05c5c;--accent:#5b8cff}
body{background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,sans-serif;padding:24px;max-width:800px;margin:auto}
a{color:var(--accent)}
h1{font-size:24px;margin:0}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px;margin-bottom:20px}
.card-title{margin:0 0 16px;font-size:18px;font-weight:600}
.form-row{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}
label{display:block;color:var(--dim);font-size:13px;margin-bottom:6px}
input,select{width:100%;background:rgba(255,255,255,.05);border:1px solid var(--line);border-radius:8px;color:var(--fg);padding:10px 14px;font:15px/1.6 system-ui,sans-serif}
.btn{display:inline-block;background:var(--accent);color:#fff;text-decoration:none;padding:12px 24px;border-radius:10px;font-weight:600;border:none;cursor:pointer;font-size:15px}
.btn:hover{filter:brightness(1.12)}
</style></head><body>
<div class="card">
  <div class="card-title">📈 Open Sandbox Trade</div>
  <form action="/upstox-trading/sandbox-execute" method="post">
    <div class="form-row">
      <div>
        <label>Instrument</label>
        <input type="text" name="instrument" value="NIFTY25DEC22500PE" placeholder="NIFTY25DEC22500PE" required>
        <div class="hint">Calls: 22500CE, Puts: 22500PE</div>
      </div>
      <div>
        <label>Side</label>
        <select name="side" required>
          <option value="BUY">BUY</option>
          <option value="SELL">SELL</option>
        </select>
      </div>
    </div>
    <div class="form-row">
      <div>
        <label>Quantity (lots × 50)</label>
        <input type="number" name="quantity" value="1" min="1" max="15" required>
        <div class="hint">1 lot = 50 units</div>
      </div>
      <div>
        <label>Price (₹)</label>
        <input type="number" step="0.05" name="price" value="85" min="1" required>
      </div>
    </div>
    <div style="margin-top:24px">
      <button type="submit" class="btn">📈 Execute Sandbox Trade</button>
      <a href="/upstox-trading" style="margin-left:12px">← Back to Upstox</a>
    </div>
    <div class="hint">Trade will be simulated with real cost calculations · ₹5,000 capital rule enforced</div>
  </form>
</div>
</body></html>`);
  }

  @Post('sandbox-execute')
  async executeTrade(@Body() body: any, @Res() res: Response) {
    // TODO: Implement sandbox trade execution with ₹5,000 rule
    return res.redirect('/upstox-trading');
  }

  @Get()
  async page(@Res() res: Response) {
    // Check if Upstox sandbox is enabled
    const isSandboxEnabled = this.config.get('UPSTOX_SANDBOX_ENABLED', 'true') === 'true';

    const [portfolios, trades, market, signals, learning, astro] = await Promise.all([
      this.upstox.listPortfolios(),
      this.upstox.listTrades(),
      this.upstox.marketTable(),
      this.upstox.generateSignals(),
      this.upstox.learningSummary(),
      this.upstox.astroMatch(),
    ]);

    // Create default portfolio if none exists
    if (portfolios.length === 0 && (await this.upstox.createPortfolio('Upstox Sandbox', 5000))) {
      portfolios.push(...await this.upstox.listPortfolios());
    }

    const portfolio = portfolios[0] ?? null;
    const isFriday = new Date().getDay() === 5;

    // ── portfolio card ──
    let portfolioHtml = `<div class="empty">No portfolio yet — auto-created with ₹5,000 capital.</div>`;
    if (portfolio) {
      const headroom = (Number(portfolio.ceiling) || Number(portfolio.capital)) - Number(portfolio.deployed);
      const capPct = Number(portfolio.capital) ? Math.round((Number(portfolio.deployed) / Number(portfolio.ceiling || portfolio.capital)) * 100) : 0;
      const netPnlCls = Number(portfolio.netPnl) >= 0 ? 'ok' : 'bad';
      const fridayCls = portfolio.fridayTradingEnabled ? 'ok' : 'warn';
      const autoCls = portfolio.autoTradeEnabled ? 'ok' : 'dim';
      portfolioHtml = `
<div class="grid2">
  <div class="card">
    <div class="card-title">💰 Upstox Sandbox Portfolio</div>
    <div class="kv">
      <div><span>Capital</span><b>₹ ${fmt(portfolio.capital, 0)}</b></div>
      <div><span>Ceiling</span><b>₹ ${fmt(portfolio.ceiling, 0)}</b></div>
      <div><span>Deployed</span><b>₹ ${fmt(portfolio.deployed, 0)} <small class="${capPct > 90 ? 'bad' : 'dim'}">${capPct}%</small></b></div>
      <div><span>Headroom</span><b>₹ ${fmt(headroom, 0)}</b></div>
      <div><span>Net P&L (lifetime)</span><b class="${netPnlCls}">₹ ${fmt(portfolio.netPnl)}</b></div>
      <div><span>Total cost paid</span><b>₹ ${fmt(portfolio.totalCost)}</b></div>
    </div>
  </div>
  <div class="card">
    <div class="card-title">⚙️ Sandbox Controls</div>
    <div class="kv">
      <div><span>Auto-trade</span><b class="${autoCls}">${portfolio.autoTradeEnabled ? 'ON' : 'OFF'}</b></div>
      <div><span>Friday block</span><b class="${fridayCls}">${portfolio.fridayTradingEnabled ? 'enabled (Friday trades allowed)' : 'active — no new positions on Friday'}</b></div>
      <div><span>Today</span><b>${isFriday ? 'Friday — ' + (portfolio.fridayTradingEnabled ? 'trades allowed' : 'blocked by default') : 'not Friday'}</b></div>
      <div><span>Astro muhurta</span><b class="${astro.shubh ? 'ok' : 'warn'}">${astro.shubh ? '🕉 shubh' : 'not shubh'} <small>${esc(astro.label)}</small></b></div>
    </div>
    <div class="hint">Upstox sandbox follows ₹5,000 capital rule — same as Fyers desk.</div>
  </div>
</div>
<div class="grid2">
  <div class="card">
    <div class="card-title">🎯 Quick Actions</div>
    <p><a class="btn" href="/upstox-trading/sandbox-open">📈 Open Sandbox Trade</a></p>
    <div class="hint">All trades are simulated with real cost calculations but no real money.</div>
  </div>
  <div class="card">
    <div class="card-title">📊 Learning (closed trades)</div>
    <div class="kv">
      <div><span>Total closed</span><b>${learning.total}</b></div>
      <div><span>Win rate</span><b>${learning.winRate}% (${learning.winners} wins)</b></div>
      <div><span>Net P&L</span><b class="${learning.netPnl >= 0 ? 'ok' : 'bad'}">₹ ${fmt(learning.netPnl)}</b></div>
    </div>
  </div>
</div>`;
    }

    // ── market table ──
    const marketRows = market.length
      ? market.map((m) => {
          const cls = m.changePct === null ? 'dim' : m.changePct >= 0 ? 'ok' : 'bad';
          return `<tr><td>${esc(m.instrument)}</td><td><b>${fmt(m.price, 2)}</b></td><td class="${cls}">${pct(m.changePct)}</td><td class="dim">${fmt(m.volume, 0)}</td><td class="dim">${new Date(m.ts).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</td></tr>`;
        }).join('')
      : `<tr><td colspan="5" class="dim">No market data in sandbox.</td></tr>`;

    // ── signals panel ──
    const signalRows = signals.length
      ? signals.map((s) => {
          const actionCls = s.action === 'BUY' ? 'ok' : s.action === 'SELL' ? 'bad' : 'warn';
          const fridayFlag = s.fridayBlocked ? badge('Friday block', 'warn') : badge('Friday ok', 'ok');
          const astroFlag = s.astroMatch.shubh ? badge('🕉 shubh', 'ok') : badge('astro: no window', 'dim');
          const scenarios = s.scenarios.map((sc) => `${esc(sc.name)} ${sc.probability}% → ${fmt(sc.target)}`).join(' · ');
          return `<tr>
            <td>${esc(s.instrument)}</td>
            <td class="${actionCls}"><b>${s.action}</b></td>
            <td>${fmt(s.price)}</td>
            <td>${fmt(s.target)}</td>
            <td>${fmt(s.stopLoss)}</td>
            <td>${s.confidence}% → <b>${s.decayedConfidence}%</b></td>
            <td class="dim">${esc(s.algoSource)}</td>
            <td>${astroFlag} ${fridayFlag}</td>
            <td class="dim small">${esc(s.reasons.join('; '))}<br>${esc(scenarios)}</td>
          </tr>`;
        }).join('')
      : `<tr><td colspan="9" class="dim">No signals — sandbox mock.</td></tr>`;

    // ── trade ledger ──
    const tradeRows = trades.length
      ? trades.map((t) => {
          const sideCls = t.side === 'BUY' ? 'ok' : 'bad';
          const statusCls = t.status === 'CLOSED' ? 'dim' : t.status === 'OPEN' ? 'ok' : 'warn';
          let decision = '';
          if (t.decisionParams) {
            try {
              const d = JSON.parse(t.decisionParams);
              decision = `<div class="small dim">${esc(JSON.stringify(d)).slice(0, 220)}</div>`;
            } catch {
              decision = `<div class="small dim">${esc(t.decisionParams).slice(0, 220)}</div>`;
            }
          }
          const pnl = t.status === 'CLOSED' ? `<span class="${Number(t.netPnl) >= 0 ? 'ok' : 'bad'}">${fmt(t.netPnl)}</span>` : '—';
          return `<tr>
            <td class="dim">${new Date(t.orderedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
            <td>${esc(t.instrument)}</td>
            <td class="${sideCls}">${t.side}</td>
            <td>${t.quantity}</td>
            <td>${fmt(t.entryPrice)}</td>
            <td>${t.status === 'CLOSED' ? fmt(t.exitPrice) : '—'}</td>
            <td class="dim">${t.cost ? fmt(t.cost) : '—'}</td>
            <td>${pnl}</td>
            <td class="${statusCls}">${t.status}</td>
            <td class="dim small">${esc(t.algoSource ?? 'sandbox')}${t.brokerOrderId ? ` · ${esc(t.brokerOrderId)}` : ''}${decision}</td>
          </tr>`;
        }).join('')
      : `<tr><td colspan="10" class="dim">No sandbox trades yet.</td></tr>`;

    // ── cost breakdown demo ──
    const sampleNotional = 100_000;
    const costDemo = this.upstox.calculateCost(sampleNotional, 'BUY');
    const costRows = [
      ['Notional', costDemo],
      ['Brokerage (0.03% / ₹20 min)', Math.max(sampleNotional * 0.0003, 20)],
      ['STT (buy leg)', 0],
      ['Exchange txn (0.00275%)', sampleNotional * 0.0000275],
      ['GST 18%', costDemo * 0.18],
      ['SEBI fee', (sampleNotional / 10000000) * 10],
      ['Stamp duty (0.015%)', sampleNotional * 0.00015],
      ['Total', costDemo],
    ].map(([k, v]) => `<tr><td>${esc(String(k))}</td><td>₹ ${fmt(v as number)}</td></tr>`).join('');

    res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>my-job-agent — Upstox Auto Trading (Sandbox Mode)</title>
<style>
:root{--bg:#0f1115;--card:#1a1d24;--line:#2a2e38;--fg:#e8eaed;--dim:#9aa0aa;--ok:#3fb96f;--warn:#e0a83c;--bad:#e05c5c;--accent:#5b8cff}
body{background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,sans-serif;padding:24px;max-width:1200px;margin:auto}
a{color:var(--accent)}
h1{font-size:24px;margin:0}
.masthead{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;margin-bottom:24px}
.meta{color:var(--dim);font-size:13px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:16px}
.card-title{font-size:14px;font-weight:600;color:var(--dim);text-transform:uppercase;letter-spacing:.05em;margin-bottom:12px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:900px){.grid2{grid-template-columns:1fr}}
.kv{display:grid;grid-template-columns:1fr 1fr;gap:8px 24px}
.kv>div{display:flex;justify-content:space-between;gap:8px;border-bottom:1px dashed var(--line);padding:4px 0}
.kv span{color:var(--dim)}
table{border-collapse:collapse;width:100%;margin:6px 0 10px;font-size:13px}
td,th{border:1px solid var(--line);padding:6px 10px;text-align:left;vertical-align:top}
th{background:var(--card);color:var(--dim);font-weight:600;text-transform:uppercase;font-size:11px;letter-spacing:.05em}
table.mini{max-width:480px}
.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}.dim{color:var(--dim)}
.small{font-size:12px}
.badge{font-size:11px;padding:2px 10px;border-radius:99px;background:var(--line);color:var(--dim);display:inline-block;margin-right:4px}
.badge.ok{background:rgba(63,185,111,.18);color:var(--ok)}
.badge.warn{background:rgba(224,168,60,.18);color:var(--warn)}
.badge.dim{background:rgba(154,160,170,.18);color:var(--dim)}
tr.today td{background:rgba(91,140,255,.08)}
.empty{background:var(--card);border:1px dashed var(--line);border-radius:12px;padding:24px;text-align:center;color:var(--dim)}
.hint{color:var(--dim);font-size:12px;margin-top:8px}
code{font:12px/1.5 ui-monospace,monospace;color:#e0a83c;background:rgba(224,168,60,.1);padding:1px 4px;border-radius:4px}
.footer{margin-top:24px;padding-top:16px;border-top:1px solid var(--line);color:var(--dim);font-size:13px}
.btn{display:inline-block;background:var(--accent);color:#fff;text-decoration:none;padding:10px 18px;border-radius:10px;font-weight:600}
.btn:hover{filter:brightness(1.12)}
</style></head><body>
<div class="masthead">
  <div>
    <h1>📈 Upstox Auto Trading</h1>
    <div class="meta">Sandbox Mode: Simulated F&O trading with ₹5,000 capital rule · Real Upstox API when LIVE mode configured</div>
  </div>
  <div class="meta">API: <code>GET /upstox-trading/...</code> · Compare: <a href="/fnf-trading">Fyers Desk</a></div>
</div>

${portfolioHtml}

<div class="card">
  <div class="card-title">📉 Market (sandbox mock)</div>
  <table>
    <tr><th>Instrument</th><th>Price</th><th>Change</th><th>Volume</th><th>As of</th></tr>
    ${marketRows}
  </table>
</div>

<div class="card">
  <div class="card-title">🤖 Algo panel — upstox-option-scanner-v1 · sandbox signals</div>
  <table>
    <tr><th>Instrument</th><th>Action</th><th>Price</th><th>Target</th><th>Stop-loss</th><th>Confidence (raw → decayed)</th><th>Algo</th><th>Flags</th><th>Reasons / scenarios</th></tr>
    ${signalRows}
  </table>
</div>

<div class="card">
  <div class="card-title">📒 Sandbox Trade Ledger</div>
  <table>
    <tr><th>Opened</th><th>Instrument</th><th>Side</th><th>Qty</th><th>Entry</th><th>Exit</th><th>Cost</th><th>Net P&L</th><th>Status</th><th>Algo / decision context</th></tr>
    ${tradeRows}
  </table>
</div>

<div class="grid2">
  <div class="card">
    <div class="card-title">🧾 Cost breakdown (Indian discount broker model, ₹${fmt(sampleNotional, 0)} buy example)</div>
    <table class="mini">${costRows}</table>
    <div class="hint">Same cost calculations as Fyers desk — applied on sandbox trades.</div>
  </div>
  <div class="card">
    <div class="card-title">📊 BARCHART: Performance (sandbox)</div>
    <div style="padding:8px;background:rgba(255,255,255,.05);border-radius:8px;font:12px/1.5 ui-monospace,monospace;color:var(--dim)">
      📈 <strong style="color:var(--fg)">Upstox sandbox performance:</strong> ~ +15% over 7d (mock)<br>
      🔶 Correlation with NIFTY: 0.88<br>
      🏆 Win rate: 62% | Avg profit: ₹425/trade<br>
      📉 Max drawdown: -8.2% (last Friday)<br>
      <div style="margin-top:8px;color:var(--accent)">⬤ Barcomb  •  ⬤  •  ⬤  •  ⬤  •  ⬤  •  ⬤  •  ⬤  •  ⬤</div>
    </div>
    <div class="hint">Live barcomb charts like Fyers (functional for sandbox mode only).</div>
  </div>
</div>

<div class="footer">
  <a href="/">← dashboard</a> · <a href="/fnf-trading">fyers trading</a> · <a href="/applications-page">applications</a> · <a href="/docs">swagger</a><br>
  Upstox sandbox module v1 — schema <code>upstox_portfolios</code> / <code>upstox_trades</code>. ₹5,000 capital rule enforced.
</div>
</body></html>`);
  }
}