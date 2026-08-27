import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
// pdfkit ships as a callable function with .constructor typing quirks —
// use the documented require pattern.
const PDFDocument: any = require('pdfkit');

export interface CvWorkStint {
	company: string;
	role: string;
	from: string;
	to: string;
	summary?: string;
}

export interface CvEducation {
	school: string;
	degree: string;
	from: string;
	to: string;
	note?: string;
}

export interface TailoredCvInput {
	profile: Record<string, string>;
	workHistory: CvWorkStint[];
	/** Education history — rendered ALL, descending by start then end date. */
	education?: CvEducation[];
	/** Skills present in THIS job description — ordered by relevance. */
	matchedSkills: string[];
	/** Full skill list (rest, listed after matched). */
	allSkills: string[];
	jobTitle: string;
	jobCompany: string;
	jobDescription?: string | null;
}

/**
 * AtsCvBuilder — rewrites the CV per job description and renders an
 * ATS-friendly PDF (single column, standard headings, no tables/graphics):
 *  - professional summary re-worded to mirror the job title/company
 *  - skills section lists job-matching skills first
 *  - work bullets emphasise experience relevant to the posting keywords
 *  - same-company designation changes merged; short stints already hidden upstream
 */
@Injectable()
export class AtsCvBuilder {
	private readonly logger = new Logger(AtsCvBuilder.name);

	async build(input: TailoredCvInput): Promise<string> {
		const dir = path.join(process.cwd(), 'generated', 'cv');
		fs.mkdirSync(dir, { recursive: true });
		const safe = `${input.jobCompany}-${input.jobTitle}`.replace(/[^a-z0-9]+/gi, '_').slice(0, 60);
		const filePath = path.join(dir, `Swarna_Sekhar_Dhar_${safe}.pdf`);

		const doc = new PDFDocument({ size: 'A4', margins: { top: 40, bottom: 40, left: 48, right: 48 } });
		doc.pipe(fs.createWriteStream(filePath));

		const p = input.profile;

		// Header
		doc.font('Helvetica-Bold').fontSize(18).text(String(p.name ?? ''), { align: 'left' });
		doc.moveDown(0.2);
		doc.font('Helvetica').fontSize(10)
			.text(`${p.headline ?? ''}`)
			.text(`${p.email ?? ''} | ${p.phone ?? ''} | ${p.currentLocation ?? ''}${p.linkedinUrl ? ' | ' + p.linkedinUrl : ''}`);
		doc.moveDown(0.6);

		// Professional summary tailored to the posting
		doc.font('Helvetica-Bold').fontSize(11).text('PROFESSIONAL SUMMARY');
		doc.font('Helvetica').fontSize(10);
		const years = Math.round(Number(p.experienceYears ?? 16));
		doc.text(
			`Backend-focused Software Engineer with ${years}+ years designing and operating production systems ` +
			`in ${input.matchedSkills.slice(0, 4).join(', ') || 'Node.js, TypeScript and MySQL'}. ` +
			`Applying for the ${input.jobTitle} role at ${input.jobCompany}: recent work includes leading a ` +
			`Laravel-to-NestJS modernization and running high-availability MySQL/Oracle services. ` +
			`Notice period: ${p.noticePeriod ?? 'negotiable'}.`,
		);
		doc.moveDown(0.5);

		// Skills — matched first
		doc.font('Helvetica-Bold').fontSize(11).text('TECHNICAL SKILLS');
		doc.font('Helvetica').fontSize(10);
		const rest = input.allSkills.filter((s) => !input.matchedSkills.includes(s));
		doc.text([...input.matchedSkills, ...rest].join(' • '));
		doc.moveDown(0.5);

		// Experience — STRICTLY descending by start (join) date, then end (leave)
		// date. User rule 2026-08-27: chronological order only; never reorder by
		// JD relevance (that produced the "random" arrangement users complained of).
		doc.font('Helvetica-Bold').fontSize(11).text('PROFESSIONAL EXPERIENCE');
		const jdText = `${input.jobTitle} ${input.jobDescription ?? ''}`.toLowerCase();
		const sorted = [...input.workHistory].sort((a, b) => {
			const byFrom = b.from.localeCompare(a.from);
			if (byFrom !== 0) return byFrom;
			const aTo = a.to === 'present' ? '9999-99' : a.to;
			const bTo = b.to === 'present' ? '9999-99' : b.to;
			return bTo.localeCompare(aTo);
		});
		for (const stint of sorted) {
			doc.font('Helvetica-Bold').fontSize(10).text(`${stint.role} — ${stint.company}`);
			doc.font('Helvetica').fontSize(9).fillColor('#444444')
				.text(`${this.fmt(stint.from)} – ${stint.to === 'present' ? 'Present' : this.fmt(stint.to)}`, { continued: false });
			doc.fillColor('#000000').fontSize(10);
			if (stint.summary) doc.text(this.tailorBullets(stint.summary, jdText));
			doc.moveDown(0.4);
		}

		// Education & eligibility — same rules as experience (FR-23): ALL entries
		// kept, strictly descending by start then end date, never relevance-ordered.
		doc.font('Helvetica-Bold').fontSize(11).text('EDUCATION & CERTIFICATIONS');
		doc.font('Helvetica').fontSize(10);
		const education = [...(input.education ?? [])].sort((a, b) => {
			const byFrom = b.from.localeCompare(a.from);
			if (byFrom !== 0) return byFrom;
			return b.to.localeCompare(a.to);
		});
		if (education.length === 0) {
			// fallback (profile not yet populated): keep the known history visible
			doc.text('MCA — T. John College, Bangalore (2005–2008)');
			doc.text('BCA — Dumkal Institute of Engineering & Technology (2002–2005)');
		}
		for (const edu of education) {
			const yrs = edu.to && edu.to !== 'present' ? `${edu.from}–${edu.to}` : `${edu.from}–present`;
			const label = [edu.degree, edu.school].filter(Boolean).join(' — ');
			doc.text(`${label} (${yrs})${edu.note ? ` — ${edu.note}` : ''}`);
		}
		doc.text('HK-dir verified foreign education (Norway recognition statement available)');
		// user rule: no "Tailored for…" watermark line on the CV

		await new Promise<void>((resolve) => {
			doc.on('end', () => resolve());
			doc.end();
		});
		this.logger.log(`ATS CV generated: ${filePath}`);
		return filePath;
	}

	private relevance(summary: string, jdText: string): number {
		if (!jdText.trim() || !summary) return 0;
		const words = summary.toLowerCase().match(/[a-z+#.]{3,}/g) ?? [];
		return words.filter((w) => jdText.includes(w)).length;
	}

	/** Rewrite a stint summary into 2-3 ATS bullet sentences emphasising JD keywords. */
	private tailorBullets(summary: string, jdText: string): string {
		const sentences = summary.split(/;\s*/).filter(Boolean);
		const ranked = [...sentences].sort((a, b) => {
			const scoreOf = (s: string): number => (s.toLowerCase().match(/[a-z+#.]{3,}/g) ?? []).filter((w) => jdText.includes(w)).length;
			return scoreOf(b) - scoreOf(a);
		});
		return '• ' + ranked.slice(0, 3).map((s) => s.trim()).join('\n• ');
	}

	private fmt(ym: string): string {
		const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
		const [y, m] = ym.split('-');
		const idx = Number(m) - 1;
		return `${months[idx] ?? m} ${y}`;
	}
}
