import { Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ProjectChecklistItem } from './project-checklist-item.entity';
import { ProjectStatusService } from './project-status.service';

const esc = (s: unknown): string =>
	String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c] as string));

const STATUS_META: Record<string, { label: string; cls: string }> = {
	pending: { label: '⬜ pending', cls: 'dim' },
	in_progress: { label: '🔄 in progress', cls: 'warn' },
	done: { label: '✅ done', cls: 'ok' },
	blocked: { label: '🚫 blocked', cls: 'bad' },
	'n/a': { label: '— n/a', cls: 'dim' },
};

const badge = (status: string): string => {
	const m = STATUS_META[status] ?? STATUS_META.pending;
	return `<span class="badge ${m.cls}">${m.label}</span>`;
};

const STATUS_BUTTONS = ['pending', 'in_progress', 'done', 'blocked'];

@Controller('project-status')
export class ProjectStatusPageController {
	constructor(private readonly status: ProjectStatusService) {}

	@Get()
	async page(@Res() res: Response) {
		const [groups, overall] = await Promise.all([this.status.grouped(), this.status.overallStats()]);

		const bar = (done: number, total: number): string => {
			const pct = total ? Math.round((done / total) * 100) : 0;
			return `<div class="pbar"><div class="pfill" style="width:${pct}%"></div><span>${pct}%</span></div>`;
		};

		const gateHtml = groups
			.map((g) => {
				const rows = g.items
					.map((it) => {
						const id = it.id;
						const noteForm = `
<form class="noteform" method="post" action="/project-status/item/${id}/note">
  <input type="text" name="note" value="${esc(it.note)}" placeholder="note…" maxlength="500"/>
  <button type="submit">save</button>
</form>`;
						const buttons = STATUS_BUTTONS.map(
							(s) =>
								`<form class="inline" method="post" action="/project-status/item/${id}/status"><input type="hidden" name="status" value="${s}"/><button class="mini${s === it.status ? ' active' : ''}" ${s === it.status ? 'disabled' : ''}>${esc((STATUS_META[s] ?? STATUS_META.pending).label.replace(/^[^ ]+ /, ''))}</button></form>`,
						).join('');
						const v5detail = it.instr || it.doneWhen
							? `<div class="v5">
${it.instr ? `<div class="v5-i"><b>Implementation:</b> ${esc(it.instr)}</div>` : ''}
${it.doneWhen ? `<div class="v5-d"><b>Done when:</b> ${esc(it.doneWhen)}</div>` : ''}
</div>`
							: '';
						return `<tr class="row-${esc(it.status)}">
  <td class="num">${it.item_order}</td>
  <td><div>${esc(it.item)}</div>${v5detail}${it.note ? `<div class="note">📝 ${esc(it.note)}</div>` : ''}</td>
  <td class="nowrap">${buttons}</td>
  <td class="nowrap">${noteForm}</td>
</tr>`;
					})
					.join('\n');
				const done = g.stats.done ?? 0;
				return `
<details class="gate" ${g.grp.startsWith('GATE 0') || g.grp.startsWith('B.') ? 'open' : ''}>
  <summary>
    <div class="ghead">
      <span class="gtitle">${esc(g.grp)}</span>
      <span class="gmeta">${done}/${g.items.length} done · ${bar(done, g.items.length)}</span>
    </div>
    ${g.goal ? `<div class="ggoal">${esc(g.goal)}</div>` : ''}
  </summary>
  <table>
    <thead><tr><th>#</th><th>Checklist item</th><th>Status</th><th style="width:260px">Note</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</details>`;
			})
			.join('\n');

		const html = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Project Status — Hermes F&O v4 Checklist</title>
<style>
:root{--bg:#0d1117;--card:#161b22;--line:#30363d;--text:#e6edf3;--dim:#8b949e;--ok:#3fb96f;--bad:#f85149;--warn:#e0a83c}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 -apple-system,'Segoe UI',Roboto,sans-serif;padding:20px}
h1{font-size:22px;margin:0 0 4px}
.masthead{margin-bottom:14px}
.meta{color:var(--dim);font-size:12.5px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:14px}
.summary{display:flex;gap:22px;flex-wrap:wrap;align-items:center}
.summary b{font-size:20px}
.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}.dim{color:var(--dim)}
.pbar{display:inline-block;width:110px;height:10px;background:var(--line);border-radius:99px;position:relative;vertical-align:middle;margin-left:6px}
.pfill{height:100%;background:var(--ok);border-radius:99px;transition:width .3s}
.pbar span{display:none}
details.gate{background:var(--card);border:1px solid var(--line);border-radius:12px;margin-bottom:10px;overflow:hidden}
summary{cursor:pointer;padding:10px 14px;list-style:none}
summary::-webkit-details-marker{display:none}
.ghead{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
.gtitle{font-weight:700;font-size:14.5px}
.gmeta{color:var(--dim);font-size:12.5px;white-space:nowrap}
.ggoal{color:var(--dim);font-size:12.5px;margin-top:3px}
table{border-collapse:collapse;width:100%;font-size:13px}
td,th{border-top:1px solid var(--line);padding:7px 10px;text-align:left;vertical-align:middle}
th{background:rgba(0,0,0,.25);color:var(--dim);font-weight:600;text-transform:uppercase;font-size:11px;letter-spacing:.04em}
td.num{color:var(--dim);width:34px;text-align:right}
.badge{font-size:11px;padding:2px 10px;border-radius:99px;background:var(--line);color:var(--dim);display:inline-block}
.badge.ok{background:rgba(63,185,111,.16);color:var(--ok)}
.badge.warn{background:rgba(224,168,60,.16);color:var(--warn)}
.badge.bad{background:rgba(248,81,73,.16);color:var(--bad)}
form.inline{display:inline-block;margin-right:4px}
button{background:var(--line);color:var(--text);border:1px solid transparent;border-radius:8px;padding:3px 8px;font-size:11.5px;cursor:pointer}
button:hover{border-color:var(--dim)}
button.mini.active,button:disabled{opacity:.45;cursor:default}
form.noteform{display:flex;gap:6px}
input[type=text]{background:var(--bg);border:1px solid var(--line);color:var(--text);border-radius:8px;padding:4px 8px;font-size:12px;width:180px}
input:focus{outline:none;border-color:var(--dim)}
.row-done td{opacity:.55}
.v5{margin-top:4px;font-size:12px;color:var(--dim);border-left:2px solid var(--line);padding-left:8px}
.v5-i{margin:2px 0}
.v5-d{margin:2px 0;color:var(--ok)}
.note{margin-top:4px;font-size:12px;color:var(--warn);background:rgba(224,168,60,.07);border-radius:6px;padding:3px 8px;display:inline-block}
.nowrap{white-space:nowrap}
.footer{margin-top:20px;padding-top:14px;border-top:1px solid var(--line);color:var(--dim);font-size:12.5px}
.footer a{color:var(--warn)}
code{font:11.5px ui-monospace,monospace;color:#e0a83c}
</style></head><body>
<div class="masthead">
  <h1>📋 Project Status — Hermes AI F&amp;O Trading Agent (v4 validated checklist)</h1>
  <div class="meta">DB-driven checklist · 22 gates + final priority order · toggle status inline · source: <code>Hermes_AI_FO_Trading_Agent_TO_DO_Checklist_Validated_v4_All_Guides.pdf</code> · rows in <code>project_checklist_items</code></div>
</div>
<div class="card summary">
  <div><div class="meta">Overall</div><b>${overall.done}<span class="dim">/${overall.total}</span></b> <span class="dim">(${overall.pct}%)</span></div>
  <div><div class="meta">In progress</div><b class="warn">${overall.in_progress}</b></div>
  <div><div class="meta">Blocked</div><b class="bad">${overall.blocked}</b></div>
  <div><div class="meta">Pending</div><b class="dim">${overall.pending}</b></div>
  <div style="min-width:220px">${bar(overall.done, overall.total)}</div>
</div>
${gateHtml}
<div class="footer">
  <a href="/">← dashboard</a> · <a href="/fnf-trading">F&amp;O desk</a> · <a href="/option-trading">option trading</a> · <a href="/docs">swagger</a><br/>
  Seed: Hermes AI F&amp;O Trading Agent — Validated TO-DO v4 (21 gates + priority order) · Gate 0 items pre-marked done where already implemented on the live desk.
</div>
</body></html>`;

		res.type('html').send(html);
	}

	@Post('item/:id/status')
	async setStatus(@Param('id') id: string, @Body('status') status: string, @Res() res: Response) {
		const row = await this.status.setStatus(Number(id), String(status ?? ''));
		res.type('html');
		if (!row) {
			res.status(400).send('<p>bad request</p><p><a href="/project-status">← back</a></p>');
			return;
		}
		res.redirect(303, '/project-status');
	}

	@Post('item/:id/note')
	async setNote(@Param('id') id: string, @Body('note') note: string, @Res() res: Response) {
		const row = await this.status.setNote(Number(id), String(note ?? ''));
		res.type('html');
		if (!row) {
			res.status(400).send('<p>bad request</p><p><a href="/project-status">← back</a></p>');
			return;
		}
		res.redirect(303, '/project-status');
	}
}
