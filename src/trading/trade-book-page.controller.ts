import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { TradeBookImporterService } from './trade-book-importer.service';
import { TradeBookImport } from './trade-book.entity';

const esc = (s: unknown): string =>
	String(s ?? '').replace(/[<>&"\']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c] as string));

const fmt = (n: unknown, digits = 2): string => {
	const v = Number(n ?? 0);
	return isNaN(v) ? '—' : v.toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
};

const badge = (label: string, cls: string): string => `<span class="badge ${cls}">${esc(label)}</span>`;

@Controller('trade-book')
export class TradeBookPageController {
	constructor(private readonly tradeBook: TradeBookImporterService) {}

	@Get()
	async page(@Res() res: Response) {
		// Fetch all trade book imports (research data - NOT Hermes execution)
		const { getRepository } = await import('typeorm');
		const tradeBookRepo = getRepository(TradeBookImport);
		const imports = await tradeBookRepo.find({
			order: { importedAt: 'DESC' },
			take: 500,
		});

		const rows = imports.map((t) => {
			const sideCls = t.side === 'BUY' ? 'ok' : 'bad';
			const matchBadge = badge(t.matchStatus, t.matchStatus === 'matched' ? 'ok' : 'dim');
			const normBadge = badge(t.normalizationStatus, t.normalizationStatus === 'normalized' ? 'ok' : 'warn');
			const pnlCls = Number(t.netPnl) >= 0 ? 'ok' : 'bad';
			return `<tr>
				<td class="dim">${new Date(t.importedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
				<td>${esc(t.tradeId ?? t.id)}</td>
				<td class="dim small">${esc(t.broker)}</td>
				<td>${esc(t.underlying)}</td>
				<td class="dim small">${esc(t.expiry ?? '—')}</td>
				<td>${t.strike ? fmt(t.strike) : '—'}</td>
				<td class="dim small">${esc(t.optionType ?? '—')}</td>
				<td class="${sideCls}"><b>${t.side}</b></td>
				<td>${t.quantity}</td>
				<td>${fmt(t.entryPrice)}</td>
				<td>${t.exitPrice ? fmt(t.exitPrice) : '—'}</td>
				<td class="${pnlCls}">${fmt(t.netPnl)}</td>
				<td class="dim small">${esc(t.sourceFile)}</td>
				<td class="dim small">row ${t.sourceRow}</td>
				<td>${matchBadge} ${normBadge}</td>
				<td class="dim small">${esc(t.matchMethod ?? '—')}</td>
			</tr>`;
		}).join('') || `<tr><td colspan="18" class="dim">No trade book data imported yet — use POST /trading/trade-book/import to import Zerodha TradeBook CSVs.</td></tr>`;

		res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>my-job-agent — Historical TradeBook</title>
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
</style></head><body>
<div class="masthead">
  <div>
    <h1>📋 Historical TradeBook</h1>
    <div class="meta">Broker tradebook records imported for research/learning — NOT Hermes execution</div>
  </div>
  <div class="meta">API: <code>POST /trading/trade-book/import</code> · <a href="/docs">Swagger</a></div>
</div>

<div class="card" style="background:rgba(53,60,72,.18);border-color:rgba(224,168,60,.3)">
  <div class="card-title" style="color:var(--warn)">⚠️ IMPORTANT: RESEARCH DATA ONLY</div>
  <div class="kv">
    <div><span>Data origin</span><b class="dim">Broker-imported (Zerodha/other)</b></div>
    <div><span>For</span><b class="dim">Research, learning, pattern analysis</b></div>
    <div><span>NOT</span><b class="bad">Hermes execution / paper trading</b></div>
    <div><span>Status</span><b class="warn">Historical only</b></div>
  </div>
  <div class="hint">
    These records represent actual broker tradebooks. They may be linked to Hermes
    DecisionSnapshots where exact matches exist, but many will remain unmatched.
    Do NOT treat these as Hermes trades.
  </div>
</div>

<div class="card">
  <div class="card-title">📊 TradeBook history (latest 500 imports)</div>
  <table>
    <tr>
      <th>Imported</th>
      <th>ID</th>
      <th> Broker</th>
      <th>Underlying</th>
      <th>Expiry</th>
      <th>Strike</th>
      <th>Option</th>
      <th>Side</th>
      <th>Qty</th>
      <th>Entry</th>
      <th>Exit</th>
      <th>Net P&L</th>
      <th>Source</th>
      <th>Row</th>
      <th>Match</th>
      <th>Method</th>
    </tr>
    ${rows}
  </table>
  <div class="hint">
    Filter is available in future iterations. Currently shows latest 500 records sorted by import time.
    <br>Import via POST /trading/trade-book/import with a Zerodha TradeBook CSV from ~/Downloads/zerodha/
  </div>
</div>

<div class="footer">
  <a href="/">← dashboard</a> · <a href="/fnf-trading">FNF trading</a> · <a href="/option-trading">Option trading</a> · <a href="/docs">Swagger</a><br>
  Historical TradeBook panel — research data only. Hermes execution → FNF trading.
</div>
</body></html>`);
	}
}
