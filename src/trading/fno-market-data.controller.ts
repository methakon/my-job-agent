import { Controller, Get } from '@nestjs/common';
import { FnoMarketDataService } from './fno-market-data.service';

@Controller('trading/market-feed')
export class FnoMarketDataController {
  constructor(private readonly feed: FnoMarketDataService) {}

  @Get('status')
  status() {
    return this.feed.status();
  }
}
