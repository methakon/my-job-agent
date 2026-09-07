/** Point-in-time decision snapshot carried through the deterministic → AI boundary.
 *  Everything is derived from the SAME calculation cycle as AlgoSignal; no second DB lookup.
 *  The snapshot is the single authoritative source for AI assessment input.
 */

/** Feature snapshot carried from deterministic calculation */
export interface JournalFeature {
	underlying: string;
	spot: number;
	sma20: number;
	sma5: number;
	momentumFrac: number | null;
	bars: number;
	lastBarMs: number;
}

/** Candidate snapshot with actual point-in-time quote data */
export interface JournalCandidate {
	symbol: string;
	premium: number;
	contractValue: number;
	spreadPct: number | null;
	delta: number | null;
	score: number;
	quoteTsMs?: number;
	quoteAgeMin?: number;
	bid?: number | null;
	ask?: number | null;
	mid?: number | null;
	ltp?: number;
	volume?: number;
	oi?: number;
	oiChange?: number | null;
	iv?: number | null;
	provider?: string;
	quality?: string;
}

/** Cycle metadata with actual timestamps and latencies */
export interface JournalCycle {
	startedAtMs: number;
	latencyMs: number | null;
	featureCutoffMs: number | null;
}

/** Decision snapshot produced by generateSignals, passed to AI and journal. */
export interface DecisionSnapshot {
	decisionId: string;
	asOf: Date;
	portfolioId?: string | null;
	portfolio: {
		label: string;
		capital: number;
		ceiling: number;
		deployed: number;
		netPnl: number;
		headroom: number;
		autoTradeEnabled: boolean;
		fridayTradingEnabled: boolean;
	};
	underlying: string;
	direction: {
		dir: 'CE' | 'PE';
		reason: string;
		conf: number;
		spot: number;
		sma20: number;
		sma5: number;
	};
	optionContract: {
		symbol: string;
		underlying: string;
		strike: number;
		expiry: string;
		optionType: 'CE' | 'PE';
		lotSize: number;
	};
	dte: number;
	actualQuote: {
		ltp: number;
		bid: number | null;
		ask: number | null;
		mid: number | null;
		volume: number;
		oi: number;
		oiChange: number | null;
		iv: number | null;
		provider: string;
		quoteTs: Date;
		quoteAgeMin: number;
		quality: string;
		spreadPct: number | null;
	};
	localGreeks: {
		delta: number | null;
		gamma: number | null;
		theta: number | null;
		vega: number | null;
		iv: number | null;
	};
	providerGreeks: {
		delta: number | null;
		gamma: number | null;
		theta: number | null;
		vega: number | null;
	};
	candidateScoring: {
		atmScore: number;
		expiryScore: number;
		greeksScore: number;
		totalScore: number;
		rank: number;
		totalCandidates: number;
	};
	confidence: {
		raw: number;
		decayed: number;
		rate: number;
		ageHours: number;
		timingFactor: number;
	};
	sessionPhase: string;
	cycle: JournalCycle;
	features: JournalFeature[];
	dataWarnings: string[];
	rejected: string[];
	winnerSymbol: string;
	algoSource: string;
	buildSha: string;
	sessionId?: string;
}
