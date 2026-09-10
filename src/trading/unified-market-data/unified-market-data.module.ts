import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UnifiedOptionQuote } from './unified-option-quote.entity';
import { UnifiedMarketSnapshot } from './unified-market-snapshot.entity';
import { MarketDataFeedLease } from './market-data-feed-lease.entity';
import { UnifiedMarketDataService } from './unified-market-data.service';
import { FeedHealthService } from './feed-health.service';
import { FeedArbitrationService } from './feed-arbitration.service';
import { MarketDataHealthController } from './market-data-health.controller';

/**
 * Broker-independent common live market-data pipeline (brief s4/s5/s7/s8).
 * Hosted by every process that runs a live feed adapter:
 *  - AppModule (web app, port 3010 — feed can run here when enabled)
 *  - TradingAgentModule (headless feed worker on Dhargent)
 * The health controller is inert in the headless worker (no HTTP server).
 *
 * The store is the ONE place live ticks are normalized and persisted, and the
 * arbiter (market_data_feed_leases) is how producers in DIFFERENT processes
 * agree on which single feed is active per instrument universe.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([UnifiedOptionQuote, UnifiedMarketSnapshot, MarketDataFeedLease]),
  ],
  controllers: [MarketDataHealthController],
  providers: [UnifiedMarketDataService, FeedHealthService, FeedArbitrationService],
  exports: [UnifiedMarketDataService, FeedHealthService, FeedArbitrationService],
})
export class UnifiedMarketDataModule {}
