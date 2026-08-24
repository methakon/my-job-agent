import { Controller, Get, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ScoutService } from './scout.service';
import { LeadRepository } from '../leads/lead.repository';

@ApiTags('leads')
@Controller('leads')
export class LeadController {
	constructor(
		private readonly scout: ScoutService,
		private readonly leadRepo: LeadRepository,
	) {}

	@Get()
	list() {
		return this.leadRepo.findRecent(100);
	}

	@Post('scout')
	runNow() {
		return this.scout.runOnce();
	}
}
