import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { QuestionAnswer } from './question-answer.entity';

/**
 * Answer bank for custom application questions.
 * Auto-seeds common answers from the candidate profile; unknown questions
 * are stored with empty answers so the dashboard can prompt the user once,
 * then every future form reuses the saved reply.
 */
const normalize = (q: string) => q.toLowerCase().trim().replace(/\s+/g, ' ').slice(0, 300);

@Injectable()
export class AnswerBankService {
	private readonly logger = new Logger(AnswerBankService.name);
	constructor(
		@InjectRepository(QuestionAnswer) private readonly repo: Repository<QuestionAnswer>,
	) {}

	async resolve(questions: string[]): Promise<Record<string, string>> {
		const out: Record<string, string> = {};
		for (const q of questions) {
			const hit = await this.repo.findOne({ where: { questionNormalized: normalize(q) } });
			if (hit && hit.answer.trim() !== '') out[q] = hit.answer;
		}
		return out;
	}

	async save(question: string, answer: string, origin: 'auto' | 'manual' = 'manual'): Promise<void> {
		const normalized = normalize(question);
		const existing = await this.repo.findOne({ where: { questionNormalized: normalized } });
		if (existing) {
			existing.answer = answer;
			existing.origin = origin;
			await this.repo.save(existing);
		} else {
			await this.repo.save(this.repo.create({
				questionNormalized: normalized,
				questionOriginal: question.slice(0, 300),
				answer,
				origin,
			}));
		}
	}

	findAll(): Promise<QuestionAnswer[]> {
		return this.repo.find({ order: { updatedAt: 'DESC' } });
	}

	/** Seed profile-derived answers once (e.g. notice period, salary). */
	async seedFromProfile(profile: Record<string, string>): Promise<number> {
		const seeds: Array<[string, string]> = [];
		if (profile.noticePeriod) seeds.push(['What is your notice period?', profile.noticePeriod]);
		if (profile.salaryExpectation) seeds.push(['What are your salary expectations?', profile.salaryExpectation]);
		if (profile.currentLocation) seeds.push(['Where are you currently located?', profile.currentLocation]);
		if (profile.experienceYears) seeds.push(['How many years of experience do you have?', profile.experienceYears]);
		let n = 0;
		for (const [q, a] of seeds) {
			const exists = await this.repo.findOne({ where: { questionNormalized: normalize(q) } });
			if (!exists) {
				await this.save(q, a, 'auto');
				n++;
			}
		}
		if (n) this.logger.log(`answer bank seeded ${n} profile-derived answers`);
		return n;
	}
}
