import { Controller, Get, Post, Delete, Body, Param, Req, Res, HttpCode, HttpStatus } from '@nestjs/common';
import { Response } from 'express';
import { JobApplicationRoadmapService } from './job-application-roadmap.service';
import { BypassAuth } from '../auth/bypass-auth.decorator';

const OPERATOR_PASSWORD_HEADER = 'x-operator-password';

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function statusBadge(status: string): string {
  const map: Record<string, string> = {
    pending: 'badge',
    'in_progress': 'badge warn',
    done: 'badge ok',
    blocked: 'badge bad',
  };
  return `<span class="${map[status] ?? 'badge'}">${esc(status)}</span>`;
}

function verifyBadge(verifiedAt?: string): string {
  return verifiedAt ? `<span class="ok">verified ${esc(verifiedAt)}</span>` : '<span class="dim">not yet</span>';
}

function sha0(s: string): string {
  return s && s.length ? s.slice(0, 10) : '—';
}

function pct(current: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((current / total) * 100);
}

function bar(filled: number, total: number): string {
  const p = pct(filled, total);
  return `<span class="pbar"><span class="pfill" style="width:${String(p)}%"></span></span>`;
}

@Controller('job-application-roadmap')
@BypassAuth()
export class JobApplicationRoadmapPageController {
  constructor(private readonly jaSvc: JobApplicationRoadmapService) {}

  @Get()
  async page(@Req() req: any, @Res() res: Response) {
    const passwordHeader = req.headers[OPERATOR_PASSWORD_HEADER];
    const sessionUser = req.session?.user as { id?: string; username?: string } | undefined;

    if (!sessionUser && !passwordHeader) {
      res.redirect(302, '/');
      return;
    }
    if (passwordHeader && process.env.SESSION_PASSWORD && passwordHeader !== process.env.SESSION_PASSWORD) {
      res.status(401).type('text/plain').send('unauthorized');
      return;
    }

    const [items, identity] = await Promise.all([
      this.jaSvc.findAll(),
      Promise.resolve(JobApplicationRoadmapService.IDENTITY),
    ]);

    const total = items.length;
    const doneCount = items.filter((r) => r.status === 'done').length;
    const inProgress = items.filter((r) => r.status === 'in_progress').length;
    const blocked = items.filter((r) => r.status === 'blocked').length;
    const pending = total - doneCount - inProgress - blocked;
    const seedSha = process.env.GATE_SEED_SHA ?? '';

    const rowsHtml = this.renderRows(items);
    const notesHtml = this.renderNotes(items);

    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Job Application Agent Roadmap — ${esc(identity)}</title>
<style>
:root { --bg: #0d1117; --card: #161b22; --line: #30363d; --text: #e6edf3; --dim: #8b949e; --ok: #3fb96f; --bad: #f85149; --warn: #e0a83c; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text);
  font: 14px/1.55 -apple-system, 'Segoe UI', Roboto, sans-serif; padding: 20px; }
h1 { font-size: 22px; margin: 0 0 4px; }
.masthead { margin-bottom: 14px; }
.meta { color: var(--dim); font-size: 12.5px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px; margin-bottom: 14px; }
.summary { display: flex; gap: 22px; flex-wrap: wrap; align-items: center; }
.summary b { font-size: 20px; }
.ok { color: var(--ok); }
.bad { color: var(--bad); }
.warn { color: var(--warn); }
.dim { color: var(--dim); }
.pbar { display: inline-block; width: 110px; height: 10px; background: var(--line); border-radius: 99px; position: relative; vertical-align: middle; margin-left: 6px; }
.pfill { height: 100%; background: var(--ok); border-radius: 99px; transition: width .3s; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
td, th { border-top: 1px solid var(--line); padding: 7px 10px; text-align: left; vertical-align: middle; }
th { background: rgba(0,0,0,.25); color: var(--dim); font-weight: 600; text-transform: uppercase; font-size: 11px; letter-spacing: .04em; }
td.num { color: var(--dim); width: 34px; text-align: right; }
.badge { font-size: 11px; padding: 2px 10px; border-radius: 99px; background: var(--line); color: var(--dim); display: inline-block; }
.badge.ok { background: rgba(63,185,111,.16); color: var(--ok); }
.badge.warn { background: rgba(224,168,60,.16); color: var(--warn); }
.badge.bad { background: rgba(248,81,73,.16); color: var(--bad); }
form.inline { display: inline-block; margin-right: 4px; }
button { background: var(--line); color: var(--text); border: 1px solid transparent; border-radius: 8px; padding: 3px 8px; font-size: 11.5px; cursor: pointer; }
button:hover { border-color: var(--dim); }
input[type=text] { background: var(--bg); border: 1px solid var(--line); color: var(--text); border-radius: 8px; padding: 4px 8px; font-size: 12px; width: 180px; }
input:focus { outline: none; border-color: var(--dim); }
textarea { background: var(--bg); border: 1px solid var(--line); color: var(--text); border-radius: 8px; padding: 5px 8px; font: 12px/1.45 ui-monospace, monospace; width: 100%; resize: vertical; }
textarea:focus { outline: none; border-color: var(--dim); }
.row-done td { opacity: .55; }
.nowrap { white-space: nowrap; }
.footer { margin-top: 20px; padding-top: 14px; border-top: 1px solid var(--line); color: var(--dim); font-size: 12.5px; }
.footer a { color: var(--warn); }
code { font: 11.5px ui-monospace, monospace; color: #e0a83c; }
.note-block { margin-top: 14px; }
.note-block .nb-head { font-size: 13px; margin-bottom: 6px; }
.note-block pre { background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; font: 12px ui-monospace, monospace; white-space: pre-wrap; max-height: 180px; overflow: auto; }
</style>
</head>
<body>
<div class="masthead">
  <h1>Job Application Agent Roadmap — ${esc(identity)}</h1>
  <div class="meta">Separate control plane from the F&amp;O Trading roadmap · table: <code>job_application_roadmap_items</code> · rows in DB</div>
</div>
<div class="card summary">
  <div><div class="meta">Total</div><b>${esc(String(total))}</b></div>
  <div><div class="meta">Done</div><b class="ok">${esc(String(doneCount))}</b></div>
  <div><div class="meta">In progress</div><b class="warn">${esc(String(inProgress))}</b></div>
  <div><div class="meta">Blocked</div><b class="bad">${esc(String(blocked))}</b></div>
  <div><div class="meta">Pending</div><b class="dim">${esc(String(pending))}</b></div>
  <div style="min-width:220px">${bar(doneCount, total)}</div>
</div>
<div class="card">
  <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
    <div>
      <div style="font-weight:700;font-size:14.5px">Control-plane identity</div>
      <div class="meta">${esc(identity)} · edition ${esc(String(items.length ? items[0].edition : 'v1'))} · seed SHA ${esc(seedSha)}</div>
    </div>
    <div style="display:flex;gap:8px;align-items:center">
      <span class="meta">page</span><span class="badge ok">live</span>
    </div>
  </div>
</div>
${rowsHtml}
${notesHtml}
<div class="footer">
  Separate from <a href="/project-status">/project-status</a> (Trading roadmap) · never mixed · status writes require <code>x-operator-password</code> header or browser session<br>
  Roadmap rows by roadmap identity + doneWhen only — no invented rows · done requires SHA + verification evidence
</div>
</body>
</html>`;

    res.type('html').send(html);
  }

  private renderRows(items: any[]): string {
    const header = `<table>
<thead>
<tr>
<th style="width:70px">ID</th>
<th style="width:120px">PHASE</th>
<th style="width:120px">PRIORITY</th>
<th>WORKSTREAM / ITEM</th>
<th style="width:110px">STATUS</th>
<th style="width:120px">DONE WHEN</th>
<th style="width:120px">LAST VERIFIED</th>
<th style="width:130px">LAST COMMIT</th>
</tr>
</thead>
<tbody>`;

    const body = items
      .map(
        (r) =>
          `<tr class="${(r.status === 'done') ? 'row-done' : ''}">
<td class="num"><code>${esc(r.itemId)}</code></td>
<td>${esc(r.phase ?? '')}</td>
<td>${esc(r.priority ?? 'p2')}</td>
<td><div><b>${esc(r.item ?? '')}</b></div><div class="meta">${esc(r.goal ?? '')}</div></td>
<td>${statusBadge(r.status ?? 'pending')}</td>
<td class="meta">${r.doneWhen ? esc(r.doneWhen) : '<span class="dim">—</span>'}</td>
<td class="meta">${verifyBadge(r.lastVerifiedAt ? r.lastVerifiedAt.toISOString() : '')}</td>
<td class="meta nowrap"><code>${esc(sha0(r.lastCommitSha))}</code></td>
</tr>`,
      )
      .join('');

    return `${header}${body}</tbody></table>`;
  }

  private renderNotes(items: any[]): string {
    const withNotes = items.filter((r) => r.note && r.note.length > 0);
    if (withNotes.length === 0) {
    return `<div class="note-block"><div class="nb-head meta">Notes</div><pre class="dim">No operator notes yet. Status writes append timestamped evidence blocks.</pre></div>`;
    }
    return `<div class="note-block"><div class="nb-head">Operator notes / evidence log</div>
${withNotes
  .map(
    (r) =>
      `<div style="margin-top:14px">
<div style="font-size:12.5px;color:var(--dim);margin-bottom:4px"><code style="color:var(--warn)">${esc(r.itemId)}</code> · status ${esc(r.status ?? 'pending')} · <a href="/job-application-roadmap#${esc(r.itemId)}">row</a></div>
<pre>${esc(r.note)}</pre>
</div>`,
  )
  .join('')}
</div>`;
  }

  @Post('item/:id/status')
  @HttpCode(HttpStatus.NO_CONTENT)
  async setStatus(@Param('id') id: string, @Body() body: any) {
    await this.jaSvc.setStatus(id, body.status, body.evidence, body.commitSha, body.verifiedAt);
  }

  @Post('item/:id/note')
  @HttpCode(HttpStatus.NO_CONTENT)
  async appendNote(@Param('id') id: string, @Body() body: any) {
    await this.jaSvc.appendNote(id, body.note);
  }

  @Delete('item/:id/evidence')
  @HttpCode(HttpStatus.NO_CONTENT)
  async clearEvidence(@Param('id') id: string) {
    await this.jaSvc.clearEvidence(id);
  }
}

