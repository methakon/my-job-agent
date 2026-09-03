import { Controller, Get, Param, Res, Post, Body, UseInterceptors, UploadedFile, BadRequestException } from '@nestjs/common';
import type { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { mkdirSync, existsSync, createReadStream } from 'fs';
import { join, extname } from 'path';
import { PreApplyService } from '../astro/pre-apply.service';
import { PreApplyItemRepository } from '../astro/pre-apply-item.repository';
import { LeadRepository } from '../leads/lead.repository';

const UPLOAD_DIR = join(process.cwd(), 'uploads', 'user-cvs');

const esc = (s: unknown): string =>
	String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function fmt(d: unknown): string {
	if (!d) return '—';
	const date = d instanceof Date ? d : new Date(String(d));
	return date.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function parseJson(s: string | null): unknown {
	if (!s) return null;
	try { return JSON.parse(s); } catch { return null; }
}

/**
 * PreApplyPageController — FR-17 review queue. Lists every prepared
 * application (tailored CV + email draft + channel + astro match + planned
 * muhurta window) and lets the user APPROVE (send at next shubh muhurta),
 * HOLD/PAUSE (while correcting), or UPLOAD a corrected CV before anything
 * goes out. Nothing is sent without explicit approval.
 */
@Controller('pre-apply-page')
export class PreApplyPageController {
	constructor(
		private readonly preApply: PreApplyService,
		private readonly items: PreApplyItemRepository,
		private readonly leadRepo: LeadRepository,
	) {}

	@Get()
	async page(@Res() res: Response) {
		const items = await this.preApply.listReview();
		const sentCount = await this.items.countSent();
		const leadIds = [...new Set(items.map((i) => i.leadId))];
		const leads = leadIds.length
			? await this.leadRepo.findRecent(500).then((all) => all.filter((l) => leadIds.includes(l.id)))
			: [];
		const byId = new Map(leads.map((l) => [l.id, l]));
		res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>my-job-agent — Pre-Apply Review</title><style>
:root{--bg:#0f1115;--card:#1a1d24;--line:#2a2e38;--fg:#e8eaed;--dim:#9aa0aa;--ok:#3fb96f;--warn:#e0a83c;--bad:#e05c5c;--accent:#5b8cff;--astro:#b48cff}
body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;padding:24px;max-width:1050px;margin:auto}
h1{font-size:22px}.sub{color:var(--dim);margin-bottom:18px}a{color:var(--accent)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;margin:10px 0}
.row{display:flex;justify-content:space-between;gap:10px;align-items:flex-start;flex-wrap:wrap}
.badge{font-size:11px;padding:2px 10px;border-radius:99px;background:var(--line)}
.badge.ready{background:rgba(91,140,255,.18);color:var(--accent)}
.badge.approved{background:rgba(180,140,255,.2);color:var(--astro)}
.badge.hold{background:rgba(224,168,60,.18);color:var(--warn)}
.badge.sent{background:rgba(63,185,111,.18);color:var(--ok)}
.badge.failed{background:rgba(224,92,92,.18);color:var(--bad)}
h3{color:var(--accent);margin:14px 0 4px;font-size:13px;text-transform:uppercase;letter-spacing:.05em}
.kv{display:flex;gap:8px}.kv b{min-width:130px;display:inline-block;color:var(--dim);font-weight:400}
pre.mail{white-space:pre-wrap;font:13px/1.55 system-ui;color:#c9ced6;background:var(--bg);padding:10px;border-radius:8px;max-height:260px;overflow:auto}
details.jd{background:var(--bg);border:1px solid var(--line);border-radius:8px;margin:8px 0}
details.jd summary{cursor:pointer;padding:8px 10px;color:var(--accent);font-size:13px;user-select:none}
details.jd pre.jd-body{white-space:pre-wrap;font:12.5px/1.55 system-ui;color:#c9ced6;padding:0 10px 10px;max-height:180px;overflow:auto;margin:0}
.meta{color:var(--dim);font-size:13px}
.actions{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
button{background:var(--line);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:7px 14px;font-size:13px;cursor:pointer}
button.ok{background:rgba(63,185,111,.16);border-color:rgba(63,185,111,.4);color:var(--ok)}
button.hold{background:rgba(224,168,60,.14);border-color:rgba(224,168,60,.4);color:var(--warn)}
button.cv{background:rgba(91,140,255,.14);border-color:rgba(91,140,255,.4);color:var(--accent)}
button:disabled{opacity:.5;cursor:not-allowed}
.astro{color:var(--astro)}
.astro-bar{height:6px;background:var(--line);border-radius:99px;overflow:hidden;margin:4px 0 8px}
.astro-bar i{display:block;height:100%;background:linear-gradient(90deg,#5b8cff,#b48cff)}
input[type=file]{font-size:12px;color:var(--dim)}
</style></head><body>
<h1>🕉️ Pre-Apply Review Queue</h1>
<div class="sub">Applications are <b>prepared but NOT sent</b> until you approve. Approved items send at the next <span class="astro">shubh muhurta</span> window.${sentCount > 0 ? ` · <b style="color:var(--ok)">${sentCount} sent</b> → moved to <a href="/applications-page">Applications &amp; Tracking</a>` : ''} · <a href="/">← dashboard</a></div>
<div id="list">${items.map((i) => card({ ...i, lead: byId.get(i.leadId) })).join('') || '<p class="meta">no prepared applications yet</p>'}</div>
<script>
async function act(id, action, btn) {
  btn.disabled = true;
  try {
    const res = await fetch('/pre-apply-page/' + id + '/' + action, { method: 'POST' });
    const r = await res.json().catch(() => null);
    if (r && r.ok) { location.reload(); return; }
    alert((r && (r.error || r.message)) || ('HTTP ' + res.status));
  } catch (e) { alert('network error — is the agent running?'); }
  btn.disabled = false;
}
async function uploadCv(id, input, btn) {
  if (!input.files.length) return;
  btn.disabled = true;
  const fd = new FormData();
  fd.append('file', input.files[0]);
  const r = await fetch('/pre-apply-page/' + id + '/upload-cv', { method: 'POST', body: fd }).then(r => r.json());
  if (r.ok) location.reload();
  else { btn.disabled = false; alert(r.error || 'upload failed'); }
}
</script></body></html>`);
	}

	// ------------------------------------------------------------- actions

	@Post(':id/approve')
	async approve(@Param('id') id: string) {
		const r = await this.preApply.approve(id);
		return { ok: !('error' in r), error: 'error' in r ? r.error : null, item: 'error' in r ? null : r };
	}

	@Post(':id/hold')
	async hold(@Param('id') id: string) {
		const r = await this.preApply.hold(id);
		return { ok: !('error' in r), error: 'error' in r ? r.error : null };
	}

	@Post(':id/resume')
	async resume(@Param('id') id: string) {
		const r = await this.preApply.resume(id);
		return { ok: !('error' in r), error: 'error' in r ? r.error : null };
	}

	@Post(':id/upload-cv')
	@UseInterceptors(FileInterceptor('file', {
		storage: diskStorage({
			destination: (_req, _file, cb) => { mkdirSync(UPLOAD_DIR, { recursive: true }); cb(null, UPLOAD_DIR); },
			filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`),
		}),
		fileFilter: (_req, file, cb) => {
			if (!/\.(pdf|docx?)$/i.test(file.originalname)) return cb(new BadRequestException('only .pdf/.doc/.docx allowed'), false);
			cb(null, true);
		},
	}))
	async uploadCv(@Param('id') id: string, @UploadedFile() file: { path: string } | undefined) {
		if (!file) throw new BadRequestException('file required');
		const r = await this.preApply.uploadCv(id, file.path);
		return { ok: !('error' in r), error: 'error' in r ? r.error : null };
	}

	@Get(':id/cv')
	async cv(@Param('id') id: string, @Res() res: Response) {
		const item = await this.items.findOneById(id);
		if (!item) return res.status(404).send('not found');
		const path = item.userCvPath ?? item.cvPath;
		if (!path || !existsSync(path)) return res.status(404).send('no CV on this item');
		res.setHeader('Content-Type', extname(path) === '.pdf' ? 'application/pdf' : 'application/octet-stream');
		res.setHeader('Content-Disposition', `inline; filename="${path.split(/[\\/]/).pop()}"`);
		createReadStream(path).pipe(res);
	}
}

function card(i: {
	id: string; status: string; source: string; matchScore: number | string; astroScore: number | string;
	astroJson: string | null; muhurtaWindowJson: string | null; channelJson: string | null;
	coverLetter: string | null; emailSubject: string | null; cvPath: string | null; userCvPath: string | null;
	leadId: string; createdAt: Date; approvedAt: Date | null;
	lead?: { title?: string; company?: string; url?: string | null; description?: string | null };
}): string {
	const astro = parseJson(i.astroJson) as { reasons?: string[]; muhurta?: { label?: string } } | null;
	const win = parseJson(i.muhurtaWindowJson) as { startsAt?: string; endsAt?: string; score?: number; tithi?: number; nakshatra?: string; weekday?: string } | null;
	const channel = parseJson(i.channelJson) as { kind?: string; target?: string; detectedBy?: string } | null;
	const astroPct = Math.round(Number(i.astroScore ?? 0));
	const matchPct = Math.round(Number(i.matchScore ?? 0));
	const holdActions = i.status === 'hold' ? `
	<button onclick="act('${i.id}','resume',this)">▶ Resume</button>` : `
	<button class="hold" onclick="act('${i.id}','hold',this)">⏸ Hold / Pause</button>`;
	return `
<div class="card">
  <div class="row">
    <div><b>${esc(i.lead?.title ?? i.leadId)}</b>
      <div class="meta">${esc(i.lead?.company ?? '')} · ${esc(i.source)} · prepared ${fmt(i.createdAt)}</div></div>
    <span class="badge ${esc(i.status)}">${esc(i.status.toUpperCase())}</span>
  </div>
  ${i.lead?.description ? `<details class="jd"><summary>📋 Job description</summary><pre class="jd-body">${esc(i.lead.description)}</pre></details>` : ''}
  <div class="kv"><b>Match</b><span>${matchPct}%</span></div>
  <div class="kv"><b>Astro match</b><span class="astro">${astroPct}/100</span></div>
  <div class="astro-bar"><i style="width:${astroPct}%"></i></div>
  ${astro?.reasons?.length ? `<div class="meta">${esc(astro.reasons.join(' · '))}</div>` : ''}
  ${win ? `<div class="kv"><b>Shubh window</b><span class="astro">${fmt(win.startsAt)} → ${fmt(win.endsAt)} IST · ${esc(win.weekday ?? '')} tithi ${win.tithi ?? ''} ${esc(win.nakshatra ?? '')} (score ${win.score ?? ''})</span></div>` : ''}
  ${channel ? `<div class="kv"><b>Channel</b><span>${esc(channel.kind ?? '')}${channel.target ? ' → ' + esc(channel.target) : ''} <span class="meta">(${esc(channel.detectedBy ?? '')})</span></span></div>` : ''}
  <h3>📧 Email draft</h3>
  <div class="kv"><b>Subject</b><span>${esc(i.emailSubject ?? i.coverLetter?.split('\n')[0] ?? '')}</span></div>
  <pre class="mail">${esc(i.coverLetter ?? '')}</pre>
  <h3>📄 CV</h3>
  <div class="meta">${i.userCvPath ? `user-uploaded CV: ${esc(i.userCvPath.split(/[\\/]/).pop())} (overrides tailored)` : `tailored ATS CV: ${esc(i.cvPath?.split(/[\\/]/).pop() ?? 'none')}`}</div>
  <div class="actions">
    ${i.status === 'ready' ? `<button class="ok" onclick="act('${i.id}','approve',this)">✅ Approve — send at shubh muhurta</button>` : i.status === 'approved' ? '<button class="ok" disabled>⏳ approved — awaiting shubh muhurta</button>' : ''}
    ${holdActions}
    <a href="/pre-apply-page/${i.id}/cv" target="_blank"><button class="cv">👁 Preview CV</button></a>
    <label class="cv"><button class="cv" onclick="document.getElementById('cv-${i.id}').click();return false">⬆ Upload corrected CV</button>
      <input id="cv-${i.id}" type="file" accept=".pdf,.doc,.docx" style="display:none" onchange="uploadCv('${i.id}',this,this.previousElementSibling)"></label>
  </div>
</div>`;
}
