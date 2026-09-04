import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/** J-10 — regional CV/resume conventions database (researched 2026-09-05).
 *  One row per country / region / global class. Drives per-market CV framing:
 *  photo/DOB/nationality policy, date format, length, paper, language, and the
 *  lines that must (or must not) appear for that destination. */
@Entity('cv_region_formats')
@Index('idx_cvr_region', ['region'])
export class CvRegionFormat {
	@PrimaryGeneratedColumn('uuid')
	id!: string;

	/** Country or class name, e.g. 'United States', 'Norway', 'Global remote / startup'. */
	@Column({ type: 'varchar', length: 80 })
	country!: string;

	/** Region, e.g. 'North America', 'Europe', 'Middle East', 'Asia'. */
	@Column({ type: 'varchar', length: 40 })
	region!: string;

	/** Continent / market class: 'Americas', 'Europe', 'Asia', 'Middle East',
	 *  'Oceania', 'Africa', 'LATAM', 'Global'. */
	@Column({ type: 'varchar', length: 20 })
	continent!: string;

	/** Local document name: resume / CV / Lebenslauf / rirekisho / jianli. */
	@Column({ type: 'varchar', length: 40 })
	docName!: string;

	/** photo policy: expected | common | discouraged | no */
	@Column({ type: 'varchar', length: 16 })
	photo!: string;

	/** personal-details policy: expected | common | discouraged | no
	 *  (date of birth, nationality, marital status, gender). */
	@Column({ type: 'varchar', length: 16 })
	personalDetails!: string;

	/** date convention, e.g. 'Month YYYY', 'MM.YYYY', 'DD.MM.YYYY'. */
	@Column({ type: 'varchar', length: 40 })
	dateFormat!: string;

	/** typical length in pages, e.g. '1-2', '2-3'. */
	@Column({ type: 'varchar', length: 24 })
	lengthPages!: string;

	/** paper size: 'US Letter' | 'A4'. */
	@Column({ type: 'varchar', length: 24 })
	paperSize!: string;

	/** language expectation for the CV document. */
	@Column({ type: 'varchar', length: 80 })
	language!: string;

	/** notice-period / CTC relevance (India-style fields): expected | forms-only | no. */
	@Column({ type: 'varchar', length: 16, default: 'no' })
	noticeCtc!: string;

	/** nationality / visa-status line: expected | useful | no */
	@Column({ type: 'varchar', length: 16, default: 'no' })
	visaNationalityLine!: string;

	/** free-text local conventions + gotchas. */
	@Column({ type: 'text' })
	notes!: string;

	/** semicolon-separated source URLs backing this row. */
	@Column({ type: 'text' })
	sources!: string;

	@CreateDateColumn()
	createdAt!: Date;

	@UpdateDateColumn()
	updatedAt!: Date;
}
