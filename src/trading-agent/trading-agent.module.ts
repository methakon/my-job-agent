import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { mysqlConfig } from '../shared/db.config';
import { AstroMuhurtaService } from '../astro/astro-muhurta.service';
import { EncryptionService } from '../auth/encryption.service';
import { ProviderTokenService } from '../trading/provider-token.service';
import { FnfOptionChainService } from '../trading/fnf-option-chain.service';
import { FnfTradingService } from '../trading/fnf-trading.service';
import { FnoMarketDataService } from '../trading/fno-market-data.service';
import { ProviderToken } from '../trading/provider-token.entity';
import { MuhurtaWindow } from '../astro/muhurta-window.entity';
import { FnfPortfolio } from '../trading/fnf-portfolio.entity';
import { FnfTrade } from '../trading/fnf-trade.entity';
import { FnfMarketSnapshot } from '../trading/fnf-market-snapshot.entity';
import { FnfDecayCalibration } from '../trading/fnf-decay-calibration.entity';
import { FnfOptionContract } from '../trading/fnf-option-contract.entity';
import { FnfOptionQuote } from '../trading/fnf-option-quote.entity';
import { FnfMarketSnapshotHistory } from '../trading/fnf-market-snapshot-history.entity';
import { FnfOptionQuoteHistory } from '../trading/fnf-option-quote-history.entity';
import { FnfTradeReflection } from '../trading/fnf-trade-reflection.entity';
import { FnfDecisionJournal } from '../trading/fnf-decision-journal.entity';
import { FnfTradeReport } from '../trading/fnf-trade-report.entity';
import { SandboxTick } from '../trading/sandbox-tick.entity';
import { UpstoxSandboxProvider } from '../trading/upstox-sandbox.provider';
import { UpstoxSandboxIngestionService } from '../trading/upstox-sandbox-ingestion.service';
import { UnifiedMarketDataModule } from '../trading/unified-market-data/unified-market-data.module';
import { ResearchModule } from '../trading/research/research.module';
import { AdaptationCandidate } from '../trading/research/adaptation-candidate.entity';
// import { EventIntelModule } from '../trading/event-intel/event-intel.module';  // DISABLED: memory pressure on 8GB; re-enable after upgrade
import { SessionDriverService } from './session-driver.service';

/**
 * Headless trading agent (runs on the always-on Dhargent VM).
 * Boots exactly the F&O engine stack — no HTTP controllers, no job-agent
 * modules. The market feed (Fyers socket or Yahoo poll) persists real ticks,
 * and SessionDriverService turns them into live paper executions during the
 * IST session (09:15-15:30 Mon-Fri) with self-learning via decay rectification.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        mysqlConfig(config.get<string>('DATABASE_NAME', 'myjob_agent')),
    }),
    TypeOrmModule.forFeature([
      MuhurtaWindow,
      FnfPortfolio,
      FnfTrade,
      FnfMarketSnapshot,
      FnfDecayCalibration,
      FnfOptionContract,
      FnfOptionQuote,
      FnfMarketSnapshotHistory,
      FnfOptionQuoteHistory,
      FnfTradeReflection,
      FnfDecisionJournal,
      FnfTradeReport,
      SandboxTick,
      ProviderToken,
      AdaptationCandidate,
    ]),
    UnifiedMarketDataModule,
    ResearchModule,
    // EventIntelModule,  // DISABLED: memory pressure on 8GB; re-enable after upgrade
  ],
  providers: [
    AstroMuhurtaService,
    FnfOptionChainService,
    FnfTradingService,
    FnoMarketDataService,
    SessionDriverService,
    UpstoxSandboxProvider,
    UpstoxSandboxIngestionService,
    // FYERS token DB store (FnoMarketDataService reads its access token from
    // the single provider_tokens row written by the OAuth callback — not .env).
    ProviderTokenService,
    // Upstox token DB store (reuses provider_tokens table with provider='upstox_sandbox').
    EncryptionService,
  ],
})
export class TradingAgentModule {}
