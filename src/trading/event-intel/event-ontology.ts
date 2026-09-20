/**
 * Event Ontology — Event Classification
 *
 * PURE: No clock, no I/O, no DB, no network, no randomness.
 * Deterministic: same inputs → same outputs.
 *
 * SAFETY: NEVER reduce to bullish/bearish. Event is evidence, not decision.
 * The classifier assigns ontology and features but does NOT make trade decisions.
 */

import {
  EventFeatures,
  EventOntology,
  EventRawRecord,
  EventLifecycle,
  TransmissionNode,
  TransmissionPath,
} from './event-types';

// ── Classification Keywords ──────────────────────────────────────────────────

/** Keyword sets for each ontology. Matched case-insensitively. */
const ONTOLOGY_KEYWORDS: ReadonlyMap<EventOntology, readonly string[]> = new Map([
  ['MACRO', [
    'gdp', 'inflation', 'cpi', 'ppi', 'employment', 'unemployment',
    'retail sales', 'industrial production', 'pmi', 'ism',
    'consumer confidence', 'housing', 'trade balance',
    'current account', 'fiscal deficit', 'government spending',
    'tax', 'tariff', 'sanctions', 'economic growth',
  ]],
  ['CENTRAL_BANK', [
    'rbi', 'reserve bank', 'fed', 'federal reserve', 'ecb',
    'interest rate', 'rate cut', 'rate hike', 'monetary policy',
    'repo rate', 'reverse repo', 'ltro', 'qe', 'quantitative easing',
    'taper', 'fomc', 'mpc', 'policy rate', 'basis point', 'bps',
    'rate decision', 'pause', 'hawkish', 'dovish',
  ]],
  ['GEOPOLITICAL', [
    'war', 'conflict', 'military', 'sanctions', 'embargo',
    'diplomacy', 'election', 'coup', 'protest', 'cabinet',
    'trade war', 'treaty', 'alliance', 'border', 'territorial',
    'missile', 'nuclear', 'nato', 'summit',
  ]],
  ['COMMODITIES', [
    'crude', 'oil', 'brent', 'wti', 'natural gas', 'lng',
    'gold', 'silver', 'copper', 'aluminum', 'iron ore',
    'palm oil', 'rubber', 'wheat', 'corn', 'soybean',
    'opec', 'supply cut', 'production cut', 'demand',
    'inventory', 'stockpile', 'barrel',
  ]],
  ['FINANCIAL_SYSTEM', [
    'bank', 'banking crisis', 'credit', 'liquidity', 'repo',
    'margin', 'leverage', 'default', 'downgrade', 'rating',
    'securities', 'etf', 'fund', 'hedge fund', 'margin call',
    'counterparty', 'systemic', 'contagion', 'volatility',
    'vix', 'fear', 'panic', 'sell-off', 'correction',
  ]],
  ['INDIA', [
    'nifty', 'sensex', 'bank nifty', 'nse', 'bse', 'sebi',
    'indiaindia', 'modi', 'parliament', 'gst', 'budget',
    'rupee', 'inr', 'fpi', 'fii', 'dii', 'fandoo',
    'earnings', 'results', 'tata', 'reliance', 'icici',
    'hdfc', ' infosys', 'wipro', 'tcs', 'sbi',
    'india', 'indian', 'mumbai', 'delhi',
  ]],
  ['MICROSTRUCTURE', [
    'bid-ask', 'spread', 'volume', 'liquidity', 'depth',
    'order book', 'tick', 'quote', 'cancellation',
    'sweep', 'iceberg', 'dark pool', 'block trade',
    'options flow', 'unusual activity', 'dark',
    'implied volatility', 'skew', 'term structure',
  ]],
]);

// ── Country Detection ────────────────────────────────────────────────────────

const COUNTRY_KEYWORDS: ReadonlyMap<string, readonly string[]> = new Map([
  ['IN', ['india', 'indian', 'nse', 'bse', 'mumbai', 'delhi', 'rbi', 'sebi']],
  ['US', ['usa', 'united states', 'fed', 'federal reserve', 'wall street', 'nyse', 'nasdaq', 'cme']],
  ['CN', ['china', 'chinese', 'pboc', 'hang seng', 'shanghai']],
  ['EU', ['eurozone', 'ecb', 'european union', 'euro', 'germany', 'france']],
  ['JP', ['japan', 'japanese', 'boj', 'nikkei', 'yen']],
  ['SA', ['saudi', 'opec', 'middle east', 'gulf']],
  ['RU', ['russia', 'russian', 'moscow']],
]);

// ── Classification Functions ─────────────────────────────────────────────────

/**
 * Classify a raw event record into an EventOntology.
 *
 * PURE: Yes. Deterministic: Yes.
 *
 * Uses keyword matching on title and body. Returns the ontology with
 * the highest keyword match count. Falls back to 'MACRO' for
 * unclassifiable events (better to over-classify than lose events).
 */
export function classifyEvent(rawRecord: EventRawRecord): EventOntology {
  const text = `${rawRecord.title} ${rawRecord.body}`.toLowerCase();

  let bestOntology: EventOntology = 'MACRO';
  let bestScore = 0;

  for (const [ontology, keywords] of ONTOLOGY_KEYWORDS) {
    let score = 0;
    for (const keyword of keywords) {
      if (text.includes(keyword)) {
        score += 1;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestOntology = ontology;
    }
  }

  return bestOntology;
}

// ── Feature Extraction ───────────────────────────────────────────────────────

/**
 * Extract structured features from a raw event record.
 *
 * PURE: Yes. Deterministic: Yes.
 *
 * Returns a rich feature set without making any trading decisions.
 * The features are inputs to downstream analysis (surprise, forecast,
 * transmission) — they are NEVER the output themselves.
 */
export function extractEventFeatures(rawRecord: EventRawRecord): EventFeatures {
  const text = `${rawRecord.title} ${rawRecord.body}`.toLowerCase();
  const ontology = classifyEvent(rawRecord);

  return {
    eventType: ontology,
    eventSubtype: extractSubtype(text, ontology),
    countries: extractCountries(text),
    institutions: extractInstitutions(text),
    companies: extractCompanies(text),
    assets: extractAssets(text),
    action: extractAction(text),
    magnitude: extractMagnitude(text),
    severity: estimateSeverity(text, rawRecord.sourceTier),
    supplyDemandChannel: extractSupplyDemandChannel(text, ontology),
    scheduled: detectScheduled(text, rawRecord.sourceType),
    officialStatus: determineOfficialStatus(rawRecord),
    novelty: 0.5, // Default — computed by surprise engine
    sourceReliability: tierToReliability(rawRecord.sourceTier),
    contradictoryStatements: detectContradictions(text),
    transmissionPaths: inferTransmissionPaths(ontology, extractAssets(text), extractCountries(text)),
  };
}

// ── Helper Extraction Functions ───────────────────────────────────────────────

function extractSubtype(text: string, ontology: EventOntology): string {
  if (ontology === 'CENTRAL_BANK') {
    if (text.includes('rate cut') || text.includes('rate hike') || text.includes('rate decision')) {
      return 'RATE_DECISION';
    }
    if (text.includes('minutes') || text.includes('transcript')) {
      return 'MINUTES';
    }
    if (text.includes('speech') || text.includes('remarks')) {
      return 'SPEECH';
    }
    return 'POLICY_STATEMENT';
  }

  if (ontology === 'MACRO') {
    if (text.includes('cpi') || text.includes('inflation')) return 'INFLATION_DATA';
    if (text.includes('employment') || text.includes('unemployment') || text.includes('nfp')) return 'EMPLOYMENT_DATA';
    if (text.includes('gdp')) return 'GDP_DATA';
    if (text.includes('pmi')) return 'PMI_DATA';
    return 'MACRO_DATA';
  }

  if (ontology === 'GEOPOLITICAL') {
    if (text.includes('war') || text.includes('conflict')) return 'CONFLICT';
    if (text.includes('election') || text.includes('vote')) return 'ELECTION';
    if (text.includes('sanction') || text.includes('embargo')) return 'SANCTIONS';
    return 'GEOPOLITICAL_EVENT';
  }

  if (ontology === 'COMMODITIES') {
    if (text.includes('opec') || text.includes('production cut')) return 'OPEC_DECISION';
    if (text.includes('inventory') || text.includes('stockpile')) return 'INVENTORY_DATA';
    return 'COMMODITY_MOVE';
  }

  if (ontology === 'INDIA') {
    if (text.includes('budget')) return 'BUDGET';
    if (text.includes('results') || text.includes('earnings')) return 'EARNINGS';
    if (text.includes('fpi') || text.includes('fii') || text.includes('dii')) return 'FLOWS';
    return 'INDIA_EVENT';
  }

  return 'GENERAL';
}

function extractCountries(text: string): readonly string[] {
  const countries: string[] = [];
  for (const [code, keywords] of COUNTRY_KEYWORDS) {
    for (const kw of keywords) {
      if (text.includes(kw)) {
        countries.push(code);
        break;
      }
    }
  }
  return countries.length > 0 ? countries : ['GLOBAL'];
}

function extractInstitutions(text: string): readonly string[] {
  const institutions: string[] = [];
  const patterns: ReadonlyMap<string, readonly string[]> = new Map([
    ['RBI', ['rbi', 'reserve bank of india']],
    ['FED', ['federal reserve', 'fed', 'fomc']],
    ['ECB', ['ecb', 'european central bank']],
    ['BOJ', ['boj', 'bank of japan']],
    ['SEBI', ['sebi']],
    ['OPEC', ['opec']],
    ['IMF', ['imf']],
    ['WORLD_BANK', ['world bank']],
    ['US_TREASURY', ['treasury', 'us treasury']],
  ]);

  for (const [inst, keywords] of patterns) {
    for (const kw of keywords) {
      if (text.includes(kw)) {
        institutions.push(inst);
        break;
      }
    }
  }
  return institutions;
}

function extractCompanies(text: string): readonly string[] {
  const companies: string[] = [];
  const knownCompanies: ReadonlyMap<string, readonly string[]> = new Map([
    ['RELIANCE', ['reliance']],
    ['TCS', ['tcs', 'tata consultancy']],
    ['INFOSYS', ['infosys']],
    ['HDFC', ['hdfc']],
    ['ICICI', ['icici']],
    ['SBI', ['state bank', 'sbi']],
    ['TATA', ['tata']],
    ['WIPRO', ['wipro']],
    ['ITC', ['itc']],
    ['BHARTI', ['bharti', 'airtel']],
  ]);

  for (const [company, keywords] of knownCompanies) {
    for (const kw of keywords) {
      if (text.includes(kw)) {
        companies.push(company);
        break;
      }
    }
  }
  return companies;
}

function extractAssets(text: string): readonly string[] {
  const assets: string[] = [];
  const assetPatterns: ReadonlyMap<string, readonly string[]> = new Map([
    ['NIFTY', ['nifty 50', 'nifty']],
    ['BANKNIFTY', ['bank nifty', 'banknifty']],
    ['SENSEX', ['sensex']],
    ['USD_INR', ['usd/inr', 'dollar rupee', 'inr', 'rupee']],
    ['CRUDE', ['crude', 'brent', 'wti', 'oil']],
    ['GOLD', ['gold']],
    ['SILVER', ['silver']],
    ['US_10Y', ['us 10y', 'treasury yield', 'us treasury']],
    ['DXY', ['dxy', 'dollar index']],
  ]);

  for (const [asset, keywords] of assetPatterns) {
    for (const kw of keywords) {
      if (text.includes(kw)) {
        assets.push(asset);
        break;
      }
    }
  }
  return assets.length > 0 ? assets : ['EQUITY'];
}

function extractAction(text: string): string {
  if (text.includes('cut') || text.includes('reduce') || text.includes('decrease')) return 'REDUCE';
  if (text.includes('raise') || text.includes('increase') || text.includes('hike')) return 'INCREASE';
  if (text.includes('pause') || text.includes('hold') || text.includes('unchanged')) return 'HOLD';
  if (text.includes('announce') || text.includes('declare')) return 'ANNOUNCE';
  if (text.includes('deny') || text.includes('reject') || text.includes('refute')) return 'DENY';
  if (text.includes('confirm') || text.includes('verify')) return 'CONFIRM';
  return 'GENERAL';
}

function extractMagnitude(text: string): number | null {
  // Try to find basis points
  const bpsMatch = text.match(/(\d+)\s*(?:bps|basis\s*points?)/i);
  if (bpsMatch) {
    return parseInt(bpsMatch[1], 10);
  }

  // Try percentage
  const pctMatch = text.match(/(\d+\.?\d*)\s*%/);
  if (pctMatch) {
    return parseFloat(pctMatch[1]);
  }

  // Try numbers near impact words
  const impactWords = ['magnitude', 'size', 'scale', 'level'];
  for (const word of impactWords) {
    const idx = text.indexOf(word);
    if (idx >= 0) {
      const after = text.slice(idx + word.length);
      const numMatch = after.match(/(\d+\.?\d*)/);
      if (numMatch) {
        return parseFloat(numMatch[1]);
      }
    }
  }

  return null;
}

function estimateSeverity(text: string, _sourceTier: string): number {
  let severity = 3; // default medium

  // High severity indicators
  const highSeverities = ['crisis', 'panic', 'crash', 'collapse', 'emergency', 'war', 'default', 'bankrupt'];
  for (const word of highSeverities) {
    if (text.includes(word)) {
      severity = Math.max(severity, 5);
    }
  }

  // Low severity indicators
  const lowSeverities = ['routine', 'scheduled', 'regular', 'minor', 'slight'];
  for (const word of lowSeverities) {
    if (text.includes(word)) {
      severity = Math.min(severity, 2);
    }
  }

  return severity;
}

function extractSupplyDemandChannel(text: string, ontology: EventOntology): string | null {
  if (ontology === 'COMMODITIES') {
    if (text.includes('supply cut') || text.includes('production cut')) return 'SUPPLY_REDUCTION';
    if (text.includes('demand') && text.includes('increase')) return 'DEMAND_INCREASE';
    if (text.includes('inventory') && text.includes('increase')) return 'SUPPLY_INCREASE';
    if (text.includes('inventory') && text.includes('decrease')) return 'SUPPLY_REDUCTION';
  }

  if (ontology === 'CENTRAL_BANK') {
    if (text.includes('rate cut')) return 'MONETARY_EASING';
    if (text.includes('rate hike')) return 'MONETARY_TIGHTENING';
  }

  return null;
}

function detectScheduled(text: string, sourceType: string): boolean {
  if (sourceType === 'economic_calendar') return true;
  const scheduledWords = ['scheduled', 'upcoming', 'calendar', 'due', 'expected'];
  for (const word of scheduledWords) {
    if (text.includes(word)) return true;
  }
  return false;
}

function determineOfficialStatus(rawRecord: EventRawRecord): EventLifecycle {
  if (rawRecord.sourceTier === 'TIER1_AUTHORITATIVE') return 'OFFICIAL';
  if (rawRecord.sourceTier === 'TIER2_MARKET_DATA') return 'PRELIMINARY';
  return 'RUMOR';
}

function detectContradictions(text: string): boolean {
  const contradictionPatterns = [
    'contradicts', 'disputes', 'refutes', 'denies',
    'contrary to', 'conflicting', 'disagrees',
    'earlier report', 'previous claim',
  ];
  for (const pattern of contradictionPatterns) {
    if (text.includes(pattern)) return true;
  }
  return false;
}

function tierToReliability(tier: string): number {
  switch (tier) {
    case 'TIER1_AUTHORITATIVE': return 1.0;
    case 'TIER2_MARKET_DATA': return 0.8;
    case 'TIER3_STRUCTURED_MACRO': return 0.6;
    case 'TIER4_GENERAL_DISCOVERY': return 0.3;
    default: return 0.5;
  }
}

/**
 * Infer likely transmission paths based on event ontology and assets.
 * Returns paths as suggestions — NOT hard-coded predictions.
 */
function inferTransmissionPaths(
  ontology: EventOntology,
  assets: readonly string[],
  countries: readonly string[],
): readonly TransmissionPath[] {
  const paths: TransmissionPath[] = [];

  // India-specific event → direct NIFTY/BANKNIFTY path
  if (countries.includes('IN')) {
    if (assets.includes('NIFTY')) {
      paths.push({
        from: 'INDIA_RATES',
        to: 'NIFTY',
        expectedSign: -1,
        expectedLagMs: 300_000,
        confidence: 0.7,
      });
    }
  }

  // Commodities → cross-asset transmission
  if (ontology === 'COMMODITIES') {
    if (assets.includes('CRUDE')) {
      paths.push(
        {
          from: 'CRUDE',
          to: 'INR',
          expectedSign: -1,
          expectedLagMs: 600_000,
          confidence: 0.6,
        },
        {
          from: 'CRUDE',
          to: 'NIFTY',
          expectedSign: -1,
          expectedLagMs: 900_000,
          confidence: 0.5,
        },
      );
    }
  }

  // Central bank → rates → INR → NIFTY
  if (ontology === 'CENTRAL_BANK') {
    if (countries.includes('US')) {
      paths.push(
        {
          from: 'US_RATES',
          to: 'INDIA_RATES',
          expectedSign: 1,
          expectedLagMs: 3_600_000,
          confidence: 0.5,
        },
        {
          from: 'US_RATES',
          to: 'INR',
          expectedSign: -1,
          expectedLagMs: 3_600_000,
          confidence: 0.4,
        },
      );
    }
    if (countries.includes('IN')) {
      paths.push(
        {
          from: 'INDIA_RATES',
          to: 'NIFTY',
          expectedSign: -1,
          expectedLagMs: 600_000,
          confidence: 0.6,
        },
        {
          from: 'INDIA_RATES',
          to: 'BANKNIFTY',
          expectedSign: -1,
          expectedLagMs: 600_000,
          confidence: 0.7,
        },
      );
    }
  }

  // Geopolitical → USD → cross-asset
  if (ontology === 'GEOPOLITICAL') {
    paths.push(
      {
        from: 'USD_DXY',
        to: 'GOLD',
        expectedSign: -1,
        expectedLagMs: 300_000,
        confidence: 0.4,
      },
      {
        from: 'GLOBAL_EQUITY',
        to: 'ASIAN_EQUITY',
        expectedSign: 1,
        expectedLagMs: 1_800_000,
        confidence: 0.5,
      },
    );
  }

  // Macro data → USD → INR → NIFTY
  if (ontology === 'MACRO' && countries.includes('US')) {
    paths.push(
      {
        from: 'USD_DXY',
        to: 'INR',
        expectedSign: -1,
        expectedLagMs: 1_800_000,
        confidence: 0.4,
      },
    );
  }

  return paths;
}
