import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { FnfTradingService, WEEKDAY_NAMES, DECAY_DEFAULTS } from './fnf-trading.service';
import { FnoMarketDataService } from './fno-market-data.service';
import { ProviderTokenService } from './provider-token.service';
import { UnifiedMarketDataService } from './unified-market-data/unified-market-data.service';
import { BypassAuth, AllowIps } from '../auth/bypass-auth.decorator';

const esc = (s: unknown): string =>
	String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

/**
 * NSE/BSE session window, evaluated in IST. Used only so a stale tick feed
 * outside trading hours is reported as "market closed" instead of "feed DOWN".
 */
const marketClosedIst = (now = Date.now()): boolean => {
	const ist = new Date(now + 5.5 * 3_600_000); // IST wall clock, read as UTC fields
	const dow = ist.getUTCDay();
	const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
	return dow === 0 || dow === 6 || minutes < 9 * 60 + 15 || minutes > 15 * 60 + 45;
};

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

@Controller('fnf-trading')
@BypassAuth()
@AllowIps('127.0.0.1', '::1')
export class FnfTradingPageController {
	constructor(
		private readonly trading: FnfTradingService,
		private readonly fyersTokens: ProviderTokenService,
		private readonly feed: FnoMarketDataService,
		private readonly unifiedStore: UnifiedMarketDataService,
	) {}

	@Get()
	async page(
		@Res() res: Response,
		@Query('fyers') fyers: string | undefined,
		@Query('reason') reason: string | undefined,
	) {
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
		const isFriday = new Date().getDay() === 5;

		// ── FYERS token card (market-data source for the paper desk) ──
		const fyersBanner = fyers === 'ok'
			? '<div class="banner ok">✅ FYERS login successful — token stored in the database. The FYERS feed reconnects automatically (within a minute — no restart needed).</div>'
			: fyers === 'error'
				? `<div class="banner bad">⚠️ FYERS login failed — ${esc(reason ?? 'unknown reason')}. Click <b>GET THE TOKEN</b> to try again (login link is valid for 5 minutes).</div>`
				: '';
		const tokenInfo = await this.fyersTokens.getActiveTokenInfo('fyers', 'live');
		const feedStatus = this.feed.status();
		// Tick source of truth: this web app holds no broker socket of its own
		// (one writer only — the headless trading engine), so the honest "is the
		// desk blind?" signal is the age of the shared market-data store.
		const store = await this.unifiedStore.storeFreshness();
		const fmtIst = (d: Date | null): string =>
			d ? new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
		const tokenExpired = !!tokenInfo?.expiresAt && tokenInfo.expiresAt.getTime() < Date.now();
		const [tokenCls, tokenLabel] = !tokenInfo
			? ['warn', 'NO TOKEN — click GET THE TOKEN below']
			: tokenExpired
				? ['bad', 'EXPIRED — click GET THE TOKEN below']
				: ['ok', 'ACTIVE (stored in DB, encrypted)'];
		let feedCls = 'dim';
		let feedLabel = 'no ticks in the shared market-data store yet';
		if (feedStatus.enabled) {
			if (feedStatus.connected && !feedStatus.fallbackActive) {
				feedCls = 'ok';
				feedLabel = `FYERS WebSocket connected (${feedStatus.subscribedSymbols.length} symbols)`;
			} else if (feedStatus.fallbackActive) {
				feedCls = 'warn';
				feedLabel = 'Yahoo fallback active — auto-reconnects to FYERS ≤ 1 min after a fresh login';
			} else {
				feedCls = 'warn';
				feedLabel = esc(feedStatus.lastMessage ?? feedStatus.provider);
			}
		} else if (store.ageMs === null) {
			feedCls = 'warn';
			feedLabel = 'no ticks in the shared market-data store yet — the trading engine is not writing';
		} else {
			const ageSec = Math.round(store.ageMs / 1000);
			const ageTxt = ageSec < 90 ? `${ageSec}s ago` : `${(ageSec / 60).toFixed(1)} min ago`;
			if (ageSec <= 60) {
				feedCls = 'ok';
				feedLabel = `FYERS via the trading engine — live (last tick ${ageTxt})`;
			} else if (ageSec <= 300) {
				feedCls = 'warn';
				feedLabel = `trading-engine feed lagging — last tick ${ageTxt}`;
			} else if (marketClosedIst()) {
				feedCls = 'dim';
				feedLabel = `market closed — last tick ${ageTxt} (${fmtIst(store.lastTs)})`;
			} else {
				feedCls = 'bad';
				feedLabel = `trading-engine feed DOWN — last tick ${ageTxt} (${fmtIst(store.lastTs)})`;
			}
		}
		const fyersCard = `
<div class="card token-card">
  <div class="card-title">🔑 FYERS token — paper-desk market data</div>
  <div class="kv">
    <div><span>Stored token</span><b class="${tokenCls}">${tokenLabel}</b></div>
    <div><span>Expires (IST)</span><b>${fmtIst(tokenInfo?.expiresAt ?? null)}</b></div>
    <div><span>Live feed</span><b class="${feedCls}">${feedLabel}</b></div>
    <div><span>Ticks in store (5 min)</span><b>${(store.quotesLast5m + store.snapshotsLast5m).toLocaleString('en-IN')} rows · ${store.symbolsLast5m} contracts${store.source ? ` · ${esc(store.source)}` : ''}</b></div>
    <div><span>Tick writer</span><b class="dim">${feedStatus.enabled ? 'this web app + trading engine' : 'trading engine (this web app holds no socket)'}</b></div>
  </div>
  <p style="margin:12px 0 2px"><a class="btn" href="/auth/fyers/login">🔑 GET THE TOKEN — log in at FYERS</a></p>
  <div class="hint">Opens FYERS in this tab (FY ID + password + TOTP + PIN — typed only into FYERS, never stored by this app). On success FYERS returns you here automatically: the token is saved in the database (single row, encrypted) and the FYERS feed reconnects on its own. No .env edits, no restart.</div>
</div>`;

		// ── portfolio card ──
		let portfolioHtml = `<div class="empty">No portfolio yet — create one via <code>POST /trading/portfolios</code>.</div>`;
		if (portfolio) {
			const headroom = (Number(portfolio.ceiling) || Number(portfolio.capital)) - Number(portfolio.deployed);
			const capPct = Number(portfolio.capital) ? Math.round((Number(portfolio.deployed) / Number(portfolio.ceiling || portfolio.capital)) * 100) : 0;
			const netPnlCls = Number(portfolio.netPnl) >= 0 ? 'ok' : 'bad';
			const fridayCls = portfolio.fridayTradingEnabled ? 'ok' : 'warn';
			const autoCls = portfolio.autoTradeEnabled ? 'ok' : 'dim';
			portfolioHtml = `
<div class="grid2">
  <div class="card">
    <div class="card-title">💰 Portfolio — ${esc(portfolio.label)}</div>
    <div class="kv">
      <div><span>Capital</span><b>₹ ${fmt(portfolio.capital, 0)}</b></div>
      <div><span>Ceiling</span><b>₹ ${fmt(portfolio.ceiling, 0)}</b></div>
      <div><span>Deployed</span><b>₹ ${fmt(portfolio.deployed, 0)} <small class="${capPct > 90 ? 'bad' : 'dim'}">${capPct}%</small></b></div>
      <div><span>Headroom</span><b>₹ ${fmt(headroom, 0)}</b></div>
      <div><span>Net P&amp;L (lifetime)</span><b class="${netPnlCls}">₹ ${fmt(portfolio.netPnl)}</b></div>
      <div><span>Total cost paid</span><b>₹ ${fmt(portfolio.totalCost)}</b></div>
    </div>
  </div>
  <div class="card">
    <div class="card-title">⚙️ Controls</div>
    <div class="kv">
      <div><span>Auto-trade</span><b class="${autoCls}">${portfolio.autoTradeEnabled ? 'ON' : 'OFF'}</b></div>
      <div><span>Friday block</span><b class="${fridayCls}">${portfolio.fridayTradingEnabled ? 'enabled (Friday trades allowed)' : 'active — no new positions on Friday'}</b></div>
      <div><span>Today</span><b>${isFriday ? 'Friday — ' + (portfolio.fridayTradingEnabled ? 'trades allowed' : 'blocked by default') : 'not Friday'}</b></div>
      <div><span>Astro muhurta</span><b class="${astro.shubh ? 'ok' : 'warn'}">${astro.shubh ? '🕉 shubh' : 'not shubh'} <small>${esc(astro.label)}</small></b></div>
    </div>
  </div>
</div>
<div class="grid2">
  <div class="card">
    <div class="card-title">🏦 Broker config</div>
    <div class="kv">
      <div><span>Zerodha Kite</span><b class="dim">not connected</b></div>
      <div><span>Angel One</span><b class="dim">not connected</b></div>
    </div>
    <div class="hint">Real broker wiring is TODO item 5 — credentials stored encrypted, paper-trade first.</div>
  </div>
  <div class="card">
    <div class="card-title">📈 Learning (closed trades)</div>
    <div class="kv">
      <div><span>Total closed</span><b>${learning.total}</b></div>
      <div><span>Win rate</span><b>${learning.winRate}% (${learning.winners} wins)</b></div>
      <div><span>Net P&amp;L</span><b class="${learning.netPnl >= 0 ? 'ok' : 'bad'}">₹ ${fmt(learning.netPnl)}</b></div>
    </div>
    ${Object.entries(learning.byAlgo).length ? `<table class="mini"><tr><th>algo</th><th>n</th><th>win%</th><th>net P&amp;L</th></tr>` +
      Object.entries(learning.byAlgo).map(([a, b]) => `<tr><td>${esc(a)}</td><td>${b.count}</td><td>${b.winRate}%</td><td class="${b.netPnl >= 0 ? 'ok' : 'bad'}">₹ ${fmt(b.netPnl)}</td></tr>`).join('') + `</table>` : '<div class="hint">No closed trades yet.</div>'}
  </div>
</div>`;
		}

		// ── market table ──
		const marketRows = market.length
			? market.map((m) => {
					const cls = m.changePct === null ? 'dim' : m.changePct >= 0 ? 'ok' : 'bad';
					return `<tr><td>${esc(m.instrument)}</td><td><b>${fmt(m.price, 2)}</b></td><td class="${cls}">${pct(m.changePct)}</td><td class="dim">${fmt(m.volume, 0)}</td><td class="dim">${new Date(m.ts).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</td></tr>`;
			  }).join('')
			: `<tr><td colspan="5" class="dim">No snapshots yet — ingest via <code>POST /trading/market/ingest</code>.</td></tr>`;

		// ── signals panel ──
		const signalRows = signals.length
			? signals.map((s) => {
					const actionCls = s.action === 'BUY' ? 'ok' : s.action === 'SELL' ? 'bad' : 'warn';
					const fridayFlag = s.fridayBlocked ? badge('Friday block', 'warn') : badge('Friday ok', 'ok');
					const astroFlag = s.astroMatch.shubh ? badge('🕉 shubh', 'ok') : badge('astro: no window', 'dim');
					const decayFlag = s.decayedConfidence < DECAY_DEFAULTS.confidenceFloor
						? badge('decayed → HOLD', 'warn')
						: badge(`decay ${s.decay.ageHours.toFixed(1)}h ×${s.decay.rate.toFixed(3)}`, s.decay.timingFactor === 1 ? 'ok' : 'warn');
					const scenarios = s.scenarios.map((sc) => `${esc(sc.name)} ${sc.probability}% → ${fmt(sc.target)}`).join(' · ');
					return `<tr>
						<td>${esc(s.instrument)}</td>
						<td class="${actionCls}"><b>${s.action}</b></td>
						<td>${fmt(s.price)}</td>
						<td>${fmt(s.target)}</td>
						<td>${fmt(s.stopLoss)}</td>
						<td>${s.confidence}% → <b>${s.decayedConfidence}%</b></td>
						<td class="dim">${esc(s.algoSource)}</td>
						<td>${astroFlag} ${fridayFlag}<br>${decayFlag}</td>
						<td class="dim small">${esc(s.reasons.join('; '))}<br>${esc(scenarios)}</td>
					</tr>`;
			  }).join('')
			: `<tr><td colspan="9" class="dim">No signals — needs ≥5 snapshots per instrument.</td></tr>`;

		// ── decay calibration table (day-wise, self-rectifying) ──
		const todayWd = new Date().getDay();
		const decayRows = calibrations.map((c) => {
			const isToday = c.weekday === todayWd;
			const hours = `${Number(c.windowStartHour).toFixed(2)} – ${Number(c.windowEndHour).toFixed(2)}`;
			return `<tr class="${isToday ? 'today' : ''}">
				<td>${esc(WEEKDAY_NAMES[c.weekday] ?? c.weekday)}${isToday ? ' <b class="ok">← today</b>' : ''}</td>
				<td>${fmt(c.decayRate, 4)}/h</td>
				<td>${hours}</td>
				<td class="dim">${c.samples} trades</td>
				<td class="dim">${c.lastRectifiedAt ? new Date(c.lastRectifiedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never'}</td>
			</tr>`;
		}).join('');

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
						<td class="dim small">${esc(t.algoSource ?? 'manual')}${t.brokerOrderId ? ` · ${esc(t.brokerOrderId)}` : ''}${decision}</td>
					</tr>`;
			  }).join('')
			: `<tr><td colspan="10" class="dim">No trades yet.</td></tr>`;

		// ── cost breakdown demo ──
		const sampleNotional = 100_000;
		const costDemo = this.trading.calculateCost(sampleNotional, 'BUY');
		const costRows = [
			['Notional', costDemo.notional],
			['Brokerage (0.03% / ₹20 min)', costDemo.brokerage],
			['STT (buy leg)', costDemo.stt],
			['Exchange txn (0.00275%)', costDemo.exchangeTxn],
			['GST 18%', costDemo.gst],
			['SEBI fee', costDemo.sebi],
			['Stamp duty (0.015%)', costDemo.stamp],
			['Total', costDemo.total],
		].map(([k, v]) => `<tr><td>${esc(String(k))}</td><td>₹ ${fmt(v as number)}</td></tr>`).join('');

		res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>my-job-agent — FNF Trading</title>
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
.banner{padding:12px 16px;border-radius:10px;margin-bottom:16px;font-size:14px}
.banner.ok{background:rgba(63,185,111,.14);border:1px solid var(--ok);color:var(--ok)}
.banner.bad{background:rgba(224,92,92,.14);border:1px solid var(--bad);color:var(--bad)}
.btn{display:inline-block;background:var(--accent);color:#fff;text-decoration:none;padding:10px 18px;border-radius:10px;font-weight:600}
.btn:hover{filter:brightness(1.12)}
.token-card{border-color:rgba(91,140,255,.42)}
</style></head><body>
<div class="masthead">
  <div>
    <h1>📊 FNF Trading</h1>
    <div class="meta">Friday Nifty Futures algo desk · capital-envelope trading · astro-matched muhurta · self-learning ledger</div>
  </div>
  <div class="meta">API: <code>GET /trading/...</code> · Swagger <a href="/docs">/docs</a></div>
</div>
${fyersBanner}
${fyersCard}
${portfolioHtml}

<div class="card">
  <div class="card-title">📉 Market (latest snapshot per instrument)</div>
  <table>
    <tr><th>Instrument</th><th>Price</th><th>Change</th><th>Volume</th><th>As of</th></tr>
    ${marketRows}
  </table>
</div>

<div class="card">
  <div class="card-title">🤖 Algo panel — sma-mean-reversion-v1 · decay-adjusted predictions · scenarios · astro match</div>
  <table>
    <tr><th>Instrument</th><th>Action</th><th>Price</th><th>Target</th><th>Stop-loss</th><th>Confidence (raw → decayed)</th><th>Algo</th><th>Flags</th><th>Reasons / scenarios</th></tr>
    ${signalRows}
  </table>
</div>

<div class="card">
  <div class="card-title">⏳ Decay calibration — day-wise, self-rectifying (rate × exp(−rate·h) + timing window)</div>
  <table class="mini">
    <tr><th>Weekday</th><th>Decay rate (per hour)</th><th>Best entry window (IST)</th><th>Samples</th><th>Last rectified</th></tr>
    ${decayRows}
  </table>
  <div class="hint">Every prediction is decay-adjusted: confidence × e^(−rate × data-age-hours) × timing factor (1.0 in window, 0.85 out). Below floor ${DECAY_DEFAULTS.confidenceFloor} → HOLD. After each closed trade, the weekday's rate + window are rectified from the outcome (winners ease decay, losers tighten it; window drifts toward winning entry hours). Manual override: <code>PATCH /trading/decay</code> · force now: <code>POST /trading/decay/rectify</code></div>
</div>

<div class="card">
  <div class="card-title">📒 Trade ledger</div>
  <table>
    <tr><th>Opened</th><th>Instrument</th><th>Side</th><th>Qty</th><th>Entry</th><th>Exit</th><th>Cost</th><th>Net P&amp;L</th><th>Status</th><th>Algo / decision context</th></tr>
    ${tradeRows}
  </table>
</div>

<div class="grid2">
  <div class="card">
    <div class="card-title">🧾 Cost breakdown (Indian discount broker model, ₹${fmt(sampleNotional, 0)} buy example)</div>
    <table class="mini">${costRows}</table>
    <div class="hint">Brokerage 0.03% (₹20 min), STT 0.025% sell, NSE txn 0.00275%, GST 18%, SEBI ₹10/cr, stamp 0.015% buy. Cost auto-applied on close.</div>
  </div>
  <div class="card">
    <div class="card-title">🕉 Astro match</div>
    <div class="kv">
      <div><span>Shubh muhurta</span><b class="${astro.shubh ? 'ok' : 'warn'}">${astro.shubh ? 'yes' : 'no'}</b></div>
      <div><span>Score</span><b>${astro.score}/100</b></div>
      <div><span>Next window</span><b class="dim">${esc(astro.label)}</b></div>
    </div>
    <div class="hint">Signals + trades carry the astro match flag; auto-sends batch inside shubh windows (same engine as job applications).</div>
  </div>
</div>

<div class="footer">
  <a href="/">← dashboard</a> · <a href="/applications-page">applications</a> · <a href="/visa-guide">visa guide</a> · <a href="/docs">swagger</a><br>
  FNF trading module v1 — schema <code>fnf_portfolios</code> / <code>fnf_trades</code> / <code>fnf_market_snapshots</code>. Real broker wiring (Zerodha Kite / Angel One) is next.
</div>
</body></html>`);
	}
}
