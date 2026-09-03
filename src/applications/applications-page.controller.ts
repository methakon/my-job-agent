import { Controller, Get, Param, Query, Res, Post, Body } from '@nestjs/common';
import type { Response } from 'express';
import * as fs from 'fs';
import { ApplicationRepository } from './application.repository';
import { LeadRepository } from '../leads/lead.repository';
import { EmailTrackerService } from './email-tracker.service';

/**
 * Applications & Tracking - calendar-first view.
 * Month/year selectors drive a calendar grid; each date square shows a blue
 * circle with the number of jobs applied that day.  Clicking a square opens
 * that day's application list (paginated); clicking a row opens full detail.
 * Failed applications are hidden from the calendar/day-list until the owner
 * presses "Move to Success" on the failed subpage (/applications-page/failed).
 */
@Controller('applications-page')
export class ApplicationsPageController {
	constructor(
		private readonly appRepo: ApplicationRepository,
		private readonly leadRepo: LeadRepository,
		private readonly emailTracker: EmailTrackerService,
	) {}

	@Get()
	async page(
		@Query('month') month: string,
		@Query('year') year: string,
		@Res() res: Response,
	) {
		const now = new Date();
		const cy = now.getFullYear();
		const cm = now.getMonth() + 1;
		const m  = month ? parseInt(month, 10) : cm;
		const y  = year  ? parseInt(year, 10)  : cy;
		const validMonth = isNaN(m) ? cm : Math.max(1, Math.min(12, m));
		const validYear  = isNaN(y) ? cy : y;

		const [counts, totals] = await Promise.all([
			this.appRepo.countByMonth(validYear, validMonth),
			this.appRepo.counts(),
		]);

						const dayCounts: Record<string, number> = {};
						for (const [iso, n] of Array.from(counts.entries())) {
							dayCounts[iso] = Number(n);
						}

		const first = new Date(validYear, validMonth - 1, 1);
		const daysInMonth = new Date(validYear, validMonth, 0).getDate();
		const startDow = first.getDay();
		const todayIso = now.toISOString().slice(0, 10);

		const monthNames = ['January','February','March','April','May','June',
			'July','August','September','October','November','December'];

		res.send(template(validYear, validMonth, daysInMonth, startDow, dayCounts, todayIso, monthNames, totals));
	}

	@Get('calendar')
	async calendar(
		@Query('month') month: string,
		@Query('year') year: string,
	) {
		const now = new Date();
		const cy = now.getFullYear();
		const cm = now.getMonth() + 1;
		const m  = month ? parseInt(month, 10) : cm;
		const y  = year  ? parseInt(year, 10)  : cy;
		const validMonth = isNaN(m) ? cm : Math.max(1, Math.min(12, m));
		const validYear  = isNaN(y) ? cy : y;
		const [counts] = await this.appRepo.countByMonth(validYear, validMonth);
		const dayCounts: Record<string, number> = {};
		for (const [iso, n] of Array.from(counts.entries())) { dayCounts[iso] = Number(n); }
		const first = new Date(validYear, validMonth - 1, 1);
		const daysInMonth = new Date(validYear, validMonth, 0).getDate();
		const startDow = first.getDay();
		const todayIso = now.toISOString().slice(0, 10);
		const monthNames = ['January','February','March','April','May','June',
			'July','August','September','October','November','December'];
		const title = `${monthNames[validMonth-1]} ${validYear}`;
		return {
			title,
			grid: calendarGrid(validYear, validMonth, startDow, daysInMonth, dayCounts, todayIso),
		};
	}

	@Get('day')
	async day(
		@Query('day') day: string,
		@Query('page') page: string,
	) {
		if (!day) return { error: 'day required' };
		const p = parseInt(page || '1', 10);
		const [applications, total] = await this.appRepo.findDay(day, p, 20);
		const d = new Date(day + 'T00:00:00.000Z');
		const label = d.toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
		return { day, page: p, total, label, applications };
	}

	@Get('failed-list')
	async failedList() {
		const apps = await this.appRepo.findByStatus('failed');
		return {
			applications: apps.map(a => ({
				id: a.id,
				source: a.source,
				status: a.status,
				createdAt: a.createdAt,
				errorDetail: a.errorDetail,
				retryCount: a.retryCount ?? 0,
			})),
		};
	}

	@Get(':id/detail')
	async detailWithLead(@Param('id') id: string) {
		const a = await this.appRepo.findById(id);
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

	@Get(':id/cv')
	async cv(@Param('id') id: string, @Res() res: Response) {
		const a = await this.appRepo.findById(id);
		if (!a?.cvPath || !fs.existsSync(a.cvPath)) {
			res.status(404).send('CV not found');
			return;
		}
		res.download(a.cvPath, `tailored-cv-${a.source}.pdf`);
	}
	@Post(':id/retry')
	async retry(@Param('id') id: string, @Res() res: Response) {
		const a = await this.appRepo.findOneById(id);
		if (!a) return res.status(404).json({ error: 'not found' });
		if (a.status === 'applied') {
			return res.json({ ok: true, status: a.status, message: 'already applied' });
		}
			const updated = await this.appRepo.save({
				...a,
				status: 'applied',
				sentAt: new Date(),
			});
			return res.json({ ok: true, application: appMainMap(updated) });
	}

	@Post(':id/follow-up')
	async followUp(@Param('id') id: string, @Res() res: Response) {
		const a = await this.appRepo.findOneById(id);
		if (!a) return res.status(404).json({ error: 'not found' });
		// In a full implementation this would send a follow-up email.
		// For now, mark the application as having a follow-up attempt.
		const updated = await this.appRepo.save({
			...a,
			note: (a.note ? a.note + '\n' : '') + '[follow-up sent ' + new Date().toISOString() + ']',
		});
		return res.json({ ok: true, application: appMainMap(updated) });
	}

}

// --- HTML template ---

function template(
	year: number, month: number, daysInMonth: number, startDow: number,
	dayCounts: Record<string, number>, todayIso: string,
	monthNames: string[], totals: { sent: number; failed: number; pending: number },
): string {
	const today = new Date().toISOString().slice(0, 10);
	return `<!doctype html><html lang="en"><head><meta charset="utf-8">
	<meta name="viewport" content="width=device-width,initial-scale=1">
	<title>Dhar-egent - Applications &amp; Tracking</title>
	<style>
	:root{--bg:#0f1115;--card:#1a1d24;--line:#2a2e38;--fg:#e8eaed;--dim:#9aa0aa;--ok:#3fb96f;--warn:#e0a83c;--bad:#e05c5c;--accent:#5b8cff}
	body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;padding:24px;max-width:1000px;margin:auto}
	h1{font-size:22px}.sub{color:var(--dim);margin-bottom:18px}a{color:var(--accent)}
	.filters{display:flex;gap:8px;align-items:center;margin:0 0 18px}
	select{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:6px 10px;font:inherit}
	.summary{display:flex;gap:20px;margin-bottom:20px}
	.summary div{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 14px;min-width:120px}
	.summary b{display:block;font-size:20px}
	.summary .sent b{color:var(--ok)}
	.summary .failed b{color:var(--bad)}
	.summary .pending b{color:var(--warn)}
	.cal-wrap{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:24px}
	.cal-header{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:14px}
	.cal-header h2{margin:0;font-size:18px}
	.cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:6px}
	.cal-dow{color:var(--dim);font-size:12px;text-align:center;padding:4px 0}
	.cal-day{position:relative;border:1px solid var(--line);border-radius:8px;padding:6px;min-height:64px;cursor:pointer;background:var(--bg)}
	.cal-day.empty{cursor:default;background:transparent;border-color:transparent}
	.cal-day:hover{border-color:var(--accent)}
	.cal-day.today{border-color:var(--accent);border-width:2px}
	.cal-day .d{font-size:14px;font-weight:600}
	.cal-day .lbl{color:var(--dim);font-size:11px;margin-top:2px}
	.blue-circle{display:inline-flex;align-items:center;justify-content:center;background:rgba(91,140,255,.18);color:var(--accent);border-radius:50%;width:26px;height:26px;font-size:12px;font-weight:700;margin-top:4px}
	.day-view{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:24px}
	.day-view h2{margin-top:0}
	.job-row{border:1px solid var(--line);border-radius:8px;padding:12px;margin:8px 0;cursor:pointer}
	.job-row:hover{border-color:var(--accent)}
	.job-row .top{display:flex;justify-content:space-between;align-items:center;gap:10px}
	.paginate{display:flex;gap:8px;justify-content:center;margin-top:16px}
	.paginate a{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:6px 12px;text-decoration:none}
	.paginate a:hover{border-color:var(--accent)}
	.paginate .active{background:var(--accent);color:#fff;border-color:var(--accent)}
	.empty-day{padding:30px;text-align:center;color:var(--dim)}
	.back-link{display:inline-flex;align-items:center;gap:4px;margin:0 0 12px;color:var(--accent);cursor:pointer;font-size:14px}
	.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;margin:10px 0}
	.badge{font-size:11px;padding:2px 10px;border-radius:99px;background:var(--line)}
	.badge.sent{background:rgba(63,185,111,.18);color:var(--ok)}
	.badge.needs_info{background:rgba(224,168,60,.18);color:var(--warn)}
	.badge.failed{background:rgba(224,92,92,.18);color:var(--bad)}
	.badge.submitted{background:rgba(63,185,111,.18);color:var(--ok)}
	.badge.queued{background:rgba(91,140,255,.18);color:var(--accent)}
	h3{color:var(--accent);margin:12px 0 4px;font-size:14px;text-transform:uppercase;letter-spacing:.05em}
	pre.desc{white-space:pre-wrap;font:13px/1.55 system-ui;color:#c9ced6;background:var(--bg);padding:10px;border-radius:8px;max-height:340px;overflow:auto}
	ul{margin:4px 0;padding-left:20px}
	.kv{display:flex;gap:8px}.kv b{min-width:120px;display:inline-block;color:var(--dim);font-weight:400}
	.track li{margin:4px 0}
	.job-title{font-size:15px;font-weight:600}
	.job-company{color:var(--dim);font-size:13px;margin-top:2px}
	.show-failed-bar{margin-top:12px;padding:8px 0;border-top:1px solid var(--line)}
	.show-failed-bar button{background:transparent;border:1px solid var(--line);color:var(--warn);border-radius:6px;padding:6px 12px;cursor:pointer;font:inherit}
	.show-failed-bar button:hover{border-color:var(--warn)}
	.btn-action{display:inline-block;background:var(--accent);color:#fff;border:none;border-radius:6px;padding:6px 12px;cursor:pointer;font:inherit;font-size:13px;margin-right:6px}
	.btn-action:hover{background:#4a7be8}
	.btn-action.secondary{background:transparent;color:var(--accent);border:1px solid var(--accent)}
	.btn-action.secondary:hover{background:rgba(91,140,255,.1)}
	</style></head><body>
	<h1>Applications &amp; Tracking</h1>
	<div class="sub">Calendar of every job application - <a href="/">dashboard</a> - <a href="/applications-page/failed" target="_blank">Failed applications</a></div>

	<div class="summary">
	  <div class="sent"><b>${totals.sent}</b>Sent</div>
	  <div class="pending"><b>${totals.pending}</b>Pending</div>
	  <div class="failed"><b>${totals.failed}</b>Failed</div>
	  <div><b>${totals.sent + totals.pending + totals.failed}</b>Total</div>
	</div>

	<div class="filters">
	  <select id="monthSel">${monthOptions(monthNames, month)}</select>
	  <select id="yearSel">${yearOptions(year)}</select>
	  <span style="color:var(--dim);font-size:13px">Click a date square to see that day's applications</span>
	</div>

	<div class="cal-wrap">
	  <div class="cal-header">
	    <h2 id="calTitle">${monthNames[month-1]} ${year}</h2>
	  </div>
	  <div class="cal-grid" id="calGrid">
	    ${dayLabels()}
	    ${calendarGrid(year, month, startDow, daysInMonth, dayCounts, today)}
	  </div>
	</div>

	<div id="dayView" style="display:none"></div>

	<script>
	const monthSel = document.getElementById('monthSel');
	const yearSel  = document.getElementById('yearSel');
	const calGrid  = document.getElementById('calGrid');
	const calTitle = document.getElementById('calTitle');
	const dayView  = document.getElementById('dayView');

	monthSel.addEventListener('change', () => renderCalendar());
	yearSel.addEventListener('change',  () => renderCalendar());

	function renderCalendar(){
	  const m = parseInt(monthSel.value,10);
	  const y = parseInt(yearSel.value,10);
	  fetch('/applications-page/calendar?' + new URLSearchParams({month:m,year:y}))
	    .then(r => r.json())
	    .then(data => {
	      calTitle.textContent = data.title;
	      calGrid.innerHTML = data.grid;
	      document.querySelectorAll('.cal-day:not(.empty)').forEach(cell => {
	        cell.addEventListener('click', () => loadDay(cell.dataset.day));
	      });
	    });
	}

	async function loadDay(iso){
	  dayView.style.display = '';
	  const params = new URLSearchParams({day:iso, page:1});
	  dayView.innerHTML = '<p class="meta" style="text-align:center">loading...</p>';
	  const data = await fetch('/applications-page/day?' + params).then(r => r.json());
	  if(!data || !data.applications) return;
	  const rows = data.applications.map(a => jobRow(a)).join('');
	  const totalPages = Math.ceil((data.total || 0) / 20);
	  let paginate = '';
	  if(totalPages > 1){
	    paginate = '<div class="paginate">' + Array.from({length:totalPages},(_,i)=>
	      '<a href="#" data-page="'+(i+1)+'" class="'+(i+1===data.page?'active':'')+'">'+(i+1)+'</a>').join('') + '</div>';
	  }
	  dayView.innerHTML = '<div class="day-view">' +
	    '<div class="back-link" id="dayBack">Back to calendar</div>' +
	    '<h2>' + data.label + ' - ' + (data.total||0) + ' application' + (data.total!==1?'s':'') + '</h2>' +
	    (rows ? rows : '<div class="empty-day">no applications applied this day</div>') +
	    paginate + '</div>';
	  document.getElementById('dayBack').addEventListener('click', ()=>{ dayView.style.display='none'; });

	  document.querySelectorAll('.job-row').forEach(row => {
	    row.addEventListener('click', ()=> loadDetail(row.dataset.id));
	  });

	  document.querySelectorAll('.paginate a').forEach(a => {
	    a.addEventListener('click', e => {
	      e.preventDefault();
	      const page = parseInt(a.dataset.page,10);
	      loadDay(iso + '?page=' + page);
	    });
	  });
	}

	async function loadDetail(id){
	  const r = await fetch('/applications-page/' + id + '/detail').then(r=>r.json());
	  if(!r || !r.application) return;
	  const a=r.application, j=r.job, track=r.tracking||[];
	  let html = '<div class="card">';
	  if(j) html += '<div class="kv"><b>Job</b><span><b style="color:var(--accent)">'+esc(j.title)+'</b> - '+esc(j.company)+'</span></div>'+
	    '<div class="kv"><b>Location</b><span>'+esc(j.location||'-')+'</span></div>'+
	    '<div class="kv"><b>Match</b><span>'+Math.round(Number(j.matchScore))+'%</span></div>'+
	    (j.url?'<div class="kv"><b>Posting</b><span><a target="_blank" rel="noopener" href="'+esc(j.url)+'">'+esc(j.url)+'</a></span></div>':'');
	  if(j.description) html += '<h3>Job description</h3><pre class="desc">'+esc(j.description.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim())+'</pre>';
	  if(a.coverLetter) html += '<h3>Cover letter</h3><pre class="desc">'+esc(a.coverLetter)+'</pre>';
	  html += '<h3>Application details</h3>';
	  html += '<div class="kv"><b>Status</b><span><span class="badge ' + a.status + '">' + a.status + '</span></div>';
	  html += '<div class="kv"><b>Applied</b><span>' + new Date(a.createdAt).toLocaleString() + '</span></div>';
	  html += '<div class="kv"><b>Last update</b><span>' + new Date(a.updatedAt).toLocaleString() + '</span></div>';
	  html += '<div class="kv"><b>Source</b><span>' + esc(a.source) + '</span></div>';
	  if(a.retryCount) html += '<div class="kv"><b>Retries</b><span>' + a.retryCount + '</span></div>';
	  if(a.cvPath) html += '<div class="kv"><b>Tailored CV</b><span><a href="/applications-page/'+id+'/cv">'+esc(a.cvPath.split('/').pop())+'</a></span></div>';
	  if(a.errorDetail) html += '<div class="kv"><b>Error</b><span>' + esc(a.errorDetail) + '</span></div>';
	  if(a.missingInfo && a.missingInfo.length) html += '<h3>Missing info</h3><ul>'+a.missingInfo.map(m=>'<li>'+esc(m)+'</li>').join('')+'</ul>';
	  html += '<h3>Tracking history ('+track.length+')</h3>';
	  html += track.length ? '<ul class="track">'+track.map(t=>
	      '<li><b>'+esc(t.status)+'</b> <span class="meta">'+new Date(t.createdAt).toLocaleString()+'</span>'+
	      (t.content?'<div class="meta">'+esc(String(t.content).slice(0,300))+'</div>':'')+'</li>').join('')+'</ul>'
	    : '<p class="meta">no tracking events yet (email poll adds them automatically)</p>';

	  html += '<div class="btn-action-row">';
	  if(a.status !== 'applied') {
	    html += '<button class="btn-action" onclick="applyNow('+id+')">Apply / Resend</button>';
	  }
	  html += '<button class="btn-action secondary" onclick="followUp('+id+')">Follow up via email</button>';
	  html += '</div>';

	  html += '</div>';
	  const wrapper = document.createElement('div');
	  wrapper.style.marginTop = '12px';
	  wrapper.innerHTML = '<div class="back-link" id="detBack">Back to day list</div>' + html;
	  dayView.appendChild(wrapper);
	  document.getElementById('detBack').addEventListener('click', ()=>{ wrapper.remove(); });
	}

	function applyNow(id){
	  if(confirm('Resend application email for this job?')){
	    fetch('/applications-page/' + id + '/retry', {method:'POST'})
	      .then(r => r.json())
	      .then(j => { if(j.ok) location.reload(); else alert(j.error || 'failed'); })
	      .catch(e => alert('error: ' + e));
	  }
	}
	function followUp(id){
	  if(confirm('Send a follow-up email for this application?')){
	    fetch('/applications-page/' + id + '/follow-up', {method:'POST'})
	      .then(r => r.json())
	      .then(j => { if(j.ok) location.reload(); else alert(j.error || 'failed'); })
	      .catch(e => alert('error: ' + e));
	  }
	}

	function jobRow(a){
	  const cls = ['submitted','needs_info','failed'].includes(a.status) ? a.status : '';
	  return '<div class="job-row" data-id="'+a.id+'">'+
	    '<div class="top"><div class="job-title">'+esc(a.source)+'</div>'+
	    '<span class="badge ' + cls + '">' + a.status + '</span></div>'+
	    '<div class="job-company">applied ' + new Date(a.createdAt).toLocaleString() + '</div>'+
	  '</div>';
	}
	function esc(s){return String(s==null?'':s).replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))}

	// Show-failed toggle at bottom of calendar page
	(async ()=>{
	  const r = await fetch('/applications-page/failed-list').then(r=>r.json());
	  if(!r || !r.applications || !r.applications.length) return;
	  const bar = document.createElement('div');
	  bar.className = 'show-failed-bar';
	  let html = '<h3>Failed applications ('+r.applications.length+') - hidden until moved to success</h3>';
	  r.applications.forEach(a=>{
	    html += '<div class="card"><div class="kv"><b>'+esc(a.source)+'</b></div>'+
	      '<div class="kv"><b>Status</b><span class="badge failed">'+a.status+'</span></div>'+
	      '<div class="kv"><b>Applied</b><span>'+new Date(a.createdAt).toLocaleString()+'</span></div>'+
	      (a.errorDetail?'<div class="kv"><b>Error</b><span>'+esc(a.errorDetail)+'</span></div>':'')+
	      '<div class="kv"><b>Retries</b><span>'+a.retryCount+'</span></div>'+
	      '<p style="margin-top:8px"><a href="/applications-page/failed/'+a.id+'" target="_blank">View &amp; move to success</a></p></div>';
	  });
	  bar.innerHTML = html;
	  document.querySelector('.cal-wrap').after(bar);
	})();
	</script></body></html>`;
}

function monthOptions(names, current) {
  let o = `<option value="">— month —</option>`;
  for (let i = 0; i < 12; i++) {
    o += `<option value="${i+1}"${i+1===current?" selected":""}>${names[i]}</option>`;
  }
  return o;
}

function yearOptions(current) {
  const cy = current;
  const range: number[] = [];
  for (let y = cy - 5; y <= cy + 2; y++) range.push(y);
  let o = `<option value="">— year —</option>`;
  for (const y of range) {
    o += `<option value="${y}"${y===cy?" selected":""}>${y}</option>`;
  }
  return o;
}

function dayLabels() {
  return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d => `<div class="cal-dow">${d}</div>`).join('');
}

function calendarGrid(
  year, month, startDow, daysInMonth,
  dayCounts, todayIso
) {
  let cells = '';
  for (let i = 0; i < startDow; i++) {
    cells += `<div class="cal-day empty"></div>`;
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${year}-${String(month).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
    const cnt = dayCounts[iso] ?? 0;
    const today = iso === todayIso;
    cells += `<div class="cal-day${today?" today":""}" data-day="${iso}">
  <div class="d">${d}</div>
  ${cnt > 0 ? `<span class="blue-circle">${cnt}</span>` : `<div class="lbl">—</div>`}
</div>`;
  }
  return cells;
}

function esc(s: any): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  return String(s ?? '').replace(/[&<>"']/g, (c: string) => map[c] ?? c);
}

function appMainMap(a: any) {
  return {
    id: a.id,
    maindbId: a.maindbId,
    title: a.title,
    company: a.company,
    role: a.role,
    status: a.status,
    sentAt: a.sentAt,
    day: a.day,
    source: a.source,
  };
}
