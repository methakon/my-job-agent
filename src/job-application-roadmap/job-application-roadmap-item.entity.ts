import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * One row of the Job Application Agent roadmap.
 *
 * This is a SEPARATE control plane from the Trading Agent /project-status
 * checklist (project_checklist_items). It must never be confused with it.
 *
 * Identity: roadmap identity string on every row — here "my-job-agent-job-application".
 * Trading rows have their own identity. The two must never be mixed.
 */
@Entity('job_application_roadmap_items')
@Index(['roadmapIdentity', 'phase', 'itemOrder'])
export class JobApplicationRoadmapItem {
  @PrimaryGeneratedColumn()
  id!: number;

  /** Stable roadmap identity — distinguishes this roadmap from all others. */
  @Column({ type: 'varchar', length: 80, default: 'my-job-agent-job-application' })
  roadmapIdentity!: string;

  /** Phase heading, e.g. "PHASE 0 — FOUNDATION & SAFETY". */
  @Column({ type: 'varchar', length: 160 })
  phase!: string;

  /** Order of the phase (1-based). */
  @Column({ type: 'int' })
  phaseOrder!: number;

  /** One-line goal of the phase, when the source provides one. */
  @Column({ type: 'varchar', length: 300, default: '' })
  goal!: string;

  /** Position of the item inside its phase (1-based). */
  @Column({ type: 'int' })
  itemOrder!: number;

  /** Short stable ID, e.g. "JA-001". */
  @Column({ type: 'varchar', length: 24 })
  itemId!: string;

  /** The checklist text. */
  @Column({ type: 'varchar', length: 600 })
  item!: string;

  /** pending | in_progress | done | blocked */
  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status!: string;

  /** Priority: p0 | p1 | p2 */
  @Column({ type: 'varchar', length: 8, default: 'p1' })
  priority!: string;

  /** Optional user note attached to the item. */
  @Column({ type: 'varchar', length: 500, default: '' })
  note!: string;

  /** v5 detailed edition — implementation instruction for this item. */
  @Column({ type: 'text', nullable: true })
  instr!: string | null;

  /** v5 detailed edition — objective "Done when" condition. */
  @Column({ type: 'text', nullable: true })
  doneWhen!: string | null;

  /** Roadmap edition the item text came from. */
  @Column({ type: 'varchar', length: 8, default: 'v1' })
  edition!: string;

  /** Last commit SHA recorded against this row (trim of hex or short ref). */
  @Column({ type: 'varchar', length: 64, default: '' })
  lastCommitSha!: string;

  /** Timestamp of the last render-verified status write on this row. */
  @Column({ type: 'timestamp', nullable: true })
  lastVerifiedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
