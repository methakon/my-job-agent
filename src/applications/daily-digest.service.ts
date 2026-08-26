import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { MailService } from './mail.service';
import { ApplyEngineService } from './apply-engine.service';

/**
 * DailyDigestService — once a day (09:00 IST-ish via env DIGEST_HOUR, default
 * 9) emails the user a digest: new high-match leads, applications submitted
 * in last 24h, needs_info items awaiting answers, learning stats.
 */
@Injectable()
export class DailyDigestService {
	private readonly logger = new Logger(DailyDigestService.name);
	private lastSentDate = '';

	constructor(
		private readonly mailer: MailService,
		private readonly engine: ApplyEngineService,
	) {}

	/** Check hourly; send once per day when hour matches. */
	@Interval(60 * 60 * 1000)
	async tick(): Promise<void> {
		const now = new Date();
		const today = now.toISOString().slice(0, 10);
		if (this.lastSentDate === today) return;
		const targetHour = Number(process.env.DIGEST_HOUR ?? 9);
		if (now.getHours() !== targetHour) return;
		this.lastSentDate = today;
		try {
			await this.sendDigest();
		} catch (err) {
			this.logger.warn(`digest failed: ${String(err).slice(0, 150)}`);
		}
	}

	async sendDigest(): Promise<void> {
		const leadRepo = this.engine.leadRepo;
		const appRepo = this.engine.appRepo;
		const since = new Date(Date.now() - 24 * 3600_000);
		const leads = await leadRepo.findRecent(200);
		const topLeads = leads
			.filter((l) => l.status === 'new' && Number(l.matchScore) >= 60)
			.sort((a, b) => Number(b.matchScore) - Number(a.matchScore))
			.slice(0, 8);
		const apps = await appRepo.findRecent(500);
		const recentApps = apps.filter((a) => new Date(a.createdAt) >= since && a.status === 'submitted');
		const needsInfo = apps.filter((a) => a.status === 'needs_info');
		const stats = await this.engine.learning.stats();

		const rows = topLeads
			.map((l) => `<tr><td>${Math.round(Number(l.matchScore))}%</td><td>${esc(l.title)}</td><td>${esc(l.company)}</td><td>${esc(l.source)}</td></tr>`)
			.join('');
		const appRows = recentApps.map((a) => `<li>${esc(a.source)} — ${esc(String(a.errorDetail ?? '').slice(0, 60)) || 'submitted'}</li>`).join('');
		const infoRows = needsInfo.map((a) => `<li>${esc(a.source)}: ${esc(JSON.parse(a.missingInfoJson ?? '[]').join('; '))}</li>`).join('');

		const html = `
<h2>🤖 my-job-agent daily digest</h2>
<h3>🔥 Top new leads (≥60% match)</h3>
<table border="1" cellpadding="6" style="border-collapse:collapse">
<tr><th>Match</th><th>Title</th><th>Company</th><th>Source</th></tr>${rows || '<tr><td colspan=4>none</td></tr>'}</table>
<h3>✅ Submitted in last 24h (${recentApps.length})</h3><ul>${appRows || '<li>none</li>'}</ul>
<h3>⏸ Needs your input (${needsInfo.length})</h3><ul>${infoRows || '<li>none</li>'}</ul>
<h3>🧠 Learning</h3><p>Total applications: ${stats.totalApplications}. Best channel: ${await this.bestChannelLabel()}</p>
<p style="color:#888">Dashboard: http://localhost:3010/ · Side income: http://localhost:3010/side-income-dashboard/dashboard</p>`;
		await this.mailer.send({ to: process.env.DIGEST_TO ?? 'bapay.9@gmail.com', subject: `my-job-agent digest — ${topLeads.length} hot leads`, html });
		this.logger.log('daily digest sent');
	}

	private async bestChannelLabel(): Promise<string> {
		const best = await (this.engine.learning?.bestChannel?.() ?? Promise.resolve(null));
		return best ?? 'not enough data yet';
	}
}

function esc(s: string): string {
	return String(s ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] as string));
}
