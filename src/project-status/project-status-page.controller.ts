import { Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ProjectChecklistItem } from './project-checklist-item.entity';
import { ProjectStatusService } from './project-status.service';
import { ProjectClarification } from './project-clarification.entity';
import { ProjectClarificationService, AskClarificationInput, StageClarificationCount } from './project-clarification.service';

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

const istWhen = (d: Date | null | undefined): string =>
	d ? new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }) : '';

/**
 * Yellow block: a pending question WITH its answer box. Every pending question
 * is rendered in the always-open panel at the top of the page, so a question can
 * never be reachable only by expanding a collapsed gate.
 */
const pendingBlock = (c: ProjectClarification, rowLink?: number | null): string => `
<div class="cl-box" id="clar-${c.id}">
  <div class="cl-q">❓ awaiting your clarification${c.stage ? ` · <span class="cl-stage">${esc(c.stage)}</span>` : ''} · filed ${esc(istWhen(c.createdAt))} by ${esc(c.askedBy)} · <code>#${c.id}</code>${
		rowLink ? ` · <a href="#item-${rowLink}">↓ checklist row #${rowLink}</a>` : ''
	}</div>
  <div class="cl-text">${esc(c.question)}</div>
  <form method="post" action="/project-status/clarifications/${c.id}/answer" class="cl-form">
    <textarea name="answer" rows="2" maxlength="4000" placeholder="your clarification…" required></textarea>
    <div class="cl-actions"><button type="submit">💾 save clarification</button></div>
  </form>
</div>`;

/** Compact pointer shown on a checklist row: the box itself lives in the panel. */
const pendingPointer = (n: number): string =>
	`<span class="badge clarify">❔ ${n} awaiting clarification</span> <a class="cl-up" href="#clarifications">answer above ↑</a>`;

/**
 * Answered question: the stored answer stays EDITABLE in place — the textarea is
 * prefilled with what was saved, so an answer like "hi" can be corrected without
 * re-typing the question. "send back to pending" is for answers that are wrong
 * rather than incomplete.
 */
const answeredBlock = (c: ProjectClarification, open = false, rowLink?: number | null): string => `
<details class="cl-box ok" id="clar-${c.id}"${open ? ' open' : ''}>
  <summary>
    <span class="cl-q ok">💬 clarification given · ${esc(istWhen(c.answeredAt))} · <code>#${c.id}</code>${c.stage ? ` · <span class="cl-stage">${esc(c.stage)}</span>` : ''}</span>
    — ${esc(c.question.slice(0, 110))}${c.question.length > 110 ? '…' : ''}
  </summary>
  <div class="cl-text">${esc(c.question)}</div>
  <form method="post" action="/project-status/clarifications/${c.id}/answer" class="cl-form">
    <textarea name="answer" rows="3" maxlength="4000" placeholder="your clarification…" required>${esc(c.answer ?? '')}</textarea>
    <div class="cl-actions">
      <button type="submit">💾 update clarification</button>
      ${rowLink ? `<a class="cl-up" href="#item-${rowLink}">↓ checklist row #${rowLink}</a>` : ''}
    </div>
  </form>
  <form method="post" action="/project-status/clarifications/${c.id}/reopen" class="cl-actions" style="margin-top:4px"><button class="mini" type="submit">↩ send back to pending</button></form>
</details>`;

const askForm = (itemId: number | null, stage: string, label: string): string => `
<details class="ask">
  <summary>❓ ${esc(label)}</summary>
  <form method="post" action="/project-status/clarifications" class="cl-form">
    ${itemId != null ? `<input type="hidden" name="itemId" value="${itemId}"/>` : ''}
    ${itemId != null
		? `<input type="hidden" name="stage" value="${esc(stage)}"/>`
		: `<input type="text" name="stage" value="${esc(stage)}" placeholder="stage label (e.g. LIVE PAPER DESK)" maxlength="160"/>`}
    <textarea name="question" rows="2" maxlength="4000" placeholder="what needs clarifying?" required></textarea>
    <div class="cl-actions"><button type="submit">💾 file clarification</button></div>
  </form>
</details>`;

const stageCounts = (byStage: StageClarificationCount[]): string =>
	byStage.length
		? `<ul class="stages">${byStage
				.map(
					(s) =>
						`<li><span class="cl-stage">${esc(s.stage)}</span> — ${s.pending ? `<b class="cl-wait">${s.pending} awaiting clarification</b>` : ''}${s.pending && s.answered ? ' · ' : ''}${s.answered ? `<span class="ok">${s.answered} given</span>` : ''}</li>`,
				)
				.join('')}</ul>`
		: '<div class="meta">no clarifications filed yet</div>';

@Controller('project-status')
export class ProjectStatusPageController {
	constructor(
		private readonly status: ProjectStatusService,
		private readonly clar: ProjectClarificationService,
	) {}

	@Get()
	async page(@Res() res: Response) {
		const [groups, overall, clarOv] = await Promise.all([
			this.status.grouped(),
			this.status.overallStats(),
			this.clar.overview(),
		]);

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
						const cl = clarOv.byItem.get(id) ?? { pending: [], answered: [] };
						const clarBadge = cl.pending.length
							? pendingPointer(cl.pending.length)
							: cl.answered.length
								? `<span class="badge ok">💬 ${cl.answered.length} clarification${cl.answered.length === 1 ? '' : 's'} given</span>`
								: '';
						const clarHtml = [
							...cl.answered.map((c) => answeredBlock(c, false, id)),
							askForm(id, it.grp, 'ask a clarification on this item'),
						].join('\n');
						return `<tr id="item-${id}" class="row-${esc(it.status)}${cl.pending.length ? ' row-clarify' : ''}">
  <td class="num">${it.item_order}</td>
  <td><div>${esc(it.item)}</div>${v5detail}${it.note ? `<div class="note">📝 ${esc(it.note)}</div>` : ''}${clarBadge ? `<div class="cl-badges">${clarBadge}</div>` : ''}${clarHtml}</td>
  <td class="nowrap">${buttons}</td>
  <td class="nowrap">${noteForm}</td>
</tr>`;
					})
					.join('\n');
				const done = g.stats.done ?? 0;
				// A gate holding a pending question opens by itself: the yellow row and its
				// "answer above" pointer must never sit behind a collapsed accordion.
				const gatePending = g.items.reduce((n, it) => n + (clarOv.byItem.get(it.id)?.pending.length ?? 0), 0);
				return `
<details class="gate" id="gate-${esc(g.grp.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase())}" ${g.grp.startsWith('GATE 0') || g.grp.startsWith('B.') || gatePending ? 'open' : ''}>
  <summary>
    <div class="ghead">
      <span class="gtitle">${esc(g.grp)}</span>
      <span class="gmeta">${done}/${g.items.length} done · ${bar(done, g.items.length)}${gatePending ? ` · <b class="cl-wait">${gatePending} awaiting clarification</b>` : ''}</span>
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

		/**
		 * The clarification panel: the ONE place a question is answerable.
		 * - every pending question (attached to a row or not) with its answer box
		 * - every answered question that no checklist row renders (null / stale itemId)
		 *   with its stored answer prefilled and editable
		 * Nothing here is duplicated in the gates: a row only points up to this panel.
		 */
		const liveIds = new Set([...clarOv.byItem.keys()]);
		const rowLinkOf = (c: ProjectClarification): number | null =>
			c.itemId != null && liveIds.has(c.itemId) ? c.itemId : null;
		const pendingHtml = clarOv.allPending.length
			? clarOv.allPending.map((c) => pendingBlock(c, rowLinkOf(c))).join('\n')
			: '<div class="meta">nothing awaiting your clarification 🎉</div>';
		const detachedAnswered = clarOv.unattached.answered;
		const answeredHtml = detachedAnswered.length
			? `<details class="cl-history" open>
  <summary>💬 ${detachedAnswered.length} clarification${detachedAnswered.length === 1 ? '' : 's'} given outside a checklist row — review or correct any of them here</summary>
  ${detachedAnswered.map((c) => answeredBlock(c, false, null)).join('\n')}
</details>`
			: '';
		const clarCard = `
<div class="card" id="clarifications">
  <div class="ghead">
    <span class="gtitle">❔ Clarifications — what the agent needs from you</span>
    <span class="meta">stored in <code>project_clarifications</code> · a pending question paints its checklist row <span class="cl-wait">yellow</span></span>
  </div>
  <div class="summary">
    <div><div class="meta">Awaiting your clarification</div><b class="${clarOv.stats.pending ? 'cl-wait' : 'dim'}">${clarOv.stats.pending}</b></div>
    <div><div class="meta">Clarifications given</div><b class="ok">${clarOv.stats.answered}</b></div>
    <div><div class="meta">Total filed</div><b class="dim">${clarOv.stats.total}</b></div>
  </div>
  <div class="cl-panel">
    <div class="cl-head">${clarOv.stats.pending ? `❓ ${clarOv.stats.pending} awaiting your clarification` : '❓ no clarification pending'} — answer here; every answer stays editable after saving.</div>
    ${pendingHtml}
  </div>
  ${answeredHtml}
  ${stageCounts(clarOv.byStage)}
  ${askForm(null, '', 'file a new clarification against a stage')}
</div>`;

		const html = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Project Status — Hermes F&O v4 Checklist</title>
<style>
:root{--bg:#0d1117;--card:#161b22;--line:#30363d;--text:#e6edf3;--dim:#8b949e;--ok:#3fb96f;--bad:#f85149;--warn:#e0a83c;--clarify:#f2c94c}
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
/* Clarifications: a pending question paints its checklist row yellow; once the
   operator gives the clarification the row returns to its normal colour and the
   item just shows how many clarifications have been given. */
tr.row-clarify td{background:rgba(242,201,76,.10);opacity:1}
tr.row-clarify td:first-child{border-left:3px solid var(--clarify)}
.cl-badges{margin-top:5px}
.badge.clarify{background:rgba(242,201,76,.18);color:var(--clarify)}
.cl-box{background:rgba(242,201,76,.08);border:1px solid rgba(242,201,76,.42);border-radius:8px;padding:7px 9px;margin:6px 0;font-size:12.5px}
.cl-box.ok{background:rgba(63,185,111,.07);border-color:rgba(63,185,111,.35)}
.cl-box.ok summary{padding:0}
.cl-q{color:var(--clarify);font-weight:600;font-size:12px}
.cl-q.ok{color:var(--ok)}
.cl-stage{color:var(--dim);font-weight:400}
.cl-wait{color:var(--clarify)}
.cl-text{margin:3px 0;white-space:pre-wrap}
.cl-a{margin:3px 0;color:var(--ok);white-space:pre-wrap}
.cl-form{margin-top:6px;display:flex;flex-direction:column;gap:5px;max-width:760px}
.cl-actions{display:flex;gap:6px}
textarea{background:var(--bg);border:1px solid var(--line);color:var(--text);border-radius:8px;padding:5px 8px;font:12px/1.45 ui-monospace,monospace;width:100%;resize:vertical}
textarea:focus{outline:none;border-color:var(--dim)}
details.ask{margin-top:6px}
details.ask summary{color:var(--dim);font-size:11.5px;padding:2px 0}
details.ask summary:hover{color:var(--clarify)}
/* The clarification panel is the single place a question is answerable, so it is
   always on screen above the gates and never hidden behind a collapsed section. */
.cl-panel{margin-top:10px;border-top:1px solid var(--line);padding-top:10px}
.cl-head{font-size:12.5px;color:var(--clarify);font-weight:600;margin-bottom:4px}
.cl-history{margin-top:10px;border-top:1px solid var(--line);padding-top:8px}
.cl-history>summary{color:var(--ok);font-size:12.5px;padding:2px 0}
.cl-up{color:var(--clarify);font-size:11.5px;text-decoration:none;border-bottom:1px dotted var(--clarify)}
.cl-up:hover{color:#fff}
.cl-box:target,.cl-history:target{outline:2px solid var(--clarify);outline-offset:2px}
ul.stages{margin:8px 0 0;padding-left:18px;font-size:12.5px}
ul.stages li{margin:2px 0}
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
${clarCard}
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

	/** File a clarification (against a checklist item, or a free stage label). */
	@Post('clarifications')
	async clarify(
		@Body('itemId') itemId: string,
		@Body('stage') stage: string,
		@Body('question') question: string,
		@Res() res: Response,
	) {
		const row = await this.clar.ask({
			itemId: itemId ? Number(itemId) : null,
			stage: String(stage ?? ''),
			question: String(question ?? ''),
			askedBy: 'operator',
		});
		res.type('html');
		if (!row) {
			res.status(400).send('<p>a clarification needs a question</p><p><a href="/project-status">← back</a></p>');
			return;
		}
		res.redirect(303, '/project-status#clarifications');
	}

	/** Store the operator's answer (also used to EDIT a saved one). */
	@Post('clarifications/:id/answer')
	async answerClarification(@Param('id') id: string, @Body('answer') answer: string, @Res() res: Response) {
		const row = await this.clar.answer(Number(id), String(answer ?? ''));
		res.type('html');
		if (!row) {
			res.status(400).send('<p>unknown clarification or empty answer</p><p><a href="/project-status#clarifications">← back</a></p>');
			return;
		}
		// Land on the panel, not the top of a 500KB page: the saved answer sits there
		// prefilled in its own editable box (attached rows also carry it, collapsed).
		res.redirect(303, `/project-status#clar-${row.id}`);
	}

	/** Send a question back to pending (the answer was not enough). */
	@Post('clarifications/:id/reopen')
	async reopenClarification(@Param('id') id: string, @Res() res: Response) {
		await this.clar.reopen(Number(id));
		res.redirect(303, `/project-status#clar-${id}`);
	}

	// ---- machine-readable view of the same store (agent CLI / cron) ----

	@Get('clarifications.json')
	async clarificationsJson(@Query('status') status: string, @Res() res: Response) {
		const [ov, all] = await Promise.all([this.clar.overview(), this.clar.all()]);
		const want = String(status ?? '').trim();
		const items = want ? all.filter((r) => (want === 'pending' ? r.status !== 'answered' : r.status === want)) : all;
		res.json({ stats: ov.stats, byStage: ov.byStage, items });
	}

	@Post('clarifications.json')
	async askJson(@Body() body: AskClarificationInput, @Res() res: Response) {
		const row = await this.clar.ask({
			itemId: body?.itemId ?? null,
			stage: body?.stage,
			question: String(body?.question ?? ''),
			askedBy: body?.askedBy === 'operator' ? 'operator' : 'hermes',
		});
		if (!row) {
			res.status(400).json({ ok: false, error: 'question is required' });
			return;
		}
		res.json({ ok: true, id: row.id, itemId: row.itemId, stage: row.stage, status: row.status });
	}

	@Post('clarifications/:id/answer.json')
	async answerJson(@Param('id') id: string, @Body('answer') answer: string, @Res() res: Response) {
		const row = await this.clar.answer(Number(id), String(answer ?? ''));
		if (!row) {
			res.status(400).json({ ok: false, error: 'unknown clarification id or empty answer' });
			return;
		}
		res.json({ ok: true, id: row.id, status: row.status, answeredAt: row.answeredAt });
	}
}
