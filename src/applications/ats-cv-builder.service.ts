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

export interface TailoredCvInput {
	profile: Record<string, string>;
	workHistory: CvWorkStint[];
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

		// Experience — reorder so roles most relevant to the JD come first within recency tiers
		doc.font('Helvetica-Bold').fontSize(11).text('PROFESSIONAL EXPERIENCE');
		const jdText = `${input.jobTitle} ${input.jobDescription ?? ''}`.toLowerCase();
		const scored = input.workHistory.map((w) => ({
			...w,
			score: this.relevance(w.summary ?? '', jdText),
		}));
		// stable sort: keep recency order but boost strongly-relevant older roles to top group
		const sorted = [...scored].sort((a, b) => b.score - a.score);
		const primary = sorted.filter((s) => s.score > 0);
		const secondary = sorted.filter((s) => s.score === 0);
		for (const stint of [...primary, ...secondary]) {
			doc.font('Helvetica-Bold').fontSize(10).text(`${stint.role} — ${stint.company}`);
			doc.font('Helvetica').fontSize(9).fillColor('#444444')
				.text(`${this.fmt(stint.from)} – ${stint.to === 'present' ? 'Present' : this.fmt(stint.to)}`, { continued: false });
			doc.fillColor('#000000').fontSize(10);
			if (stint.summary) doc.text(this.tailorBullets(stint.summary, jdText));
			doc.moveDown(0.4);
		}

		// Education & eligibility
		doc.font('Helvetica-Bold').fontSize(11).text('EDUCATION & CERTIFICATIONS');
		doc.font('Helvetica').fontSize(10);
		doc.text('MCA — T. John College, Bangalore (2005–2008)');
		doc.text('BCA — Dumkal Institute of Engineering & Technology (2002–2005)');
		doc.text('HK-dir verified foreign education (Norway recognition statement available)');
		doc.moveDown(0.3);
		doc.fontSize(8).fillColor('#666666')
			.text(`Tailored for ${input.jobTitle} @ ${input.jobCompany} — generated ${new Date().toISOString().slice(0, 10)}`);
		doc.fillColor('#000000');

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
