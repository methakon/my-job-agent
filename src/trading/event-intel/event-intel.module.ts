/**
 * Event Intelligence Module
 *
 * Declares and exports EventOrchestratorService so it can be imported
 * by TradingAgentModule (or any other module) without creating circular
 * dependencies. This module does NOT import any existing trading module.
 *
 * DB-backed: All 5 event-intel entities are registered with TypeORM
 * for repository injection. The orchestrator persists events, versions,
 * predictions, outcomes, and source observations to MySQL.
 *
 * Usage:
 *   @Module({ imports: [EventIntelModule] })
 *   export class TradingAgentModule { … }
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventOrchestratorService } from './event-orchestrator.service';
import { EventIntelEvent } from './entities/event.entity';
import { EventIntelVersion } from './entities/event-version.entity';
import { EventIntelPrediction } from './entities/event-prediction.entity';
import { EventIntelOutcome } from './entities/event-outcome.entity';
import { EventIntelSourceObservation } from './entities/event-source-observation.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      EventIntelEvent,
      EventIntelVersion,
      EventIntelPrediction,
      EventIntelOutcome,
      EventIntelSourceObservation,
    ]),
  ],
  providers: [EventOrchestratorService],
  exports: [EventOrchestratorService],
})
export class EventIntelModule {}
