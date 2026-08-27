import { Injectable } from '@nestjs/common';
import { CandidateProfile } from './candidate-profile.entity';
import { ProfileRepository } from './profile.repository';
import { UpsertProfileDto, ProfileResponseDto } from './profile.dto';

/** Fields required before the agent will submit any application. */
const REQUIRED_FIELDS = ['name', 'email', 'phone', 'skills', 'noticePeriod', 'salaryExpectation', 'currentLocation'] as const;

@Injectable()
export class ProfileService {
	constructor(private readonly profileRepo: ProfileRepository) {}

	async upsert(dto: UpsertProfileDto): Promise<CandidateProfile> {
		let profile = await this.profileRepo.findFirst();
		if (!profile) {
			profile = await this.profileRepo.createPartial({
				name: dto.name ?? '',
			});
		}
		if (dto.name !== undefined) profile.name = dto.name;
		if (dto.email !== undefined) profile.email = dto.email;
		if (dto.phone !== undefined) profile.phone = dto.phone;
		if (dto.skills !== undefined) profile.skills = dto.skills.join(',');
		if (dto.headline !== undefined) profile.headline = dto.headline;
		if (dto.experienceYears !== undefined) profile.experienceYears = Number(dto.experienceYears);
		if (dto.noticePeriod !== undefined) profile.noticePeriod = dto.noticePeriod;
		if (dto.salaryExpectation !== undefined) profile.salaryExpectation = dto.salaryExpectation;
		if (dto.linkedinUrl !== undefined) profile.linkedinUrl = dto.linkedinUrl;
		if (dto.githubUrl !== undefined) profile.githubUrl = dto.githubUrl;
		if (dto.portfolioUrl !== undefined) profile.portfolioUrl = dto.portfolioUrl;
		if (dto.currentLocation !== undefined) profile.currentLocation = dto.currentLocation;
		if (dto.workHistory !== undefined) profile.workHistoryJson = JSON.stringify(dto.workHistory);
		if (dto.education !== undefined) profile.educationJson = JSON.stringify(dto.education);
		if (dto.projects !== undefined) profile.projectsJson = JSON.stringify(dto.projects);
		return this.profileRepo.save(profile);
	}

	async getResponse(): Promise<ProfileResponseDto | null> {
		const p = await this.profileRepo.findFirst();
		if (!p) return null;
		return this.toResponse(p);
	}

	toResponse(p: CandidateProfile): ProfileResponseDto {
		const missing: string[] = [];
		for (const field of REQUIRED_FIELDS) {
			const value = (p as unknown as Record<string, string | null>)[field];
			if (!value || String(value).trim() === '') missing.push(field);
		}
		let workHistory: ProfileResponseDto['workHistory'] = [];
		try {
			workHistory = p.workHistoryJson ? JSON.parse(p.workHistoryJson) : [];
		} catch {
			workHistory = [];
		}
		let education: ProfileResponseDto['education'] = [];
		try {
			education = p.educationJson ? JSON.parse(p.educationJson) : [];
		} catch {
			education = [];
		}
		let projects: ProfileResponseDto['projects'] = [];
		try {
			projects = p.projectsJson ? JSON.parse(p.projectsJson) : [];
		} catch {
			projects = [];
		}
		return {
			id: p.id,
			name: p.name,
			email: p.email,
			phone: p.phone,
			skills: p.skills ? p.skills.split(',').map((s) => s.trim()).filter(Boolean) : [],
			headline: p.headline,
			experienceYears: p.experienceYears,
			noticePeriod: p.noticePeriod,
			salaryExpectation: p.salaryExpectation,
			linkedinUrl: p.linkedinUrl,
			githubUrl: p.githubUrl,
			portfolioUrl: p.portfolioUrl,
			currentLocation: p.currentLocation,
			workHistory,
			education,
			projects,
			missingFields: missing,
		};
	}

	/** Flattened record handed to adapters when filling forms. */
	async flatten(): Promise<Record<string, string>> {
		const p = await this.profileRepo.findFirst();
		if (!p) return {};
		return Object.fromEntries(
			Object.entries(p as unknown as Record<string, unknown>)
				.filter(([k, v]) => typeof v === 'string' || typeof v === 'number')
				.map(([k, v]) => [k, String(v)]),
		);
	}

	/** Set the last-uploaded CV path (LinkedIn easy-apply canonical CV).
	 * Called after the user manually uploads a corrected PDF. */
	async setLastUploadedCv(cvPath: string): Promise<void> {
		const p = await this.profileRepo.findFirst();
		if (!p) return;
		p.lastUploadedCvPath = cvPath;
		await this.profileRepo.save(p);
	}

	/** Get the last-uploaded CV path for LinkedIn easy-apply (may be null). */
	async getLastUploadedCvPath(): Promise<string | null> {
		const p = await this.profileRepo.findFirst();
		return p?.lastUploadedCvPath ?? null;
	}
}
