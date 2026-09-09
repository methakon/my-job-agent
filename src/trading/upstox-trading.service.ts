import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UpstoxPortfolio, UpstoxTrade } from './upstox-trading.entity';

export interface UpstoxSignal {
  instrument: string;
  action: 'BUY' | 'SELL' | 'HOLD';
  price: number;
  target: number;
  stopLoss: number;
  confidence: number;
  algoSource: string;
  reasons: string[];
  fridayBlocked: boolean;
  scenarios: Array<{ name: string; probability: number; target: number }>;
  decayedConfidence: number;
  decay: { ageHours: number; rate: number; timingFactor: number };
  astroMatch: { shubh: boolean; score: number; label: string };
}

@Injectable()
export class UpstoxTradingService {
  private readonly logger = new Logger(UpstoxTradingService.name);

  constructor(
    @InjectRepository(UpstoxPortfolio)
    private readonly portfolioRepo: Repository<UpstoxPortfolio>,
    @InjectRepository(UpstoxTrade)
    private readonly tradeRepo: Repository<UpstoxTrade>,
  ) {}

  // Portfolio management
  async createPortfolio(label: string, capital: number = 5000): Promise<UpstoxPortfolio> {
    const portfolio = this.portfolioRepo.create({
      label,
      capital,
      ceiling: capital, // ₹5,000 rule - ceiling same as capital
      deployed: 0,
      netPnl: 0,
      totalCost: 0,
      autoTradeEnabled: true,
      fridayTradingEnabled: false,
      active: true,
    });
    return await this.portfolioRepo.save(portfolio);
  }

  async listPortfolios(): Promise<UpstoxPortfolio[]> {
    return await this.portfolioRepo.find({ where: { active: true } });
  }

  // Sandbox trading
  async sandboxOpenTrade(
    portfolioId: string,
    instrument: string,
    side: 'BUY' | 'SELL',
    quantity: number,
    price: number,
    decisionParams?: any,
  ): Promise<UpstoxTrade> {
    const portfolio = await this.portfolioRepo.findOne({ where: { id: portfolioId } });
    if (!portfolio) throw new Error('Portfolio not found');

    // Check headroom with ₹5,000 rule
    const totalCost = this.calculateCost(price * quantity, side);
    const headroom = portfolio.ceiling - portfolio.deployed;
    
    if (headroom < totalCost) {
      throw new Error(`Insufficient headroom: ₹${headroom.toFixed(2)} available, need ₹${totalCost.toFixed(2)}`);
    }

    // Update portfolio deployed amount
    portfolio.deployed = Number(portfolio.deployed) + totalCost;
    await this.portfolioRepo.save(portfolio);

    const trade = this.tradeRepo.create({
      portfolioId,
      instrument,
      side,
      quantity,
      entryPrice: price,
      cost: totalCost,
      decisionParams: typeof decisionParams === 'string' ? decisionParams : JSON.stringify(decisionParams || {}),
      orderedAt: new Date(),
      executionProvider: 'UPSTOX',
      executionMode: 'SANDBOX',
      onRealData: false,
      status: 'OPEN',
    });

    this.logger.log(`[UPSTOX][SANDBOX] opened ${side} ${instrument} @ ${price}`);
    return await this.tradeRepo.save(trade);
  }

  async sandboxCloseTrade(tradeId: string, exitPrice: number, exitTrigger: string): Promise<UpstoxTrade> {
    const trade = await this.tradeRepo.findOne({ where: { id: tradeId } });
    if (!trade) throw new Error('Trade not found');
    if (trade.status !== 'OPEN') throw new Error('Trade not open');

    // Calculate P&L
    const entryPrice = Number(trade.entryPrice);
    const quantity = Number(trade.quantity);
    let grossPnl = 0;

    if (trade.side === 'BUY') {
      grossPnl = (exitPrice - entryPrice) * quantity;
    } else {
      grossPnl = (entryPrice - exitPrice) * quantity;
    }

    // Update trade
    trade.exitPrice = exitPrice;
    trade.grossPnl = grossPnl;
    trade.netPnl = grossPnl - Number(trade.cost);
    trade.status = 'CLOSED';
    trade.closedAt = new Date();
    trade.exitAlertReason = exitTrigger;
    trade.exitAlertAt = new Date();
    trade.exitAlertPrice = exitPrice;

    // Update portfolio
    const portfolio = await this.portfolioRepo.findOne({ where: { id: trade.portfolioId } });
    if (portfolio) {
      portfolio.deployed = Number(portfolio.deployed) - Number(trade.cost);
      portfolio.netPnl = Number(portfolio.netPnl) + Number(trade.netPnl);
      await this.portfolioRepo.save(portfolio);
    }

    this.logger.log(`[UPSTOX][SANDBOX] closed ${trade.side} ${trade.instrument} @ ${exitPrice}: ${exitTrigger}`);
    return await this.tradeRepo.save(trade);
  }

  // Market data (mock for sandbox)
  async marketTable(): Promise<any[]> {
    // Mock market data for sandbox
    return [
      {
        instrument: 'NSE:NIFTY50-INDEX',
        price: 23761.95,
        changePct: 0.42,
        volume: 12345678,
        ts: new Date(),
      },
      {
        instrument: 'NSE:BANKNIFTY-INDEX',
        price: 52134.25,
        changePct: -0.18,
        volume: 5678901,
        ts: new Date(),
      },
    ];
  }

  // Generate mock signals for sandbox
  async generateSignals(): Promise<UpstoxSignal[]> {
    const now = new Date();
    const wkday = now.getDay();
    const isFriday = wkday === 5;

    return [
      {
        instrument: 'NSE:NIFTY26SEP23500CE',
        action: 'BUY',
        price: 85.50,
        target: 128.25,
        stopLoss: 60.85,
        confidence: 68,
        algoSource: 'upstox-option-scanner-v1',
        reasons: [
          'NIFTY50-INDEX above SMA-20 with rising 5-bar mean (bullish)',
          'strike 23500 (spot 23761.95; 1.10% from ATM)',
          'premium ₹85.50 × 65 units × 1 lot(s) = ₹5557.50',
          'ranked #1 of affordable candidate(s) with score 70.2',
        ],
        fridayBlocked: isFriday,
        scenarios: [
          { name: 'bullish breakout', probability: 45, target: 142.00 },
          { name: 'theta decay', probability: 35, target: 115.00 },
        ],
        decayedConfidence: 68,
        decay: { ageHours: 0.0, rate: 0.040, timingFactor: 1.0 },
        astroMatch: { shubh: wkday !== 0, score: 85, label: `weekday ${wkday}` },
      },
    ];
  }

  // Trading cost calculation (same as Fyers)
  calculateCost(notional: number, side: 'BUY' | 'SELL'): number {
    const brokerage = Math.max(notional * 0.0003, 20);
    const stt = side === 'SELL' ? notional * 0.00025 : 0;
    const exchangeTxn = notional * 0.0000275;
    const sebi = (notional / 10000000) * 10; // ₹10 per crore
    const stamp = side === 'BUY' ? notional * 0.00015 : 0;
    const subtotal = brokerage + stt + exchangeTxn + sebi + stamp;
    const gst = subtotal * 0.18;
    return subtotal + gst;
  }

  // List open trades
  async listTrades(portfolioId?: string, limit: number = 100): Promise<UpstoxTrade[]> {
    const where: any = {};
    if (portfolioId) where.portfolioId = portfolioId;
    where.status = 'OPEN';
    
    return await this.tradeRepo.find({
      where,
      order: { orderedAt: 'DESC' },
      take: limit,
    });
  }

  // Learning summary from closed trades
  async learningSummary(): Promise<any> {
    const closed = await this.tradeRepo.find({ where: { status: 'CLOSED' } });
    const winners = closed.filter(t => Number(t.netPnl) > 0);
    
    return {
      total: closed.length,
      winners: winners.length,
      winRate: closed.length ? Math.round((winners.length / closed.length) * 100) : 0,
      netPnl: closed.reduce((sum, t) => sum + Number(t.netPnl), 0),
      byAlgo: {},
    };
  }

  // Astro match (mock)
  async astroMatch(): Promise<{ shubh: boolean; score: number; label: string }> {
    const now = new Date();
    const wkday = now.getDay();
    return {
      shubh: wkday !== 0 && wkday !== 6, // Not Sunday or Saturday (mock)
      score: 85,
      label: `weekday ${wkday}, ${now.getHours()}:${now.getMinutes()} IST`,
    };
  }

  // List calibrations (mock)
  async listCalibrations(): Promise<any[]> {
    return [];
  }
}