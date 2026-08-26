import { Controller, Get, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { LinkedInProfileService } from './linkedin-profile.service';

@ApiTags('linkedin')
@Controller('linkedin')
export class LinkedInController {
	constructor(private readonly service: LinkedInProfileService) {}

	/** Re-extract insights from the saved profile snapshot in data/linkedin/. */
	@Post('refresh')
	refresh() {
		return this.service.refreshFromSnapshot();
	}

	@Get()
	load() {
		return this.service.load();
	}
}
