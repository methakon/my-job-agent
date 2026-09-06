import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiModule } from '../ai/ai.module';
import { FnfDecisionJournal } from './fnf-decision-journal.entity';
import { FnfPortfolio } from './fnf-portfolio.entity';
import { FnfTradingService } from './fnf-trading.service';
import { AiTradingDecisionService } from './trading-ai.service';
import { TradingDecisionOrchestrator } from './trading-ai-orchestrator.service';

/**
 * Shopping AI module - provides AI assessment for trading decisions.
 * 
 * SHADOW MODE: AI assessment runs alongside deterministic engine
 * but NEVER influences BUY/SELL/HOLD decisions.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([FnfDecisionJournal, FnfPortfolio]),
    AiModule,
  ],
  providers: [
   AiTradingDecisionService,
    TradingDecisionOrchestrator,
  ],
  exports: [
    AiTradingDecisionService,
    TradingDecisionOrchestrator,
  ],
})
export class TradingAiModule {}
