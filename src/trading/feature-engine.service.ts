import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, LessThan } from 'typeorm';
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

/* ───────────────────────── GapATR (roadmap row 427, GATE 3 P0) ─────────────────────────
 * The opening gap measured in PRIOR-SESSION ATR units: gapAtr = (open − priorClose) / ATR14.
 * Rationale and evidence: over the 3,213 recorded daily index sessions (2021–2025) the gap
 * normalised this way is the single most informative recorded quantity for intraday gap fill
 * (AUC 0.19, bottom decile 94.3% filled vs top decile 17.8%, stable per year and per
 * instrument). It is a CONDITIONING variable, not a directional edge.
 *
 * Deliberately distinct from the tick-based `atr14` above: a session open must be normalised by
 * the average DAILY range, not by tick-to-tick movement, or the ratio has no stable meaning.
 * Every value is either computed from recorded data or null — this feature NEVER returns 0,
 * NaN or Infinity to stand in for "unknown".
 */
export const GAP_ATR_VERSION = 'gapatr-v1';
/** ATR-14 = mean of the last 14 true ranges — the SAME convention as the tick `atr14` above. */
export const DAILY_ATR_PERIOD = 14;
/** How far back to look for prior sessions (calendar days). */
export const DAILY_ATR_LOOKBACK_DAYS = 60;

/** Closed refusal vocabulary: declaration order is the canonical order. */
export const GAP_ATR_REFUSALS = [
	'NO_OPEN',
	'INVALID_OPEN',
	'NO_PRIOR_CLOSE',
	'INVALID_PRIOR_CLOSE',
	'NO_PRIOR_SESSIONS',
	'INSUFFICIENT_SESSIONS',
	'NO_ATR',
] as const;
export type GapAtrRefusal = (typeof GAP_ATR_REFUSALS)[number];

/** One recorded session collapsed to a single daily bar (IST session date). */
export interface DailySessionBar {
	date: string; // IST session date, YYYY-MM-DD
	open: number;
	high: number;
	low: number;
	close: number;
}

export interface GapAtrResult {
	version: string;
	/** (open − priorClose) / atr14, or null. Signed: negative = gap down. */
	gapAtr: number | null;
	/** open − priorClose in index points, or null. */
	gapPoints: number | null;
	/** ATR-14 over the PRIOR sessions. */
	atr14Daily: number | null;
	/** How many prior daily bars the ATR used. */
	sessionsUsed: number;
	refusal: GapAtrRefusal | null;
}

/** Numeric coercion that FAILS CLOSED for absent values. `Number(null)` is 0 and `Number('')` is 0,
 *  so those are rejected explicitly — otherwise a missing column would be read as a real zero and
 *  could fabricate a gap or an ATR instead of refusing. */
const num = (v: unknown): number | null => {
	if (v === null || v === undefined || v === '') return null;
	const n = typeof v === 'number' ? v : Number(v);
	return Number.isFinite(n) ? n : null;
};

/** Normalise a session-date value to `YYYY-MM-DD`.
 *  Accepts the string the SQL `DATE_FORMAT` path produces AND a `Date` the MySQL driver returns for
 *  a `DATE(ts)` column — a Date silently failing the date test would drop EVERY bar and yield a
 *  refusal instead of a value. Local components are used for a Date because mysql2 constructs DATE
 *  values in the process's own timezone. */
const toDateKey = (d: unknown): string | null => {
	if (d instanceof Date) {
		if (Number.isNaN(d.getTime())) return null;
		const p = (n: number) => String(n).padStart(2, '0');
		return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
	}
	const s = String(d ?? '');
	const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
	return m ? m[1] : null;
};

/** Build one bar per IST session date from pre-aggregated columns, ascending.
 *  `o`/`c` are the session's first open and last close; `h`/`l` the session's extremes.
 *  A date whose high <= low is a placeholder rather than a bar and is DROPPED: a flat "bar"
 *  would inject a fabricated true range. Non-positive open/close are dropped too. */
export function toDailyBars(
	rows: readonly { d: unknown; o: unknown; h: unknown; l: unknown; c: unknown }[],
): DailySessionBar[] {
	const out: DailySessionBar[] = [];
	for (const r of rows) {
		const date = toDateKey(r.d);
		if (date === null) continue;
		const open = num(r.o);
		const close = num(r.c);
		const high = num(r.h);
		const low = num(r.l);
		if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
		if (open === null || close === null || high === null || low === null) continue;
		if (open <= 0 || close <= 0) continue;
		if (!(high > low)) continue; // placeholder, not a bar
		out.push({ date, open, high, low, close });
	}
	return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** ATR over DAILY bars: mean of the last `period` true ranges.
 *  TR_i = max(high_i − low_i, |high_i − close_{i−1}|, |low_i − close_{i−1}|).
 *  Needs `period + 1` bars (one for the prior close). Returns null — never 0 — when it cannot
 *  be computed, with the exact reason. */
export function computeDailyAtr14(
	bars: readonly DailySessionBar[],
	period: number = DAILY_ATR_PERIOD,
): { atr14: number | null; used: number; refusal: GapAtrRefusal | null } {
	if (bars.length < 2) return { atr14: null, used: bars.length, refusal: 'NO_PRIOR_SESSIONS' };
	if (bars.length < period + 1) return { atr14: null, used: bars.length - 1, refusal: 'INSUFFICIENT_SESSIONS' };
	const trs: number[] = [];
	for (let i = bars.length - period; i < bars.length; i++) {
		const prev = bars[i - 1].close;
		trs.push(Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - prev), Math.abs(bars[i].low - prev)));
	}
	const atr = trs.reduce((a, b) => a + b, 0) / trs.length;
	if (!Number.isFinite(atr) || atr <= 0) return { atr14: null, used: trs.length, refusal: 'NO_ATR' };
	return { atr14: atr, used: trs.length, refusal: null };
}

/** gapAtr = (open − priorClose) / ATR14(prior sessions). Null — never 0 — whenever unavailable. */
export function computeGapAtr(input: {
	open: number | null;
	priorClose: number | null;
	priorBars: readonly DailySessionBar[];
	period?: number;
}): GapAtrResult {
	const { open, priorClose } = input;
	const base = { version: GAP_ATR_VERSION, gapAtr: null, gapPoints: null, atr14Daily: null, sessionsUsed: 0 };
	const o = num(open);
	if (o === null) return { ...base, refusal: 'NO_OPEN' };
	if (o <= 0) return { ...base, refusal: 'INVALID_OPEN' };
	const pc = num(priorClose);
	if (pc === null) return { ...base, refusal: 'NO_PRIOR_CLOSE' };
	if (pc <= 0) return { ...base, refusal: 'INVALID_PRIOR_CLOSE' };
	const { atr14, used, refusal } = computeDailyAtr14(input.priorBars, input.period ?? DAILY_ATR_PERIOD);
	if (atr14 === null) return { ...base, sessionsUsed: used, refusal: refusal ?? 'NO_ATR' };
	const gapPoints = o - pc;
	return { version: GAP_ATR_VERSION, gapAtr: gapPoints / atr14, gapPoints, atr14Daily: atr14, sessionsUsed: used, refusal: null };
}

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

	/** Prior session close for gap math: last stored tick strictly before the
	 *  given day's 09:15 IST open (from live+history, any earlier day). */
	private async priorClose(instrument: string, dayIso: string): Promise<number | null> {
		const openTime = new Date(`${dayIso}T09:15:00.000Z`);
		const live = await this.snaps.find({ where: { instrument, ts: LessThan(openTime) }, order: { ts: 'DESC' }, take: 1 }).catch(() => [] as FnfMarketSnapshot[]);
		const past = await this.hist.find({ where: { instrument, ts: LessThan(openTime) }, order: { ts: 'DESC' }, take: 1 }).catch(() => [] as FnfMarketSnapshotHistory[]);
		const cands = [...live, ...past].sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
		return cands.length ? Number(cands[0].price) : null;
	}

	/** Recorded PRIOR sessions as daily bars (one bar per IST date), oldest first.
	 *  Aggregated in SQL so an intraday-heavy session cannot flood the window, and bounded to the
	 *  last `DAILY_ATR_PERIOD + 2` session dates. Strictly `ts < that day's 09:15` — a bar stamped
	 *  09:15 on the queried day is the day's OWN bar and is excluded, so no look-ahead is possible.
	 *  GROUP_CONCAT takes the FIRST element in each direction and is ordered accordingly, so the
	 *  server's `group_concat_max_len` truncation cannot change the result. */
	private async priorDailyBars(instrument: string, dayIso: string): Promise<DailySessionBar[]> {
		const openTime = new Date(`${dayIso}T09:15:00.000Z`);
		const from = new Date(openTime.getTime() - DAILY_ATR_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
		const limit = DAILY_ATR_PERIOD + 2;
		const rows: { d: unknown; o: unknown; h: unknown; l: unknown; c: unknown }[] = [];
		const qb = this.hist.manager.connection.createQueryBuilder();
		for (const table of ['fnf_market_snapshots_history', 'fnf_market_snapshots']) {
			const part = await qb
				.select(`DATE_FORMAT(s.ts, '%Y-%m-%d')`, 'd')
				.addSelect(`SUBSTRING_INDEX(GROUP_CONCAT(s.open ORDER BY s.ts ASC SEPARATOR ','), ',', 1)`, 'o')
				.addSelect('MAX(s.high)', 'h')
				.addSelect('MIN(s.low)', 'l')
				.addSelect(`SUBSTRING_INDEX(GROUP_CONCAT(s.close ORDER BY s.ts DESC SEPARATOR ','), ',', 1)`, 'c')
				.from(table, 's')
				.where('s.instrument = :instrument', { instrument })
				.andWhere('s.ts >= :from', { from })
				.andWhere('s.ts < :openTime', { openTime })
				.groupBy('d')
				.orderBy('d', 'DESC')
				.limit(limit)
				.getRawMany()
				.catch(() => [] as never[]);
			rows.push(...(part as never[]));
		}
		// history wins for a shared date (a session is archived, then dropped from live)
		const byDate = new Map<string, DailySessionBar>();
		for (const b of toDailyBars(rows)) if (!byDate.has(b.date)) byDate.set(b.date, b);
		return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-(limit));
	}

	/** Full intraday feature set for an instrument on a day (default today IST). */
	async featuresFor(instrument: string, dayIso?: string): Promise<IntradayFeatures & { gapPct: number | null; priorClose: number | null; openPrice: number | null; atr14Daily: number | null; gapAtr: number | null; gapAtrVersion: string; gapAtrRefusal: string | null }> {
		const istNow = new Date(Date.now() + IST_OFFSET_MS);
		const day = dayIso ?? istNow.toISOString().slice(0, 10);
		const rows = await this.loadWindow(instrument, day);
		if (!rows.length) {
			return { instrument, day, asOfMin: 0, vwap: null, atr14: null, rangePct: null, orbs: { orb5: null, orb15: null, orb30: null }, barCount: 0, gapPct: null, priorClose: null, openPrice: null, atr14Daily: null, gapAtr: null, gapAtrVersion: GAP_ATR_VERSION, gapAtrRefusal: 'NO_OPEN' };
		}
		const asOfMin = Math.max(0, this.minOfDay(rows[rows.length - 1].ts) - OPEN_MIN);
		const prices = rows.map((r) => r.price);
		const rangePct = prices.length > 1 ? ((Math.max(...prices) - Math.min(...prices)) / (prices[0] || 1)) * 100 : null;
		const openPrice = rows[0]?.price ?? null;
		const priorClose = await this.priorClose(instrument, day);
		const gapPct = openPrice !== null && priorClose && priorClose > 0 ? ((openPrice - priorClose) / priorClose) * 100 : null;
		const gapAtr = computeGapAtr({ open: openPrice, priorClose, priorBars: await this.priorDailyBars(instrument, day) });
		return {
			instrument,
			day,
			asOfMin,
			vwap: this.vwap(rows),
			atr14: this.atr14(rows),
			rangePct,
			orbs: this.orbs(rows, asOfMin),
			barCount: rows.length,
			gapPct,
			priorClose,
			openPrice,
			atr14Daily: gapAtr.atr14Daily,
			gapAtr: gapAtr.gapAtr,
			gapAtrVersion: gapAtr.version,
			gapAtrRefusal: gapAtr.refusal,
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
