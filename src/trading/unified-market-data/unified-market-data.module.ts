import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UnifiedOptionQuote } from './unified-option-quote.entity';
import { UnifiedMarketSnapshot } from './unified-market-snapshot.entity';
import { UnifiedOptionQuoteHistory } from './unified-option-quote-history.entity';
import { UnifiedMarketSnapshotHistory } from './unified-market-snapshot-history.entity';
import { MarketDataFeedLease } from './market-data-feed-lease.entity';
import { UnifiedMarketDataService } from './unified-market-data.service';
import { UnifiedArchiveService } from './unified-archive.service';
import { FeedHealthService } from './feed-health.service';
import { FeedArbitrationService } from './feed-arbitration.service';
import { DedicatedLeaseStore, LEASE_STORE } from './lease-connection.store';
import { TickInterpreterService } from './canonical/tick-interpreter.service';
import { MarketDataHealthController } from './market-data-health.controller';
import { PersistenceHealthMachine } from '../../shared/persistence-state';
import { DbHealthService } from '../../shared/db-health.service';

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
 *
 * The arbiter's lease/heartbeat operations run on their OWN dedicated single
 * MySQL connection (LEASE_STORE → DedicatedLeaseStore), so the hot market-data
 * write path on the shared pool can never starve the liveness heartbeat.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([UnifiedOptionQuote, UnifiedMarketSnapshot, UnifiedOptionQuoteHistory, UnifiedMarketSnapshotHistory, MarketDataFeedLease]),
  ],
  controllers: [MarketDataHealthController],
  providers: [
    PersistenceHealthMachine,
    DbHealthService,
    UnifiedMarketDataService,
    UnifiedArchiveService,
    FeedHealthService,
    FeedArbitrationService,
    // One dedicated connection for the arbitration control path only.
    { provide: LEASE_STORE, useFactory: () => new DedicatedLeaseStore() },
    // Deterministic, provider-independent canonical tick interpreter.
    TickInterpreterService,
  ],
  exports: [PersistenceHealthMachine, DbHealthService, UnifiedMarketDataService, UnifiedArchiveService, FeedHealthService, FeedArbitrationService, TickInterpreterService],
})
export class UnifiedMarketDataModule {}
