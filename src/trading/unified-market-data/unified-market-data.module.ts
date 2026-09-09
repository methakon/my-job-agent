import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UnifiedOptionQuote } from './unified-option-quote.entity';
import { UnifiedMarketSnapshot } from './unified-market-snapshot.entity';
import { UnifiedMarketDataService } from './unified-market-data.service';

/**
 * Broker-independent common live market-data pipeline (brief s4/s5/s7).
 * Hosted by every process that runs a live feed adapter:
 *  - AppModule (web app, port 3010 — feed can run here when enabled)
 *  - TradingAgentModule (headless feed worker on Dhargent)
 * No controllers yet; Phase 3 adds the feed-health status endpoint.
 */
@Module({
  imports: [TypeOrmModule.forFeature([UnifiedOptionQuote, UnifiedMarketSnapshot])],
  providers: [UnifiedMarketDataService],
  exports: [UnifiedMarketDataService],
})
export class UnifiedMarketDataModule {}
