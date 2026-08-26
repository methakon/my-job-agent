import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as Astronomy from 'astronomy-engine';
import { MuhurtaWindow } from './muhurta-window.entity';

/**
 * AstroMuhurtaService — computes live Vedic panchanga for the user's birth
 * location and derives shubh (auspicious) application windows, Parashari
 * panchanga rules. Pure-JS ephemeris (astronomy-engine) — math aligned with
 * the MyLife shared ephemeris (services/shared/src/ephemeris.ts): dynamic
 * Lahiri ayanamsa, true geocentric ecliptic-of-date, tithi 1–15 + paksha.
 *
 * Birth data (user): b. 9 Dec 1981, 01:00 IST, Berhampore 24.1N 88.25E.
 * Lagna = Virgo (index 5), so house-from-lagna = (moonSign - 5 + 12) % 12 + 1.
 *
 * Shubh muhurta = the most suitable windows OF THE DAY (user rule: there can
 * be several in one day, and the agent bombs all approved applications inside
 * the first open shubh window). Rules (defaults; docs/REQUIREMENTS.md FR-16):
 * - HARD VETO: rahu kala, yamaganda, amavasya (krishna 15), ganda-mula
 *   nakshatras (Mula, Ashlesha, Jyeshtha, Magha) — score 0.
 * - Gulika kala −15.
 * - +tithi: shubha tithis (2,3,5,7,10,11,13) +25, neutral (1,15) +15, else +5
 * - +nakshatra: shubha nakshatras +20, neutral +10 (ganda-mula = veto)
 * - +weekday: Mon/Wed/Thu/Fri +10, Sun +5, Tue/Sat 0
 * - +Moon in 1/3/6/10/11 from lagna +10
 * - base 45; shubh iff score >= 65 — an inauspicious day has no window,
 *   a good day has several (multiple per day is the user rule).
 */
export interface MuhurtaAssessment {
	/** instant evaluated (UTC) */
	at: Date;
	/** 0–100 */
	score: number;
	shubh: boolean;
	tithi: number;
	paksha: 'shukla' | 'krishna';
	nakshatra: string;
	/** weekday name in IST (Asia/Kolkata, fixed +5:30) */
	weekday: string;
	/** house number of Moon counted from Virgo lagna (1–12) */
	moonHouse: number;
	rahuKala: boolean;
	yamaganda: boolean;
	gulika: boolean;
	reasons: string[];
}

export interface MuhurtaWindowDto {
	startsAt: Date;
	endsAt: Date;
	score: number;
	tithi: number;
	nakshatra: string;
	weekday: string;
	reasons: string[];
}

const LAGNA_INDEX = 5; // Virgo (Aries=0 … Pisces=11)
const SHUBH_MIN_SCORE = Number(process.env.SHUBH_MIN_SCORE ?? 65);
const STEP_MINUTES = 10; // scan granularity when finding windows
const LON = 88.25;
const LAT = 24.1;
const IST_OFFSET_MIN = 330; // UTC+5:30

/** Lahiri ayanamsa (Chitrapaksha) — same linear approximation as MyLife's shared ephemeris. */
function lahiriAyanamsa(date: Date): number {
	const jd = date.getTime() / 86400000 + 2440587.5;
	const yearsSince1900 = (jd - 2415020.5) / 365.25;
	return ((22.460148 + yearsSince1900 * (50.2909 / 3600)) % 360 + 360) % 360;
}

function norm360(x: number): number {
	return ((x % 360) + 360) % 360;
}

/** True geocentric ecliptic-of-date longitude — identical to MyLife's geoEclipticLongitude. */
function geoEclipticLongitude(body: Astronomy.Body, date: Date): number {
	const t = Astronomy.MakeTime(date);
	const ecl = Astronomy.Ecliptic(Astronomy.GeoVector(body, t, true));
	return norm360(ecl.elon);
}

const AUSPICIOUS_TITHIS = new Set([2, 3, 5, 7, 10, 11, 13]);
const NEUTRAL_TITHIS = new Set([1, 15]);
const AUSPICIOUS_NAKS = new Set([
	'Rohini', 'Mrigashira', 'Punarvasu', 'Pushya', 'Uttara Phalguni',
	'Hasta', 'Swati', 'Anuradha', 'Shravana', 'Dhanishta', 'Shatabhisha',
	'Uttara Ashadha', 'Uttara Bhadrapada', 'Revati',
]);
/** ganda-mula nakshatras — hard veto for new beginnings */
const GANDA_MULA_NAKS = new Set(['Mula', 'Ashlesha', 'Jyeshtha', 'Magha']);
const FAVORABLE_WEEKDAYS = new Set(['Monday', 'Wednesday', 'Thursday', 'Friday']);
const NEUTRAL_WEEKDAYS = new Set(['Sunday']);
const FAVORABLE_MOON_HOUSES = new Set([1, 3, 6, 10, 11]);

const NAKSHATRAS = [
	'Ashwini', 'Bharani', 'Krittika', 'Rohini', 'Mrigashira', 'Ardra',
	'Punarvasu', 'Pushya', 'Ashlesha', 'Magha', 'Purva Phalguni', 'Uttara Phalguni',
	'Hasta', 'Chitra', 'Swati', 'Vishakha', 'Anuradha', 'Jyeshtha',
	'Mula', 'Purva Ashadha', 'Uttara Ashadha', 'Shravana', 'Dhanishta', 'Shatabhisha',
	'Purva Bhadrapada', 'Uttara Bhadrapada', 'Revati',
];

/** 1/8-day inauspicious segments indexed by IST weekday (0=Sunday). */
const RAHU_SEGMENT = [8, 2, 7, 5, 6, 4, 3]; // Sun..Sat
const YAMAGANDA_SEGMENT = [5, 4, 3, 2, 1, 7, 6]; // Sun..Sat
const GULIKA_SEGMENT = [7, 6, 5, 4, 3, 2, 1]; // Sun..Sat

@Injectable()
export class AstroMuhurtaService {
	private readonly logger = new Logger(AstroMuhurtaService.name);

	constructor(
		@InjectRepository(MuhurtaWindow) private readonly windowRepo: Repository<MuhurtaWindow>,
	) {}

	// ---------------------------------------------------------------- panchanga

	private siderealMoonLon(at: Date): number {
		return norm360(geoEclipticLongitude(Astronomy.Body.Moon, at) - lahiriAyanamsa(at));
	}

	private siderealSunLon(at: Date): number {
		return norm360(geoEclipticLongitude(Astronomy.Body.Sun, at) - lahiriAyanamsa(at));
	}

	/** tithi 1–15 + paksha (shukla/krishna), MyLife convention (amavasya = krishna 15). */
	private computeTithi(at: Date): { tithi: number; paksha: 'shukla' | 'krishna' } {
		const elong = norm360(this.siderealMoonLon(at) - this.siderealSunLon(at));
		const tithiIndex = Math.floor(elong / 12); // 0–29
		const paksha = tithiIndex < 15 ? 'shukla' : 'krishna';
		const tithi = (tithiIndex % 15) + 1;
		return { tithi, paksha };
	}

	/** Full tithi state (amavasya = krishna 15). */
	private tithiState(at: Date): { index: number; tithi: number; paksha: 'shukla' | 'krishna'; isAmavasya: boolean } {
		const elong = norm360(this.siderealMoonLon(at) - this.siderealSunLon(at));
		const tithiIndex = Math.floor(elong / 12);
		const paksha = tithiIndex < 15 ? 'shukla' : 'krishna';
		const tithi = (tithiIndex % 15) + 1;
		return { index: tithiIndex, tithi, paksha, isAmavasya: tithiIndex === 29 };
	}

	private computeNakshatra(at: Date): string {
		const moon = this.siderealMoonLon(at);
		const idx = Math.min(26, Math.floor(moon / (360 / 27)));
		return NAKSHATRAS[idx];
	}

	/** Moon's house counted from Virgo lagna (1–12). */
	private moonHouse(at: Date): number {
		const moon = this.siderealMoonLon(at);
		const sign = Math.floor(moon / 30); // 0=Aries … 11=Pisces
		return ((sign - LAGNA_INDEX + 12) % 12) + 1;
	}

	/** Weekday name at `at` in IST. */
	private istWeekday(at: Date): string {
		const ist = new Date(at.getTime() + IST_OFFSET_MIN * 60_000);
		return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][ist.getUTCDay()];
	}

	/** Sunrise/sunset (UTC) at Berhampore for the IST day containing `at`. */
	private daylightBounds(at: Date): { rise: Date; set: Date } | null {
		// IST day start/end → candidate search window in UTC
		const istStart = new Date(at.getTime() + IST_OFFSET_MIN * 60_000);
		istStart.setUTCHours(0, 0, 0, 0);
		const dayStartUtc = new Date(istStart.getTime() - IST_OFFSET_MIN * 60_000);
		const dayEndUtc = new Date(dayStartUtc.getTime() + 24 * 3600 * 1000);
		const observer = new Astronomy.Observer(LAT, LON, 0);
		try {
			const rise = Astronomy.SearchRiseSet(Astronomy.Body.Sun, observer, +1, dayStartUtc, 1.2);
			const set = Astronomy.SearchRiseSet(Astronomy.Body.Sun, observer, -1, dayStartUtc, 1.2);
			if (!rise || !set) return null;
			const riseDate = rise.date;
			const setDate = set.date;
			// guard against set landing in next IST day
			return { rise: riseDate, set: setDate > dayEndUtc ? dayEndUtc : setDate };
		} catch {
			return null;
		}
	}

	/** Which 1/8-day inauspicious segment contains `at` (null = none). */
	private inauspiciousSegment(at: Date): { kind: 'rahu' | 'yamaganda' | 'gulika'; segment: number } | null {
		const bounds = this.daylightBounds(at);
		if (!bounds) return null;
		const dayMs = bounds.set.getTime() - bounds.rise.getTime();
		if (dayMs <= 0) return null;
		const segLen = dayMs / 8;
		const idx = Math.floor((at.getTime() - bounds.rise.getTime()) / segLen) + 1;
		if (idx < 1 || idx > 8) return null;
		const weekdayIdx = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].indexOf(this.istWeekday(at));
		if (RAHU_SEGMENT[weekdayIdx] === idx) return { kind: 'rahu', segment: idx };
		if (YAMAGANDA_SEGMENT[weekdayIdx] === idx) return { kind: 'yamaganda', segment: idx };
		if (GULIKA_SEGMENT[weekdayIdx] === idx) return { kind: 'gulika', segment: idx };
		return null;
	}

	// ---------------------------------------------------------------- scoring

	/** Full assessment of a single instant. */
	assess(at: Date): MuhurtaAssessment {
		const { tithi, paksha, isAmavasya } = this.tithiState(at);
		const nakshatra = this.computeNakshatra(at);
		const weekday = this.istWeekday(at);
		const moonHouse = this.moonHouse(at);
		const seg = this.inauspiciousSegment(at);
		const rahuKala = seg?.kind === 'rahu';
		const yamaganda = seg?.kind === 'yamaganda';
		const gulika = seg?.kind === 'gulika';
		const reasons: string[] = [];

		let score = 45; // base — a normal day starts at 45, factors move it up
		// tithi
		if (AUSPICIOUS_TITHIS.has(tithi)) { score += 25; reasons.push(`tithi ${paksha} ${tithi} shubha (+25)`); }
		else if (NEUTRAL_TITHIS.has(tithi)) { score += 15; reasons.push(`tithi ${paksha} ${tithi} neutral (+15)`); }
		else { score += 5; reasons.push(`tithi ${paksha} ${tithi} ashubha (+5)`); }
		// nakshatra
		if (AUSPICIOUS_NAKS.has(nakshatra)) { score += 20; reasons.push(`nakshatra ${nakshatra} shubha (+20)`); }
		else if (GANDA_MULA_NAKS.has(nakshatra)) { reasons.push(`nakshatra ${nakshatra} ganda-mula — VETO`); }
		else { score += 10; reasons.push(`nakshatra ${nakshatra} neutral (+10)`); }
		// weekday
		if (FAVORABLE_WEEKDAYS.has(weekday)) { score += 10; reasons.push(`weekday ${weekday} shubha (+10)`); }
		else if (NEUTRAL_WEEKDAYS.has(weekday)) { score += 5; reasons.push(`weekday ${weekday} neutral (+5)`); }
		else reasons.push(`weekday ${weekday} (Tue/Sat 0)`);
		// moon house from lagna
		if (FAVORABLE_MOON_HOUSES.has(moonHouse)) { score += 10; reasons.push(`Moon in house ${moonHouse} from lagna (+10)`); }
		else reasons.push(`Moon in house ${moonHouse} from lagna`);

		// inauspicious segments
		if (rahuKala) { score = 0; reasons.push(`RAHU KALA (segment ${seg!.segment}) — VETO`); }
		else if (yamaganda) { score = 0; reasons.push(`YAMAGANDA (segment ${seg!.segment}) — VETO`); }
		else if (gulika) { score = Math.max(0, score - 15); reasons.push(`Gulika kala (segment ${seg!.segment}) — −15`); }
		if (isAmavasya) { score = 0; reasons.push('AMAVASYA (krishna 15) — VETO'); }
		if (GANDA_MULA_NAKS.has(nakshatra)) { score = 0; reasons.push(`GANDA-MULA nakshatra — VETO`); }

		// shubh muhurta = score above threshold. The base+factors scoring
		// naturally blocks flat inauspicious stretches (bad tithi + bad
		// nakshatra + bad weekday ≈ 60 < threshold) and hard vetoes, while
		// good days yield several windows (user rule: multiple per day).
		const shubh = score >= SHUBH_MIN_SCORE;

		return {
			at, score: Math.min(100, Math.max(0, score)),
			shubh,
			tithi, paksha, nakshatra, weekday, moonHouse,
			rahuKala, yamaganda, gulika, reasons,
		};
	}

	// ---------------------------------------------------------------- windows

	/**
	 * Find shubh windows in [from, from+hours]. Scans every STEP_MINUTES,
	 * merges contiguous shubh slots, persists them, returns DTOs.
	 */
	async nextWindows(from: Date, hours = 24): Promise<MuhurtaWindowDto[]> {
		const end = new Date(from.getTime() + hours * 3600 * 1000);
		const slots: MuhurtaAssessment[] = [];
		for (let t = from.getTime(); t < end.getTime(); t += STEP_MINUTES * 60_000) {
			slots.push(this.assess(new Date(t)));
		}
		// merge contiguous shubh slots
		const windows: MuhurtaWindowDto[] = [];
		let cur: MuhurtaAssessment[] = [];
		for (const s of slots) {
			if (s.shubh) {
				cur.push(s);
			} else if (cur.length) {
				windows.push(this.toWindow(cur));
				cur = [];
			}
		}
		if (cur.length) windows.push(this.toWindow(cur));
		// persist for audit/dashboard
		for (const w of windows) {
			await this.windowRepo.save(this.windowRepo.create({
				startsAt: w.startsAt,
				endsAt: w.endsAt,
				score: w.score,
				tithi: w.tithi,
				nakshatra: w.nakshatra,
				weekday: w.weekday,
				reasonsJson: JSON.stringify(w.reasons),
			}));
		}
		this.logger.log(`muhurta: ${windows.length} shubh windows in next ${hours}h`);
		return windows;
	}

	/** First shubh window strictly after `from` (or null if none in 24h). */
	async nextWindow(from: Date, hours = 24): Promise<MuhurtaWindowDto | null> {
		const windows = await this.nextWindows(from, hours);
		return windows[0] ?? null;
	}

	private toWindow(slots: MuhurtaAssessment[]): MuhurtaWindowDto {
		const first = slots[0];
		const last = slots[slots.length - 1];
		const score = Math.round(slots.reduce((a, s) => a + s.score, 0) / slots.length);
		return {
			startsAt: first.at,
			endsAt: new Date(last.at.getTime() + STEP_MINUTES * 60_000),
			score,
			tithi: first.tithi,
			nakshatra: first.nakshatra,
			weekday: first.weekday,
			reasons: first.reasons,
		};
	}

	/** Most recently persisted windows (for the API without recompute). */
	latest(limit = 10): Promise<MuhurtaWindow[]> {
		return this.windowRepo.find({ order: { startsAt: 'ASC' }, take: limit });
	}

	/** Short human label of the next window, e.g. "shubh 18:30–19:50 IST". */
	describeNext(from: Date): string {
		const a = this.assess(from);
		if (a.shubh) {
			return `now (${a.weekday}, tithi ${a.tithi} ${a.paksha}, ${a.nakshatra})`;
		}
		return `not now (${a.weekday}, tithi ${a.tithi} ${a.paksha}, ${a.nakshatra}, score ${a.score})`;
	}
}
