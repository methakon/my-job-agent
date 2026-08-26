import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsString, IsOptional, Length } from 'class-validator';
import { ApplyEngineService } from './apply-engine.service';
import { AnswerBankService } from './answer-bank.service';
import { EmailTrackerService } from './email-tracker.service';
import { ApplicationRepository } from './application.repository';

export class AnswerSaveDto {
	@IsString() @Length(1, 300)
	question!: string;

	@IsString() @Length(0, 2000)
	answer!: string;
}

@ApiTags('applications')
@Controller('applications')
export class ApplicationController {
	constructor(
		private readonly engine: ApplyEngineService,
		private readonly answers: AnswerBankService,
		private readonly appRepo: ApplicationRepository,
		private readonly emailTracker: EmailTrackerService,
	) {}

	@Get()
	list() {
		return this.appRepo.findRecent(100);
	}

	@Post('apply/:leadId')
	apply(@Param('leadId') leadId: string) {
		return this.engine.applyToLead(leadId);
	}

	/** Detail of one application (for the dashboard's sent-info popover). */
	@Get(':id')
	async detail(@Param('id') id: string) {
		const a = await this.appRepo.findOneById(id);
		if (!a) return null;
		return {
			id: a.id,
			source: a.source,
			status: a.status,
			cvPath: a.cvPath,
			coverLetter: a.coverLetter,
			errorDetail: a.errorDetail,
			missingInfo: a.missingInfoJson ? JSON.parse(a.missingInfoJson) : [],
			retryCount: a.retryCount ?? 0,
			createdAt: a.createdAt,
			updatedAt: a.updatedAt,
		};
	}

	@Post('poll-email')
	pollEmail() {
		return this.emailTracker.poll();
	}

	@Get('status-updates/:applicationId')
	statusUpdates(@Param('applicationId') applicationId: string) {
		return this.emailTracker.listFor(applicationId);
	}

	@Get('answers')
	listAnswers() {
		return this.answers.findAll();
	}

	@Post('answers')
	saveAnswer(@Body() dto: AnswerSaveDto) {
		return this.answers.save(dto.question, dto.answer, 'manual');
	}
}
