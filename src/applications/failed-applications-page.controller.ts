import { Controller, Get, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import * as fs from 'fs';
import { ApplicationRepository } from './application.repository';
import { LeadRepository } from '../leads/lead.repository';
import { EmailTrackerService } from './email-tracker.service';

/**
 * FailedApplicationsPageController — dedicated subpage under
 * "Applications & Tracking" listing only applications whose status is
 * `failed`, with failure diagnostics: errorDetail, retryCount, missingInfo,
 * last tracking event, and the job description + match score so the user can
 * decide whether to retry, rewrite, or drop.
 */
@Controller('applications-page/failed')
export class FailedApplicationsPageController {
	constructor(
		private readonly appRepo: ApplicationRepository,
		private readonly leadRepo: LeadRepository,
		private readonly emailTracker: EmailTrackerService,
	) {}

	@Get()
	async page(@Res() res: Response) {
		// Applications that didn't reach sent — failed, needs_info, or any unsent/open
		const unsentStatuses = ['failed', 'needs_info', 'open', 'pending_review', 'req_info', 'saved'];
		const apps = await this.appRepo.repo.createQueryBuilder('app')
			.andWhere('app.status IN (:...statuses)', { statuses: unsentStatuses })
			.andWhere('app.createdAt >= CURRENT_DATE - 1')
			.orderBy('app.createdAt', 'DESC')
			.take(80)
			.getMany();

		res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>my-job-agent — Failed Applications</title><style>
:root{--bg:#0f1115;--card:#1a1d24;--line:#2a2e38;--fg:#e8eaed;--dim:#9aa0aa;--bad:#e05c5c;--accent:#5b8cff;--ok:#3fb96f;--warn:#e0a83c}
body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;padding:24px;max-width:1000px;margin:auto}
h1{font-size:22px}.sub{color:var(--dim);margin-bottom:18px}a{color:var(--accent)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;margin:10px 0}
summary{cursor:pointer;display:flex;justify-content:space-between;gap:10px;align-items:center}
.badge{font-size:11px;padding:2px 10px;border-radius:99px;background:rgba(224,92,92,.18);color:var(--bad)}
pre.desc{white-space:pre-wrap;font:13px/1.55 system-ui;color:#c9ced6;background:var(--bg);padding:10px;border-radius:8px;max-height:340px;overflow:auto}
ul{margin:4px 0;padding-left:20px}.meta{color:var(--dim);font-size:13px}
.track li{margin:4px 0}.kv{display:flex;gap:8px}.kv b{min-width:130px;display:inline-block;color:var(--dim);font-weight:400}
.retry-btn{margin-top:8px;padding:6px 14px;background:var(--accent);color:#fff;border:0;border-radius:6px;cursor:pointer;font-size:13px}
.retry-btn.secondary{background:#21262d;border:1px solid var(--line);color:var(--fg)}
</style></head><body>
<h1>❌ Failed Applications</h1>
<div class="sub">Applications that did not complete. Review the error, decide whether to retry or rewrite. · <a href="/applications-page">all applications</a> · <a href="/">← dashboard</a></div>
<div id="list">${apps.map((a) => failedCard(a)).join('') || '<p class="meta">no failed applications</p>'}</div>
<script>
function esc(s){return String(s??'').replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))}

async function expand(d, id) {
  if (d.dataset.loaded) return;
  d.dataset.loaded = 1;
  const box = d.querySelector('.detail');
  const r = await fetch('/applications-page/' + id + '/detail').then(r => r.json());
  if (!r || !r.application) { box.innerHTML = '<p class="meta">not found</p>'; return; }
  const a = r.application, j = r.job, track = r.tracking || [];

  let html = '';
  if (j) {
    html += '<h3>💼 Job</h3>' +
      '<div class="kv"><b>Title</b><span>' + esc(j.title) + '</span></div>' +
      '<div class="kv"><b>Company</b><span>' + esc(j.company) + '</span></div>' +
      '<div class="kv"><b>Location</b><span>' + esc(j.location || '—') + '</span></div>' +
      '<div class="kv"><b>Match</b><span>' + Math.round(Number(j.matchScore)) + '%</span></div>' +
      (j.url ? '<div class="kv"><b>Posting</b><span><a target="_blank" rel="noopener" href="' + esc(j.url) + '">' + esc(j.url.slice(0,70)) + '</a></span></div>' : '') +
      (j.description ? '<h3>📄 Job description</h3><pre class="desc">' + esc(j.description.replace(/<[^>]+>/g,' ').replace(/\\s+/g,' ').trim()) + '</pre>' : '');
  }

  html += '<h3>🔴 Failure details</h3>';
  if (a.errorDetail) html += '<pre class="desc">' + esc(a.errorDetail) + '</pre>';

  if (a.missingInfo && a.missingInfo.length) {
    html += '<h3>⏸ Missing info (needs_info)</h3><ul>' +
      a.missingInfo.map(m => '<li>' + esc(m) + '</li>').join('') + '</ul>';
  }

  html += '<h3>📎 Application details</h3>';
  html += '<div class="kv"><b>Source</b><span>' + esc(a.source) + '</span></div>';
  html += '<div class="kv"><b>Submitted at</b><span>' + new Date(a.createdAt).toLocaleString() + '</span></div>';
  html += '<div class="kv"><b>Last update</b><span>' + new Date(a.updatedAt).toLocaleString() + '</span></div>';
  html += '<div class="kv"><b>Retries</b><span>' + (a.retryCount ?? 0) + '</span></div>';
  html += '<div class="kv"><b>Tailored CV</b><span>' +
    (a.cvPath ? '<a href="/applications-page/' + id + '/cv">' + esc(a.cvFile) + '</a>' : '—') + '</span></div>';
  if (a.coverLetter) html += '<div class="kv"><b>Cover letter sent</b><span>' + esc(a.coverLetter.slice(0, 200)) + (a.coverLetter.length > 200 ? '…</span>' : '</span>') + '</div>';

  html += '<h3>📦 Tracking history (' + track.length + ')</h3>';
  if (track.length) {
    html += '<ul class="track">' + track.map(t =>
      '<li><b>' + esc(t.status) + '</b> <span class="meta">' + new Date(t.createdAt).toLocaleString() + '</span>' +
      (t.content ? '<div class="meta">' + esc(String(t.content).slice(0, 300)) + '</div>' : '') + '</li>').join('') + '</ul>';
  } else {
    html += '<p class="meta">no tracking events (email poll adds them automatically)</p>';
  }

  box.innerHTML = html;
}

document.querySelectorAll('details').forEach(d => {
  d.addEventListener('toggle', () => { if (d.open) expand(d, d.dataset.id); });
});
</script></body></html>`);
	}

	/** JSON detail (reuses the main detail route — same shape as the main page). */
	@Get(':id/detail')
	async detailWithLead(@Param('id') id: string) {
		const a = await this.appRepo.findOneById(id);
		if (!a) return null;
		const lead = await this.leadRepo.findOneById(a.leadId);
		return {
			application: {
				id: a.id,
				source: a.source,
				status: a.status,
				cvPath: a.cvPath,
				cvFile: a.cvPath ? a.cvPath.split('/').pop() : null,
				coverLetter: a.coverLetter,
				errorDetail: a.errorDetail,
				missingInfo: a.missingInfoJson ? JSON.parse(a.missingInfoJson) : [],
				retryCount: a.retryCount ?? 0,
				createdAt: a.createdAt,
				updatedAt: a.updatedAt,
			},
			job: lead
				? {
						title: lead.title,
						company: lead.company,
						location: lead.location,
						url: lead.url,
						description: lead.description,
						matchScore: lead.matchScore,
						matchedSkills: lead.matchedSkills,
					}
				: null,
			tracking: await this.emailTracker.listFor(id),
		};
	}

	/** Serve the tailored CV PDF for a failed application. */
	@Get(':id/cv')
	async cv(@Param('id') id: string, @Res() res: Response) {
		const a = await this.appRepo.findOneById(id);
		if (!a?.cvPath || !fs.existsSync(a.cvPath)) {
			res.status(404).send('CV not found');
			return;
		}
		res.download(a.cvPath, `failed-cv-${a.source}.pdf`);
	}
}

function failedCard(a: {
	id: string;
	source: string;
	status: string;
	errorDetail: string | null;
	createdAt: Date;
}): string {
	return `<details class="card" data-id="${a.id}">
  <summary>
    <div><b>${esc2(a.source)}</b> <span style="color:var(--dim)">· ${new Date(a.createdAt).toLocaleDateString()}</span></div>
    <span class="badge">failed</span>
  </summary>
  <div class="detail"><p class="meta">loading…</p><div class="retry-btn secondary" onclick="location.href='/applications-page'">← back to all applications</div></div>
</details>`;
}

function esc2(s: string): string {
	return String(s ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] as string));
}
