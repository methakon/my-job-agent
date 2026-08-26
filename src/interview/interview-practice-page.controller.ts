import { Controller, Get, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { InterviewPrepService } from './interview-prep.service';

@ApiTags('interview-practice-page')
@Controller('interview-practice-page')
export class InterviewPracticePageController {
	constructor(private readonly prep: InterviewPrepService) {}

	@Get()
	async renderPage(@Res() res: Response) {
		const questions = await this.prep.listAll();
		const topics = [...new Set(questions.map((q) => q.topic))];

		const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>my-job-agent — Interview Practice</title>
<style>
	:root { --bg:#0f1115; --card:#1a1d24; --line:#2a2e38; --fg:#e8eaed; --dim:#9aa0aa; --ok:#3fb96f; --warn:#e0a83c; --accent:#5b8cff; }
	* { box-sizing:border-box; margin:0; padding:0; }
	body { background:var(--bg); color:var(--fg); font:15px/1.5 system-ui, sans-serif; padding:24px; max-width:1100px; margin:auto; }
	h1 { font-size:22px; margin-bottom:4px; }
	.sub { color:var(--dim); margin-bottom:20px; }
	a { color:var(--accent); text-decoration:none; }
	.filters { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:20px; }
	.chip { background:var(--card); border:1px solid var(--line); color:var(--dim); padding:6px 14px; border-radius:99px; cursor:pointer; font-size:13px; }
	.chip.active { background:var(--accent); color:#fff; border-color:var(--accent); }
	.grid { display:grid; gap:16px; grid-template-columns:repeat(auto-fit,minmax(450px,1fr)); }
	.card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:18px; display:flex; flex-direction:column; justify-space-between; }
	.topic-tag { display:inline-block; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.05em; padding:2px 8px; border-radius:4px; background:var(--line); color:var(--accent); margin-bottom:8px; }
	.diff { float:right; font-size:12px; color:var(--warn); }
	.q-text { font-size:16px; font-weight:600; margin-bottom:12px; }
	.ans-guide { display:none; background:var(--bg); border:1px solid var(--line); border-left:3px solid var(--ok); padding:12px; border-radius:6px; margin-top:10px; font-size:14px; color:var(--fg); }
	button { background:var(--accent); color:#fff; border:0; border-radius:6px; padding:8px 14px; cursor:pointer; font-size:13px; align-self:flex-start; margin-top:8px; }
	button.ghost { background:transparent; border:1px solid var(--line); color:var(--dim); }
</style>
</head>
<body>
<h1>🎯 Interview Practice Prep Bank</h1>
<div class="sub"><a href="/">← Dashboard</a> · Practice tailored questions by topic or job lead</div>

<div class="filters" id="filters">
	<div class="chip active" onclick="filterTopic('all', this)">All Topics (${questions.length})</div>
	${topics.map((t) => `<div class="chip" onclick="filterTopic('${t}', this)">${t}</div>`).join('')}
</div>

<div class="grid" id="qGrid">
	${questions
		.map(
			(q) => `
	<div class="card" data-topic="${q.topic}">
		<div>
			<span class="topic-tag">${q.topic}</span>
			<span class="diff">Difficulty ${'★'.repeat(q.difficulty)}</span>
			<div class="q-text">${q.question.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
		</div>
		<div>
			<button class="ghost" onclick="toggleAns(this)">Show Answer Guide</button>
			<div class="ans-guide">💡 <b>Answer Guide:</b><br>${(q.answerGuide ?? '').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
		</div>
	</div>`,
		)
		.join('')}
</div>

<script>
function filterTopic(topic, el) {
	document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
	el.classList.add('active');
	document.querySelectorAll('.card').forEach(c => {
		if (topic === 'all' || c.dataset.topic === topic) {
			c.style.display = 'flex';
		} else {
			c.style.display = 'none';
		}
	});
}

function toggleAns(btn) {
	const guide = btn.nextElementSibling;
	if (guide.style.display === 'block') {
		guide.style.display = 'none';
		btn.textContent = 'Show Answer Guide';
	} else {
		guide.style.display = 'block';
		btn.textContent = 'Hide Answer Guide';
	}
}
</script>
</body>
</html>`;

		res.send(html);
	}
}
