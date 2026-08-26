import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LearningWeight } from './learning-weight.entity';

/**
 * LearningWeightsService (FR-11 persistence) — accumulates outcome stats in
 * the learning_weights table atomically (upsert-increment) and serves
 * aggregated stats + recommendations that tune future application behaviour.
 */
@Injectable()
export class LearningWeightsService {
	private readonly logger = new Logger(LearningWeightsService.name);

	constructor(
		@InjectRepository(LearningWeight)
		private readonly repo: Repository<LearningWeight>,
	) {}

	/** Increment sent (+1) and optionally replies for a metric key. */
	async record(metricKey: string, replied = false): Promise<void> {
		await this.repo
			.createQueryBuilder()
			.insert()
			.into(LearningWeight)
			.values({ metricKey, sent: 1, replies: replied ? 1 : 0 })
			.orUpdate(['sent', 'replies'], ['metricKey'])
			.setParameter('sent', 1)
			.execute();
		// MySQL ON DUPLICATE KEY with expressions needs raw fallback:
		await this.repo.query(
			`UPDATE learning_weights SET sent = sent + 1, replies = replies + ${replied ? 1 : 0} WHERE metric_key = ?`,
			[metricKey],
		);
	}

	/** Convenience: record an application attempt on channel+portal+hour. */
	async recordAttempt(channel: string, portalSource: string, hour: number): Promise<void> {
		await this.record(`channel:${channel}`);
		await this.record(`portal:${portalSource}`);
		await this.record(`hour:${hour}`);
	}

	/** Record that a channel/portal/hour got a reply. */
	async recordReply(channel: string, portalSource: string, hour: number, keyword?: string): Promise<void> {
		await this.record(`channel:${channel}`, true);
		await this.record(`portal:${portalSource}`, true);
		await this.record(`hour:${hour}`, true);
		if (keyword) await this.record(`keyword:${keyword.toLowerCase()}`, true);
	}

	/** Aggregated stats for the dashboard / decision-making. */
	async stats(): Promise<{
		channelSuccess: Record<string, { sent: number; replies: number; rate: number }>;
		portalSuccess: Record<string, { sent: number; replies: number; rate: number }>;
		bestSendHour: number | null;
		topKeywords: Array<{ keyword: string; replies: number }>;
		totalApplications: number;
	}> {
		const rows = await this.repo.find();
		const parse = (r: LearningWeight) => ({ sent: r.sent, replies: r.replies });
		const rateOf = (p: { sent: number; replies: number }) => (p.sent > 0 ? Math.round((p.replies / p.sent) * 100) : 0);

		const channelSuccess: Record<string, { sent: number; replies: number; rate: number }> = {};
		const portalSuccess: Record<string, { sent: number; replies: number; rate: number }> = {};
		const hourReplies: Record<number, number> = {};
		const topKeywords: Array<{ keyword: string; replies: number }> = [];
		let totalApplications = 0;

		for (const r of rows) {
			if (r.metricKey.startsWith('channel:')) {
				const name = r.metricKey.slice(8);
				const p = parse(r);
				channelSuccess[name] = { ...p, rate: rateOf(p) };
				totalApplications += r.sent;
			} else if (r.metricKey.startsWith('portal:')) {
				const name = r.metricKey.slice(7);
				const p = parse(r);
				portalSuccess[name] = { ...p, rate: rateOf(p) };
			} else if (r.metricKey.startsWith('hour:')) {
				hourReplies[Number(r.metricKey.slice(5))] = r.replies;
			} else if (r.metricKey.startsWith('keyword:') && r.replies > 0) {
				topKeywords.push({ keyword: r.metricKey.slice(8), replies: r.replies });
			}
		}
		topKeywords.sort((a, b) => b.replies - a.replies);
		const bestSendHour =
			Object.keys(hourReplies).length > 0
				? Number(Object.entries(hourReplies).sort((a, b) => b[1] - a[1])[0][0])
				: null;

		return { channelSuccess, portalSuccess, bestSendHour, topKeywords: topKeywords.slice(0, 10), totalApplications };
	}

	/** Recommendation: which channel currently has the best reply rate (min 3 sends). */
	async bestChannel(): Promise<string | null> {
		const { channelSuccess } = await this.stats();
		let best: string | null = null;
		let bestRate = -1;
		for (const [name, s] of Object.entries(channelSuccess)) {
			if (s.sent >= 3 && s.rate > bestRate) {
				bestRate = s.rate;
				best = name;
			}
		}
		return best;
	}
}
