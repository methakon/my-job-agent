import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { SideIncomeService } from './side-income.service';

/**
 * Minimal self-contained dashboard page (no frontend build needed):
 * lists side-income opportunities ranked by fit, expandable details,
 * and status buttons. Served at GET /side-income/dashboard.
 */
@Controller('side-income-dashboard')
export class SideIncomeDashboardController {
	constructor(private readonly service: SideIncomeService) {}

	@Get('dashboard')
	async page(@Res() res: Response) {
		const ops = (await this.service.list()).map((o) => this.service.toDashboard(o));
		const cards = ops
			.map(
				(o, i) => `
<details class="card" ${i === 0 ? 'open' : ''}>
  <summary>
    <span class="fit">${o.fitScore}% fit</span>
    <strong>${esc(o.provider)}: ${esc(o.title)}</strong>
    <span class="pill ${o.involvement}">${o.involvement} involvement</span>
    <span class="status s-${o.status}" data-status-for="${o.id}">${o.status}</span>
  </summary>
  <p>${esc(o.description)}</p>
  <div class="grid">
    <div><h4>💰 Investment</h4><p>${esc(o.investmentRange ?? '—')}</p></div>
    <div><h4>📈 Expected income</h4><p>${esc(o.expectedIncome ?? '—')}</p></div>
  </div>
  ${costTable(o.costBreakdown)}
  <h4>✅ Requirements</h4><ul>${(o.requirements as string[]).map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
  <h4>📄 Documents needed</h4><ul>${(o.documents as string[]).map((d) => `<li>${esc(d)}</li>`).join('')}</ul>
  <h4>🧭 How to apply</h4><p>${esc(o.howToApply ?? '')}</p>
  ${(o.warnings as string[]).length ? `<div class="warn"><h4>⚠️ Warnings</h4><ul>${(o.warnings as string[]).map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
  <p><a href="${esc(o.applyUrl ?? '#')}" target="_blank" rel="noopener">🔗 Official apply page</a></p>
  <div class="actions">
    <button onclick="setStatus('${o.id}','applied')">Mark applied</button>
    <button onclick="setStatus('${o.id}','in_progress')">In progress</button>
    <button onclick="setStatus('${o.id}','rejected')">Not interested</button>
  </div>
</details>`,
			)
			.join('\n');

		res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>My Job Agent — Side Income Opportunities</title><style>
body{font-family:system-ui,sans-serif;max-width:860px;margin:2rem auto;padding:0 1rem;background:#0f1115;color:#e6e6e6}
h1{color:#7ab8ff}details.card{background:#171a21;border:1px solid #2a2f3a;border-radius:10px;margin:1rem 0;padding:1rem}
summary{cursor:pointer;display:flex;gap:.6rem;align-items:center;flex-wrap:wrap}
.fit{background:#123c22;color:#5ee08a;padding:.15rem .55rem;border-radius:999px;font-weight:700}
.pill{padding:.1rem .5rem;border-radius:999px;font-size:.8rem}.pill.low{background:#12342e;color:#4fd1b5}.pill.medium{background:#3a3111;color:#ffd66b}
.status{margin-left:auto;font-size:.8rem;color:#9aa3b2}.s-applied{color:#5ee08a}.s-in_progress{color:#ffd66b}.s-rejected{color:#ff7a7a}
.grid{display:flex;gap:1rem}.grid div{flex:1;background:#10131a;border-radius:8px;padding:.6rem}
h4{margin:.8rem 0 .3rem;color:#9fc3ff}.warn{background:#2b1414;border-radius:8px;padding:.6rem;margin-top:.6rem}
.warn h4{color:#ff9c9c}button{background:#24509c;color:#fff;border:0;border-radius:6px;padding:.45rem .9rem;margin-right:.4rem;cursor:pointer}
button:hover{background:#2f63bd}a{color:#7ab8ff}</style></head><body>
<h1>💼 Side-Income Opportunities</h1>
<p>Matched to: Khagra, Berhampore 742103 · spare space available · minimal investment & involvement preferred.</p>
${cards}
<script>
async function setStatus(id, status) {
  await fetch(\`/side-income/\${id}/status\`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({status})});
  const el = document.querySelector(\`[data-status-for="\${id}"]\`);
  if (el) { el.textContent = status; el.className = 'status s-' + status; }
}
</script></body></html>`);
	}
}

function esc(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function costTable(items: unknown): string {
	const list = Array.isArray(items) ? (items as { item: string; cost: string }[]) : [];
	if (!list.length) return '';
	return `<h4>💸 Cost breakdown</h4><table><tr><th align="left">Item</th><th align="left">Cost</th></tr>${list
		.map((c) => `<tr><td>${esc(c.item)}</td><td>${esc(c.cost)}</td></tr>`)
		.join('')}</table>`;
}
