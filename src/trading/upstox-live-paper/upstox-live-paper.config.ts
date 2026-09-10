import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RiskPolicy, clampCapital, riskPolicyFromEnv } from './paper-risk';

/**
 * Upstox LIVE paper-trading configuration + safety model.
 *
 * MASTER SAFETY SWITCH: UPSTOX_SANDBOX_ENABLED (existing env var, DO NOT RENAME).
 *
 * Effective rules (see README below):
 *  - UPSTOX_SANDBOX_ENABLED=true  → REAL ORDERS ARE IMPOSSIBLE.
 *      LIVE market data may be used. Execution is PAPER.
 *  - UPSTOX_SANDBOX_ENABLED=false → real mode is only *permitted*, not auto-enabled.
 *      REAL_ORDER_ALLOWED requires false AND explicit REAL trading mode AND all
 *      existing safety/authorization checks. This module itself never enables REAL.
 *
 * This module runs PAPER regardless of UPSTOX_SANDBOX_ENABLED value; the flag only
 * gates whether a REAL path elsewhere could even be reachable. The LIVE paper path
 * is always PAPER and never submits to the Upstox order API.
 */
@Injectable()
export class UpstoxLivePaperConfig implements OnModuleInit {
  private readonly logger = new Logger(UpstoxLivePaperConfig.name);

  /** Master safety switch — existing var, never renamed. */
  readonly sandboxEnabled: boolean;
  /**
   * Explicit REAL trading mode requested for this module.
   * Even when false here, the module stays PAPER; this only feeds the
   * REAL_ORDER_ALLOWED derivation for cross-module safety checks.
   */
  readonly requestedRealMode: boolean;
  /** True when a REAL order path would be theoretically reachable (safety audit). */
  readonly realOrderAllowed: boolean;
  /** Always true for this module — it never submits real orders. */
  readonly paperOnly: boolean = true;

  readonly tradingModeLabel: string;
  readonly paperCapital: number;
  /**
   * The configurable risk envelope for a NEW account. Each account's own
   * configured capital overrides `configuredCapital`; the percentages and caps
   * below are the single source of truth for how limits scale.
   */
  readonly riskPolicy: RiskPolicy;
  readonly defaultSlippageBps: number;
  readonly staleQuoteMaxAgeMs: number;
  readonly abnormalSpreadPctThreshold: number;

  /** LIVE Upstox market-data config (data source, NOT execution). */
  readonly liveApiKey: string;
  readonly liveApiSecret: string;
  readonly liveAccessToken: string;
  readonly liveTokenExpiry: string | null;
  readonly liveInstruments: string[];
  readonly liveWebSocketEnabled: boolean;
  /**
   * Expiry selection for the live option chain: always the NEAREST listed
   * expiry (which is today's expiry on expiry day). Derived from the broker's
   * own contract list — never a hard-coded date.
   */
  readonly livePreferTodayExpiry: boolean;
  /** Strikes kept per side around ATM, bounding each poll's universe. */
  readonly liveStrikeWindow: number;

  /** Derived README-style status string for the UI. */
  readonly safetyStatusText: string;

  constructor(config: ConfigService) {
    // Master safety switch (existing env var — do not rename/default-change).
    const sandboxEnabledRaw = config.get<string>('UPSTOX_SANDBOX_ENABLED') ?? 'true';
    this.sandboxEnabled = /^(1|true|yes)$/i.test(sandboxEnabledRaw);

    // Explicit REAL mode request (for derivation only; module stays PAPER).
    const requestedRaw = config.get<string>('UPSTOX_LIVE_PAPER_REAL_MODE') ?? 'false';
    this.requestedRealMode = /^(1|true|yes)$/i.test(requestedRaw);

    // REAL_ORDER_ALLOWED derivation (safety audit). False here = PAPER enforced.
    this.realOrderAllowed =
      !this.sandboxEnabled &&
      this.requestedRealMode &&
      this.liveCredentialsPresent;

    // Always paper for THIS module.
    this.paperOnly = true;

    this.tradingModeLabel = this.realOrderAllowed ? 'REAL (permitted)' : 'PAPER';
    // Configurable, never hard-coded to ₹5,000: the env value is only the
    // DEFAULT for accounts that do not carry their own capital. Every limit in
    // this module scales from the account's configured capital.
    this.paperCapital = clampCapital(config.get<string>('UPSTOX_LIVE_PAPER_CAPITAL'));
    this.riskPolicy = riskPolicyFromEnv(process.env);
    this.defaultSlippageBps = Math.max(0, Number(config.get<string>('UPSTOX_LIVE_PAPER_SLIPPAGE_BPS') ?? 20));
    this.staleQuoteMaxAgeMs = Math.max(5_000, Number(config.get<string>('UPSTOX_LIVE_STALE_MAX_AGE_MS') ?? 15_000));
    this.abnormalSpreadPctThreshold = Math.max(0.1, Number(config.get<string>('UPSTOX_LIVE_ABNORMAL_SPREAD_PCT') ?? 15));

    // LIVE market-data credentials (data source). Order API credentials must NOT
    // be usable by this module — see safety notes in the service.
    this.liveApiKey = config.get<string>('UPSTOX_LIVE_API_KEY')?.trim() ?? '';
    this.liveApiSecret = config.get<string>('UPSTOX_LIVE_API_SECRET')?.trim() ?? '';
    this.liveAccessToken = config.get<string>('UPSTOX_LIVE_ACCESS_TOKEN')?.trim() ?? '';
    this.liveTokenExpiry = config.get<string>('UPSTOX_LIVE_TOKEN_EXPIRY')?.trim() ?? null;
    this.liveInstruments = (config.get<string>('UPSTOX_LIVE_INSTRUMENTS') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 200);
    this.liveWebSocketEnabled = /^(1|true|yes)$/i.test(config.get<string>('UPSTOX_LIVE_WS_ENABLED') ?? 'true');
    this.livePreferTodayExpiry = /^(1|true|yes)$/i.test(config.get<string>('UPSTOX_LIVE_PREFER_TODAY_EXPIRY') ?? 'true');
    this.liveStrikeWindow = Math.max(1, Math.min(50, Number(config.get<string>('UPSTOX_LIVE_STRIKE_WINDOW') ?? 10) || 10));

    this.safetyStatusText = this.buildSafetyStatusText();
  }

  async onModuleInit(): Promise<void> {
    if (!this.liveInstruments.length) {
      this.logger.warn('[UPSTOX-LIVE-PAPER] UPSTOX_LIVE_INSTRUMENTS is empty — live market-data ingestion will have no targets');
    }
    if (!this.liveCredentialsPresent && this.liveWebSocketEnabled) {
      this.logger.warn('[UPSTOX-LIVE-PAPER] LIVE Upstox credentials missing — live feed will start in degraded mode (REST-only where possible, WS disabled)');
    }
    if (this.realOrderAllowed) {
      // This module is PAPER only; if derivation somehow says REAL allowed, harden.
      this.logger.warn('[UPSTOX-LIVE-PAPER] REAL_ORDER_ALLOWED=true derivation — module still PAPER-only; real order paths are unreachable from here');
    }
  }

  /** Whether LIVE market-data credentials are at least partially present. */
  get liveCredentialsPresent(): boolean {
    return Boolean(this.liveApiKey) || Boolean(this.liveAccessToken);
  }

  /** Master safety switch is ON → real orders impossible. */
  get safetyLockActive(): boolean {
    return this.sandboxEnabled;
  }

  private buildSafetyStatusText(): string {
    const lock = this.safetyLockActive;
    return [
      `UPSTOX MARKET DATA: ${this.liveCredentialsPresent || this.liveInstruments.length ? 'LIVE' : 'CONFIGURED (no creds)'}`,
      `EXECUTION: PAPER`,
      `REAL ORDERS: ${lock ? 'DISABLED' : 'DISABLED (safety lock, module is paper-only)'}`,
      `SAFETY LOCK: UPSTOX_SANDBOX_ENABLED=${lock ? 'true' : 'false'}`,
      `PAPER CAPITAL (default): ₹${this.paperCapital.toLocaleString('en-IN')} · RISK/TRADE ${this.riskPolicy.maxRiskPerTradePct}% · MAX ${this.riskPolicy.maxOpenPositions} POS · ${this.riskPolicy.mode}`,
      `SLIPPAGE ASSUMPTION: ${this.defaultSlippageBps} bps`,
      `STALE QUOTE MAX AGE: ${this.staleQuoteMaxAgeMs} ms`,
      `ABNORMAL SPREAD THRESHOLD: ${this.abnormalSpreadPctThreshold}%`,
    ].join(' · ');
  }

  /** Print the README-style safety block to logger (call at startup). */
  logSafetyBlock(): void {
    this.logger.log('═══════════════════════════════════════════════════════════════');
    this.logger.log('[UPSTOX-LIVE-PAPER] SAFETY MODEL — READ THIS');
    this.logger.log('═══════════════════════════════════════════════════════════════');
    this.logger.log(`UPSTOX_SANDBOX_ENABLED = ${this.sandboxEnabled}  (master safety switch, DO NOT RENAME)`);
    this.logger.log(`Module execution mode   = PAPER (always; this module never submits real orders)`);
    this.logger.log(`REAL_ORDER_ALLOWED      = ${this.realOrderAllowed}  (derivation: !sandboxEnabled && requestedRealMode && checks)`);
    this.logger.log(`Paper capital           = \u20b9${this.paperCapital.toLocaleString('en-IN')}`);
    this.logger.log(`Safety lock active      = ${this.safetyLockActive}`);
    this.logger.log(`Live market data source = UPSTOX (REST + WebSocket when configured)`);
    this.logger.log('[UPSTOX-LIVE-PAPER] SAFETY BLOCK END');
  }
}
