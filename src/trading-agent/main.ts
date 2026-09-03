import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { TradingAgentModule } from './trading-agent.module';

/**
 * Trading-agent entrypoint (pm2/systemd on Dhargent VM).
 * Keeps the process alive with a heartbeat so the headless agent never
 * exits; FnoMarketDataService engages the feed on module init when env is
 * configured (FNO_MARKET_DATA_ENABLED=true + FYERS_ACCESS_TOKEN set).
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(TradingAgentModule, {
    logger: ['log', 'warn', 'error'],
  });
  app.enableShutdownHooks();
  const logger = new Logger('TradingAgent');
  logger.log('trading-agent up; feed engages per FNO_MARKET_DATA_ENABLED at session open');
  setInterval(() => logger.log(`alive ${new Date().toISOString()}`), 60_000);
}

bootstrap().catch((err: unknown) => {
  console.error('trading-agent fatal:', err);
  process.exit(1);
});
