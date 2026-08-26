import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, Length, Min } from 'class-validator';
import { ApplySettingRepository } from './apply-setting.repository';
import { ApplyEngineService } from './apply-engine.service';

export class UpdateSettingDto {
	@IsOptional() @IsBoolean()
	autoApplyEnabled?: boolean;

	@IsOptional() @IsInt() @Min(1)
	maxPerDay?: number;

	@IsOptional() @IsInt() @Min(1)
	maxPerPortal?: number;

	@IsOptional() @IsInt() @Min(1)
	minutesBetweenApplies?: number;
}

@ApiTags('settings')
@Controller('settings')
export class SettingsController {
	constructor(
		private readonly settingsRepo: ApplySettingRepository,
		private readonly engine: ApplyEngineService,
	) {}

	@Get()
	async list() {
		await this.engine.ensureSettings();
		return this.settingsRepo.findAll();
	}

	@Post(':source')
	async update(@Param('source') source: string, @Body() dto: UpdateSettingDto) {
		const setting = await this.settingsRepo.findBySource(source);
		if (!setting) return { ok: false, error: 'unknown source' };
		if (dto.autoApplyEnabled !== undefined) setting.autoApplyEnabled = dto.autoApplyEnabled;
		if (dto.maxPerDay !== undefined) setting.maxPerDay = dto.maxPerDay;
		if (dto.maxPerPortal !== undefined) setting.maxPerPortal = dto.maxPerPortal;
		if (dto.minutesBetweenApplies !== undefined) setting.minutesBetweenApplies = dto.minutesBetweenApplies;
		return this.settingsRepo.save(setting);
	}
}
