import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/** One checkbox line of a project checklist (e.g. the Hermes F&O v4 validated
 *  TO-DO: 22 gates + final priority order). DB-driven so the portal can show
 *  each item with a live status that the user toggles. */
@Entity('project_checklist_items')
export class ProjectChecklistItem {
	@PrimaryGeneratedColumn()
	id!: number;

	/** Group heading, e.g. "GATE 3 - CORE FEATURE ENGINE". */
	@Column({ type: 'varchar', length: 160 })
	grp!: string;

	/** Order of the group within the checklist (1-based). */
	@Column({ type: 'int' })
	grp_order!: number;

	/** One-line goal/description of the group, when the source provides one. */
	@Column({ type: 'varchar', length: 300, default: '' })
	goal!: string;

	/** Position of the item inside its group (1-based). */
	@Column({ type: 'int' })
	item_order!: number;

	/** The checklist text. */
	@Column({ type: 'varchar', length: 600 })
	item!: string;

	/** pending | in_progress | done | blocked | n/a */
	@Column({ type: 'varchar', length: 16, default: 'pending' })
	status!: string;

	/** Optional user note attached to the item. */
	@Column({ type: 'varchar', length: 500, default: '' })
	note!: string;

	/** v5 detailed edition — implementation instruction for this item. */
	@Column({ type: 'text', nullable: true })
	instr!: string | null;

	/** v5 detailed edition — objective "Done when" condition. */
	@Column({ type: 'text', nullable: true })
	doneWhen!: string | null;

	/** checklist edition the item text came from: v4 | v5 */
	@Column({ type: 'varchar', length: 8, default: 'v4' })
	edition!: string;

	@CreateDateColumn()
	createdAt!: Date;

	@UpdateDateColumn()
	updatedAt!: Date;
}
