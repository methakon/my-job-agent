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
// ── Phase 1 (single paper portfolio): execution components retired ────────────
// The following services, controllers and cron jobs are no longer registered:
//   ✗ UpstoxLivePaperAutoEntryService  (@Cron autoentry + labelling every 30s)
//   ✗ UpstoxLivePaperRiskService       (per-trade risk checks)
//   ✗ UpstoxLivePaperCapitalContinuityService (capital balance mgmt)
//   ✗ UpstoxLivePaperWeeklyReportService (weekly P&L reports)
//   ✗ UpstoxLivePaperLearningService    (trade reflection)
//   ✗ UpstoxLivePaperScheduledService   (@Cron weekly report generation)
//   ✗ UpstoxLivePaperInstructionService (pre-cleared instructions)
//   ✗ UpstoxLivePaperService            (portfolio/trade/order CRUD)
//   ✗ UpstoxLivePaperController         (REST API)
//   ✗ UpstoxLivePaperTokenController    (OAuth endpoints)
//
// /fnf-trading is now the ONLY paper execution/portfolio system.
// FYERS + Upstox are redundant market-data providers only.
// ──────────────────────────────────────────────────────────────────────────────
import { EncryptionService } from '../../auth/encryption.service';
import { UnifiedMarketDataModule } from '../unified-market-data/unified-market-data.module';

@Module({
  imports: [
    ConfigModule,
    UnifiedMarketDataModule,
    TypeOrmModule.forFeature([
      // All entity registrations kept for market-data tables (upstox_live_paper_option_quotes, etc.)
      // Portfolio/trade/order entities retained for historical data access if needed.
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
  // No controllers — paper execution REST + OAuth endpoints retired.
  controllers: [],
  providers: [
    // Market-data services (ACTIVE)
    UpstoxLivePaperConfig,
    UpstoxLivePaperMarketService,
    UpstoxLivePaperMarketStabilityService,
    UpstoxLivePaperTokenService,
    EncryptionService, // token/credential AES (same convention as FYERS/FNF)
  ],
  exports: [
    // Only market-data services exported — consumed by pre-open, pattern engine (read-only).
    UpstoxLivePaperConfig,
    UpstoxLivePaperMarketService,
    UpstoxLivePaperTokenService,
  ],
})
export class UpstoxLivePaperModule implements OnModuleInit {
  constructor(private readonly config: UpstoxLivePaperConfig) {}

  async onModuleInit(): Promise<void> {
    this.config.logSafetyBlock();
  }
}
