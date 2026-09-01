import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { MarketDataInspectionService } from './market-data-inspection.service';

@ApiTags('market-data-inspection')
@Controller('trading/market')
export class MarketDataInspectionController {
  constructor(private readonly inspection: MarketDataInspectionService) {}

  @Get('snapshots')
  snapshots(@Query() query: Record<string, string | undefined>) {
    return this.inspection.find(this.inspection.parseQuery(query));
  }
}
