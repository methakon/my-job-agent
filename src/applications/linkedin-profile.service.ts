import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

/**
 * LinkedInProfileService — LinkedIn blocks scraping, so the user saves their
 * profile once (HTML or PDF export) into `data/linkedin/`. This service
 * caches extracted keyword data (headline, about, skills, recent roles) from
 * that snapshot and merges it into CV tailoring:
 *   - ADD keywords present on LinkedIn but missing from the base skill list
 *   - REMOVE base keywords that contradict/stale vs LinkedIn
 */
export interface LinkedInInsights {
	headline?: string;
	about?: string;
	skills: string[];
	recentRoles: Array<{ title: string; company: string; period?: string }>;
	extractedAt: string;
	sourceFile: string;
}

const LINKEDIN_DIR = path.join(process.cwd(), 'data', 'linkedin');
const CACHE_FILE = path.join(LINKEDIN_DIR, 'insights.json');

@Injectable()
export class LinkedInProfileService {
	private readonly logger = new Logger(LinkedInProfileService.name);

	/** Extract insights from a saved profile snapshot; cache to JSON. */
	refreshFromSnapshot(): { ok: boolean; insights?: LinkedInInsights; error?: string } {
		if (!fs.existsSync(LINKEDIN_DIR)) {
			return { ok: false, error: `no snapshot dir at ${LINKEDIN_DIR} — save your LinkedIn profile HTML there first` };
		}
		const files = fs.readdirSync(LINKEDIN_DIR).filter((f) => f.endsWith('.html') || f.endsWith('.htm'));
		if (files.length === 0) return { ok: false, error: 'no .html snapshot in data/linkedin/' };

		const html = fs.readFileSync(path.join(LINKEDIN_DIR, files[0]), 'utf8').replace(/<[^>]+>/g, '\n');
		const text = html.replace(/\n{2,}/g, '\n');

		const headline = text.match(/(?:^|\n)([^\n]{10,120})\n/) ?. [1]?.trim();
		const aboutMatch = text.match(/About\n([\s\S]{50,1500}?)(?:\nExperience|\nLicenses|\nEducation|\nSkills)/);
		const skillsMatch = text.match(/Top Skills([\s\S]{0,800}?)(?:\nExperiences?\n|\nEducation\n|$)/i);

		const knownSkillDict = [
			'node.js', 'nestjs', 'typescript', 'javascript', 'mysql', 'oracle', 'redis', 'graphql',
			'rest apis', 'microservices', 'docker', 'aws', 'jwt', 'oauth', 'typeorm', 'laravel',
			'php', 'codeigniter', 'vue.js', 'team leadership', 'code review', 'sql tuning',
			'konnektive', 'rbac', 'html', 'css', 'jquery', 'git', 'agile', 'scrum',
		];
		const lower = text.toLowerCase();
		const skills = knownSkillDict.filter((s) => lower.includes(s));

		const recentRoles: LinkedInInsights['recentRoles'] = [];
		const roleRe = /([A-Za-z].{3,60})\n([A-Za-z].{2,60}(?:Pvt\.? Ltd\.?|Ltd\.?|LLC|Inc\.?|Group|Solutions|Technologies)[^\n]*)\n/gm;
		let m: RegExpExecArray | null;
		while ((m = roleRe.exec(text)) && recentRoles.length < 6) {
			recentRoles.push({ title: m[1].trim(), company: m[2].trim() });
		}

		const insights: LinkedInInsights = {
			headline,
			about: aboutMatch?.[1]?.trim(),
			skills: [...new Set(skills)],
			recentRoles,
			extractedAt: new Date().toISOString(),
			sourceFile: files[0],
		};
		fs.writeFileSync(CACHE_FILE, JSON.stringify(insights, null, 2));
		this.logger.log(`LinkedIn insights refreshed from ${files[0]} (${insights.skills.length} skills)`);
		return { ok: true, insights };
	}

	/** Load cached insights, if any. */
	load(): LinkedInInsights | null {
		if (!fs.existsSync(CACHE_FILE)) return null;
		try {
			return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
		} catch {
			return null;
		}
	}

	/**
	 * Merge LinkedIn insights into the CV input: add LinkedIn-only keywords
	 * when they appear in the JD, drop base skills absent from both.
	 */
	tuneSkills(baseSkills: string[], matchedSkills: string[], jdText: string): { add: string[]; remove: string[]; finalMatched: string[] } {
		const li = this.load();
		if (!li) return { add: [], remove: [], finalMatched: matchedSkills };
		const jdLower = jdText.toLowerCase();
		const add = li.skills.filter(
			(s) => !baseSkills.includes(s) && !matchedSkills.includes(s) && jdLower.includes(s.toLowerCase()),
		);
		// remove: base matched skills that LinkedIn never mentions AND JD barely needs — keep JD-driven ones anyway
		const liLower = li.skills.map((s) => s.toLowerCase());
		const remove = matchedSkills.filter((s) => !liLower.includes(s.toLowerCase()) && !jdLower.includes(s.toLowerCase()));
		return { add, remove, finalMatched: matchedSkills.filter((s) => !remove.includes(s)).concat(add) };
	}
}
