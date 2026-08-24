import { Controller, Get, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { InterviewPrepService } from './interview-prep.service';

@ApiTags('interview-prep')
@Controller('interview-prep')
export class InterviewPrepController {
	constructor(private readonly prep: InterviewPrepService) {}

	@Get()
	list() {
		return this.prep.listAll();
	}

	@Get('for-lead/:leadId')
	practice(@Param('leadId') leadId: string) {
		return this.prep.practiceForLead(leadId);
	}
}
