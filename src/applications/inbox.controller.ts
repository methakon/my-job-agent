import { Controller, Get, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { InboxReaderService } from './inbox-reader.service';

@ApiTags('inbox')
@Controller('inbox')
export class InboxController {
	constructor(private readonly inbox: InboxReaderService) {}

	/** FR-12: fetch latest OTP code (optionally for a specific portal). */
	@Get('otp')
	otp(@Query('portal') portal?: string) {
		return this.inbox.readOtp(portal);
	}

	@Post('poll-replies')
	pollReplies() {
		return this.inbox.pollReplies();
	}
}
