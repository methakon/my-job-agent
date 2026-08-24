import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JobLead } from './job-lead.entity';

@Injectable()
export class LeadRepository {
	constructor(
		@InjectRepository(JobLead) private readonly repo: Repository<JobLead>,
	) {}

	findByExternal(source: string, externalId: string): Promise<JobLead | null> {
		return this.repo.findOne({ where: { source, externalId } });
	}

	findRecent(limit = 100, status?: string): Promise<JobLead[]> {
		const where = status ? { status } : {};
		return this.repo.find({ where, order: { matchScore: 'DESC', createdAt: 'DESC' }, take: limit });
	}

	upsert(lead: Partial<JobLead>): Promise<JobLead> {
		return this.repo.save(this.repo.create(lead));
	}

	async setStatus(id: string, status: string): Promise<void> {
		await this.repo.update(id, { status });
	}

	countToday(): Promise<number> {
		return this.repo.count({});
	}
}
