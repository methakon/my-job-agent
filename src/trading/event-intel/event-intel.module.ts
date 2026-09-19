/**
 * Event Intelligence Module
 *
 * Declares and exports EventOrchestratorService so it can be imported
 * by TradingAgentModule (or any other module) without creating circular
 * dependencies. This module does NOT import any existing trading module.
 *
 * Usage:
 *   @Module({ imports: [EventIntelModule] })
 *   export class TradingAgentModule { … }
 */
import { Module } from '@nestjs/common';
import { EventOrchestratorService } from './event-orchestrator.service';

@Module({
  providers: [EventOrchestratorService],
  exports: [EventOrchestratorService],
})
export class EventIntelModule {}
