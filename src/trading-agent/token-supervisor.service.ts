import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';
import { ProviderTokenService } from '../trading/provider-token.service';
import { UpstoxLivePaperToken } from '../trading/upstox-live-paper/upstox-live-paper-token.entity';

/**
 * Deterministic token-lifecycle supervisor — runs inside the Trading Agent
 * process (operator decision 2026-09-23). Responsibilities, and ONLY these:
 *
 *  - bootstrap / pre-market health check plus a periodic (10 min) check of the
 *    FYERS and Upstox access tokens held in provider_tokens (single active row)
 *  - automatic FYERS refresh when a refresh token AND FYERS_PIN are available
 *  - Upstox token-request initiation hook — hard-gated OFF until the operator
 *    confirms the Upstox notifier webhook URL is configured (P3)
 *  - deterministic state reporting: VALID | EXPIRING | REFRESHING |
 *    AWAITING_APPROVAL | AUTH_REQUIRED | INVALID
 *
 * It is NOT responsible for strategy, risk, sizing or execution and never
 * touches those code paths.
 *
 * SAFETY:
 *  - Never logs token values, PINs, decrypted material or request bodies —
 *    states, reasons and timestamps only.
 *  - Missing PIN / missing refresh token => AUTH_REQUIRED with ZERO refresh
 *    attempts (no retry storm).
 *  - Failed refreshes are bounded: >= 15 min between attempts and at most
 *    FYERS_MAX_CONSECUTIVE_FAILURES attempts per stored-token content per
 *    process; a fresh login (row content change) lifts the block.
 *  - The AWAITING_APPROVAL marker is durable (survives process restart) and
 *    lives in the EXISTING `upstox_live_paper_tokens` table — its token column
 *    is nullable by design (TOKEN_MISSING seed rows) and 'AWAITING_APPROVAL'
 *    fits its status column, so NO schema change and no new subsystem. Runtime
 *    token consumers remain on `provider_tokens` only; this table is used here
 *    strictly as request-state bookkeeping.
 *  - No Hermes dependency.
 */

export type TokenState =
  | 'VALID'
  | 'EXPIRING'
  | 'REFRESHING'
  | 'AWAITING_APPROVAL'
  | 'AUTH_REQUIRED'
  | 'INVALID';

export type ProviderTokenHealth = {
  provider: 'fyers' | 'upstox';
  state: TokenState;
  /** Redacted, human-readable detail. NEVER contains token material. */
  detail: string;
  expiresAt: string | null;
};

export type TokenHealthReport = {
  checkedAt: string;
  fyers: ProviderTokenHealth;
  upstox: ProviderTokenHealth;
};

/** A token with <= 30 min left is due for renewal. */
const EXPIRING_WINDOW_MS = 30 * 60 * 1000;
/** Periodic health-check cadence (plus one bootstrap check at module init). */
const CHECK_INTERVAL_MS = 10 * 60 * 1000;
/** Minimum gap between FYERS refresh attempts. */
const FYERS_REFRESH_COOLDOWN_MS = 15 * 60 * 1000;
/**
 * After this many consecutive failures for the SAME stored token content,
 * automated refresh stops until the stored token changes (re-login / a
 * successful refresh) or the process restarts. Keeps a dead refresh token from
 * becoming a retry storm.
 */
const FYERS_MAX_CONSECUTIVE_FAILURES = 2;
/** Durable marker status for a pending Upstox token request. */
const UPSTOX_AWAITING_STATUS = 'AWAITING_APPROVAL';

type UpstoxInitiationOutcome = 'disabled' | 'inflight' | 'skipped' | 'initiated' | 'failed';

@Injectable()
export class TokenSupervisorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TokenSupervisorService.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  private fyersRefreshInFlight = false;
  private fyersLastAttemptAt = 0;
  private fyersFailureCount = 0;
  private fyersFailuresForContentKey: string | null = null;
  private upstoxInitiationInFlight = false;
  private markerReadWarned = false;

  /** Last state logged per provider — states are logged on CHANGE only. */
  private readonly lastLoggedState: Partial<Record<'fyers' | 'upstox', TokenState>> = {};

  constructor(
    private readonly tokens: ProviderTokenService,
    @InjectRepository(UpstoxLivePaperToken)
    private readonly markerRepo: Repository<UpstoxLivePaperToken>,
  ) {}

  async onModuleInit(): Promise<void> {
    // Bootstrap / pre-market health check: run immediately on boot so the
    // process never sits on an expired FYERS token it could have refreshed.
    // Kept non-blocking and fully guarded — a DB that is still connecting at
    // boot must not fail module init (the next interval tick retries).
    void this.tick().catch((error: unknown) => {
      this.logger.warn(`[TOKEN-SUPERVISOR] bootstrap check failed: ${this.describe(error)}`);
    });
    this.timer = setInterval(() => {
      void this.tick().catch((error: unknown) => {
        this.logger.warn(`[TOKEN-SUPERVISOR] periodic check failed: ${this.describe(error)}`);
      });
    }, CHECK_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One deterministic health-check cycle for both providers. */
  async tick(now: Date = new Date()): Promise<TokenHealthReport> {
    const fyers = await this.checkFyers(now);
    const upstox = await this.checkUpstox(now);
    return { checkedAt: now.toISOString(), fyers, upstox };
  }

  // ── FYERS ────────────────────────────────────────────────────────────────

  private async checkFyers(now: Date): Promise<ProviderTokenHealth> {
    try {
      const info = await this.tokens.getActiveTokenInfo('fyers', 'live');
      if (!info?.active) {
        return this.report(
          'fyers',
          'AUTH_REQUIRED',
          'no active FYERS token row — log in via the portal',
          null,
        );
      }
      if (!info.expiresAt) {
        return this.report(
          'fyers',
          'INVALID',
          'FYERS token expiry cannot be derived (no row expiry and no decodable exp claim)',
          null,
        );
      }
      const expiresAt = info.expiresAt;
      const remainingMs = expiresAt.getTime() - now.getTime();
      if (remainingMs > EXPIRING_WINDOW_MS) {
        return this.report('fyers', 'VALID', `access token valid until ${expiresAt.toISOString()}`, expiresAt);
      }

      const refreshStatus = await this.tokens.getRefreshStatus();
      if (!refreshStatus.hasRefreshToken || !refreshStatus.hasPin) {
        const why = !refreshStatus.hasRefreshToken
          ? 'no refresh token stored'
          : 'FYERS_PIN not configured in the process environment';
        // No automated recovery possible — human action required. NEVER retried.
        return this.report(
          'fyers',
          remainingMs <= 0 ? 'AUTH_REQUIRED' : 'EXPIRING',
          `refresh unavailable (${why}) — manual login required`,
          expiresAt,
        );
      }

      const outcome = await this.maybeRefreshFyers(now);
      if (outcome === 'refreshed') {
        const after = await this.tokens.getActiveTokenInfo('fyers', 'live');
        return this.report('fyers', 'VALID', 'access token refreshed', after?.expiresAt ?? null);
      }
      if (outcome === 'inflight') {
        return this.report('fyers', 'REFRESHING', 'refresh attempt in flight', expiresAt);
      }
      if (outcome === 'suppressed') {
        return this.report(
          'fyers',
          'AUTH_REQUIRED',
          'automated refresh stopped after repeated failures for the current token — re-login required',
          expiresAt,
        );
      }
      if (outcome === 'failed') {
        return this.report('fyers', 'REFRESHING', 'refresh attempt failed — retry scheduled', expiresAt);
      }
      if (outcome === 'pending-retry') {
        return this.report('fyers', 'REFRESHING', 'refresh retry pending (cooldown)', expiresAt);
      }
      return this.report(
        'fyers',
        remainingMs <= 0 ? 'AUTH_REQUIRED' : 'EXPIRING',
        'refresh not attempted',
        expiresAt,
      );
    } catch (error) {
      return this.report('fyers', 'INVALID', `supervisor read failed: ${this.describe(error)}`, null);
    }
  }

  private async maybeRefreshFyers(
    now: Date,
  ): Promise<'refreshed' | 'failed' | 'suppressed' | 'pending-retry' | 'inflight'> {
    if (this.fyersRefreshInFlight) return 'inflight';
    const contentKey = await this.fyersContentKey();
    if (this.fyersFailuresForContentKey !== contentKey) {
      // New stored token content (fresh login / a successful refresh landed):
      // previous failures no longer apply.
      this.fyersFailuresForContentKey = contentKey;
      this.fyersFailureCount = 0;
    }
    if (this.fyersFailureCount >= FYERS_MAX_CONSECUTIVE_FAILURES) return 'suppressed';
    if (now.getTime() - this.fyersLastAttemptAt < FYERS_REFRESH_COOLDOWN_MS) return 'pending-retry';

    this.fyersRefreshInFlight = true;
    this.fyersLastAttemptAt = now.getTime();
    try {
      const ok = await this.tokens.refreshAccessToken();
      if (ok) {
        this.fyersFailureCount = 0;
        return 'refreshed';
      }
      this.fyersFailureCount += 1;
      return 'failed';
    } finally {
      this.fyersRefreshInFlight = false;
    }
  }

  /**
   * Identity of the stored FYERS row content (id + ciphertext digest) used to
   * scope failure suppression. In-memory only; never logged.
   */
  private async fyersContentKey(): Promise<string> {
    const row = await this.tokens.getCurrentToken('fyers', 'live');
    if (!row) return 'no-row';
    return crypto.createHash('sha256').update(`${row.id}:${row.accessTokenEncrypted}`).digest('hex').slice(0, 16);
  }

  // ── Upstox ───────────────────────────────────────────────────────────────

  private async checkUpstox(now: Date): Promise<ProviderTokenHealth> {
    try {
      const info = await this.tokens.getActiveTokenInfo('upstox', 'live');
      if (info?.active && info.expiresAt && info.expiresAt.getTime() - now.getTime() > EXPIRING_WINDOW_MS) {
        return this.report('upstox', 'VALID', `access token valid until ${info.expiresAt.toISOString()}`, info.expiresAt);
      }

      const pending = await this.getPendingUpstoxRequest(now);
      if (pending) {
        const until = pending.expiresAt ? pending.expiresAt.toISOString() : 'n/a';
        return this.report(
          'upstox',
          'AWAITING_APPROVAL',
          `token request awaiting operator approval (valid until ${until})`,
          pending.expiresAt ?? null,
        );
      }

      if (info?.active && !info.expiresAt) {
        return this.report('upstox', 'INVALID', 'Upstox token expiry cannot be derived from the stored row', null);
      }

      const hasUnexpiredToken = !!info?.active && !!info.expiresAt && info.expiresAt.getTime() > now.getTime();
      let initiation: UpstoxInitiationOutcome | 'not-needed' = 'not-needed';
      if (!hasUnexpiredToken) {
        initiation = await this.maybeInitiateUpstoxRequest(now);
      }

      if (initiation === 'initiated') {
        const started = await this.getPendingUpstoxRequest(now);
        const until = started?.expiresAt ? ` (valid until ${started.expiresAt.toISOString()})` : '';
        return this.report(
          'upstox',
          'AWAITING_APPROVAL',
          `token request initiated — awaiting operator approval${until}`,
          started?.expiresAt ?? null,
        );
      }
      if (initiation === 'failed') {
        return this.report(
          'upstox',
          'AUTH_REQUIRED',
          'token request initiation failed — manual OAuth (GET UPSTOX TOKEN) required',
          info?.expiresAt ?? null,
        );
      }

      if (hasUnexpiredToken && info?.expiresAt) {
        return this.report('upstox', 'EXPIRING', `access token expires ${info.expiresAt.toISOString()}`, info.expiresAt);
      }

      const detailByInitiation: Record<string, string> = {
        disabled:
          'no valid token — manual OAuth (GET UPSTOX TOKEN); request automation gated until the notifier URL is confirmed',
        inflight: 'no valid token — token request initiation in flight',
        skipped: 'no valid token — a token request is already pending',
        'not-needed': 'no valid token — manual OAuth (GET UPSTOX TOKEN) required',
      };
      return this.report(
        'upstox',
        'AUTH_REQUIRED',
        detailByInitiation[initiation] ?? detailByInitiation['not-needed'],
        info?.expiresAt ?? null,
      );
    } catch (error) {
      return this.report('upstox', 'INVALID', `supervisor read failed: ${this.describe(error)}`, null);
    }
  }

  /**
   * Read the durable AWAITING_APPROVAL marker (survives restarts). Rows whose
   * authorization window has passed are ignored (approval validity ends 03:30
   * IST the following day — provider-side rule).
   */
  private async getPendingUpstoxRequest(now: Date): Promise<UpstoxLivePaperToken | null> {
    try {
      const rows = await this.markerRepo.find({
        where: { broker: 'UPSTOX', status: UPSTOX_AWAITING_STATUS },
        order: { createdAt: 'DESC' },
      });
      return rows.find((row) => !row.expiresAt || row.expiresAt.getTime() > now.getTime()) ?? null;
    } catch (error) {
      if (!this.markerReadWarned) {
        this.markerReadWarned = true;
        this.logger.warn(`[TOKEN-SUPERVISOR] pending-request read failed: ${this.describe(error)}`);
      }
      return null;
    }
  }

  /**
   * Durably record that an Upstox token request is in flight. See the class
   * header for why this uses the existing upstox_live_paper_tokens table.
   * NEVER includes token material (the column stays null by design).
   */
  protected async markUpstoxRequestPending(now: Date, authorizationExpiry: Date): Promise<void> {
    const clientId = ((process.env.UPSTOX_LIVE_API_KEY ?? '').trim() || 'unknown').toUpperCase();
    const row = this.markerRepo.create({
      broker: 'UPSTOX',
      clientId,
      accessTokenEncrypted: null,
      tokenType: 'Bearer',
      issuedAt: now,
      expiresAt: authorizationExpiry,
      status: UPSTOX_AWAITING_STATUS,
    });
    await this.markerRepo.save(row);
  }

  /**
   * Upstox token-request initiation — single entry point enforcing: gate,
   * single-flight, and "never a duplicate while a request is pending".
   */
  private async maybeInitiateUpstoxRequest(now: Date): Promise<UpstoxInitiationOutcome> {
    if (!this.upstoxInitiationEnabled()) return 'disabled';
    if (this.upstoxInitiationInFlight) return 'inflight';
    if (await this.getPendingUpstoxRequest(now)) return 'skipped'; // duplicate guard
    this.upstoxInitiationInFlight = true;
    try {
      await this.initiateUpstoxTokenRequest(now);
      return 'initiated';
    } catch (error) {
      this.logger.warn(`[TOKEN-SUPERVISOR] Upstox token request initiation failed: ${this.describe(error)}`);
      return 'failed';
    } finally {
      this.upstoxInitiationInFlight = false;
    }
  }

  /**
   * P3 gate (operator decision 2026-09-23): the Upstox Access Token Request
   * flow stays DISABLED until the operator confirms the app's notifier webhook
   * URL is configured. Flip together with implementing the API call below and
   * exposing AWAITING_APPROVAL on the portal.
   */
  protected upstoxInitiationEnabled(): boolean {
    return false;
  }

  /**
   * P3 placeholder — the Access Token Request call
   * (POST https://api.upstox.com/v3/login/auth/token/request/:client_id with
   * the server-side client secret) is intentionally NOT implemented: notifier
   * configuration could not be confirmed, so P3 is stopped per the directive.
   */
  protected async initiateUpstoxTokenRequest(_now: Date): Promise<void> {
    throw new Error('Upstox Access Token Request not implemented — notifier configuration unconfirmed (P3 gated)');
  }

  // ── shared ───────────────────────────────────────────────────────────────

  private report(
    provider: 'fyers' | 'upstox',
    state: TokenState,
    detail: string,
    expiresAt: Date | null,
  ): ProviderTokenHealth {
    if (this.lastLoggedState[provider] !== state) {
      this.lastLoggedState[provider] = state;
      const line = `[TOKEN-SUPERVISOR] ${provider.toUpperCase()} ${state} — ${detail}`;
      if (state === 'AUTH_REQUIRED' || state === 'INVALID') this.logger.warn(line);
      else this.logger.log(line);
    }
    return { provider, state, detail, expiresAt: expiresAt ? expiresAt.toISOString() : null };
  }

  private describe(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.slice(0, 200);
  }
}
