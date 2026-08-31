import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

/** Per-weekday signal-decay calibration for FNF predictions.
 *  One row per weekday (0=Sun … 6=Sat); portfolioId NULL = global default.
 *  Rectified day-wise from actual closed-trade outcomes:
 *  - decayRate: hourly exponential decay of signal confidence
 *  - windowStartHour/windowEndHour: best entry timing window for that weekday */
@Entity('fnf_decay_calibrations')
export class FnfDecayCalibration {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** NULL = global default row; set = portfolio-specific override. */
  @Column({ type: 'varchar', length: 36, nullable: true })
  portfolioId: string | null;

  /** 0=Sunday … 6=Saturday. */
  @Column({ type: 'tinyint' })
  weekday: number;

  /** Hourly exponential decay coefficient (confidence × e^(−rate×hours)). */
  @Column({ type: 'decimal', precision: 8, scale: 5, default: 0.04 })
  decayRate: number;

  /** Best entry window (IST hours, e.g. 9.5 = 09:30). */
  @Column({ type: 'decimal', precision: 5, scale: 2, default: 9.5 })
  windowStartHour: number;

  @Column({ type: 'decimal', precision: 5, scale: 2, default: 15.25 })
  windowEndHour: number;

  /** Closed trades consumed by the last rectification. */
  @Column({ type: 'int', default: 0 })
  samples: number;

  @Column({ type: 'datetime', nullable: true })
  lastRectifiedAt: Date;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
