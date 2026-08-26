import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

/**
 * MuhurtaWindow — one computed shubh (auspicious) window snapshot.
 * Written by AstroMuhurtaService whenever windows are computed; the latest
 * set is served by GET /astro/muhurta and referenced by pre-apply items.
 */
@Entity('muhurta_windows')
export class MuhurtaWindow {
	@PrimaryGeneratedColumn('uuid')
	id!: string;

	/** ISO start of the auspicious window (UTC). */
	@Column({ type: 'datetime' })
	@Index('idx_muh_start')
	startsAt!: Date;

	/** ISO end of the auspicious window (UTC). */
	@Column({ type: 'datetime' })
	endsAt!: Date;

	/** 0–100 muhurta score for this window. */
	@Column({ type: 'decimal', precision: 5, scale: 2, default: 0 })
	score!: number;

	/** tithi number 1–30 (panchanga, sidereal). */
	@Column({ type: 'int', nullable: true })
	tithi!: number | null;

	/** nakshatra name (sidereal, 27). */
	@Column({ type: 'varchar', length: 30, nullable: true })
	nakshatra!: string | null;

	/** weekday name at window start (IST). */
	@Column({ type: 'varchar', length: 12, nullable: true })
	weekday!: string | null;

	/** comma-joined reason strings, e.g. "tithi 5 shukla, nak Rohini". */
	@Column({ type: 'text', nullable: true })
	reasonsJson!: string | null;

	@CreateDateColumn({ name: 'created_at' })
	createdAt!: Date;
}
