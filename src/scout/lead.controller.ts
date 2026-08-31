import { Controller, Get, Post, Body } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ScoutService } from './scout.service';
import { LeadRepository } from '../leads/lead.repository';
import { IsString, IsOptional } from 'class-validator';

export class CreateLeadDto {
	@IsString()
	source!: string;

	@IsString()
	externalId!: string;

	@IsString()
	title!: string;

	@IsString()
	company!: string;

	@IsOptional() @IsString()
	location?: string;

	@IsOptional() @IsString()
	description?: string;

	@IsString()
	url!: string;
}

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

	@Post()
	create(@Body() dto: CreateLeadDto) {
		return this.leadRepo.upsert(dto);
	}

	@Post('scout')
	runNow() {
		return this.scout.runOnce();
	}
}
