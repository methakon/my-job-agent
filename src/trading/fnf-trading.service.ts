import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThanOrEqual } from 'typeorm';
import { FnfPortfolio } from './fnf-portfolio.entity';
import { FnfTrade } from './fnf-trade.entity';
import { FnfMarketSnapshot } from './fnf-market-snapshot.entity';
import { CreatePortfolioDto, UpdatePortfolioDto, CreateTradeDto, CloseTradeDto, IngestSnapshotDto } from './fnf-trading.dto';
import { AstroMuhurtaService } from '../astro/astro-muhurta.service';

/** Minimum score for a shubh muhurta window (same threshold as the engine). */
const SHUBH_SCORE_MIN = Number(process.env.SHUBH_MIN_SCORE ?? 65);

export interface CostBreakdown {
	notional: number;
	brokerage: number;
	stt: number;
	exchangeTxn: number;
	gst: number;
	sebi: number;
	stamp: number;
	total: number;
}

export interface AlgoSignal {
	instrument: string;
	algoSource: string;
	action: 'BUY' | 'SELL' | 'HOLD';
	price: number;
	target: number;
	stopLoss: number;
	confidence: number; // 0..100
	scenarios: { name: string; probability: number; target: number }[];
	astroMatch: { shubh: boolean; score: number; label: string };
	fridayBlocked: boolean;
	reasons: string[];
}

/** Indian discount-broker cost model (Zerodha-style). */
const COST_RATES = {
	brokeragePct: 0.0003, // 0.03% or ₹20 min, whichever lower
	brokerageMin: 20,
	sttSellPct: 0.00025, // 0.025% on sell side
	exchangeTxnPct: 0.0000275, // NSE 0.00275%
	gstPct: 0.18,
	sebiPct: 0.000001, // ₹10 per crore
	stampBuyPct: 0.00015, // 0.015% on buy side
};

@Injectable()
export class FnfTradingService {
	private readonly logger = new Logger(FnfTradingService.name);

	constructor(
		@InjectRepository(FnfPortfolio) private readonly portfolios: Repository<FnfPortfolio>,
		@InjectRepository(FnfTrade) private readonly trades: Repository<FnfTrade>,
		@InjectRepository(FnfMarketSnapshot) private readonly snapshots: Repository<FnfMarketSnapshot>,
		private readonly muhurta: AstroMuhurtaService,
	) {}

	// ── Portfolio ────────────────────────────────────────────────────────

	async listPortfolios(): Promise<FnfPortfolio[]> {
		return this.portfolios.find({ order: { createdAt: 'ASC' } });
	}

	async getPortfolio(id: string): Promise<FnfPortfolio> {
		const p = await this.portfolios.findOne({ where: { id } });
		if (!p) throw new NotFoundException(`portfolio ${id} not found`);
		return p;
	}

	async createPortfolio(dto: CreatePortfolioDto): Promise<FnfPortfolio> {
		const ceiling = dto.ceiling ?? dto.capital;
		return this.portfolios.save(this.portfolios.create({
			label: dto.label ?? 'main',
			capital: dto.capital,
			ceiling,
			autoTradeEnabled: dto.autoTradeEnabled ?? false,
			fridayTradingEnabled: dto.fridayTradingEnabled ?? false,
			brokerConfig: dto.brokerConfig ?? undefined,
		}));
	}

	async updatePortfolio(id: string, dto: UpdatePortfolioDto): Promise<FnfPortfolio> {
		const p = await this.getPortfolio(id);
		Object.assign(p, {
			label: dto.label ?? p.label,
			capital: dto.capital ?? p.capital,
			ceiling: dto.ceiling ?? p.ceiling,
			autoTradeEnabled: dto.autoTradeEnabled ?? p.autoTradeEnabled,
			fridayTradingEnabled: dto.fridayTradingEnabled ?? p.fridayTradingEnabled,
			brokerConfig: dto.brokerConfig ?? p.brokerConfig,
		});
		return this.portfolios.save(p);
	}

	async setAutoTrade(id: string, enabled: boolean): Promise<FnfPortfolio> {
		return this.updatePortfolio(id, { autoTradeEnabled: enabled });
	}

	async setFridayTrading(id: string, enabled: boolean): Promise<FnfPortfolio> {
		return this.updatePortfolio(id, { fridayTradingEnabled: enabled });
	}

	// ── Trades ───────────────────────────────────────────────────────────

	/** Open a position. Enforces: portfolio exists, capital headroom, and the
	 *  Friday block (no new positions on Friday unless explicitly enabled). */
	async openTrade(dto: CreateTradeDto): Promise<FnfTrade> {
		const portfolio = await this.getPortfolio(dto.portfolioId);
		const notional = dto.quantity * dto.entryPrice;

		const isFriday = new Date().getDay() === 5;
		if (isFriday && !portfolio.fridayTradingEnabled) {
			throw new BadRequestException(
				'Friday block active: no new positions on Friday unless fridayTradingEnabled. Enable the Friday toggle to override.',
			);
		}

		const headroom = (Number(portfolio.ceiling) || Number(portfolio.capital)) - Number(portfolio.deployed);
		if (notional > headroom) {
			throw new BadRequestException(
				`notional ${notional} exceeds available headroom ${headroom.toFixed(2)} (ceiling ${portfolio.ceiling} − deployed ${portfolio.deployed})`,
			);
		}

		const trade = await this.trades.save(this.trades.create({
			portfolio,
			instrument: dto.instrument,
			side: dto.side,
			quantity: dto.quantity,
			entryPrice: dto.entryPrice,
			algoSource: dto.algoSource ?? undefined,
			decisionParams: dto.decisionParams ?? undefined,
			status: 'OPEN',
		}));

		await this.portfolios.update(portfolio.id, {
			deployed: Number(portfolio.deployed) + notional,
		});
		this.logger.log(`trade opened ${dto.side} ${dto.quantity}x ${dto.instrument} @ ${dto.entryPrice} (${notional.toFixed(2)})`);
		return trade;
	}

	/** Close a position: compute gross/net P&L + cost, update portfolio. */
	async closeTrade(id: string, dto: CloseTradeDto): Promise<FnfTrade> {
		const trade = await this.trades.findOne({ where: { id }, relations: { portfolio: true } });
		if (!trade) throw new NotFoundException(`trade ${id} not found`);
		if (trade.status !== 'OPEN') throw new BadRequestException(`trade ${id} already ${trade.status}`);

		const qty = Number(trade.quantity);
		const entry = Number(trade.entryPrice);
		const exit = dto.exitPrice;
		const side = trade.side as 'BUY' | 'SELL';
		const notional = qty * exit;

		// gross P&L: BUY → (exit − entry) × qty ; SELL (short) → (entry − exit) × qty
		const grossPnl = side === 'BUY' ? (exit - entry) * qty : (entry - exit) * qty;

		// cost: caller-provided override, else the standard model on the exit leg
		const cost = dto.cost ?? this.calculateCost(notional, side).total;
		const netPnl = grossPnl - cost;

		trade.exitPrice = exit;
		trade.grossPnl = grossPnl;
		trade.cost = cost;
		trade.netPnl = netPnl;
		trade.status = 'CLOSED';
		trade.closedAt = new Date();
		const saved = await this.trades.save(trade);

		const portfolio = trade.portfolio;
		await this.portfolios.update(portfolio.id, {
			deployed: Math.max(0, Number(portfolio.deployed) - notional),
			netPnl: Number(portfolio.netPnl) + netPnl,
			totalCost: Number(portfolio.totalCost) + cost,
		});
		this.logger.log(`trade closed ${id}: gross ${grossPnl.toFixed(2)} cost ${cost.toFixed(2)} net ${netPnl.toFixed(2)}`);
		return saved;
	}

	async listTrades(portfolioId?: string, limit = 100): Promise<FnfTrade[]> {
		const where = portfolioId ? { portfolio: { id: portfolioId } } : {};
		return this.trades.find({ where, order: { orderedAt: 'DESC' }, take: limit });
	}

	/** Self-learning summary: per-algoSource win rate + totals over closed trades. */
	async learningSummary(): Promise<{ total: number; winners: number; winRate: number; netPnl: number; byAlgo: Record<string, { count: number; wins: number; winRate: number; netPnl: number }> }> {
		const closed = await this.trades.find({ where: { status: 'CLOSED' } });
		const byAlgo: Record<string, { count: number; wins: number; winRate: number; netPnl: number }> = {};
		let winners = 0;
		let netPnl = 0;
		for (const t of closed) {
			const algo = t.algoSource ?? 'manual';
			const w = Number(t.netPnl) > 0;
			if (w) winners++;
			netPnl += Number(t.netPnl);
			const bucket = byAlgo[algo] ?? { count: 0, wins: 0, winRate: 0, netPnl: 0 };
			bucket.count++;
			if (w) bucket.wins++;
			bucket.netPnl += Number(t.netPnl);
			byAlgo[algo] = bucket;
		}
		for (const b of Object.values(byAlgo)) b.winRate = b.count ? Math.round((b.wins / b.count) * 100) : 0;
		return {
			total: closed.length,
			winners,
			winRate: closed.length ? Math.round((winners / closed.length) * 100) : 0,
			netPnl,
			byAlgo,
		};
	}

	// ── Market snapshots ─────────────────────────────────────────────────

	async ingestSnapshots(dtos: IngestSnapshotDto[]): Promise<number> {
		const rows = dtos.map((d) =>
			this.snapshots.create({
				instrument: d.instrument,
				price: d.price,
				volume: d.volume ?? 0,
				open: d.open ?? undefined,
				high: d.high ?? undefined,
				low: d.low ?? undefined,
				close: d.close ?? undefined,
				ts: d.ts ? new Date(d.ts) : new Date(),
			}),
		);
		const saved = await this.snapshots.save(rows);
		return saved.length;
	}

	/** Latest price per instrument + value-change % vs previous snapshot. */
	async marketTable(): Promise<{ instrument: string; price: number; prevPrice: number | null; changePct: number | null; volume: number; ts: Date }[]> {
		const instruments = await this.snapshots
			.createQueryBuilder('s')
			.select('DISTINCT s.instrument', 'instrument')
			.getRawMany<{ instrument: string }>();
		const out: { instrument: string; price: number; prevPrice: number | null; changePct: number | null; volume: number; ts: Date }[] = [];
		for (const { instrument } of instruments) {
			const rows = await this.snapshots.find({
				where: { instrument },
				order: { ts: 'DESC' },
				take: 2,
			});
			if (!rows.length) continue;
			const latest = rows[0];
			const prev = rows[1] ?? null;
			const price = Number(latest.price);
			const prevPrice = prev ? Number(prev.price) : null;
			out.push({
				instrument,
				price,
				prevPrice,
				changePct: prevPrice && prevPrice !== 0 ? ((price - prevPrice) / prevPrice) * 100 : null,
				volume: Number(latest.volume),
				ts: latest.ts,
			});
		}
		return out;
	}

	// ── Cost calculator ──────────────────────────────────────────────────

	/** Indian discount-broker cost model for one executed order. */
	calculateCost(notional: number, side: 'BUY' | 'SELL'): CostBreakdown {
		const r = COST_RATES;
		const brokerage = Math.min(Math.max(r.brokeragePct * notional, r.brokerageMin), notional);
		const stt = side === 'SELL' ? r.sttSellPct * notional : 0;
		const exchangeTxn = r.exchangeTxnPct * notional;
		const gst = r.gstPct * (brokerage + exchangeTxn);
		const sebi = r.sebiPct * notional;
		const stamp = side === 'BUY' ? r.stampBuyPct * notional : 0;
		const total = brokerage + stt + exchangeTxn + gst + sebi + stamp;
		return { notional, brokerage, stt, exchangeTxn, gst, sebi, stamp, total };
	}

	// ── Algo signals (stubs — real prediction engines plug in here) ─────

	/** Generate BUY/SELL/HOLD signals per instrument from the latest snapshots.
	 *  Stub logic: SMA-20 mean-reversion + momentum; scenario tree; astro
	 *  match from the live muhurta engine; Friday block honored. */
	async generateSignals(portfolioId?: string): Promise<AlgoSignal[]> {
		const portfolio = portfolioId ? await this.getPortfolio(portfolioId) : (await this.listPortfolios())[0] ?? null;
		const isFriday = new Date().getDay() === 5;
		const fridayBlocked = isFriday && !(portfolio?.fridayTradingEnabled);

		const instruments = await this.snapshots
			.createQueryBuilder('s')
			.select('DISTINCT s.instrument', 'instrument')
			.getRawMany<{ instrument: string }>();
		const window = await this.muhurta.nextWindow(new Date(), 24);
		const shubh = (window?.score ?? 0) >= SHUBH_SCORE_MIN;
		const astroMatch = {
			shubh,
			score: window?.score ?? 0,
			label: window ? this.muhurta.describeNext(new Date()) : 'no muhurta window found in next 24h',
		};

		const signals: AlgoSignal[] = [];
		for (const { instrument } of instruments) {
			const rows = await this.snapshots.find({
				where: { instrument },
				order: { ts: 'DESC' },
				take: 30,
			});
			if (rows.length < 5) continue; // not enough data for a signal
			const prices = rows.map((r) => Number(r.price)).reverse();
			const last = prices[prices.length - 1];
			const sma = prices.reduce((a, b) => a + b, 0) / prices.length;
			const smaShort = prices.slice(-5).reduce((a, b) => a + b, 0) / 5;
			const momentum = (last / prices[prices.length - 6]) - 1; // 5-bar momentum

			let action: AlgoSignal['action'] = 'HOLD';
			const reasons: string[] = [];
			if (last > sma && smaShort > sma) { action = 'BUY'; reasons.push('price above SMA-20 with rising 5-bar mean'); }
			else if (last < sma && smaShort < sma) { action = 'SELL'; reasons.push('price below SMA-20 with falling 5-bar mean'); }
			else reasons.push('price oscillating around SMA-20 — range-bound');
			if (Math.abs(momentum) > 0.02) reasons.push(`5-bar momentum ${(momentum * 100).toFixed(1)}%`);
			if (astroMatch.shubh) reasons.push(`shubh muhurta ${astroMatch.label}`);
			else reasons.push('no shubh muhurta window in next 24h');

			const confidence = Math.min(85, 40 + Math.round(Math.abs(last - sma) / sma * 1000) + (astroMatch.shubh ? 15 : 0));
			const target = last * (action === 'BUY' ? 1.02 : action === 'SELL' ? 0.98 : 1);
			const stopLoss = action === 'BUY' ? last * 0.99 : action === 'SELL' ? last * 1.01 : last;

			signals.push({
				instrument,
				algoSource: 'sma-mean-reversion-v1',
				action,
				price: last,
				target,
				stopLoss,
				confidence,
				scenarios: [
					{ name: 'bull', probability: action === 'BUY' ? 55 : 30, target: last * 1.02 },
					{ name: 'base', probability: 25, target: last },
					{ name: 'bear', probability: action === 'SELL' ? 45 : 25, target: last * 0.98 },
				],
				astroMatch,
				fridayBlocked,
				reasons,
			});
		}
		return signals;
	}

	/** Convenience: does today's muhurta engine see a shubh window? */
	async astroMatch(): Promise<{ shubh: boolean; score: number; label: string }> {
		const window = await this.muhurta.nextWindow(new Date(), 24);
		return {
			shubh: (window?.score ?? 0) >= SHUBH_SCORE_MIN,
			score: window?.score ?? 0,
			label: window ? this.muhurta.describeNext(new Date()) : 'no muhurta window found in next 24h',
		};
	}

	async purgeOldSnapshots(before: Date): Promise<number> {
		const res = await this.snapshots.delete({ ts: LessThanOrEqual(before) });
		return res.affected ?? 0;
	}
}
