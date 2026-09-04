import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between } from 'typeorm';
import { FnfMarketSnapshot } from '../trading/fnf-market-snapshot.entity';
import { FnfMarketSnapshotHistory } from '../trading/fnf-market-snapshot-history.entity';

/** Per-instrument intraday window of prices for feature math. */
export interface PriceWindow {
	instrument: string;
	ts: Date;
	price: number;
	volume: number;
}

export interface IntradayFeatures {
	instrument: string;
	day: string; // IST date (naive)
	asOfMin: number; // minutes since 09:15 IST
	vwap: number | null;
	atr14: number | null;
	rangePct: number | null; // (high-low)/prevClose-ish normalized range of the day so far
	orbs: { orb5: number | null; orb15: number | null; orb30: number | null }; // opening range in price pts
	barCount: number;
}

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const OPEN_MIN = 9 * 60 + 15; // 09:15 IST

/** GATE 3 core feature engine — VWAP / ATR / ORB / normalized range computed from
 *  stored intraday snapshots (today's live table + history). Versioned formulas,
 *  deterministic on the same inputs (v5 gate rule). */
@Injectable()
export class FeatureEngineService {
	private readonly logger = new Logger(FeatureEngineService.name);

	constructor(
		@InjectRepository(FnfMarketSnapshot) private readonly snaps: Repository<FnfMarketSnapshot>,
		@InjectRepository(FnfMarketSnapshotHistory) private readonly hist: Repository<FnfMarketSnapshotHistory>,
	) {}

	/** Load a day's price window for one instrument from live + history tables
	 *  (both share the schema; live holds today, history holds prior days). */
	private async loadWindow(instrument: string, dayIso: string): Promise<PriceWindow[]> {
		// dayIso: 'YYYY-MM-DD' in IST. Snapshots store ts IST-naive (repo convention).
		const dayStart = new Date(`${dayIso}T00:00:00.000Z`);
		const dayEnd = new Date(`${dayIso}T23:59:59.999Z`);
		const live = await this.snaps.find({ where: { instrument, ts: Between(dayStart, dayEnd) }, order: { ts: 'ASC' } }).catch(() => [] as FnfMarketSnapshot[]);
		const past = await this.hist.find({ where: { instrument, ts: Between(dayStart, dayEnd) }, order: { ts: 'ASC' } }).catch(() => [] as FnfMarketSnapshotHistory[]);
		const rows = [...past, ...live].sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
		return rows.map((r) => ({ instrument, ts: new Date(r.ts), price: Number(r.price), volume: Number(r.volume ?? 0) }));
	}

	/** VWAP over the window (session-start anchored). Falls back to the tick
	 *  mean (equal-weight VWAP) when stored volume is 0 — index snapshots carry
	 *  no volume, so pure price-VWAP is the deterministic fallback. */
	private vwap(rows: PriceWindow[]): number | null {
		let pv = 0;
		let v = 0;
		for (const r of rows) {
			pv += r.price * r.volume;
			v += r.volume;
		}
		if (v > 0) return pv / v;
		return rows.length ? rows.reduce((a, r) => a + r.price, 0) / rows.length : null;
	}

	/** Wilder ATR-14 over distinct-price ticks of the day so far (consecutive
	 *  duplicate prices = idle ticks, not bars — skipped so post-close flat
	 *  stragglers cannot zero the ATR). */
	private atr14(rows: PriceWindow[]): number | null {
		const distinct = rows.filter((r, i) => i === 0 || Math.abs(r.price - rows[i - 1].price) > 1e-9);
		if (distinct.length < 2) return null;
		const trs: number[] = [];
		for (let i = 1; i < distinct.length; i++) trs.push(Math.abs(distinct[i].price - distinct[i - 1].price));
		const n = Math.min(14, trs.length);
		const recent = trs.slice(-n);
		return recent.reduce((a, b) => a + b, 0) / recent.length;
	}

	/** Opening range breakout bands (price pts from session open) at 5/15/30 min. */
	private orbs(rows: PriceWindow[], asOfMin: number): { orb5: number | null; orb15: number | null; orb30: number | null } {
		const out = { orb5: null as number | null, orb15: null as number | null, orb30: null as number | null };
		const open = rows[0]?.price ?? null;
		if (open === null) return out;
		const hi = (cut: number) => {
			const inWin = rows.filter((r) => this.minOfDay(r.ts) <= OPEN_MIN + cut);
			if (!inWin.length) return null;
			const hs = Math.max(...inWin.map((r) => r.price));
			const ls = Math.min(...inWin.map((r) => r.price));
			return { hi: hs, lo: ls };
		};
		for (const [k, cut] of [['orb5', 5], ['orb15', 15], ['orb30', 30]] as const) {
			const w = hi(cut);
			out[k] = w ? w.hi - w.lo : null;
		}
		void asOfMin;
		return out;
	}

	private minOfDay(ts: Date): number {
		const ist = new Date(ts.getTime() + IST_OFFSET_MS);
		return ist.getUTCHours() * 60 + ist.getUTCMinutes();
	}

	/** Full intraday feature set for an instrument on a day (default today IST). */
	async featuresFor(instrument: string, dayIso?: string): Promise<IntradayFeatures> {
		const istNow = new Date(Date.now() + IST_OFFSET_MS);
		const day = dayIso ?? istNow.toISOString().slice(0, 10);
		const rows = await this.loadWindow(instrument, day);
		if (!rows.length) {
			return { instrument, day, asOfMin: 0, vwap: null, atr14: null, rangePct: null, orbs: { orb5: null, orb15: null, orb30: null }, barCount: 0 };
		}
		const asOfMin = Math.max(0, this.minOfDay(rows[rows.length - 1].ts) - OPEN_MIN);
		const prices = rows.map((r) => r.price);
		const rangePct = prices.length > 1 ? ((Math.max(...prices) - Math.min(...prices)) / (prices[0] || 1)) * 100 : null;
		return {
			instrument,
			day,
			asOfMin,
			vwap: this.vwap(rows),
			atr14: this.atr14(rows),
			rangePct,
			orbs: this.orbs(rows, asOfMin),
			barCount: rows.length,
		};
	}

	/** List instruments that have stored snapshots for a day (feature availability). */
	async instrumentsOn(dayIso: string): Promise<string[]> {
		const dayStart = new Date(`${dayIso}T00:00:00.000Z`);
		const dayEnd = new Date(`${dayIso}T23:59:59.999Z`);
		const live = await this.snaps.find({ where: { ts: Between(dayStart, dayEnd) }, select: { instrument: true } }).catch(() => [] as FnfMarketSnapshot[]);
		const past = await this.hist.find({ where: { ts: Between(dayStart, dayEnd) }, select: { instrument: true } }).catch(() => [] as FnfMarketSnapshotHistory[]);
		return [...new Set([...past, ...live].map((r) => r.instrument))].sort();
	}
}
