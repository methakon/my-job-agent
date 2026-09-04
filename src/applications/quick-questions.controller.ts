import { Body, Controller, Get, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AnswerBankService } from './answer-bank.service';
import { QuestionAnswer } from './question-answer.entity';

const esc = (s: unknown) => String(s ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c] as string);

/** J-11 — Quick-question page: free-text Q&A instead of canned. Lets the owner
 *  type any custom application question and its answer; stored in the answer
 *  bank so every future portal form reuses it. */
@Controller('quick-questions')
export class QuickQuestionsController {
	constructor(private readonly bank: AnswerBankService) {}

	@Get()
	async page(@Res() res: Response) {
		const all = await this.bank.findAll();
		const answered = all.filter((a) => (a.answer ?? '').trim() !== '');
		const unanswered = all.filter((a) => (a.answer ?? '').trim() === '');

		const rows = (list: QuestionAnswer[]) =>
			list.length
				? list
						.map(
							(a) =>
								`<tr><td class="q">${esc(a.questionOriginal || a.questionNormalized)}</td>` +
								`<td>${esc(a.answer) || '<span class="dim">— empty —</span>'}</td>` +
								`<td class="dim">${esc(a.origin)}</td></tr>`,
						)
						.join('')
				: '<tr><td colspan="3" class="dim">Nothing here yet.</td></tr>';

		res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>my-job-agent — Quick Questions</title><style>
:root{--bg:#0f1115;--card:#1a1d24;--line:#2a2e38;--fg:#e8eaed;--dim:#9aa0aa;--accent:#5b8cff;--ok:#3fb96f;--warn:#e0a83c}
body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;padding:24px;max-width:960px;margin:auto}
h1{font-size:22px}.sub{color:var(--dim);margin-bottom:18px}a{color:var(--accent)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:14px 0}
label{display:block;color:var(--dim);font-size:13px;margin:10px 0 4px}
input[type=text],textarea{width:100%;box-sizing:border-box;background:var(--bg);border:1px solid var(--line);color:var(--fg);border-radius:8px;padding:8px 10px;font:inherit}
button{margin-top:12px;padding:8px 18px;background:var(--accent);color:#fff;border:0;border-radius:6px;cursor:pointer;font:inherit}
table{width:100%;border-collapse:collapse;font-size:14px}
td,th{border-bottom:1px solid var(--line);padding:8px 6px;text-align:left;vertical-align:top}
th{color:var(--dim);font-size:12px;font-weight:600}.q{max-width:320px}.dim{color:var(--dim)}
.ok{color:var(--ok)}.warn{color:var(--warn)}
#msg{margin-top:10px;font-size:14px}
</style></head><body>
<h1>⚡ Quick Questions</h1>
<div class="sub">Free-text answers for custom application questions. Anything saved here is reused automatically on future portal forms. · <a href="/">dashboard</a> · <a href="/applications-page">applications</a></div>

<div class="card"><h3 style="margin-top:0">➕ Add a question + answer</h3>
<form id="qa">
  <label>Question (as shown on the application form)</label>
  <input type="text" id="q" required maxlength="300" placeholder="e.g. Do you require visa sponsorship?">
  <label>Answer</label>
  <textarea id="a" rows="3" required placeholder="e.g. No — I hold an Indian passport and do not require sponsorship."></textarea>
  <button type="submit">Save to answer bank</button>
  <div id="msg"></div>
</form></div>

<div class="card"><h3 style="margin-top:0">📖 Answer bank (${answered.length} answered)</h3>
<table><tr><th>Question</th><th>Answer</th><th>Origin</th></tr>${rows(answered)}</table></div>

${unanswered.length ? `<div class="card"><h3 style="margin-top:0">⚠️ Unanswered questions (${unanswered.length})</h3>
<table><tr><th>Question</th><th>Answer</th><th>Origin</th></tr>${rows(unanswered)}</table></div>` : ''}

<script>
function esc(s){return String(s==null?'':s).replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))}
document.getElementById('qa').addEventListener('submit', async function(ev){
  ev.preventDefault();
  var q = document.getElementById('q').value.trim();
  var a = document.getElementById('a').value.trim();
  var msg = document.getElementById('msg');
  if(!q || !a){ msg.innerHTML = '<span class="warn">Both question and answer are required.</span>'; return; }
  var r = await fetch('/quick-questions', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({question:q, answer:a})});
  var j = await r.json();
  if(j.ok){ msg.innerHTML = '<span class="ok">✓ Saved. This answer will be used for this question from now on.</span>';
    setTimeout(function(){ location.reload(); }, 700); }
  else { msg.innerHTML = '<span class="warn">Error: ' + esc(j.error || 'unknown') + '</span>'; }
});
</script></body></html>`);
	}

	@Post()
	async save(@Body() body: { question?: string; answer?: string }) {
		const question = String(body?.question ?? '').trim();
		const answer = String(body?.answer ?? '').trim();
		if (!question || !answer) return { ok: false, error: 'question and answer are required' };
		await this.bank.save(question, answer, 'manual');
		return { ok: true };
	}
}
