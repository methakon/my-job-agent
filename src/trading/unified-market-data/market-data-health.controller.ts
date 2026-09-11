import { Controller, Get } from '@nestjs/common';
import { FeedHealthService } from './feed-health.service';
import { FeedArbitrationService } from './feed-arbitration.service';
import { TickInterpreterService } from './canonical/tick-interpreter.service';

/**
 * Live market-data health endpoint (brief s6/s8) — web host only
 * (UnifiedMarketDataModule is also hosted by the headless worker, which runs
 * no HTTP server). Reports per-feed state, the per-engine new-trading gate, and
 * the single-active-feed ownership decisions (which feed owns which universe).
 * Never contains credentials or order state.
 */
@Controller('market-data')
export class MarketDataHealthController {
  constructor(
    private readonly feedHealth: FeedHealthService,
    private readonly arbitration: FeedArbitrationService,
    private readonly interpreter: TickInterpreterService,
  ) {}

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

  /** Single-active-feed ownership: owner + standby feeds per instrument universe. */
  @Get('arbitration')
  async arbitrationStatus(): Promise<Record<string, unknown>> {
    return this.arbitration.status();
  }

  /**
   * Canonical pipeline read-out (diagnostic, read-only): what the mandatory
   * interpreter accepted/rejected/persisted/withheld/ignored for this process,
   * by rejection code and source, with measured latency percentiles. There is no
   * mode here — the pipeline is always on — this is the measurement facility the
   * live verification reads (identity, rejection rates, latency).
   */
  @Get('canonical')
  canonical(): Record<string, unknown> {
    return { asOf: new Date().toISOString(), pipeline: 'provider -> adapter -> interpreter -> validation -> canonical persistence -> desks', ...this.interpreter.metrics() };
  }
}
