
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ResearchResult } from './research-result.entity';
import { AdaptationCandidate } from './adaptation-candidate.entity';
import { ValidationResult } from './validation-result.entity';
import { OffHoursResearchService } from './off-hours-research.service';
import { ValidationEngineService } from './validation-engine.service';
import { AdaptationEngineService } from './adaptation-engine.service';
import { UnifiedMarketDataModule } from '../unified-market-data/unified-market-data.module';

/**
 * Research module — off-hours analysis, validation, and adaptation.
 *
 * Depends on UnifiedMarketDataModule for:
 * - HistoricalResearchService (reads from history tables)
 * - HistoricalAnalyticsService (deterministic analytics)
 * - HistoricalContextBuilderService (combines current + historical)
 * - UnifiedMarketDataService (live cache for current state)
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      ResearchResult,
      AdaptationCandidate,
      ValidationResult,
    ]),
    UnifiedMarketDataModule,
  ],
  providers: [
    OffHoursResearchService,
    ValidationEngineService,
    AdaptationEngineService,
  ],
  exports: [
    OffHoursResearchService,
    ValidationEngineService,
    AdaptationEngineService,
  ],
})
export class ResearchModule {}
