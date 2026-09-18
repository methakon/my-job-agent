import { Controller, Get, Post, Param, Body, HttpCode } from '@nestjs/common';
import { BypassAuth } from '../auth/bypass-auth.decorator';
import { TradingRoadmapService, ProjectStatusResponse } from './trading-roadmap.service';

/**
 * Public-facing Trading Agent project status endpoint.
 *
 * GET /trading-status — public, no auth required.
 * POST /trading-status/seed — protected, seeds roadmap items.
 * POST /trading-status/item/:id — protected, updates item status.
 *
 * Never exposes tokens, keys, credentials, or PII.
 */
@Controller('trading-status')
export class TradingStatusController {
  constructor(private readonly roadmap: TradingRoadmapService) {}

  /**
   * Public read-only project status.
   * Returns roadmap items, summary, provider health, deployment info.
   * No authentication required.
   */
  @Get()
  @BypassAuth()
  async getStatus(): Promise<ProjectStatusResponse> {
    return this.roadmap.getProjectStatus();
  }

  /**
   * Seed the roadmap with initial items. Idempotent.
   * Requires authentication.
   */
  @Post('seed')
  @HttpCode(200)
  async seed() {
    const result = await this.roadmap.seedRoadmap();
    return { ok: true, ...result };
  }

  /**
   * Update a roadmap item's status and note.
   * Requires authentication.
   */
  @Post('item/:id')
  @HttpCode(200)
  async updateItem(
    @Param('id') id: string,
    @Body() body: { status?: string; note?: string },
  ) {
    if (!body.status) {
      return { ok: false, error: 'status is required' };
    }
    const valid = ['pending', 'in_progress', 'done', 'blocked'];
    if (!valid.includes(body.status)) {
      return { ok: false, error: `status must be one of: ${valid.join(', ')}` };
    }
    const item = await this.roadmap.updateItem(id, body.status, body.note);
    if (!item) {
      return { ok: false, error: `item ${id} not found` };
    }
    return { ok: true, item: { id, status: item.status, note: item.note } };
  }
}
