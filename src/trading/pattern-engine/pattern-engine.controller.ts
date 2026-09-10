import { Controller, Get, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PatternEngineService } from './pattern-engine.service';

/**
 * Pattern/learning surfaces (brief s20): the dashboard reads the CURRENT pattern
 * per universe with the reasoning behind it, the stored setups (including the
 * failed ones) and the outcome metrics. It never shows a bare "BUY".
 */
@ApiTags('pattern-engine')
@Controller('trading/pattern')
export class PatternEngineController {
  constructor(private readonly engine: PatternEngineService) {}

  /** Current pattern per universe + component scores + confirmations + WHY. */
  @Get('status')
  status() {
    return this.engine.status();
  }

  /** Recent stored setups. `signalsOnly=true` filters to tradable signals. */
  @Get('signals')
  signals(@Query('limit') limit?: string, @Query('signalsOnly') signalsOnly?: string) {
    const parsed = Number(limit);
    return this.engine.recentSignals(Number.isFinite(parsed) && parsed > 0 ? parsed : 25, /^(1|true|yes)$/i.test(String(signalsOnly ?? '')));
  }

  /** Outcome metrics over stored setups (MFE/MAE, win rate, false breakouts). */
  @Get('metrics')
  metrics(@Query('days') days?: string) {
    const parsed = Number(days);
    return this.engine.metrics(Number.isFinite(parsed) && parsed > 0 ? parsed : 30);
  }

  /** Run a scan now (same work the interval does) — safe: read + record only. */
  @Post('scan')
  async scan(@Query('universe') universe?: string) {
    if (universe) return [await this.engine.scanUniverse(String(universe).trim().toUpperCase())];
    return this.engine.scanAll();
  }

  /** Label pending setups against what actually happened afterwards. */
  @Post('label')
  async label() {
    return { labelled: await this.engine.labelPending(80) };
  }
}
