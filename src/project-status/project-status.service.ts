import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ProjectChecklistItem } from './project-checklist-item.entity';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const SEED: SeedRow[] = require('./checklist-v4.seed.json');

export const CHECKLIST_STATUSES = ['pending', 'in_progress', 'done', 'blocked', 'n/a'] as const;
export type ChecklistStatus = (typeof CHECKLIST_STATUSES)[number];

export interface ChecklistGroup {
	grp: string;
	grpOrder: number;
	goal: string;
	stats: Record<string, number>;
	items: ProjectChecklistItem[];
}

@Injectable()
export class ProjectStatusService implements OnModuleInit {
	private readonly logger = new Logger(ProjectStatusService.name);
	private ready = false;
	private readyPromise: Promise<void> | null = null;

	constructor(
		@InjectRepository(ProjectChecklistItem)
		private readonly items: Repository<ProjectChecklistItem>,
	) {}

	async onModuleInit(): Promise<void> {
		// Seed in the background — do NOT block app bootstrap on 200+ tunnel
		// round-trips. The page handles an unseeded table gracefully meanwhile.
		this.readyPromise = this.ensureSeeded().then(
			() => {
				this.ready = true;
			},
			(err) => this.logger.warn(`checklist seed failed: ${(err as Error).message}`),
		);
	}

	/** Seed the v4 checklist on first boot (idempotent — skips rows whose
	 *  (grp_order, item_order) already exist thanks to the uq_grp_item key). */
	async ensureSeeded(): Promise<number> {
		// Fast path: table already at full seed size.
		if ((await this.items.count()) >= SEED.length) return 0;
		let inserted = 0;
		for (const r of SEED) {
			const exists = await this.items.exist({ where: { grp_order: r.grp_order, item_order: r.item_order } });
			if (exists) continue;
			await this.items.save(
				this.items.create({
					grp: r.grp,
					grp_order: r.grp_order,
					goal: r.goal ?? '',
					item_order: r.item_order,
					item: r.item,
					status: r.status ?? 'pending',
					note: r.note ?? '',
				}),
			);
			inserted += 1;
		}
		if (inserted > 0) this.logger.log(`seeded ${inserted} new checklist items (Hermes F&O v4)`);
		return inserted;
	}

	/** All groups with per-group progress stats. */
	async grouped(): Promise<ChecklistGroup[]> {
		const rows = await this.items.find({ order: { grp_order: 'ASC', item_order: 'ASC' } });
		const map = new Map<string, ChecklistGroup>();
		for (const r of rows) {
			let g = map.get(r.grp);
			if (!g) {
				g = { grp: r.grp, grpOrder: r.grp_order, goal: r.goal ?? '', stats: {}, items: [] };
				map.set(r.grp, g);
			}
			g.items.push(r);
		}
		const groups = [...map.values()].sort((a, b) => a.grpOrder - b.grpOrder);
		for (const g of groups) {
			g.stats = { total: g.items.length, done: 0, in_progress: 0, pending: 0, blocked: 0 };
			for (const it of g.items) {
				const s = it.status as ChecklistStatus;
				if (s in g.stats) g.stats[s as keyof typeof g.stats] += 1;
				else g.stats.pending += 1;
			}
		}
		return groups;
	}

	async overallStats(): Promise<{ total: number; done: number; in_progress: number; pending: number; blocked: number; pct: number }> {
		const groups = await this.grouped();
		const s = { total: 0, done: 0, in_progress: 0, pending: 0, blocked: 0 };
		for (const g of groups) {
			s.total += g.items.length;
			s.done += g.stats.done ?? 0;
			s.in_progress += g.stats.in_progress ?? 0;
			s.pending += g.stats.pending ?? 0;
			s.blocked += g.stats.blocked ?? 0;
		}
		const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
		return { ...s, pct };
	}

	async setStatus(id: number, status: string): Promise<ProjectChecklistItem | null> {
		if (!CHECKLIST_STATUSES.includes(status as ChecklistStatus)) return null;
		const row = await this.items.findOne({ where: { id } });
		if (!row) return null;
		row.status = status as ChecklistStatus;
		await this.items.save(row);
		return row;
	}

	async setNote(id: number, note: string): Promise<ProjectChecklistItem | null> {
		const row = await this.items.findOne({ where: { id } });
		if (!row) return null;
		row.note = String(note ?? '').slice(0, 500);
		await this.items.save(row);
		return row;
	}
}

interface SeedRow {
	grp: string;
	grp_order: number;
	goal?: string;
	item_order: number;
	item: string;
	status?: string;
	note?: string;
}
