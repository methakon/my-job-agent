import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ApplySetting } from './apply-setting.entity';

@Injectable()
export class ApplySettingRepository {
	constructor(
		@InjectRepository(ApplySetting) private readonly repo: Repository<ApplySetting>,
	) {}

	findAll(): Promise<ApplySetting[]> {
		return this.repo.find();
	}

	findBySource(source: string): Promise<ApplySetting | null> {
		return this.repo.findOne({ where: { source } });
	}

	save(setting: ApplySetting): Promise<ApplySetting> {
		return this.repo.save(setting);
	}

	async ensureDefaults(sources: string[]): Promise<void> {
		for (const source of sources) {
			const existing = await this.findBySource(source);
			if (!existing) {
				await this.repo.save(this.repo.create({ source }));
			}
		}
	}
}
