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
import { UpstoxLivePaperRiskService } from './upstox-live-paper-risk.service';
import { UpstoxLivePaperLearningService } from './upstox-live-paper-learning.service';
import { UpstoxLivePaperAutoEntryService } from './upstox-live-paper-autoentry.service';
import { UpstoxLivePaperCapitalContinuityService, tradingWeekFromLabel } from './upstox-live-paper-capital-continuity.service';
import { describeEntryPolicy } from './upstox-live-paper-entry-policy';

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
    private readonly risk: UpstoxLivePaperRiskService,
    private readonly learning: UpstoxLivePaperLearningService,
    private readonly autoEntry: UpstoxLivePaperAutoEntryService,
    private readonly capital: UpstoxLivePaperCapitalContinuityService,
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

  // ── configurable paper capital + risk envelope ──────────────────────────────

  /** Every account with the limits its OWN configured capital produces. */
  @Get('risk')
  async riskOverview() {
    return { riskPolicyVersion: this.service.getConfig().riskPolicy.version, accounts: await this.risk.overview() };
  }

  /** One account's live envelope + the capital configuration of each session. */
  @Get('risk/:portfolioId')
  async riskFor(@Param('portfolioId') portfolioId: string, @Query('sessions') sessions?: string) {
    const { policy, snapshot, session } = await this.risk.snapshotFor(portfolioId);
    const limit = sessions ? parseInt(sessions, 10) || 30 : 30;
    return {
      policy,
      snapshot,
      today: session,
      // Each session records the capital it STARTED with, so a later cap change
      // never rewrites what an earlier session was actually run at.
      sessions: await this.risk.listSessions(portfolioId, limit),
    };
  }

  /**
   * Change an account's configured paper capital (₹2,000 / ₹5,000 / ₹10,000 / any
   * value) without a code change. Audited via a CAPITAL_CHANGED event; history is
   * never rewritten. FNF funds and FNF accounts are not touched.
   */
  @Post('portfolios/:portfolioId/capital')
  async setCapital(
    @Param('portfolioId') portfolioId: string,
    @Body() body: { capital?: number; reason?: string; actor?: string },
  ) {
    const capital = this.risk.validateCapitalRequested(body?.capital);
    const updated = await this.risk.updateCapital(portfolioId, capital, { reason: body?.reason, actor: body?.actor });
    const { snapshot } = await this.risk.snapshotFor(portfolioId);
    return {
      portfolioId,
      configuredCapital: Number(updated.capital),
      snapshot,
      note: 'historical trades, P&L and sessions keep the capital configuration they were produced under',
    };
  }

  // ── V1 policy + learning journal ────────────────────────────────────────────

  /** The live V1 thresholds and version (a hypothesis set, adjustable). */
  @Get('entry-policy')
  async entryPolicy() {
    return { ...this.autoEntry.policyDescription(), thresholdsDetail: describeEntryPolicy() };
  }

  /** Run one V1 cycle now (management first, then at most one entry). */
  @Post('auto-entry/run')
  async runAutoEntry() {
    return this.autoEntry.runOnce();
  }

  /** Every candidate of a session — executed AND refused — with its outcome. */
  @Get('journal')
  async journal(@Query('portfolioId') portfolioId: string, @Query('sessionDate') sessionDate?: string) {
    if (!portfolioId) throw new BadRequestException('portfolioId is required');
    const date = sessionDate ?? (await this.risk.todayIst());
    return this.learning.sessionJournal(portfolioId, date);
  }

  /** (Re)label one candidate once its 5/10/15/30/60-minute tape has arrived. */
  @Post('journal/:candidateId/label')
  async labelCandidate(@Param('candidateId') candidateId: string) {
    const row = await this.learning.labelOutcomeFor(candidateId);
    if (!row) throw new BadRequestException('no quote tape for this candidate yet — nothing was extrapolated');
    return { candidateId, classification: row.classification, outcomeStatus: row.outcomeStatus };
  }

  // ── PAPER capital continuity + week-start carry-forward ─────────────────────

  /**
   * Previous week's closing PAPER equity — read-only preview of what the next
   * week's available capital would become. No writes, no state change.
   */
  @Get('capital-continuity')
  async capitalContinuity(@Query('week') week?: string) {
    return this.capital.previewWeekRoll(week ? tradingWeekFromLabel(week) : undefined);
  }

  /** Apply the week roll (previous close equity → available capital). Idempotent per week. */
  @Post('capital-continuity/roll')
  async rollCapital(@Query('week') week?: string, @Query('actor') actor?: string) {
    return this.capital.applyWeekRoll({ week: week ? tradingWeekFromLabel(week) : undefined, actor });
  }

  /** POSITIONS still open at the previous close, with their identity re-verified. */
  @Get('capital-continuity/carried-positions')
  async carriedPositions(@Query('week') week?: string) {
    return this.capital.discoverCarriedPositions(week ? tradingWeekFromLabel(week) : undefined);
  }

  /**
   * Re-evaluate the carried positions with the desk's own exit policy. Without
   * `apply=true` this is a preview and changes nothing; with it, HOLDs are kept
   * and EXITs use the normal paper fill, each recorded with its reason.
   */
  @Post('capital-continuity/carry-forward')
  async carryForward(
    @Query('week') week?: string,
    @Query('apply') apply?: string,
    @Query('actor') actor?: string,
  ) {
    return this.capital.carryForwardPositions({
      week: week ? tradingWeekFromLabel(week) : undefined,
      apply: apply === 'true',
      actor,
    });
  }

  /**
   * LIVE account/wallet balance — read-only, reported SEPARATELY from paper
   * equity. It never authorizes a real order and is never used for sizing.
   */
  @Get('live-wallet')
  async liveWallet() {
    return this.capital.liveWallet();
  }
}
