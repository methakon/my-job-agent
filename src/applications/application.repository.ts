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
}
