import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { TradingAgentModule } from './trading-agent.module';

/**
 * Trading-agent entrypoint (pm2/systemd on Dhargent VM).
 *
 * Keeps the process alive with a heartbeat so the headless agent never
 * exits; FnoMarketDataService engages the feed on module init when env
 * is configured (FNO_MARKET_DATA_ENABLED=true + FYERS_ACCESS_TOKEN set).
 *
 * BOOTSTRAP RESILIENCE (TA-012):
 * If the SSH tunnel (port 3307) is temporarily down at boot, the process
 * retries with exponential backoff instead of crash-looping under PM2.
 * Each retry waits 5s * 2^n (capped at 60s). After BOOTSTRAP_MAX_RETRIES
 * failures (default 10), the process exits so PM2 can restart later.
 */

const BOOTSTRAP_MAX_RETRIES = parseInt(process.env.BOOTSTRAP_MAX_RETRIES || '10', 10);
const BOOTSTRAP_BASE_DELAY_MS = 5_000;
const BOOTSTRAP_MAX_DELAY_MS = 60_000;

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(TradingAgentModule, {
    logger: ['log', 'warn', 'error'],
  });
  app.enableShutdownHooks();
  const logger = new Logger('TradingAgent');
  logger.log('trading-agent up; feed engages per FNO_MARKET_DATA_ENABLED at session open');
  setInterval(() => logger.log(`alive ${new Date().toISOString()}`), 60_000);
}

async function main(): Promise<void> {
  const logger = new Logger('TradingAgent');
  for (let attempt = 1; attempt <= BOOTSTRAP_MAX_RETRIES; attempt++) {
    try {
      await bootstrap();
      return;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt >= BOOTSTRAP_MAX_RETRIES) {
        logger.error(`bootstrap failed after ${BOOTSTRAP_MAX_RETRIES} attempts; exiting: ${msg}`);
        process.exit(1);
      }
      const delay = Math.min(BOOTSTRAP_BASE_DELAY_MS * Math.pow(2, attempt - 1), BOOTSTRAP_MAX_DELAY_MS);
      logger.warn(`bootstrap attempt ${attempt}/${BOOTSTRAP_MAX_RETRIES} failed: ${msg}; retrying in ${delay / 1000}s`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

main();
