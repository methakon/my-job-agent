import { Module, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { UpstoxLivePaperConfig } from './upstox-live-paper.config';
import {
  UpstoxLivePaperPortfolio,
  UpstoxLivePaperTrade,
  UpstoxLivePaperOrder,
  UpstoxLivePaperPosition,
  UpstoxLivePaperPnlEvent,
  UpstoxLivePaperOptionQuote,
  UpstoxLivePaperMarketSnapshot,
  UpstoxLivePaperWeeklyReport,
  UpstoxLivePaperToken,
  UpstoxLivePaperInstruction,
  UpstoxLivePaperSession,
  UpstoxLivePaperCandidate,
} from './upstox-live-paper-entities';
import { UpstoxLivePaperMarketService } from './upstox-live-paper-market.service';
import { UpstoxLivePaperMarketStabilityService } from './upstox-live-paper-market-stability.service';
import { UpstoxLivePaperTokenService } from './upstox-live-paper-auth.service';
import { UpstoxLivePaperTokenController } from './upstox-live-paper-token.controller';
import { UpstoxLivePaperScheduledService } from './upstox-live-paper-scheduled.service';
import { UpstoxLivePaperInstructionService } from './upstox-live-paper-instruction.service';
import { UpstoxLivePaperService } from './upstox-live-paper.service';
import { UpstoxLivePaperWeeklyReportService } from './upstox-live-paper-weekly-report.service';
import { UpstoxLivePaperRiskService } from './upstox-live-paper-risk.service';
import { UpstoxLivePaperLearningService } from './upstox-live-paper-learning.service';
import { UpstoxLivePaperAutoEntryService } from './upstox-live-paper-autoentry.service';
import { UpstoxLivePaperCapitalContinuityService } from './upstox-live-paper-capital-continuity.service';
import { UpstoxLivePaperController } from './upstox-live-paper.controller';
import { EncryptionService } from '../../auth/encryption.service';
import { UnifiedMarketDataModule } from '../unified-market-data/unified-market-data.module';

@Module({
  imports: [
    ConfigModule,
    UnifiedMarketDataModule,
    TypeOrmModule.forFeature([
      UpstoxLivePaperPortfolio,
      UpstoxLivePaperTrade,
      UpstoxLivePaperOrder,
      UpstoxLivePaperPosition,
      UpstoxLivePaperPnlEvent,
      UpstoxLivePaperOptionQuote,
      UpstoxLivePaperMarketSnapshot,
      UpstoxLivePaperWeeklyReport,
      UpstoxLivePaperToken,
      UpstoxLivePaperInstruction,
      UpstoxLivePaperSession,
      UpstoxLivePaperCandidate,
    ]),
  ],
  controllers: [UpstoxLivePaperTokenController, UpstoxLivePaperController],
  providers: [
    UpstoxLivePaperConfig,
    UpstoxLivePaperMarketService,
    UpstoxLivePaperMarketStabilityService,
    UpstoxLivePaperTokenService,
    UpstoxLivePaperScheduledService,
    UpstoxLivePaperInstructionService,
    UpstoxLivePaperService,
    UpstoxLivePaperWeeklyReportService,
    UpstoxLivePaperRiskService,
    UpstoxLivePaperLearningService,
    UpstoxLivePaperAutoEntryService,
    UpstoxLivePaperCapitalContinuityService,
    EncryptionService, // token/credential AES (same convention as FYERS/fnF)
  ],
  exports: [
    UpstoxLivePaperConfig,
    UpstoxLivePaperMarketService,
    UpstoxLivePaperTokenService,
    UpstoxLivePaperService,
    UpstoxLivePaperInstructionService,
    UpstoxLivePaperRiskService,
    UpstoxLivePaperLearningService,
    UpstoxLivePaperAutoEntryService,
    UpstoxLivePaperCapitalContinuityService,
  ],
})
export class UpstoxLivePaperModule implements OnModuleInit {
  constructor(private readonly config: UpstoxLivePaperConfig) {}

  async onModuleInit(): Promise<void> {
    this.config.logSafetyBlock();
  }
}
