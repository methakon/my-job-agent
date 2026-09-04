import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { MarketDataInspectionService } from './market-data-inspection.service';
import { FeatureEngineService } from './feature-engine.service';

@ApiTags('market-data-inspection')
@Controller('trading/market')
export class MarketDataInspectionController {
	constructor(
		private readonly inspection: MarketDataInspectionService,
		private readonly featureEngine: FeatureEngineService,
	) {}

	/** GATE 3: intraday features (VWAP/ATR/ORB/range) for one instrument on a day. */
	@Get('features/:instrument')
	features(@Param('instrument') instrument: string, @Query('day') day?: string) {
		return this.featureEngine.featuresFor(instrument, day || undefined);
	}

	/** GATE 3: instruments with stored snapshots on a day (feature availability). */
	@Get('features')
	async featureInstruments(@Query('day') day: string) {
		if (!day) return { error: 'day required (YYYY-MM-DD IST)' };
		return { day, instruments: await this.featureEngine.instrumentsOn(day) };
	}

	@Get('snapshots')
	snapshots(@Query() query: Record<string, string | undefined>) {
		return this.inspection.find(this.inspection.parseQuery(query));
	}
}
