import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between } from 'typeorm';
import { Application } from './application.entity';

/**
 * Statuses that mean the application actually went out (email sent / ATS
 * submitted). 'submitted' is what the engine writes on success; 'sent' and
 * 'applied' are legacy values from older flows + the manual retry endpoint.
 * Rows with a stamped sent_at count regardless of status.
 */
const SENT_STATUSES = ['submitted', 'sent', 'applied'];

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

	/**
	 * Count applications actually sent, per calendar day (month range).
	 * "Sent" = terminal success status (submitted/sent/applied) or a stamped
	 * sent_at. The bucket date is sent_at when known, else created_at (legacy
	 * rows predate sent_at stamping). Rows that never went out (queued,
	 * needs_info, submitting, failed, sandboxed, and no sent_at) are excluded.
	 */
	async countByMonth(year: number, month: number): Promise<Map<string, number>> {
		const firstDay = new Date(year, month - 1, 1);
		const lastDay  = new Date(year, month, 0, 23, 59, 59, 999);
		const qb = this.repo.createQueryBuilder('app')
			.select("DATE_FORMAT(COALESCE(app.sentAt, app.createdAt), '%Y-%m-%d')", 'day')
			.addSelect('COUNT(app.id)', 'cnt')
			.where('(app.status IN (:...sentStatuses) OR app.sentAt IS NOT NULL)', { sentStatuses: SENT_STATUSES })
			.andWhere('COALESCE(app.sentAt, app.createdAt) >= :start', { start: firstDay })
			.andWhere('COALESCE(app.sentAt, app.createdAt) <= :end', { end: lastDay })
			.groupBy('day')
			.orderBy('day', 'ASC');
		const rows = await qb.getRawMany();
		return new Map(rows.map(r => [String(r.day), Number(r.cnt)]));
	}

	async findDay(day: string, page = 1, limit = 20): Promise<[Application[], number]> {
		const qb = this.repo.createQueryBuilder('app')
			.where('(app.status IN (:...sentStatuses) OR app.sentAt IS NOT NULL)', { sentStatuses: SENT_STATUSES })
			.andWhere("DATE_FORMAT(COALESCE(app.sentAt, app.createdAt), '%Y-%m-%d') = :day", { day });
		const [rows, total] = await qb.getManyAndCount();
		const ordered = rows.sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
		const skip = (page - 1) * limit;
		const paged = ordered.slice(skip, skip + limit);
		return [paged.map(a => this.serialize(a)), total];
	}

	async distinctDays(): Promise<string[]> {
		const rows = await this.repo.createQueryBuilder('app')
			.select("DISTINCT DATE_FORMAT(COALESCE(app.sentAt, app.createdAt), '%Y-%m-%d')", 'day')
			.where('(app.status IN (:...sentStatuses) OR app.sentAt IS NOT NULL)', { sentStatuses: SENT_STATUSES })
			.orderBy('day', 'DESC')
			.getRawMany();
		return rows.map(r => String(r.day));
	}

	async counts(): Promise<{ sent: number; failed: number; pending: number }> {
		const qb = this.repo.createQueryBuilder('app')
			.select("CASE WHEN app.status IN ('submitted','sent','applied') OR app.sentAt IS NOT NULL THEN 'sent' WHEN app.status = 'failed' THEN 'failed' ELSE 'pending' END", 'bucket')
			.addSelect('COUNT(app.id)', 'cnt')
			.groupBy('bucket');
		const rows = await qb.getRawMany();
		const out: { sent: number; failed: number; pending: number } = { sent: 0, failed: 0, pending: 0 };
		for (const r of rows) {
			if (r.bucket === 'sent') out.sent = Number(r.cnt);
			else if (r.bucket === 'failed') out.failed = Number(r.cnt);
			else out.pending = Number(r.cnt);
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
