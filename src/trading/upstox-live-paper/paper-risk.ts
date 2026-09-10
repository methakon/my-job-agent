/**
 * Configurable paper-capital + risk engine (RISK_POLICY_VERSION).
 *
 * WHY THIS EXISTS
 * The desk's capital used to be a single number baked into the account and its
 * strategy: ₹5,000. Every limit — position size, maximum loss, drawdown, how
 * many lots fit — followed from that one constant. Training needs to change the
 * cap (₹2,000 / ₹5,000 / ₹10,000 / anything) WITHOUT touching code and WITHOUT
 * re-tuning the strategy, because the strategy must not know the cap at all.
 *
 * THE RULE
 * The strategy reasons in NORMALIZED terms (ATR multiples, %, scores). Capital
 * only ever touches SIZING and EXPOSURE. Given the same market, ₹2,000 and
 * ₹10,000 produce the same decision; only the number of lots and the rupee
 * exposure differ. Anything in this file is therefore about how much money may
 * be put at risk — never about whether a setup is good.
 *
 * SCALING
 * Every limit is derived from the configured capital:
 *   equity            = configuredCapital + netPnl + unrealisedPnl
 *   maxRiskPerTrade   = equity × maxRiskPerTradePct      (default 1%)
 *   maxLossAmount     = equity × maxLossPct              (session loss limit)
 *   maxDrawdownAmount = peakEquity × maxDrawdownPct
 *   deployable        = configuredCapital − deployed
 * A portfolio created at ₹2,000 gets ₹20 of per-trade risk; at ₹10,000 it gets
 * ₹100. Same policy, different scale.
 *
 * HISTORY IS IMMUTABLE
 * The configured capital is recorded on the portfolio AND snapshotted per
 * session (see UpstoxLivePaperSession). Changing the cap writes a new policy
 * value and a capital-change event; it never rewrites past trades, past P&L or
 * past sessions, so a ₹2,000 result stays a ₹2,000 result.
 *
 * FUTURE REAL TRADING (config + interface only — NOT enabled here)
 * mode = 'ACCOUNT_BALANCE_PCT' expresses risk/exposure as a percentage of the
 * CURRENT REAL ACCOUNT BALANCE read at execution time, instead of a fixed rupee
 * cap. The interface exists (AccountBalanceProvider) and the percentage is
 * configurable, but nothing activates it: this desk is PAPER, and a REAL
 * balance can only enter through a provider that a future, separately-approved
 * REAL path supplies.
 */

export const RISK_POLICY_VERSION = 'paper-risk-v1';

/** Default paper capital when nothing is configured. Configurable, not fixed. */
export const DEFAULT_PAPER_CAPITAL = 5_000;
/** Floor/ceiling for a configured cap: a typo must not create a ₹1 or ₹0 desk. */
export const MIN_CONFIGURABLE_CAPITAL = 100;
export const MAX_CONFIGURABLE_CAPITAL = 100_000_000;

/**
 * How the risk base is computed.
 *  - FIXED_CAPITAL      : the configured paper capital (this desk, today).
 *  - ACCOUNT_BALANCE_PCT: a % of the CURRENT REAL account balance (future REAL
 *                         mode; configurable + modelled, never activated here).
 */
export type RiskSizingMode = 'FIXED_CAPITAL' | 'ACCOUNT_BALANCE_PCT';

export interface RiskPolicy {
  version: string;
  mode: RiskSizingMode;
  /** Configured paper capital (INR) — the operator's number, recorded as-is. */
  configuredCapital: number;
  /**
   * ACCOUNT_BALANCE_PCT only: percent of the current real account balance that
   * may be put at risk. Ignored in FIXED_CAPITAL mode.
   */
  realBalancePct: number;
  /** Max loss allowed on ONE trade, as % of current equity (default 1%). */
  maxRiskPerTradePct: number;
  /** Session loss limit, as % of equity at the session's start. */
  maxLossPct: number;
  /** Drawdown limit, as % of peak equity. */
  maxDrawdownPct: number;
  /** Maximum simultaneous open positions. */
  maxOpenPositions: number;
  /** Maximum lots in one position. */
  maxLotsPerPosition: number;
  /** Averaging down is refused outright when false (and it is false). */
  allowAveragingDown: boolean;
  /** Minimum reward:risk for a fresh entry (sizing-side sanity check). */
  minRewardRisk: number;
}

export interface PaperPortfolioState {
  /** Configured capital (INR) — the operator's cap for this account. */
  capital: number;
  deployed: number;
  netPnl: number;
  unrealisedPnl: number;
  openPositionCount: number;
  /** Highest equity seen for this account (for the drawdown limit). */
  peakEquity?: number | null;
  /** Equity at session start, when known (for the session loss limit). */
  sessionStartEquity?: number | null;
}

export interface RiskCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface PaperRiskSnapshot {
  version: string;
  mode: RiskSizingMode;
  /** What the operator configured. Recorded per session; never rewritten. */
  configuredCapital: number;
  /** Equity the risk percentages are applied to. */
  riskBase: number;
  riskBaseSource: 'PAPER_EQUITY' | 'REAL_ACCOUNT_BALANCE';
  equity: number;
  realisedPnl: number;
  unrealisedPnl: number;
  peakEquity: number;
  drawdownAmount: number;
  drawdownPct: number;
  maxRiskPerTrade: number;
  maxRiskPerTradePct: number;
  maxLossAmount: number;
  maxLossPct: number;
  sessionLossUsed: number;
  maxLossHit: boolean;
  maxDrawdownAmount: number;
  maxDrawdownPct: number;
  /** Exposure ceiling: configured capital in PAPER mode, balance × pct in REAL. */
  maxExposureAmount: number;
  drawdownHit: boolean;
  maxOpenPositions: number;
  maxLotsPerPosition: number;
  /** Positions currently open on this account. */
  openPositionCount: number;
  /** Premium outlay already deployed (INR). */
  deployed: number;
  allowAveragingDown: boolean;
  minRewardRisk: number;
  deployable: number;
  checks: RiskCheck[];
}

export type PositionSizing =
  | {
      allowed: true;
      lots: number;
      units: number;
      lotSize: number;
      premium: number;
      stopPerUnit: number;
      outlay: number;
      plannedRisk: number;
      plannedRiskPct: number;
      riskLots: number;
      affordableLots: number;
      capLots: number;
      notes: string[];
    }
  | { allowed: false; refusals: string[]; notes: string[] };

const num = (value: unknown, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const bool = (value: unknown, fallback: boolean): boolean => {
  if (value === undefined || value === null || value === '') return fallback;
  return !/^(0|false|no|off)$/i.test(String(value));
};

/** Keep a configured cap sane. ₹0 / NaN / negatives never reach the engine. */
export const clampCapital = (value: unknown, fallback = DEFAULT_PAPER_CAPITAL): number => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return clampCapital(fallback, DEFAULT_PAPER_CAPITAL);
  return Math.min(MAX_CONFIGURABLE_CAPITAL, Math.max(MIN_CONFIGURABLE_CAPITAL, Math.round(n * 100) / 100));
};

/**
 * Build the risk policy. `configuredCapital` is the account's own recorded
 * capital when supplied (a port folio already configured at ₹2,000 keeps
 * ₹2,000 even if the environment default changes), otherwise the env value,
 * otherwise the documented default.
 */
export const riskPolicyFromEnv = (
  env: Record<string, string | undefined> = process.env,
  overrides: Partial<RiskPolicy> = {},
): RiskPolicy => ({
  version: RISK_POLICY_VERSION,
  mode: (String(env.UPSTOX_RISK_MODE ?? 'FIXED_CAPITAL').toUpperCase() === 'ACCOUNT_BALANCE_PCT'
    ? 'ACCOUNT_BALANCE_PCT'
    : 'FIXED_CAPITAL') as RiskSizingMode,
  configuredCapital: clampCapital(
    overrides.configuredCapital ?? env.UPSTOX_LIVE_PAPER_CAPITAL ?? DEFAULT_PAPER_CAPITAL,
  ),
  // REAL-mode exposure ceiling as a % of the CURRENT real account balance.
  // Deliberately conservative and never active until FIXED_CAPITAL is switched
  // over by an explicit operator decision (UPSTOX_RISK_MODE).
  realBalancePct: Math.max(0, num(env.UPSTOX_RISK_BALANCE_PCT, 25)),
  maxRiskPerTradePct: Math.max(0.01, num(env.UPSTOX_RISK_MAX_TRADE_PCT, 1)),
  maxLossPct: Math.max(0, num(env.UPSTOX_RISK_MAX_LOSS_PCT, 10)),
  maxDrawdownPct: Math.max(0, num(env.UPSTOX_RISK_MAX_DRAWDOWN_PCT, 20)),
  maxOpenPositions: Math.max(1, Math.trunc(num(env.UPSTOX_RISK_MAX_POSITIONS, 1))),
  maxLotsPerPosition: Math.max(1, Math.trunc(num(env.UPSTOX_RISK_MAX_LOTS, 1))),
  // Hard false: averaging down is refused by design, not by configuration drift.
  allowAveragingDown: false,
  minRewardRisk: Math.max(0, num(env.UPSTOX_RISK_MIN_RR, 1.5)),
  ...overrides,
});

/**
 * Snapshot the risk envelope for one account. Everything scales off the
 * account's configured capital — no ₹5,000 (or any) constant lives here.
 *
 * `accountBalance` is only consulted in ACCOUNT_BALANCE_PCT mode, and only when
 * a real balance was actually supplied. Without one the snapshot stays on paper
 * equity and says so in `riskBaseSource` — it never invents a balance.
 */
export const paperRiskSnapshot = (
  state: PaperPortfolioState,
  policy: RiskPolicy,
  options: { accountBalance?: number | null } = {},
): PaperRiskSnapshot => {
  const configuredCapital = clampCapital(state.capital ?? policy.configuredCapital);
  const realisedPnl = num(state.netPnl, 0);
  const unrealisedPnl = num(state.unrealisedPnl, 0);
  const equity = configuredCapital + realisedPnl + unrealisedPnl;
  const peakEquity = Math.max(equity, num(state.peakEquity, equity));
  // Session-start equity comes from the training-session row. Before that row
  // exists (or if it is 0) the account's configured capital IS the session
  // start, so the max-loss limit stays live instead of silently collapsing to
  // a zero limit that could never fire.
  const rawStart = Number(state.sessionStartEquity);
  const sessionStartEquity = Number.isFinite(rawStart) && rawStart > 0 ? rawStart : configuredCapital;

  const realBalance = Number(options.accountBalance);
  const useReal = policy.mode === 'ACCOUNT_BALANCE_PCT' && Number.isFinite(realBalance) && realBalance > 0;
  const riskBase = useReal ? realBalance : equity;
  const riskBaseSource: PaperRiskSnapshot['riskBaseSource'] = useReal ? 'REAL_ACCOUNT_BALANCE' : 'PAPER_EQUITY';

  const maxRiskPerTrade = riskBase * (policy.maxRiskPerTradePct / 100);
  const maxLossAmount = sessionStartEquity * (policy.maxLossPct / 100);
  const drawdownAmount = Math.max(0, peakEquity - equity);
  const maxDrawdownAmount = peakEquity * (policy.maxDrawdownPct / 100);
  // Loss actually taken this session (equity below where the session started).
  const sessionLossUsed = Math.max(0, sessionStartEquity - equity);
  const maxLossHit = maxLossAmount > 0 && sessionLossUsed >= maxLossAmount;
  const drawdownHit = maxDrawdownAmount > 0 && drawdownAmount >= maxDrawdownAmount;
  // Exposure ceiling. PAPER: the whole configured capital (100% by definition,
  // unchanged behaviour). REAL (future): the configurable percentage of the
  // CURRENT real account balance — the knob the operator asked for, wired but
  // inert until REAL mode is switched on.
  const maxExposureAmount = useReal ? realBalance * (policy.realBalancePct / 100) : configuredCapital;
  const deployable = Math.max(0, maxExposureAmount - num(state.deployed, 0));

  const checks: RiskCheck[] = [
    { name: 'positions', ok: num(state.openPositionCount, 0) < policy.maxOpenPositions, detail: `${num(state.openPositionCount, 0)} open / max ${policy.maxOpenPositions}` },
    { name: 'sessionLoss', ok: !maxLossHit, detail: `used ₹${sessionLossUsed.toFixed(2)} / limit ₹${maxLossAmount.toFixed(2)}` },
    { name: 'drawdown', ok: !drawdownHit, detail: `drawdown ₹${drawdownAmount.toFixed(2)} / limit ₹${maxDrawdownAmount.toFixed(2)}` },
    { name: 'deployable', ok: deployable > 0, detail: `₹${deployable.toFixed(2)} free of ₹${maxExposureAmount.toFixed(2)}${useReal ? ` (${policy.realBalancePct}% of real balance)` : ''}` },
  ];

  return {
    version: policy.version,
    mode: policy.mode,
    configuredCapital,
    riskBase,
    riskBaseSource,
    equity,
    realisedPnl,
    unrealisedPnl,
    peakEquity,
    drawdownAmount,
    drawdownPct: peakEquity > 0 ? (drawdownAmount / peakEquity) * 100 : 0,
    maxRiskPerTrade,
    maxRiskPerTradePct: policy.maxRiskPerTradePct,
    maxLossAmount,
    maxLossPct: policy.maxLossPct,
    sessionLossUsed,
    maxLossHit,
    maxDrawdownAmount,
    maxDrawdownPct: policy.maxDrawdownPct,
    maxExposureAmount,
    drawdownHit,
    maxOpenPositions: policy.maxOpenPositions,
    maxLotsPerPosition: policy.maxLotsPerPosition,
    openPositionCount: num(state.openPositionCount, 0),
    deployed: num(state.deployed, 0),
    allowAveragingDown: policy.allowAveragingDown,
    minRewardRisk: policy.minRewardRisk,
    deployable,
    checks,
  };
};

/**
 * Size a position from RISK, not from a price.
 *
 * lots = the largest count that satisfies ALL of:
 *   - planned risk (units × stop distance) ≤ maxRiskPerTrade
 *   - outlay (units × premium)               ≤ deployable
 *   - lots                                   ≤ maxLotsPerPosition
 * When even one lot cannot respect the risk limit with the structural stop, the
 * answer is NO TRADE with the reason — never a smaller stop, and never a bigger
 * risk budget. That is the operator's rule for V1.
 */
export const sizeFromRisk = (input: {
  snapshot: PaperRiskSnapshot;
  premium: number;
  lotSize: number;
  /** Per-unit distance between entry and the structural stop, in premium terms. */
  stopPerUnit: number;
  /** Operator-requested lots, when an instruction names them. */
  requestedLots?: number | null;
}): PositionSizing => {
  const notes: string[] = [];
  const snapshot = input.snapshot;
  const lotSize = Math.trunc(num(input.lotSize, 0));
  const premium = num(input.premium, 0);
  const stopPerUnit = num(input.stopPerUnit, 0);

  if (!(lotSize > 0)) return { allowed: false, refusals: ['lot size unresolved — refused rather than guessed'], notes };
  if (!(premium > 0)) return { allowed: false, refusals: ['no traded premium — cannot size'], notes };
  if (!(stopPerUnit > 0)) return { allowed: false, refusals: ['no structural stop — V1 refuses to enter without one'], notes };
  if (snapshot.maxLossHit) return { allowed: false, refusals: [`session loss limit reached (₹${snapshot.sessionLossUsed.toFixed(2)} of ₹${snapshot.maxLossAmount.toFixed(2)})`], notes };
  if (snapshot.drawdownHit) return { allowed: false, refusals: [`drawdown limit reached (${snapshot.drawdownPct.toFixed(2)}% of ${snapshot.maxDrawdownPct}%)`], notes };

  // Risk budget is per position; the cap is the policy's max lots.
  const riskLots = Math.floor(snapshot.maxRiskPerTrade / (stopPerUnit * lotSize));
  const affordableLots = Math.floor(snapshot.deployable / (premium * lotSize));
  const requested = Number(input.requestedLots);
  const capLots = snapshot.maxLotsPerPosition;
  const requestedLots = Number.isFinite(requested) && requested >= 1 ? Math.trunc(requested) : capLots;

  if (riskLots < 1) {
    return {
      allowed: false,
      refusals: [
        `one lot (${lotSize} × ₹${stopPerUnit.toFixed(2)} stop) risks ₹${(stopPerUnit * lotSize).toFixed(2)}, ` +
        `more than the ₹${snapshot.maxRiskPerTrade.toFixed(2)} per-trade limit (${snapshot.maxRiskPerTradePct}% of ₹${snapshot.riskBase.toFixed(2)}) — NO TRADE`,
      ],
      notes,
    };
  }
  if (affordableLots < 1) {
    return {
      allowed: false,
      refusals: [`one lot costs ₹${(premium * lotSize).toFixed(2)}, more than the ₹${snapshot.deployable.toFixed(2)} deployable`],
      notes,
    };
  }

  const lots = Math.max(1, Math.min(riskLots, affordableLots, capLots, requestedLots));
  if (lots < requestedLots) notes.push(`requested ${requestedLots} lot(s), sized down to ${lots} by the risk/deployable/lot cap`);
  if (lots === riskLots && riskLots < affordableLots) notes.push('size limited by the per-trade risk budget, not by capital');
  if (lots === capLots) notes.push(`size limited by maxLotsPerPosition (${capLots})`);

  const units = lots * lotSize;
  const outlay = units * premium;
  const plannedRisk = units * stopPerUnit;
  return {
    allowed: true,
    lots,
    units,
    lotSize,
    premium,
    stopPerUnit,
    outlay,
    plannedRisk,
    plannedRiskPct: snapshot.riskBase > 0 ? (plannedRisk / snapshot.riskBase) * 100 : 0,
    riskLots,
    affordableLots,
    capLots,
    notes,
  };
};

/**
 * Pre-entry guards that are not sizing: how many positions may be open, and
 * whether this order would be an averaging-down add. Averaging down means
 * adding to the SAME contract/side while it is already open — the operator's
 * "no averaging down" rule, enforced here rather than trusted to callers.
 */
export const entryGuards = (input: {
  snapshot: PaperRiskSnapshot;
  /** Contract already open on this side, if any ('SYMBOL:SIDE'). */
  openSameContract?: string | null;
  side: 'BUY' | 'SELL';
  outlay: number;
}): { allowed: boolean; refusals: string[] } => {
  const refusals: string[] = [];
  const { snapshot } = input;

  if (snapshot.maxLossHit) refusals.push(`session loss limit reached (₹${snapshot.sessionLossUsed.toFixed(2)} of ₹${snapshot.maxLossAmount.toFixed(2)})`);
  if (snapshot.drawdownHit) refusals.push(`drawdown limit reached (${snapshot.drawdownPct.toFixed(2)}% of ${snapshot.maxDrawdownPct}%)`);
  if (snapshot.openPositionCount >= snapshot.maxOpenPositions) {
    refusals.push(`${snapshot.openPositionCount} position(s) open — max ${snapshot.maxOpenPositions} (one position at a time)`);
  }
  if (!snapshot.allowAveragingDown && input.openSameContract) {
    refusals.push(`already holding ${input.openSameContract} — adding to it would be averaging down, which is refused`);
  }
  if (input.outlay > snapshot.deployable) {
    refusals.push(`outlay ₹${input.outlay.toFixed(2)} exceeds deployable ₹${snapshot.deployable.toFixed(2)}`);
  }
  return { allowed: refusals.length === 0, refusals };
};

/** Reward:risk from a target and a stop, both in premium terms per unit. */
export const rewardRisk = (input: { premium: number; stopPerUnit: number; targetPerUnit?: number | null }): number | null => {
  const premium = num(input.premium, 0);
  const stop = num(input.stopPerUnit, 0);
  if (!(stop > 0) || !(premium > 0)) return null;
  const target = num(input.targetPerUnit, 0);
  if (!(target > premium)) return null;
  return (target - premium) / stop;
};

/**
 * FUTURE REAL TRADING — the seam, not the switch.
 *
 * A REAL path would ask the broker for the account's available balance at
 * execution time and feed it into `paperRiskSnapshot({ accountBalance })` with
 * mode = ACCOUNT_BALANCE_PCT. This desk is PAPER: the paper provider returns
 * null (meaning "no real balance — stay on paper equity") and the real provider
 * refuses until a separately-approved REAL integration supplies credentials.
 */
export interface AccountBalanceProvider {
  readonly kind: 'PAPER_EQUITY' | 'REAL_ACCOUNT';
  /** Current available balance, or null when unavailable. Never fabricated. */
  availableBalance(): Promise<number | null>;
}

export class PaperAccountBalanceProvider implements AccountBalanceProvider {
  readonly kind = 'PAPER_EQUITY' as const;

  constructor(private readonly equity: () => number | null) {}

  async availableBalance(): Promise<number | null> {
    const value = this.equity();
    return Number.isFinite(Number(value)) ? Number(value) : null;
  }
}

/**
 * REAL provider: deliberately inert. It reports the mode as REAL and refuses to
 * produce a number, so an accidental future wiring fails loudly instead of
 * silently sizing real orders from a paper number.
 */
export class RealAccountBalanceProvider implements AccountBalanceProvider {
  readonly kind = 'REAL_ACCOUNT' as const;

  async availableBalance(): Promise<number | null> {
    throw new Error(
      'REAL account balance provider is not implemented — real trading is not enabled on this desk (UPSTOX = LIVE market data + PAPER execution)',
    );
  }
}
