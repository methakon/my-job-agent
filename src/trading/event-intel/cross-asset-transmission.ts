/**
 * @module cross-asset-transmission
 * @purpose Dynamic cross-asset transmission graph for event intelligence
 * @purity Pure functions — no database, no I/O
 * @safety Paper-trading only. Transmission is evidence, not decision.
 *
 * Transmission chain: EVENT → USD/DXY → US RATES → INDIA RATES → INR → CRUDE → GOLD
 *   → GLOBAL EQUITY → ASIAN EQUITY → NIFTY/BANKNIFTY → FUTURES → OPTION SURFACE
 *
 * CRITICAL: Never hard-code direction (e.g. "crude up = NIFTY down").
 * Transmission must be conditioned by: event type, event cause, regime, observed response.
 */

import {
  EventRawRecord,
  TransmissionEdge,
  TransmissionGraph,
  TransmissionNode,
  DataAvailability,
} from './event-types';

/**
 * Default edges representing the canonical transmission chain.
 * Each edge is directional: from → to.
 */
const DEFAULT_EDGES: Array<{ from: TransmissionNode; to: TransmissionNode }> = [
  { from: 'USD_DXY', to: 'US_RATES' },
  { from: 'US_RATES', to: 'INDIA_RATES' },
  { from: 'INDIA_RATES', to: 'INR' },
  { from: 'INR', to: 'CRUDE' },
  { from: 'CRUDE', to: 'GOLD' },
  { from: 'GOLD', to: 'GLOBAL_EQUITY' },
  { from: 'GLOBAL_EQUITY', to: 'ASIAN_EQUITY' },
  { from: 'ASIAN_EQUITY', to: 'NIFTY' },
  { from: 'NIFTY', to: 'BANKNIFTY' },
  { from: 'BANKNIFTY', to: 'FUTURES' },
  { from: 'FUTURES', to: 'OPTION_SURFACE' },
];

/**
 * Event types that strongly activate specific transmission paths.
 * Used to weight edges dynamically — NOT to set sign.
 */
const EVENT_TRANSMISSION_BIASES: Partial<
  Record<string, Partial<Record<TransmissionNode, number>>>
> = {
  'CENTRAL_BANK': { US_RATES: 1.5, INDIA_RATES: 1.5, INR: 1.3 },
  'COMMODITIES': { CRUDE: 2.0, GOLD: 1.5, INR: 1.2 },
  'GEOPOLITICAL': { CRUDE: 1.8, GOLD: 1.5, USD_DXY: 1.3 },
  'MACRO': { USD_DXY: 1.5, US_RATES: 1.3, GLOBAL_EQUITY: 1.2 },
  'FINANCIAL_SYSTEM': { GLOBAL_EQUITY: 1.8, ASIAN_EQUITY: 1.5 },
  'INDIA': { NIFTY: 1.5, BANKNIFTY: 1.5, INR: 1.3, INDIA_RATES: 1.3 },
};

/**
 * Determine data availability state for a given asset.
 * Market closure is NOT a source failure.
 */
function assessDataAvailability(
  asset: TransmissionNode,
  marketData: Record<string, unknown>,
): DataAvailability {
  const value = marketData[asset];
  if (value === undefined || value === null) {
    const marketHoursAssets: TransmissionNode[] = ['NIFTY', 'BANKNIFTY', 'FUTURES', 'OPTION_SURFACE'];
    if (marketHoursAssets.includes(asset)) {
      return 'MARKET_CLOSED';
    }
    return 'SOURCE_UNAVAILABLE';
  }
  const tsKey = `${asset}_timestamp`;
  const ts = marketData[tsKey];
  if (ts && typeof ts === 'number') {
    const ageMs = Date.now() - ts;
    if (ageMs > 5 * 60 * 1000) return 'SOURCE_STALE';
  }
  return 'SOURCE_AVAILABLE';
}

/**
 * Calculate edge weight based on event type, regime, and data availability.
 */
function calculateEdgeWeight(
  edge: { from: TransmissionNode; to: TransmissionNode },
  eventOntology: string,
  regime: string,
  dataAvailability: Record<TransmissionNode, DataAvailability>,
): { weight: number; confidence: number } {
  const sourceAvail = dataAvailability[edge.from];
  const targetAvail = dataAvailability[edge.to];

  if (sourceAvail === 'SOURCE_UNAVAILABLE' || targetAvail === 'SOURCE_UNAVAILABLE') {
    return { weight: 0, confidence: 0 };
  }
  if (sourceAvail === 'SOURCE_STALE' || targetAvail === 'SOURCE_STALE') {
    return { weight: 0.3, confidence: 0.2 };
  }
  if (sourceAvail === 'MARKET_CLOSED' || targetAvail === 'MARKET_CLOSED') {
    return { weight: 0.1, confidence: 0.1 };
  }

  let weight = 1.0;
  let confidence = 0.5;

  const biases = EVENT_TRANSMISSION_BIASES[eventOntology];
  if (biases) {
    const sourceBias = biases[edge.from] ?? 1.0;
    const targetBias = biases[edge.to] ?? 1.0;
    weight *= (sourceBias + targetBias) / 2;
  }

  if (regime === 'HIGH_VOL') {
    weight *= 1.3;
    confidence *= 1.2;
  } else if (regime === 'LOW_VOL') {
    weight *= 0.8;
    confidence *= 0.9;
  } else if (regime === 'RISK_OFF') {
    if (edge.to === 'GOLD' || edge.to === 'USD_DXY') {
      weight *= 1.5;
    }
  }

  return { weight: Math.min(weight, 3.0), confidence: Math.min(confidence, 1.0) };
}

/**
 * Build a dynamic transmission graph for a given event and market state.
 *
 * @pure Yes — no side effects, no I/O
 */
export function buildTransmissionGraph(
  events: EventRawRecord[],
  marketData: Record<string, unknown>,
  regime: string = 'UNKNOWN',
): TransmissionGraph {
  const primaryOntology = events.length > 0
    ? classifyOntologyFromRaw(events[0])
    : 'MACRO';

  const allNodes: TransmissionNode[] = [
    'USD_DXY', 'US_RATES', 'INDIA_RATES', 'INR', 'CRUDE', 'GOLD',
    'GLOBAL_EQUITY', 'ASIAN_EQUITY', 'NIFTY', 'BANKNIFTY', 'FUTURES', 'OPTION_SURFACE',
  ];
  const nodeAvailabilityMap = new Map<TransmissionNode, DataAvailability>();
  const dataAvailability: Record<TransmissionNode, DataAvailability> = {} as any;
  for (const node of allNodes) {
    const avail = assessDataAvailability(node, marketData);
    dataAvailability[node] = avail;
    nodeAvailabilityMap.set(node, avail);
  }

  const edges: TransmissionEdge[] = DEFAULT_EDGES.map((edge) => {
    const { weight, confidence } = calculateEdgeWeight(
      edge, primaryOntology, regime, dataAvailability,
    );
    return {
      from: edge.from,
      to: edge.to,
      leadLag: 0,
      rollingCorrelation: 0,
      eventSpecificSensitivity: weight,
      sign: 1 as const, // Default positive; actual sign observed from response
      confidence,
      regime,
      timeDecay: 0.9,
    };
  });

  return {
    edges,
    nodeAvailability: nodeAvailabilityMap,
    regime,
    calculatedAtMs: Date.now(),
  };
}

/**
 * Simple ontology classification from raw record.
 * Does NOT reduce to bullish/bearish — just determines event category.
 */
function classifyOntologyFromRaw(raw: EventRawRecord): string {
  const text = `${raw.title ?? ''} ${raw.body ?? ''}`.toLowerCase();

  if (/rbi|federal reserve|fed rate|ecb|boe|boj|pboc|central bank|monetary policy|interest rate|repo rate/i.test(text)) {
    return 'CENTRAL_BANK';
  }
  if (/crude|oil|opec|gold|silver|copper|commodity/i.test(text)) {
    return 'COMMODITIES';
  }
  if (/war|conflict|sanction|geopolit|military|nato|missile/i.test(text)) {
    return 'GEOPOLITICAL';
  }
  if (/cpi|gdp|inflation|employment|unemployment|trade balance|fiscal|budget/i.test(text)) {
    return 'MACRO';
  }
  if (/bank|systemic|leverage|margin|counterparty|liquidity crisis/i.test(text)) {
    return 'FINANCIAL_SYSTEM';
  }
  if (/nifty|banknifty|nse|bse|sebi|indian|india|sensex|reliance|tcs|hdfc/i.test(text)) {
    return 'INDIA';
  }
  if (/tick|volume|spread|order|bid|ask|microstructure/i.test(text)) {
    return 'MICROSTRUCTURE';
  }

  return 'MACRO';
}

/**
 * Reconcile overnight event state with morning opening data.
 * Called at market open (09:15 IST) to merge overnight events with actual opening prices.
 *
 * @pure Yes — no side effects
 */
export function reconcileOvernightWithOpening(
  overnightEvents: EventRawRecord[],
  openingData: Record<string, unknown>,
): {
  reconciled: boolean;
  adjustments: string[];
  confidenceChange: number;
} {
  const adjustments: string[] = [];
  let confidenceChange = 0;

  for (const event of overnightEvents) {
    const niftyOpen = openingData['NIFTY_open'] as number | undefined;
    const niftyPrevClose = openingData['NIFTY_prev_close'] as number | undefined;

    if (niftyOpen !== undefined && niftyPrevClose !== undefined) {
      const gap = (niftyOpen - niftyPrevClose) / niftyPrevClose;
      if (Math.abs(gap) > 0.01) {
        adjustments.push(`Significant NIFTY gap (${(gap * 100).toFixed(2)}%) confirms overnight event impact`);
        confidenceChange += 0.1;
      } else {
        adjustments.push(`NIFTY gap minimal (${(gap * 100).toFixed(2)}%), overnight event may have limited impact`);
        confidenceChange -= 0.05;
      }
    }
  }

  return {
    reconciled: true,
    adjustments,
    confidenceChange: Math.max(-0.5, Math.min(0.5, confidenceChange)),
  };
}
