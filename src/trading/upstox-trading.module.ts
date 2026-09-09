import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UpstoxTradingService } from './upstox-trading.service';
import { UpstoxTradingPageController } from './upstox-trading-page.controller';
import { UpstoxPortfolio, UpstoxTrade } from './upstox-trading.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([UpstoxPortfolio, UpstoxTrade]),
  ],
  controllers: [UpstoxTradingPageController],
  providers: [UpstoxTradingService],
  exports: [UpstoxTradingService],
})
export class UpstoxTradingModule {}