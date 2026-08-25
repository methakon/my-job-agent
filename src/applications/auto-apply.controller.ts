import { Controller, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AutoApplyLoopService } from './auto-apply-loop.service';

@ApiTags('auto-apply')
@Controller('auto-apply')
export class AutoApplyController {
	constructor(private readonly loop: AutoApplyLoopService) {}

	@Post('run')
	run() {
		return this.loop.runOnce();
	}
}
