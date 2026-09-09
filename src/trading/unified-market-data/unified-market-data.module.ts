import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UnifiedOptionQuote } from './unified-option-quote.entity';
import { UnifiedMarketSnapshot } from './unified-market-snapshot.entity';
import { UnifiedMarketDataService } from './unified-market-data.service';
import { FeedHealthService } from './feed-health.service';
import { MarketDataHealthController } from './market-data-health.controller';

/**
 * Broker-independent common live market-data pipeline (brief s4/s5/s7/s8).
 * Hosted by every process that runs a live feed adapter:
 *  - AppModule (web app, port 3010 — feed can run here when enabled)
 *  - TradingAgentModule (headless feed worker on Dhargent)
 * The health controller is inert in the headless worker (no HTTP server).
 */
@Module({
  imports: [TypeOrmModule.forFeature([UnifiedOptionQuote, UnifiedMarketSnapshot])],
  controllers: [MarketDataHealthController],
  providers: [UnifiedMarketDataService, FeedHealthService],
  exports: [UnifiedMarketDataService, FeedHealthService],
})
export class UnifiedMarketDataModule {}
