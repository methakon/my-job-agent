import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { UpstoxLivePaperService } from './upstox-live-paper.service';
import { UpstoxLivePaperMarketStabilityService } from './upstox-live-paper-market-stability.service';
import { UpstoxLivePaperWeeklyReportService } from './upstox-live-paper-weekly-report.service';
import { UpstoxLivePaperTokenService } from './upstox-live-paper-auth.service';
import {
  CreateUpstoxLivePaperInstructionDto,
  UpstoxLivePaperInstructionService,
} from './upstox-live-paper-instruction.service';
import {
  CreateUpstoxLivePaperPortfolioDto,
  CloseUpstoxLivePaperTradeDto,
  OpenUpstoxLivePaperTradeDto,
  IngestUpstoxLivePaperQuoteDto,
} from './upstox-live-paper.service';
import { UpstoxLivePaperPortfolio } from './upstox-live-paper-entities';
import { UpstoxLivePaperMarketService } from './upstox-live-paper-market.service';

@Controller('upstox-live-paper')
export class UpstoxLivePaperController {
  private readonly logger = new Logger(UpstoxLivePaperController.name);

  constructor(
    private readonly service: UpstoxLivePaperService,
    private readonly market: UpstoxLivePaperMarketService,
    private readonly stability: UpstoxLivePaperMarketStabilityService,
    private readonly weeklyReport: UpstoxLivePaperWeeklyReportService,
    private readonly token: UpstoxLivePaperTokenService,
    private readonly instructions: UpstoxLivePaperInstructionService,
  ) {}

  // ── safety / auth status ────────────────────────────────────────────────────

  @Get('status')
  async status() {
    const [feed, tokenStatus, monitoring] = await Promise.all([
      this.market.status(),
      this.token.tokenStatus(),
      this.stability.snapshot(),
    ]);
    return {
      safety: this.service.safetyStatusText(),
      feed,
      auth: tokenStatus,
      contractMaster: this.service.contractMasterStatus(),
      monitoring: {
        wsReconnectCount: monitoring.wsReconnectCount,
        apiErrorCount: monitoring.apiErrorCount,
        staleBlockedCount: monitoring.staleBlockedCount,
        abnormalSpreadCount: monitoring.abnormalSpreadCount,
        missingStrikeCount: monitoring.missingStrikeCount,
        dbErrorCount: monitoring.dbErrorCount,
        paperInconsistencyCount: monitoring.paperInconsistencyCount,
        paperAccountOk: monitoring.paperAccountOk,
        certification: monitoring.certification,
      },
    };
  }

  // ── portfolio ───────────────────────────────────────────────────────────────

  @Get('portfolios')
  async portfolios() {
    return this.service.listPortfolios();
  }

  @Post('portfolios')
  async createPortfolio(@Body() dto: CreateUpstoxLivePaperPortfolioDto) {
    return this.service.createPortfolio(dto);
  }

  @Get('portfolios/:id')
  async portfolio(@Param('id') id: string) {
    return this.service.getPortfolio(id);
  }

  @Post('portfolios/:id')
  async updatePortfolio(@Param('id') id: string, @Body() dto: Partial<CreateUpstoxLivePaperPortfolioDto>) {
    return this.service.updatePortfolio(id, dto);
  }

  @Post('portfolios/:id/auto')
  async setAutoTrade(@Param('id') id: string, @Body() body: { enabled: boolean }) {
    return this.service.setAutoTrade(id, body.enabled);
  }

  @Post('portfolios/:id/friday')
  async setFridayTrading(@Param('id') id: string, @Body() body: { enabled: boolean }) {
    return this.service.setFridayTrading(id, body.enabled);
  }

  // ── pre-cleared instructions (session auto-start) ───────────────────────────

  /** What the desk is armed with: instructions, window, contract master, portfolios. */
  @Get('instructions')
  async instructionStatus() {
    return this.instructions.status();
  }

  @Post('instructions')
  async createInstruction(@Body() dto: CreateUpstoxLivePaperInstructionDto) {
    return this.instructions.create(dto);
  }

  /** Evaluate every instruction that is due right now (idempotent per session). */
  @Post('instructions/run-due')
  async runDueInstructions() {
    return { results: await this.instructions.runDue('manual') };
  }

  @Post('instructions/:id')
  async updateInstruction(@Param('id') id: string, @Body() dto: Partial<CreateUpstoxLivePaperInstructionDto>) {
    return this.instructions.update(id, dto);
  }

  @Delete('instructions/:id')
  async removeInstruction(@Param('id') id: string) {
    return this.instructions.remove(id);
  }

  /** Clear today's once-per-session guard (after correcting a failed attempt). */
  @Post('instructions/:id/rearm')
  async rearmInstruction(@Param('id') id: string) {
    return this.instructions.rearm(id);
  }

  /** Run one instruction now. ?force=true also ignores the session window/guard. */
  @Post('instructions/:id/run')
  async runInstruction(@Param('id') id: string, @Query('force') force?: string) {
    return this.instructions.runNow(id, /^(1|true|yes)$/i.test(String(force ?? '')));
  }

  // ── trades ──────────────────────────────────────────────────────────────────

  @Get('trades')
  async trades(@Query('portfolioId') portfolioId?: string) {
    return this.service.listTrades(portfolioId, 200);
  }

  @Get('trades/:id')
  async trade(@Param('id') id: string) {
    return this.service.getTrade(id);
  }

  @Post('trades/open')
  async openTrade(@Body() dto: OpenUpstoxLivePaperTradeDto) {
    return this.service.openTrade(dto);
  }

  @Post('trades/close')
  async closeTrade(@Body() dto: CloseUpstoxLivePaperTradeDto) {
    return this.service.closeTrade(dto);
  }

  // ── positions ───────────────────────────────────────────────────────────────

  @Get('positions')
  async positions(@Query('portfolioId') portfolioId?: string) {
    return this.service.listPositions(portfolioId);
  }

  @Post('positions/refresh')
  async refreshPositions() {
    await this.service.refreshPositionsMarkPrices();
    return { ok: true };
  }

  // ── market data ─────────────────────────────────────────────────────────────

  @Get('market/status')
  async marketStatus() {
    return this.market.status();
  }

  @Post('market/ingest')
  async ingest(@Body() dto: IngestUpstoxLivePaperQuoteDto) {
    return this.service.ingestQuotes(dto);
  }

  // ── P&L events ──────────────────────────────────────────────────────────────

  @Get('pnl')
  async pnl(@Query('portfolioId') portfolioId?: string) {
    return this.service.listPnlEvents(portfolioId, 200);
  }

  // ── weekly report ───────────────────────────────────────────────────────────

  @Get('report')
  async report(@Query('week') week?: string) {
    const result = await this.weeklyReport.generateWeeklyReport(week);
    return { ...result, markdownUrl: `/reports/upstox-live-paper/week-${result.week}.md` };
  }

  @Get('report/list')
  async reportList(@Query('limit') limit?: string) {
    const n = limit ? parseInt(limit, 10) || 20 : 20;
    return this.weeklyReport.listReports(n);
  }

  // ── monitoring ──────────────────────────────────────────────────────────────

  @Get('monitoring')
  async monitoring() {
    return this.stability.snapshot();
  }

  // ── convenience summary ─────────────────────────────────────────────────────

  @Get()
  async summary(@Query('portfolioId') portfolioId?: string) {
    return this.service.summary(portfolioId);
  }
}
