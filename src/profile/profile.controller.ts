import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ProfileService } from './profile.service';
import { UpsertProfileDto, ProfileResponseDto } from './profile.dto';
import { ProfileOptimizer } from './profile-optimizer.service';

@ApiTags('profile')
@Controller('profile')
export class ProfileController {
	constructor(
		private readonly profileService: ProfileService,
		private readonly optimizer: ProfileOptimizer,
	) {}

	@Get()
	get(): Promise<ProfileResponseDto | null> {
		return this.profileService.getResponse();
	}

	@Get('optimized')
	optimized() {
		return this.optimizer.optimize();
	}

	@Put()
	upsert(@Body() dto: UpsertProfileDto): Promise<ProfileResponseDto | null> {
		return this.profileService.upsert(dto).then(() => this.profileService.getResponse());
	}

	@Get('linkedin/cv')
	getLinkedInCv() {
		return this.profileService.getLastUploadedCvPath();
	}

	@Put('linkedin/cv')
	setLinkedInCv(@Body() body: { cvPath: string }) {
		return this.profileService.setLastUploadedCv(body.cvPath);
	}
}
