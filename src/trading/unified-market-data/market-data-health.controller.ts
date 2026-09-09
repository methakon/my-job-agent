import { Controller, Get } from '@nestjs/common';
import { FeedHealthService } from './feed-health.service';

/**
 * Live market-data health endpoint (brief s6/s8) — web host only
 * (UnifiedMarketDataModule is also hosted by the headless worker, which runs
 * no HTTP server). Reports per-feed state and the per-engine new-trading gate.
 * Never contains credentials or order state.
 */
@Controller('market-data')
export class MarketDataHealthController {
  constructor(private readonly feedHealth: FeedHealthService) {}

  @Get('health')
  health(): Record<string, unknown> {
    const status = this.feedHealth.status();
    return {
      asOf: status.asOf,
      thresholdsMs: { staleAfterMs: status.staleAfterMs, downAfterMs: status.downAfterMs },
      feeds: status.feeds.map((feed) => ({
        name: feed.name,
        engine: feed.engine,
        enabled: feed.enabled,
        ageMs: feed.ageMs,
      })),
      gates: {
        fnf: this.feedHealth.gateForFnf(),
        'upstox-paper': this.feedHealth.gateFor('upstox-paper'),
      },
    };
  }
}
