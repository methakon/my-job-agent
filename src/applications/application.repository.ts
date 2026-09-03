import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between } from 'typeorm';
import { Application } from './application.entity';

@Injectable()
export class ApplicationRepository {
	constructor(
		@InjectRepository(Application) readonly repo: Repository<Application>,
	) {}

	async save(app: Application): Promise<Application> {
		return this.repo.save(app);
	}

	async saveMany(apps: Application[]): Promise<Application[]> {
		return this.repo.save(apps);
	}

	async count(): Promise<number> {
		return this.repo.count();
	}

	async track(id: string, type: string, detail: Record<string, unknown>): Promise<Application | null> {
		return this.repo.save({ id, lastEvent: type, eventDetail: detail });
	}

	async updateStatus(id: string, status: string, detail?: Record<string, unknown>): Promise<boolean> {
		const r = await this.repo.update(id, { status, ...(detail ? { lastEvent: 'status_changed', eventDetail: detail } : {}) });
		return (r.affected ?? 0) > 0;
	}

	async findByStatus(status: string): Promise<Application[]> {
		return this.repo.findBy({ status });
	}

	async findById(id: string): Promise<Application | null> {
		return this.repo.findOneBy({ id });
	}

	async findRecent(limit = 100): Promise<Application[]> {
		return this.repo.find({ order: { createdAt: 'DESC' }, take: limit });
	}

	async findOneById(id: string): Promise<Application | null> {
		return this.repo.findOneBy({ id });
	}

	async findByLead(leadId: string): Promise<Application | null> {
		return this.repo.findOne({ where: { leadId }, order: { createdAt: 'DESC' } });
	}

	async findAll(page = 1, limit = 100): Promise<[Application[], number]> {
		const [rows, total] = await this.repo.findAndCount({
			order: { createdAt: 'DESC' },
			skip: (page - 1) * limit,
			take: limit,
		});
		return [rows.map(a => this.serialize(a)), total];
	}

		async countByMonth(year: number, month: number, statusFilter: string = 'applied'): Promise<Map<string, number>> {
		const firstDay = new Date(year, month - 1, 1);
		const lastDay  = new Date(year, month, 0, 23, 59, 59, 999);
		const qb = this.repo.createQueryBuilder('app')
			.select('app.appliedAt', 'day')
			.addSelect('COUNT(app.id)', 'cnt')
			.where('app.appliedAt >= :start', { start: firstDay })
			.andWhere('app.appliedAt <= :end', { end: lastDay });
		if (statusFilter && statusFilter !== 'all') {
			qb.andWhere('app.status = :status', { status: statusFilter });
		}
		qb.groupBy('app.appliedAt').orderBy('app.appliedAt', 'ASC');
		const rows = await qb.getRawMany();
		return new Map(rows.map(r => [r.day.toISOString().slice(0, 10), Number(r.cnt)]));
	}

	async findDay(day: string, page = 1, limit = 20, statusFilter?: string): Promise<[Application[], number]> {
		const start = new Date(day + 'T00:00:00.000Z');
		const end   = new Date(day + 'T23:59:59.999Z');
		const qb = this.repo.createQueryBuilder('app')
			.where('app.appliedAt >= :start', { start })
			.andWhere('app.appliedAt <= :end', { end });
		if (statusFilter && statusFilter !== 'all') {
			qb.andWhere('app.status = :status', { status: statusFilter });
		}
		const [rows, total] = await qb.getManyAndCount();
		const ordered = rows.sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
		const skip = (page - 1) * limit;
		const paged = ordered.slice(skip, skip + limit);
		return [paged.map(a => this.serialize(a)), total];
	}

	async distinctDays(statusFilter?: string): Promise<string[]> {
		const qb = this.repo.createQueryBuilder('app')
			.select('DISTINCT DATE(app.appliedAt)', 'day')
			.orderBy('day', 'DESC');
		if (statusFilter && statusFilter !== 'all') {
			qb.andWhere('app.status = :status', { status: statusFilter });
		}
		const rows = await qb.getRawMany();
		return rows.map(r => r.day);
	}

	async counts(): Promise<{ sent: number; failed: number; pending: number }> {
		const qb = this.repo.createQueryBuilder('app')
			.select('app.status', 'status')
			.addSelect('COUNT(app.id)', 'cnt')
			.groupBy('app.status');
		const rows = await qb.getRawMany();
		const out: { sent: number; failed: number; pending: number } = { sent: 0, failed: 0, pending: 0 };
		for (const r of rows) {
			switch (r.status) {
				case 'sent':   out.sent    = Number(r.cnt); break;
				case 'failed': out.failed  = Number(r.cnt); break;
				default:       out.pending = Number(r.cnt);
			}
		}
		return out;
	}


	async countTodayBySource(source: string): Promise<number> {
		const start = new Date();
		start.setHours(0, 0, 0, 0);
		const end = new Date(start.getTime() + 86400000);
		return this.repo.count({
			where: {
				source,
				createdAt: Between(start, end),
			},
		});
	}

	async countBySource(source: string): Promise<number> {
		return this.repo.count({ where: { source } });
	}

	async createPartial(partial: Partial<Application>): Promise<Application> {
		return this.repo.create(partial);
	}

	async findRecentWithLead(limit = 300): Promise<(Application & { company?: string; leadUrl?: string })[]> {
		const apps = await this.repo.find({
			order: { createdAt: 'DESC' },
			take: limit,
		});
		return apps as any;
	}

	private serialize(a: Application): Application {
		const s = a;
		return Object.assign(new Application(), s);
	}
}
