import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { mysqlConfig } from '../shared/db.config';

import { MuhurtaWindow } from '../astro/muhurta-window.entity';
import { FnfPortfolio } from '../trading/fnf-portfolio.entity';
import { FnfTrade } from '../trading/fnf-trade.entity';
import { FnfMarketSnapshot } from '../trading/fnf-market-snapshot.entity';
import { FnfDecayCalibration } from '../trading/fnf-decay-calibration.entity';
import { FnfOptionContract } from '../trading/fnf-option-contract.entity';
import { FnfOptionQuote } from '../trading/fnf-option-quote.entity';

import { AstroMuhurtaService } from '../astro/astro-muhurta.service';
import { FnfOptionChainService } from '../trading/fnf-option-chain.service';
import { FnfTradingService } from '../trading/fnf-trading.service';
import { FnoMarketDataService } from '../trading/fno-market-data.service';

/**
 * Headless trading agent (runs on the always-on Dhargent VM).
 * Boots exactly the F&O engine stack — no HTTP controllers, no job-agent
 * modules. Market feed engages per FNO_MARKET_DATA_ENABLED /
 * FYERS_ACCESS_TOKEN at the next session open.
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
    ]),
  ],
  providers: [
    AstroMuhurtaService,
    FnfOptionChainService,
    FnfTradingService,
    FnoMarketDataService,
  ],
})
export class TradingAgentModule {}
