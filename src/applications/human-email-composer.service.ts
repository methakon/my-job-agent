import { Injectable } from '@nestjs/common';
import { ScrapedLead } from './portal-adapter.interface';

export interface HumanEmail {
	subject: string;
	bodyHtml: string;
}

/**
 * HumanEmailComposer — writes application emails that read like a real
 * person wrote them: short, specific, references the actual job, no
 * "Dear Sir/Madam" boilerplate or corporate filler.
 *
 * Varies openings and structure between applications so two emails to the
 * same company never look identical.
 */
@Injectable()
export class HumanEmailComposer {
	private static readonly OPENERS = [
		(lead: ScrapedLead): string =>
			`Hi, I saw your ${lead.title} opening on ${lead.source === 'remoteok' ? 'RemoteOK' : 'Remotive'} and it lines up well with what I've been doing the last few years.`,
		(lead: ScrapedLead): string =>
			`Hello — your ${lead.title} role caught my attention. I've spent 16+ years building backend systems, much of it with the exact stack you're using.`,
		(_lead: ScrapedLead): string =>
			`Hi there, I'm a backend engineer looking for my next challenge, and your posting reads like it was written for me.`,
	];

	private static readonly CLOSERS = [
		(): string => `My CV is attached. Happy to do a call whenever suits you — I can make myself available at short notice.`,
		(): string => `I've attached my CV. If it looks like a fit, I'd love to talk — even an informal chat works.`,
		(): string => `CV attached. Let me know if you'd like anything else from me in the meantime.`,
	];

	compose(
		lead: ScrapedLead,
		profile: Record<string, string>,
		matchedSkills: string[],
		variantSeed = Math.floor(Math.random() * 3),
	): HumanEmail {
		const name = profile.name ?? 'Swarna Sekhar Dhar';
		const skillsLine = this.skillsSentence(matchedSkills, lead);
		const opener = HumanEmailComposer.OPENERS[variantSeed % HumanEmailComposer.OPENERS.length](lead);
		const closer = HumanEmailComposer.CLOSERS[(variantSeed + 1) % HumanEmailComposer.CLOSERS.length]();

		const body = [
			opener,
			'',
			skillsLine,
			'',
			closer,
			'',
			'Thanks,',
			name,
			profile.phone ? profile.phone : '',
			profile.email || '',
			profile.linkedinUrl || '',
		].filter((l) => l !== undefined).join('\n');

		const subject = `${lead.title} — ${name.split(' ')[0]} ${name.split(' ').slice(-1)}`;

		return { subject: this.dedupeSubject(subject), bodyHtml: body };
	}

	private skillsSentence(skills: string[], lead: ScrapedLead): string {
		if (skills.length >= 2) {
			const head = skills.slice(0, -1).join(', ');
			const tail = skills[skills.length - 1];
			return `Most of my recent work is ${lead.company.includes('Technolog') || lead.company.includes('Solutions') || lead.company.includes('Labs') ? 'with' : 'in'} ${head} and ${tail} — including leading a backend team through a Laravel-to-NestJS migration and running MySQL/Oracle systems in production.`;
		}
		return `Most of my recent work has been Node.js/NestJS microservices with MySQL — including leading a backend team through a Laravel-to-NestJS migration.`;
	}

	private dedupeSubject(subject: string): string {
		return subject.replace(/\s+/g, ' ').trim().slice(0, 120);
	}
}
