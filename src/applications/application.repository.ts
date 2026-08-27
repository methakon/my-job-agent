import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Application } from './application.entity';

@Injectable()
export class ApplicationRepository {
	constructor(
		@InjectRepository(Application) private readonly repo: Repository<Application>,
	) {}

	createPartial(data: Partial<Application>): Promise<Application> {
		return this.repo.save(this.repo.create(data));
	}

	findRecent(limit = 100): Promise<Application[]> {
		return this.repo.find({ order: { createdAt: 'DESC' }, take: limit });
	}

	/** Recent applications joined with their lead's company name + URL (for
	 *  linking employer replies to applications). */
	findRecentWithLead(limit = 300): Promise<Array<Application & { company?: string; leadUrl?: string }>> {
		return this.repo
			.createQueryBuilder('a')
			.leftJoin('job_leads', 'l', 'l.id = a.leadId')
			.select(['a.id AS id', 'a.leadId AS leadId', 'a.source AS source', 'a.status AS status', 'l.company AS company', 'l.url AS leadUrl'])
			.orderBy('a.createdAt', 'DESC')
			.take(limit)
			.getRawMany();
	}

	findOneById(id: string): Promise<Application | null> {
		return this.repo.findOne({ where: { id } });
	}

	findByLead(leadId: string): Promise<Application | null> {
		return this.repo.findOne({ where: { leadId }, order: { createdAt: 'DESC' } });
	}

	findByStatus(status: string): Promise<Application[]> {
		return this.repo.find({ where: { status }, order: { createdAt: 'DESC' } });
	}

	save(app: Application): Promise<Application> {
		return this.repo.save(app);
	}

	countTodayBySource(source: string): Promise<number> {
		const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
		return this.repo
			.createQueryBuilder('a')
			.where('a.source = :source AND a.createdAt >= :since', { source, since })
			.getCount();
	}

	/** FR-18: total non-failed applications per portal (portal cap check). */
	countBySource(source: string): Promise<number> {
		return this.repo
			.createQueryBuilder('a')
			.where('a.source = :source AND a.status != :failed', { source, failed: 'failed' })
			.getCount();
	}
}
