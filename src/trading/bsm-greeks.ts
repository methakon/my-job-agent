/**
 * Local Black-Scholes-Merton Greeks + implied-volatility solver (T-09).
 *
 * Purpose: compute delta/gamma/theta/vega/IV locally from (spot, strike,
 * time-to-expiry, premium) so the desk can (a) score candidates on Greeks
 * even when the broker feed omits them, and (b) cross-check provider-supplied
 * Greeks for desynchronization (guidebook Gate 7 #4 pattern).
 *
 * European-style index options → BSM with continuous dividend q (index
 * approximated as q = 0 for NIFTY/BANKNIFTY futures-style margining; kept
 * parameterized). Risk-free rate is env-tunable (FNO_RISK_FREE_RATE, default
 * 6.5% p.a. INR proxy).
 */

export interface BsmInputs {
	spot: number; // underlying index level
	strike: number;
	years: number; // time to expiry in years (>0)
	rate?: number; // risk-free annual rate, default 0.065
	q?: number; // continuous dividend yield, default 0
}

export interface BsmGreeks {
	iv: number; // implied volatility (annualized), solved from premium when given
	delta: number; // call +, put −
	gamma: number;
	theta: number; // per calendar DAY (negative for longs)
	vega: number; // per 1 vol point (0.01)
	premium: number; // computed model price at solved IV
}

const N = (x: number): number => 0.5 * (1 + erf(x / Math.SQRT2));

function erf(x: number): number {
	// Abramowitz-Stegun 7.1.26 approximation (|err| ≤ 1.5e-7)
	const sign = x < 0 ? -1 : 1;
	x = Math.abs(x);
	const t = 1 / (1 + 0.3275911 * x);
	const y =
		1 -
		(((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
			t *
			Math.exp(-x * x);
	return sign * y;
}

function priceCall(S: number, K: number, T: number, r: number, q: number, v: number): number {
	if (T <= 0) return Math.max(0, S - K);
	if (v <= 0) return Math.max(0, Math.exp(-q * T) * S - Math.exp(-r * T) * K);
	const d1 = (Math.log(S / K) + (r - q + 0.5 * v * v) * T) / (v * Math.sqrt(T));
	const d2 = d1 - v * Math.sqrt(T);
	return S * Math.exp(-q * T) * N(d1) - K * Math.exp(-r * T) * N(d2);
}

function pricePut(S: number, K: number, T: number, r: number, q: number, v: number): number {
	if (T <= 0) return Math.max(0, K - S);
	if (v <= 0) return Math.max(0, Math.exp(-r * T) * K - Math.exp(-q * T) * S);
	const d1 = (Math.log(S / K) + (r - q + 0.5 * v * v) * T) / (v * Math.sqrt(T));
	const d2 = d1 - v * Math.sqrt(T);
	return K * Math.exp(-r * T) * N(-d2) - S * Math.exp(-q * T) * N(-d1);
}

/** Solve implied volatility (annualized) for a market premium via bisection. */
export function impliedVol(
	premium: number,
	{ spot, strike, years, rate = 0.065, q = 0 }: BsmInputs,
	optionType: 'CE' | 'PE',
): number | null {
	if (!Number.isFinite(premium) || premium <= 0 || years <= 0 || spot <= 0 || strike <= 0) return null;
	let lo = 0.001;
	let hi = 3.0; // 300% annualized ceiling
	const f = (v: number) => (optionType === 'CE' ? priceCall(spot, strike, years, rate, q, v) : pricePut(spot, strike, years, rate, q, v));
	// intrinsic floor: premium must at least cover intrinsic value, else IV is 0-ish
	const intrinsic = optionType === 'CE' ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
	if (premium < intrinsic) return 0;
	for (let i = 0; i < 64; i++) {
		const mid = (lo + hi) / 2;
		const p = f(mid);
		if (Math.abs(p - premium) < 1e-6) return mid;
		if (p < premium) lo = mid;
		else hi = mid;
	}
	return (lo + hi) / 2;
}

/** Full local Greeks at a given (or solved) IV. */
export function bsmGreeks(
	{ spot, strike, years, rate = 0.065, q = 0 }: BsmInputs,
	optionType: 'CE' | 'PE',
	ivOverride?: number,
): BsmGreeks | null {
	if (years <= 0 || spot <= 0 || strike <= 0) return null;
	const T = years;
	const r = rate;
	// IV: from a quote we need the premium — that's resolved by caller passing the
	// solved IV via ivOverride; without it we cannot produce Greeks (no premium arg here).
	if (!ivOverride || ivOverride <= 0) return null;
	const v = ivOverride;
	const sqT = Math.sqrt(T);
	const d1 = (Math.log(spot / strike) + (r - q + 0.5 * v * v) * T) / (v * sqT);
	const d2 = d1 - v * sqT;
	const pdf = Math.exp(-0.5 * d1 * d1) / Math.sqrt(2 * Math.PI);
	const isCall = optionType === 'CE';
	const nd1 = N(d1);
	const nd2 = N(d2);
	const nnegd1 = N(-d1);
	const nnegd2 = N(-d2);

	const delta = isCall
		? Math.exp(-q * T) * nd1
		: -Math.exp(-q * T) * nnegd1;
	const gamma = (Math.exp(-q * T) * pdf) / (spot * v * sqT);
	const theta =
		(isCall
			? -((spot * pdf * v * Math.exp(-q * T)) / (2 * sqT)) -
			  r * strike * Math.exp(-r * T) * nd2 +
			  q * spot * Math.exp(-q * T) * nd1
			: -((spot * pdf * v * Math.exp(-q * T)) / (2 * sqT)) +
			  r * strike * Math.exp(-r * T) * nnegd2 -
			  q * spot * Math.exp(-q * T) * nnegd1) / 365; // per calendar day
	const vega = (spot * Math.exp(-q * T) * pdf * sqT) / 100; // per 1 vol point
	const premium = isCall
		? priceCall(spot, strike, T, r, q, v)
		: pricePut(spot, strike, T, r, q, v);

	return { iv: v, delta, gamma, theta, vega, premium };
}

/** Convenience: solve IV from a live premium, then produce full Greeks. */
export function localGreeks(
	premium: number,
	inputs: BsmInputs,
	optionType: 'CE' | 'PE',
): BsmGreeks | null {
	const iv = impliedVol(premium, inputs, optionType);
	if (iv === null) return null;
	return bsmGreeks(inputs, optionType, iv);
}
