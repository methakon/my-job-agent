import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ProjectChecklistItem } from './project-checklist-item.entity';
import { ProjectClarification } from './project-clarification.entity';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const SEED: ClarificationSeed[] = require('./clarifications.seed.json');

export const CLARIFICATION_STATUSES = ['pending', 'answered'] as const;
export type ClarificationStatus = (typeof CLARIFICATION_STATUSES)[number];

/** Cap on a stored question/answer — the columns are TEXT, this is a sanity bound. */
export const CLARIFICATION_MAX_CHARS = 4000;

export interface AskClarificationInput {
	itemId?: number | null;
	stage?: string;
	question: string;
	askedBy?: string;
}

export interface ClarificationStats {
	total: number;
	pending: number;
	answered: number;
}

/** Per-item counts the page needs: pending drives the yellow highlight, answered the badge. */
export interface ItemClarificationCounts {
	pending: ProjectClarification[];
	answered: ProjectClarification[];
}

export interface StageClarificationCount {
	stage: string;
	pending: number;
	answered: number;
}

/**
 * Persistent clarification store for /project-status.
 *
 * The agent files a question against a checklist item (or a free stage label);
 * it lives in project_clarifications as `pending`, which paints that checklist
 * row yellow. The operator types the answer in the page and hits save; the row
 * flips to `answered`, the yellow clears and the item shows how many
 * clarifications have been given. Nothing here is ever synthesised: an empty
 * question or an empty answer is rejected rather than stored.
 */
@Injectable()
export class ProjectClarificationService implements OnModuleInit {
	private readonly logger = new Logger(ProjectClarificationService.name);

	constructor(
		@InjectRepository(ProjectClarification)
		private readonly rows: Repository<ProjectClarification>,
		@InjectRepository(ProjectChecklistItem)
		private readonly items: Repository<ProjectChecklistItem>,
	) {}

	async onModuleInit(): Promise<void> {
		// Seed in the background — never block app bootstrap on the tunnel.
		void this.seedFromFile().catch((err) =>
			this.logger.warn(`clarification seed failed: ${(err as Error).message}`),
		);
	}

	/**
	 * Idempotent seed: the questions the agent actually needs answered right now.
	 * Matches on the question text, so a re-run never duplicates a question and
	 * an answered question is never reopened by a restart.
	 */
	async seedFromFile(): Promise<number> {
		let inserted = 0;
		for (const s of SEED) {
			const question = String(s.question ?? '').trim();
			if (!question) continue;
			if (await this.rows.exist({ where: { question } })) continue;
			const itemId = s.match ? await this.resolveItemId(s.match) : null;
			await this.rows.save(
				this.rows.create({
					itemId,
					stage: String(s.stage ?? '').slice(0, 160),
					question,
					askedBy: s.askedBy ?? 'hermes',
				}),
			);
			inserted += 1;
		}
		if (inserted > 0) this.logger.log(`seeded ${inserted} pending clarification(s) for /project-status`);
		return inserted;
	}

	/** Resolve a checklist item id from a substring of its text (seed convenience). */
	private async resolveItemId(match: string): Promise<number | null> {
		const row = await this.items
			.createQueryBuilder('i')
			.where('i.item LIKE :m', { m: `%${match}%` })
			.orderBy('i.grp_order', 'ASC')
			.addOrderBy('i.item_order', 'ASC')
			.getOne();
		return row ? row.id : null;
	}

	async ask(input: AskClarificationInput): Promise<ProjectClarification | null> {
		const question = String(input?.question ?? '').trim().slice(0, CLARIFICATION_MAX_CHARS);
		if (!question) return null;
		const itemId = Number.isFinite(Number(input?.itemId)) && input?.itemId != null ? Number(input.itemId) : null;
		let stage = String(input?.stage ?? '').trim().slice(0, 160);
		if (!stage && itemId != null) {
			const item = await this.items.findOne({ where: { id: itemId } });
			stage = item ? item.grp : '';
		}
		return this.rows.save(
			this.rows.create({
				itemId,
				stage,
				question,
				answer: null,
				status: 'pending',
				askedBy: input?.askedBy === 'operator' ? 'operator' : 'hermes',
				answeredAt: null,
			}),
		);
	}

	/** Store the operator's answer. Returns null for an unknown id or a blank answer. */
	async answer(id: number, text: string): Promise<ProjectClarification | null> {
		const answer = String(text ?? '').trim().slice(0, CLARIFICATION_MAX_CHARS);
		if (!answer) return null;
		const row = await this.rows.findOne({ where: { id } });
		if (!row) return null;
		row.answer = answer;
		row.status = 'answered';
		row.answeredAt = new Date();
		return this.rows.save(row);
	}

	/** Send a question back to pending (the answer was not sufficient). */
	async reopen(id: number): Promise<ProjectClarification | null> {
		const row = await this.rows.findOne({ where: { id } });
		if (!row) return null;
		row.status = 'pending';
		row.answeredAt = null;
		return this.rows.save(row);
	}

	async remove(id: number): Promise<boolean> {
		const res = await this.rows.delete({ id });
		return (res.affected ?? 0) > 0;
	}

	/** Every clarification, oldest first — the table is deliberately small. */
	async all(): Promise<ProjectClarification[]> {
		return this.rows.find({ order: { createdAt: 'ASC', id: 'ASC' } });
	}

	/**
	 * Everything the page renders, in one pass: total/pending/answered counts,
	 * the per-item split, stage-level counts, and every question that is NOT
	 * reachable from a checklist row.
	 *
	 * A question is only reachable from a row when its itemId still matches a row
	 * that is actually rendered. A null itemId, or an itemId whose checklist row no
	 * longer exists (re-seeded checklist, deleted row), MUST land in `unattached`
	 * instead of being filed under an id nobody renders — otherwise the page shows
	 * "1 awaiting clarification" in the stage list with no box to type in.
	 */
	async overview(): Promise<{
		stats: ClarificationStats;
		byItem: Map<number, ItemClarificationCounts>;
		unattached: ItemClarificationCounts;
		unattachedPending: ProjectClarification[];
		allPending: ProjectClarification[];
		byStage: StageClarificationCount[];
	}> {
		const [rows, liveItems] = await Promise.all([
			this.all(),
			this.items.find({ select: { id: true } }),
		]);
		const liveIds = new Set(liveItems.map((i) => i.id));
		const stats: ClarificationStats = { total: rows.length, pending: 0, answered: 0 };
		const byItem = new Map<number, ItemClarificationCounts>();
		const unattached: ItemClarificationCounts = { pending: [], answered: [] };
		const allPending: ProjectClarification[] = [];
		const stages = new Map<string, StageClarificationCount>();

		for (const r of rows) {
			const pending = r.status !== 'answered';
			if (pending) stats.pending += 1;
			else stats.answered += 1;
			if (pending) allPending.push(r);

			const bucket =
				r.itemId != null && liveIds.has(r.itemId)
					? (() => {
							let b = byItem.get(r.itemId);
							if (!b) {
								b = { pending: [], answered: [] };
								byItem.set(r.itemId, b);
							}
							return b;
						})()
					: unattached;
			(pending ? bucket.pending : bucket.answered).push(r);

			const stage = r.stage || '(no stage)';
			let s = stages.get(stage);
			if (!s) {
				s = { stage, pending: 0, answered: 0 };
				stages.set(stage, s);
			}
			if (pending) s.pending += 1;
			else s.answered += 1;
		}

		const byStage = [...stages.values()].sort(
			(a, b) => b.pending - a.pending || b.answered - a.answered || a.stage.localeCompare(b.stage),
		);
		return { stats, byItem, unattached, unattachedPending: unattached.pending, allPending, byStage };
	}
}

interface ClarificationSeed {
	/** Substring of the checklist item text this question belongs to (optional). */
	match?: string;
	stage?: string;
	question: string;
	askedBy?: string;
}
