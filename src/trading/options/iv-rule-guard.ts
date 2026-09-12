/**
 * GATE 7 #9 (roadmap row 81) — "HIGH IV = SELL" IS NOT A RULE: an explicit, code-enforced negative control.
 *
 * Single responsibility: reject any option-selection attempt whose justification is the IV REGIME ALONE — in
 * particular "IV is high ⇒ sell premium" — at the boundary where that behaviour would otherwise occur. The rule
 * lives in CODE so it does not depend on a prompt, a checklist entry or operator memory, and no research module
 * can bypass it silently. PURE: no clock, no I/O, no DB, no network, no AI, no randomness.
 *
 * ── THE PROHIBITED BEHAVIOUR (this is the control) ─────────────────────────────────────────
 *   `HIGH_IV_IMPLIES_SELL` — using a high implied-volatility regime as SUFFICIENT reason to sell/short premium.
 *   The guard rejects a rationale when EITHER:
 *     * its ONLY dimension is the IV regime (regardless of its value) → IV_REGIME_ALONE; or
 *     * it explicitly cites the prohibited rule id → PROHIBITED_RULE_CITED; or
 *     * it carries no dimension at all → NO_RATIONALE.
 *   It ALLOWS a rationale that includes at least one NON-IV dimension (e.g. direction, movement, holding), so
 *   the control is a targeted negative rule, not a blanket block on IV-aware decisions.
 *
 *   SCOPE: this is a REJECTION of a justification, not a strategy engine — it never says what to trade. It is
 *   the guard a selection layer is expected to call before acting on an IV-regime reasoning chain.
 *
 * ── MISSING / DEGENERATE DATA → a safe explicit state ───────────────────────────────────────
 *   NO_RATIONALE (nothing cited) / IV_REGIME_ALONE (the prohibited pattern) / PROHIBITED_RULE_CITED (the rule
 *   named outright) — each returns a REJECTED verdict with the token; a rationale is never silently passed.
 *
 * RESEARCH / SHADOW ONLY: nothing in production imports this module (asserted by test) — it is the reference
 * control that a production selection layer would import when the row is promoted. Versioned: ivrule-v1.
 */

export const IV_RULE_GUARD_VERSION = 'ivrule-v1';

/** The rules this guard exists to forbid. Published so a reviewer can check the code against the words. */
export const PROHIBITED_IV_RULES = ['HIGH_IV_IMPLIES_SELL'] as const;
export type ProhibitedIvRule = (typeof PROHIBITED_IV_RULES)[number];

export const PROHIBITED_IV_RULE_STATEMENTS: Record<ProhibitedIvRule, string> = {
	HIGH_IV_IMPLIES_SELL: 'a high implied-volatility regime is NEVER sufficient reason to sell or short premium; IV regime alone must not select an action',
};

/** The reasoning dimensions a selection rationale may cite; only `ivRegime` is prohibited as a SOLE reason. */
export const RATIONALE_DIMENSIONS = ['direction', 'expectedMovement', 'ivRegime', 'holdingPeriod'] as const;
export type RationaleDimension = (typeof RATIONALE_DIMENSIONS)[number];

export type IvRuleVerdict = 'ALLOWED' | 'REJECTED';
export const IV_RULE_VERDICTS: readonly IvRuleVerdict[] = ['ALLOWED', 'REJECTED'];

/** Closed, published rejection vocabulary (declaration order is the canonical order). */
export const IV_RULE_REJECTIONS = ['NO_RATIONALE', 'IV_REGIME_ALONE', 'PROHIBITED_RULE_CITED'] as const;
export type IvRuleRejection = (typeof IV_RULE_REJECTIONS)[number];

export interface IvRuleRationale {
	/** The dimensions the decision cites. Unknown names are ignored (they are not a licence to pass). */
	dimensions: string[];
	/** Set when the reasoning explicitly names a rule (e.g. 'HIGH_IV_IMPLIES_SELL'). */
	citesRule?: string | null;
	/** Free-text note for the audit trail; never used to decide. */
	note?: string | null;
}

export interface IvRuleGuardConfig {
	enabled: boolean;
}

export const DEFAULT_IV_RULE_GUARD_CONFIG: IvRuleGuardConfig = { enabled: true };

export const IV_RULE_GUARD_SPEC = {
	feature: 'IvRuleGuard',
	version: IV_RULE_GUARD_VERSION,
	question: 'Is this selection rationale free of the prohibited "high IV ⇒ sell" rule?',
	prohibited: [...PROHIBITED_IV_RULES] as string[],
	transform: 'REJECT when the only cited dimension is ivRegime, when the prohibited rule id is cited, or when nothing is cited; ALLOW otherwise',
	scope: 'a rejection of a JUSTIFICATION, not a strategy engine and not a blanket block on IV-aware reasoning',
	thresholds: 'none — the guard tests the STRUCTURE of the rationale, never a numeric IV level (so it cannot be tuned to a favourite vol)',
	refuses: [...IV_RULE_REJECTIONS] as string[],
	missingData: 'no rationale, an IV-only rationale, or an explicitly cited prohibited rule each yield REJECTED with a closed-vocabulary token',
};

export const describeIvRuleGuard = (c: IvRuleGuardConfig = DEFAULT_IV_RULE_GUARD_CONFIG): string =>
	[
		`${IV_RULE_GUARD_VERSION}: rejects a selection rationale that leans on the IV regime ALONE`,
		`(e.g. "high IV ⇒ sell"), or that names the prohibited rule ${PROHIBITED_IV_RULES.join(' / ')}.`,
		`It ALLOWS any rationale citing at least one non-IV dimension, and it tests the STRUCTURE of the reasoning`,
		`— never a numeric IV level — so it cannot be tuned. Rejections: ${IV_RULE_REJECTIONS.join(' / ')}. enabled=${c.enabled}.`,
	].join(' ');

export interface IvRuleGuardResult {
	verdict: IvRuleVerdict;
	rejection: IvRuleRejection | null;
	detail: string;
	/** The dimensions that were recognised, for the audit trail. */
	citedDimensions: RationaleDimension[];
	prohibitedRuleMatched: ProhibitedIvRule | null;
}

/** The control. Deterministic: same rationale ⇒ same verdict. */
export function guardIvRule(rationale: IvRuleRationale | null | undefined, config: Partial<IvRuleGuardConfig> = {}): IvRuleGuardResult {
	const cfg: IvRuleGuardConfig = { ...DEFAULT_IV_RULE_GUARD_CONFIG, ...config };
	if (!cfg.enabled) {
		return { verdict: 'ALLOWED', rejection: null, detail: 'the guard is disabled; the rationale was not checked (this is the disabled path, never a silent pass in production)', citedDimensions: [], prohibitedRuleMatched: null };
	}
	if (!rationale || typeof rationale !== 'object') {
		return { verdict: 'REJECTED', rejection: 'NO_RATIONALE', detail: 'no rationale was supplied, so there is nothing to justify the action', citedDimensions: [], prohibitedRuleMatched: null };
	}
	const cited = [...new Set((rationale.dimensions ?? []).filter((d): d is RationaleDimension => (RATIONALE_DIMENSIONS as readonly string[]).includes(String(d))))];
	const citedProhibited = PROHIBITED_IV_RULES.includes(String(rationale.citesRule ?? '') as ProhibitedIvRule) ? (String(rationale.citesRule) as ProhibitedIvRule) : null;

	if (citedProhibited) {
		return { verdict: 'REJECTED', rejection: 'PROHIBITED_RULE_CITED', detail: `the rationale explicitly cites the prohibited rule ${citedProhibited}: ${PROHIBITED_IV_RULE_STATEMENTS[citedProhibited]}`, citedDimensions: cited, prohibitedRuleMatched: citedProhibited };
	}
	if (!cited.length) {
		return { verdict: 'REJECTED', rejection: 'NO_RATIONALE', detail: 'the rationale cites no recognised dimension, so there is nothing to justify the action', citedDimensions: [], prohibitedRuleMatched: null };
	}
	if (cited.length === 1 && cited[0] === 'ivRegime') {
		return { verdict: 'REJECTED', rejection: 'IV_REGIME_ALONE', detail: `the rationale leans on the IV regime alone — ${PROHIBITED_IV_RULE_STATEMENTS.HIGH_IV_IMPLIES_SELL}`, citedDimensions: cited, prohibitedRuleMatched: 'HIGH_IV_IMPLIES_SELL' };
	}
	return { verdict: 'ALLOWED', rejection: null, detail: `allowed: the rationale cites ${cited.join(' + ')} — at least one dimension beyond the IV regime`, citedDimensions: cited, prohibitedRuleMatched: null };
}
