import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not } from 'typeorm';
import { PreApplyItem } from './pre-apply-item.entity';

@Injectable()
export class PreApplyItemRepository {
	constructor(
		@InjectRepository(PreApplyItem) private readonly repo: Repository<PreApplyItem>,
	) {}

	create(data: Partial<PreApplyItem>): Promise<PreApplyItem> {
		return this.repo.save(this.repo.create(data));
	}

	findOneById(id: string): Promise<PreApplyItem | null> {
		return this.repo.findOne({ where: { id } });
	}

	/** items awaiting user action (ready + approved), newest first */
	findPending(limit = 100): Promise<PreApplyItem[]> {
		return this.repo.find({
			where: [{ status: 'ready' }, { status: 'approved' }],
			order: { createdAt: 'DESC' },
			take: limit,
		});
	}

	/** all items, newest first (page) */
	findAll(limit = 200): Promise<PreApplyItem[]> {
		return this.repo.find({ order: { createdAt: 'DESC' }, take: limit });
	}

	/**
	 * Review-queue items only: everything still actionable — ready, hold,
	 * approved (awaiting muhurta) and failed (retryable). Sent items are
	 * excluded: once an application goes out it belongs to Application
	 * Tracking (user rule: sent ⇒ leave the review queue).
	 */
	findReviewQueue(limit = 200): Promise<PreApplyItem[]> {
		return this.repo.find({
			where: { status: Not('sent') },
			order: { createdAt: 'DESC' },
			take: limit,
		});
	}

	/** Count of items already sent (for the queue's "moved to tracking" hint). */
	countSent(): Promise<number> {
		return this.repo.count({ where: { status: 'sent' } });
	}

	findByLead(leadId: string): Promise<PreApplyItem | null> {
		return this.repo.findOne({ where: { leadId }, order: { createdAt: 'DESC' } });
	}

	/** approved-but-not-yet-sent items, oldest approval first (send queue) */
	findApprovedPendingSend(limit = 50): Promise<PreApplyItem[]> {
		return this.repo.find({
			where: { status: 'approved' },
			order: { approvedAt: 'ASC' },
			take: limit,
		});
	}

	save(item: PreApplyItem): Promise<PreApplyItem> {
		return this.repo.save(item);
	}
}
