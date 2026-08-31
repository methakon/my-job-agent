import { Controller, Get, Post, Patch, Body, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { FnfTradingService } from './fnf-trading.service';
import {
	CreatePortfolioDto,
	UpdatePortfolioDto,
	CreateTradeDto,
	CloseTradeDto,
	IngestSnapshotDto,
	SetDecayCalibrationDto,
} from './fnf-trading.dto';

@ApiTags('fnf-trading')
@Controller('trading')
export class FnfTradingController {
	constructor(private readonly trading: FnfTradingService) {}

	// ── Portfolio ────────────────────────────────────────────────────────

	@Get('portfolios')
	listPortfolios() {
		return this.trading.listPortfolios();
	}

	@Post('portfolios')
	createPortfolio(@Body() dto: CreatePortfolioDto) {
		return this.trading.createPortfolio(dto);
	}

	@Get('portfolios/:id')
	getPortfolio(@Param('id') id: string) {
		return this.trading.getPortfolio(id);
	}

	@Patch('portfolios/:id')
	updatePortfolio(@Param('id') id: string, @Body() dto: UpdatePortfolioDto) {
		return this.trading.updatePortfolio(id, dto);
	}

	@Post('portfolios/:id/auto-trade')
	async setAutoTrade(@Param('id') id: string, @Body() body: { enabled: boolean }) {
		return this.trading.setAutoTrade(id, body.enabled);
	}

	@Post('portfolios/:id/friday')
	async setFridayTrading(@Param('id') id: string, @Body() body: { enabled: boolean }) {
		return this.trading.setFridayTrading(id, body.enabled);
	}

	// ── Trades ───────────────────────────────────────────────────────────

	@Post('trades')
	openTrade(@Body() dto: CreateTradeDto) {
		return this.trading.openTrade(dto);
	}

	@Post('trades/:id/close')
	closeTrade(@Param('id') id: string, @Body() dto: CloseTradeDto) {
		return this.trading.closeTrade(id, dto);
	}

	@Get('trades')
	listTrades(@Query('portfolioId') portfolioId?: string, @Query('limit') limit?: string) {
		return this.trading.listTrades(portfolioId, limit ? Number(limit) : 100);
	}

	@Get('summary')
	async summary() {
		const [portfolios, trades, learning] = await Promise.all([
			this.trading.listPortfolios(),
			this.trading.listTrades(undefined, 500),
			this.trading.learningSummary(),
		]);
		return { portfolios, trades, learning };
	}

	// ── Market snapshots ─────────────────────────────────────────────────

	@Post('market/ingest')
	ingestSnapshots(@Body() body: { rows: IngestSnapshotDto[] }) {
		return this.trading.ingestSnapshots(body.rows ?? []);
	}

	@Get('market')
	marketTable() {
		return this.trading.marketTable();
	}

	// ── Cost calculator + signals ────────────────────────────────────────

	@Get('cost')
	cost(@Query('notional') notional: string, @Query('side') side: 'BUY' | 'SELL') {
		return this.trading.calculateCost(Number(notional || 0), side ?? 'BUY');
	}

	@Get('signals')
	signals(@Query('portfolioId') portfolioId?: string) {
		return this.trading.generateSignals(portfolioId);
	}

	@Get('astro')
	astro() {
		return this.trading.astroMatch();
	}

	// ── Decay calibration (day-wise, self-rectifying) ───────────────────

	@Get('decay')
	listCalibrations(@Query('portfolioId') portfolioId?: string) {
		return this.trading.listCalibrations(portfolioId);
	}

	@Post('decay/rectify')
	rectifyDecay(@Query('portfolioId') portfolioId?: string) {
		return this.trading.rectifyDecay(portfolioId);
	}

	@Patch('decay')
	setCalibration(@Body() dto: SetDecayCalibrationDto, @Query('portfolioId') portfolioId?: string) {
		return this.trading.setCalibration(dto, portfolioId);
	}
}
