import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * One clarification the agent needs from the operator, or the operator's answer
 * to it, attached to a checklist item and/or a stage label.
 *
 * Lifecycle: pending (question filed, row highlighted yellow on
 * /project-status) -> answered (answer stored, highlight clears, the item
 * starts counting "N given"). A pending row is the ONLY thing that paints a
 * checklist line yellow, so the page shows exactly what is waiting on a human.
 */
@Entity('project_clarifications')
export class ProjectClarification {
	@PrimaryGeneratedColumn()
	id!: number;

	/** Checklist item this question sits against (null = stage-level question). */
	@Index()
	@Column({ type: 'int', nullable: true })
	itemId!: number | null;

	/** Stage label shown to the operator, e.g. "GATE 16 - INDEPENDENT RISK ENGINE". */
	@Column({ type: 'varchar', length: 160, default: '' })
	stage!: string;

	/** The question, in plain language, with the evidence it needs to resolve. */
	@Column({ type: 'text' })
	question!: string;

	/** The operator's answer. Empty until answered. */
	@Column({ type: 'text', nullable: true })
	answer!: string | null;

	/** pending | answered */
	@Column({ type: 'varchar', length: 16, default: 'pending' })
	status!: string;

	/** Who filed the question: hermes | operator. */
	@Column({ type: 'varchar', length: 16, default: 'hermes' })
	askedBy!: string;

	@CreateDateColumn()
	createdAt!: Date;

	/** When the answer was stored (null while pending). */
	@Column({ type: 'datetime', nullable: true })
	answeredAt!: Date | null;

	@UpdateDateColumn()
	updatedAt!: Date;
}
