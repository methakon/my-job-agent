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
import { ProviderToken } from '../provider-token.entity';
import { ProviderTokenService } from '../provider-token.service';
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
//
// /fnf-trading is now the ONLY paper execution/portfolio system.
// FYERS + Upstox are redundant market-data providers only.
//
// 2026-09-23: ONLY the OAuth token controller is re-registered (the FNF portal
// "GET UPSTOX TOKEN" button + the registered /api/upstox/callback). Token
// persistence and every consumer read go through the unified encrypted
// provider_tokens store (ProviderTokenService) — identical to the FYERS feed's
// token source. The legacy upstox_live_paper_tokens table is historical only.
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
      // Unified provider-token store (provider_tokens) — same table FYERS uses.
      ProviderToken,
    ]),
  ],
  // The token controller is the only HTTP surface this module needs: the FNF
  // portal login button (/api/upstox/login) and Upstox's registered redirect
  // (/api/upstox/callback). Everything else stays retired.
  controllers: [UpstoxLivePaperTokenController],
  providers: [
    // Market-data services (ACTIVE)
    UpstoxLivePaperConfig,
    UpstoxLivePaperMarketService,
    UpstoxLivePaperMarketStabilityService,
    UpstoxLivePaperTokenService,
    ProviderTokenService, // unified encrypted token store (provider_tokens)
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
