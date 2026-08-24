import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CandidateProfile } from './candidate-profile.entity';

/** MVCR: all candidate-profile DB access lives here. */
@Injectable()
export class ProfileRepository {
	constructor(
		@InjectRepository(CandidateProfile) private readonly repo: Repository<CandidateProfile>,
	) {}

	findFirst(): Promise<CandidateProfile | null> {
		return this.repo.findOne({ where: {}, order: { updatedAt: 'DESC' } });
	}

	save(profile: CandidateProfile): Promise<CandidateProfile> {
		return this.repo.save(profile);
	}

	createPartial(data: Partial<CandidateProfile>): Promise<CandidateProfile> {
		return this.repo.save(this.repo.create(data));
	}

	async remove(profile: CandidateProfile): Promise<void> {
		await this.repo.remove(profile);
	}
}
