import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { LearningWeightsService } from './learning-weights.service';

@ApiTags('learning')
@Controller('learning')
export class LearningController {
	constructor(private readonly service: LearningWeightsService) {}

	/** FR-11 aggregated stats: channel/portal success rates, best hour, top keywords. */
	@Get('stats')
	stats() {
		return this.service.stats();
	}

	@Get('best-channel')
	bestChannel() {
		return this.service.bestChannel();
	}
}
