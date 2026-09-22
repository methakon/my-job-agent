import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan, MoreThan, IsNull, Not } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { EncryptionService } from '../auth/encryption.service';
import { ProviderToken } from './provider-token.entity';

/**
 * ProviderTokenService — manages OAuth tokens for ALL providers (FYERS, Upstox, etc.)
 * with encrypted storage, rotation, and full audit trail.
 *
 * Design principles:
 * - Tokens encrypted with EncryptionService (AES-256-CBC under ENCRYPTION_KEY)
 * - SINGLE-ROW-PER-PROVIDER model: one active row per provider+environment,
 *   created on the first login and UPDATED IN PLACE on re-login/refresh.
 * - Historical rows retained for audit (status='expired'|'revoked').
 * - The OAuth callback is the only token intake.
 * - Runtime consumers read the token from this DB store, never from .env.
 * - PIN NEVER stored; manual entry required for refresh (FYERS-specific)
 */
@Injectable()
export class ProviderTokenService {
  private readonly logger = new Logger(ProviderTokenService.name);

  constructor(
    @InjectRepository(ProviderToken) private readonly repo: Repository<ProviderToken>,
    private readonly encryption: EncryptionService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Optional PIN for FYERS refresh token exchange.
   * PIN is NEVER stored in the database.
   * Must be provided at runtime if refresh is needed.
   */
  @Optional()
  @Inject('FYERS_PIN')
  private readonly fyersPin?: string;

  // ─── Provider-specific getters (FYERS) ────────────────────────────────

  private get fyersAppId(): string | undefined {
    return this.config.get<string>('FYERS_APP_ID')?.trim();
  }

  private get fyersAppSecret(): string | undefined {
    return this.config.get<string>('FYERS_APP_SECRET')?.trim();
  }

  /** Compute SHA-256 hex of appId:appSecret for FYERS API calls. */
  private computeFyersAppIdHash(): string {
    const crypto = require('crypto');
    const appId = this.fyersAppId;
    const appSecret = this.fyersAppSecret;
    if (!appId || !appSecret) {
      throw new Error('FYERS_APP_ID and FYERS_APP_SECRET must be configured');
    }
    return crypto.createHash('sha256').update(`${appId}:${appSecret}`).digest('hex');
  }

  // ─── Generic token CRUD ───────────────────────────────────────────────

  /**
   * Store tokens after successful OAuth exchange.
   *
   * Single-row-per-provider semantics:
   * - If an active row exists for this provider+environment, it is UPDATED in place.
   * - A row is INSERTED only on the very first login.
   *
   * @param accessToken - Raw access token from provider
   * @param refreshToken - Raw refresh token (nullable)
   * @param clientId - Provider app/client ID for audit
   * @param provider - Provider identifier (e.g., 'fyers', 'upstox', 'upstox_sandbox')
   * @param environment - 'sandbox', 'live', 'paper'
   * @param authCode - Original auth_code (hashed for audit, not stored plaintext)
   * @param options - Optional lifecycle metadata.
   *   `expiresAt` is stored on the row when the provider returns an authoritative
   *   expiry (Upstox OAuth: the token's own exp claim = 3:30 AM IST the next day).
   *   `tokenDate` is the IST calendar date the token was issued (YYYY-MM-DD).
   *   FYERS call sites pass neither: behaviour there is unchanged (expiresAt stays
   *   null; expiry is derived from the JWT exp claim at read time).
   * @returns stored token record
   */
  async storeTokens(
    accessToken: string,
    refreshToken: string | null,
    clientId: string,
    provider: string,
    environment: string = 'live',
    authCode: string | null = null,
    options: { expiresAt?: Date | null; tokenDate?: string | null } = {},
  ): Promise<ProviderToken> {
    const authCodeHash = authCode ? this.hashAuthCode(authCode) : null;
    const accessTokenEncrypted = this.encryption.encrypt(accessToken);
    const refreshTokenEncrypted = refreshToken ? this.encryption.encrypt(refreshToken) : null;

    // Find existing active row for this provider+environment
    const existing = await this.repo.findOne({
      where: { provider, environment, status: 'active' },
    });

    if (existing) {
      // Collapse any stray duplicate active rows
      await this.repo.update(
        { provider, environment, status: 'active', id: Not(existing.id) },
        {
          status: 'revoked',
          statusReason: 'superseded_single_active_row',
          revokedAt: new Date(),
        },
      );

      existing.accessTokenEncrypted = accessTokenEncrypted;
      existing.refreshTokenEncrypted = refreshTokenEncrypted;
      existing.clientId = clientId || existing.clientId;
      if (authCodeHash) existing.authCodeHash = authCodeHash;
      existing.status = 'active';
      existing.statusReason = null;
      existing.revokedAt = null;
      // Re-login clears any stale expiry; when the caller supplied an
      // authoritative one (Upstox: the token's own exp claim), it replaces the
      // value. FYERS passes none, so expiry stays null here and is derived from
      // the JWT exp claim at read time — unchanged.
      existing.expiresAt = options.expiresAt ?? null;
      if (options.tokenDate !== undefined) existing.tokenDate = options.tokenDate;
      return this.repo.save(existing);
    }

    // First login for this provider+environment
    const token = this.repo.create({
      provider,
      environment,
      clientId: clientId || 'unknown',
      accessTokenEncrypted,
      refreshTokenEncrypted,
      authCodeHash,
      status: 'active',
      statusReason: null,
      expiresAt: options.expiresAt ?? null,
      ...(options.tokenDate !== undefined ? { tokenDate: options.tokenDate } : {}),
    });

    return this.repo.save(token);
  }

  /** Get currently valid (active) token record for a provider+environment. */
  async getCurrentToken(provider: string, environment: string = 'live'): Promise<ProviderToken | null> {
    return this.repo.findOne({ where: { provider, environment, status: 'active' } });
  }

  /** Get active access token (decrypted) for a provider+environment. */
  async getActiveAccessToken(provider: string, environment: string = 'live'): Promise<string | null> {
    const token = await this.getCurrentToken(provider, environment);
    if (!token) return null;
    return this.encryption.decrypt(token.accessTokenEncrypted);
  }

  /** Non-sensitive summary of the active token row (for UI status cards). */
  async getActiveTokenInfo(
    provider: string,
    environment: string = 'live',
  ): Promise<{ active: boolean; expiresAt: Date | null; refreshAvailable: boolean } | null> {
    const row = await this.getCurrentToken(provider, environment);
    if (!row?.accessTokenEncrypted) return null;
    let expiresAt: Date | null = null;
    try {
      const plain = this.encryption.decrypt(row.accessTokenEncrypted);
      const payload = plain.split('.')[1];
      if (payload) {
        const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: number };
        if (typeof claims.exp === 'number' && Number.isFinite(claims.exp)) expiresAt = new Date(claims.exp * 1000);
      }
    } catch {
      expiresAt = null; // opaque/non-JWT token
    }
    // Fall back to the expiry stored on the row when the token itself carries
    // no decodable JWT exp (e.g. an opaque Upstox token written with an
    // explicit expiresAt by the OAuth callback). FYERS rows store null here,
    // so their read behaviour is unchanged.
    if (!expiresAt && row.expiresAt) expiresAt = row.expiresAt;
    return { active: true, expiresAt, refreshAvailable: !!row.refreshTokenEncrypted };
  }

  /** Get active refresh token (decrypted) for a provider+environment. */
  async getActiveRefreshToken(provider: string, environment: string = 'live'): Promise<string | null> {
    const token = await this.getCurrentToken(provider, environment);
    if (!token || !token.refreshTokenEncrypted) return null;
    return this.encryption.decrypt(token.refreshTokenEncrypted);
  }

  /** Check if a valid (active) token exists for a provider+environment. */
  async hasActiveToken(provider: string, environment: string = 'live'): Promise<boolean> {
    const count = await this.repo.count({ where: { provider, environment, status: 'active' } });
    return count > 0;
  }

  /** Mark a token as expired/revoked. */
  async markRevoked(tokenId: string, reason: string): Promise<void> {
    await this.repo.update(
      { id: tokenId },
      { status: 'revoked', statusReason: reason, revokedAt: new Date() },
    );
  }

  /** Mark all active tokens for a provider as expired. */
  async markExpired(provider: string, environment: string = 'live'): Promise<void> {
    const active = await this.repo.findOne({ where: { provider, environment, status: 'active' } });
    if (active) {
      active.status = 'expired';
      active.statusReason = 'token_expiry_detected';
      active.revokedAt = new Date();
      await this.repo.save(active);
    }
  }

  /** Rotate tokens — stores new and revokes old active token. */
  async rotateTokens(
    accessToken: string,
    refreshToken: string | null,
    clientId: string,
    provider: string,
    environment: string = 'live',
    authCode: string | null = null,
    options: { expiresAt?: Date | null; tokenDate?: string | null } = {},
  ): Promise<ProviderToken> {
    return this.storeTokens(accessToken, refreshToken, clientId, provider, environment, authCode, options);
  }

  /** Find tokens issued on or after a date for a provider. */
  async getTokensFromDate(date: Date, provider?: string): Promise<ProviderToken[]> {
    const where: any = { issuedAt: MoreThan(date), status: 'active' };
    if (provider) where.provider = provider;
    return this.repo.find({ where, order: { issuedAt: 'DESC' } });
  }

  /** Retrieve token history for a date range. */
  async getTokenHistory(
    startDate: Date,
    endDate: Date,
    provider?: string,
  ): Promise<{ tokens: ProviderToken[]; activeCount: number }> {
    const where: any = { issuedAt: LessThan(endDate) };
    if (provider) where.provider = provider;
    const tokens = await this.repo.find({ where, order: { issuedAt: 'DESC' } });
    const activeCount = tokens.filter((t) => t.status === 'active').length;
    return { tokens, activeCount };
  }

  /** Delete all tokens (emergency reset). NOT recommended; use markRevoked instead. */
  async deleteAllTokens(): Promise<void> {
    await this.repo.clear();
  }

  // ─── FYERS-specific ───────────────────────────────────────────────────

  /** Compute appSecret hash for FYERS API calls. */
  getAppSecretHash(): string {
    return this.computeFyersAppIdHash();
  }

  /**
   * Attempt to refresh FYERS access token using stored refresh_token.
   * IMPORTANT: Requires FYERS PIN at runtime (cannot be persisted in DB).
   * @returns true if refresh succeeded, false if PIN missing or refresh failed
   */
  async refreshAccessToken(): Promise<boolean> {
    if (!this.fyersPin || this.fyersPin.trim().length === 0) {
      this.logger.warn('FYERS_PIN not configured - refresh requires manual PIN entry');
      return false;
    }

    const refreshToken = await this.getActiveRefreshToken('fyers');
    if (!refreshToken) {
      this.logger.warn('No FYERS refresh token available');
      return false;
    }

    const appIdHash = this.computeFyersAppIdHash();

    try {
      const response = await fetch('https://api-t1.fyers.in/api/v3/refresh-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          appIdHash,
          refresh_token: refreshToken,
          pin: this.fyersPin.trim(),
        }),
      });

      const data = await response.json();
      if (!response.ok || data.s !== 'ok' || !data.access_token) {
        throw new Error(data.message || `Refresh failed with status ${response.status}`);
      }

      await this.rotateTokens(
        data.access_token,
        data.refresh_token || null,
        data.fy_id || null,
        'fyers',
        'live',
      );

      this.logger.log('FYERS tokens refreshed successfully');
      return true;
    } catch (error) {
      this.logger.error('FYERS refresh failed', error as Error);
      return false;
    }
  }

  /** Get FYERS refresh token status. */
  async getRefreshStatus(): Promise<{ hasRefreshToken: boolean; hasPin: boolean }> {
    const hasRefreshToken = (await this.repo.count({
      where: { provider: 'fyers', refreshTokenEncrypted: Not(IsNull()) },
    })) > 0;
    return {
      hasRefreshToken,
      hasPin: !!this.fyersPin && this.fyersPin.trim().length > 0,
    };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  /** Hash auth_code for audit (SHA-256, never stored plaintext). */
  private hashAuthCode(authCode: string): string {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(authCode).digest('hex');
  }
}
