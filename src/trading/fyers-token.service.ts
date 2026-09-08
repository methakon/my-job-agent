import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan, MoreThan, IsNull, Not } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { EncryptionService } from '../auth/encryption.service';
import { FyersToken } from './fyers-token.entity';
import { ConfigType } from '@nestjs/config';

/**
 * FyersTokenService — manages FYERS OAuth tokens with encryption and rotation.
 * 
 * Design principles:
 * - Tokens encrypted with EncryptionService (AES-256-CBC under ENCRYPTION_KEY)
 * - SINGLE-ROW token model: one active row, created on the first OAuth
 *   callback login and UPDATED IN PLACE on every re-login/refresh — no new
 *   token rows are ever added to the database.
 * - The OAuth callback is the only token intake: it reads auth_code from the
 *   URL parameter, exchanges it, and stores the result here once.
 * - Runtime consumers (market data, scripts) read the token from this DB
 *   store, never from freshly-minted tokens or repeated inserts.
 * - Expiry inferred from FYERS v3 doc (market close next business day)
 * - PIN NEVER stored; manual entry required for refresh
 * - PIN must be provided at refresh time; not persisted in DB
 */
@Injectable()
export class FyersTokenService {
  private readonly logger = new Logger(FyersTokenService.name);

  constructor(
    @InjectRepository(FyersToken) private readonly repo: Repository<FyersToken>,
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

  /**
   * App ID for FYERS OAuth (from environment).
   */
  private get appId(): string | undefined {
    return this.config.get<string>('FYERS_APP_ID')?.trim();
  }

  /**
   * App secret for FYERS OAuth (from environment).
   * Never log this value.
   */
  private get appSecret(): string | undefined {
    return this.config.get<string>('FYERS_APP_SECRET')?.trim();
  }

  /**
   * Compute SHA-256 hex of appId:appSecret for FYERS validate-authcode/refresh-token.
   */
  private computeAppIdHash(): string {
    const crypto = require('crypto');
    const appId = this.appId;
    const appSecret = this.appSecret;
    if (!appId || !appSecret) {
      throw new Error('FYERS_APP_ID and FYERS_APP_SECRET must be configured');
    }
    return crypto.createHash('sha256').update(`${appId}:${appSecret}`).digest('hex');
  }

  /**
   * Store tokens after successful OAuth exchange.
   *
   * Single-row semantics (user rule: "no new token should be stored in the
   * database"):
   * - If an active row already exists, it is UPDATED in place with the new
   *   encrypted tokens — the row count never grows on re-login or rotation.
   * - A row is INSERTED only on the very first login (no active row yet).
   *
   * @param accessToken - Raw access token from FYERS
   * @param refreshToken - Raw refresh token from FYERS (nullable)
   * @param userId - FYERS user ID (FY ID) for audit
   * @param authCode - Original auth_code (will be hashed for audit, not stored in plaintext)
   * @returns stored token record
   */
  async storeTokens(
    accessToken: string,
    refreshToken: string | null,
    userId: string | null = null,
    authCode: string | null = null,
  ): Promise<FyersToken> {
    // Hash auth_code for audit (never store plaintext)
    const authCodeHash = authCode ? this.hashAuthCode(authCode) : null;

    // Encrypt tokens
    const accessTokenEncrypted = this.encryption.encrypt(accessToken);
    const refreshTokenEncrypted = refreshToken ? this.encryption.encrypt(refreshToken) : null;

    // Reuse the existing active row if present (single-row model — no new rows).
    const existing = await this.repo.findOne({ where: { status: 'active' } });
    if (existing) {
      // Collapse any stray duplicate active rows (idempotent safety net).
      await this.repo.update(
        { status: 'active', id: Not(existing.id) },
        {
          status: 'revoked',
          statusReason: 'superseded_single_active_row',
          revokedAt: new Date(),
        },
      );

      existing.accessTokenEncrypted = accessTokenEncrypted;
      existing.refreshTokenEncrypted = refreshTokenEncrypted;
      existing.appId = this.appId || existing.appId;
      if (userId) existing.userId = userId;
      if (authCodeHash) existing.authCodeHash = authCodeHash;
      existing.status = 'active';
      existing.statusReason = null;
      existing.revokedAt = null;
      existing.expiresAt = null;
      return this.repo.save(existing);
    }

    // No active row yet — very first login: create the single token row.
    const token = this.repo.create({
      provider: 'fyers',
      appId: this.appId || 'unknown',
      accessTokenEncrypted,
      refreshTokenEncrypted,
      userId,
      authCodeHash,
      status: 'active',
      statusReason: null,
      // Expiry: inferred as market close next business day (FYERS v3 doc)
      // For now, we leave expiresAt null; trading agent will handle refresh
      expiresAt: null,
    });

    return this.repo.save(token);
  }

  /**
   * Get currently valid (active) token record.
   * Returns null if no active token exists.
   */
  async getCurrentToken(): Promise<FyersToken | null> {
    return this.repo.findOne({ where: { status: 'active' } });
  }

  /**
   * Get active access token (decrypted).
   * Returns null if no active token or decryption fails.
   */
  async getActiveAccessToken(): Promise<string | null> {
    const token = await this.getCurrentToken();
    if (!token) return null;
    return this.encryption.decrypt(token.accessTokenEncrypted);
  }

  /**
   * Get active refresh token (decrypted).
   * Returns null if no active token or no refresh token stored.
   */
  async getActiveRefreshToken(): Promise<string | null> {
    const token = await this.getCurrentToken();
    if (!token || !token.refreshTokenEncrypted) return null;
    return this.encryption.decrypt(token.refreshTokenEncrypted);
  }

  /**
   * Check if a valid (active) token exists.
   */
  async hasActiveToken(): Promise<boolean> {
    const count = await this.repo.count({ where: { status: 'active' } });
    return count > 0;
  }

  /**
   * Mark a token as expired/revoked.
   * Used when:
   * - Token is confirmed expired via API call
   * - User manually revokes via portal
   * - Security incident requires immediate invalidation
   */
  async markRevoked(tokenId: string, reason: string): Promise<void> {
    await this.repo.update(
      { id: tokenId },
      {
        status: 'revoked',
        statusReason: reason,
        revokedAt: new Date(),
      },
    );
  }

  /**
   * Rotate tokens (on refresh failure or manual rotation).
   * Stores new tokens and revokes old active token.
   */
  async rotateTokens(
    accessToken: string,
    refreshToken: string | null,
    userId: string | null = null,
    authCode: string | null = null,
  ): Promise<FyersToken> {
    return this.storeTokens(accessToken, refreshToken, userId, authCode);
  }

  /**
   * Find tokens issued on or after a date.
   */
  async getTokensFromDate(date: Date): Promise<FyersToken[]> {
    return this.repo.find({
      where: { issuedAt: MoreThan(date), status: 'active' },
      order: { issuedAt: 'DESC' },
    });
  }

  /**
   * Retrieve token history for a specific date range.
   */
  async getTokenHistory(
    startDate: Date,
    endDate: Date,
  ): Promise<{ tokens: FyersToken[]; activeCount: number }> {
    const tokens = await this.repo.find({
      where: {
        issuedAt: LessThan(endDate),
      },
      order: { issuedAt: 'DESC' },
    });
    const activeCount = tokens.filter((t) => t.status === 'active').length;
    return { tokens, activeCount };
  }

  /**
   * Delete all tokens (emergency reset).
   * NOT recommended; use markRevoked instead for audit.
   */
  async deleteAllTokens(): Promise<void> {
    await this.repo.clear();
  }

  /**
   * Hash auth_code for audit (SHA-256, never stored plaintext).
   */
  private hashAuthCode(authCode: string): string {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(authCode).digest('hex');
  }

  /**
   * Compute appSecret hash for FYERS API calls.
   */
  getAppSecretHash(): string {
    return this.computeAppIdHash();
  }

  /**
   * Attempt to refresh access token using stored refresh_token.
   * 
   * IMPORTANT: Requires FYERS PIN at runtime (cannot be persisted in DB).
   * If PIN is not provided, returns null and logs warning.
   * 
   * @returns true if refresh succeeded, false if PIN missing or refresh failed
   */
  async refreshAccessToken(): Promise<boolean> {
    // Check if PIN is configured
    if (!this.fyersPin || this.fyersPin.trim().length === 0) {
      this.logger.warn('FYERS_PIN not configured - refresh requires manual PIN entry');
      return false;
    }

    // Get active refresh token
    const refreshToken = await this.getActiveRefreshToken();
    if (!refreshToken) {
      this.logger.warn('No refresh token available');
      return false;
    }

    const appIdHash = this.computeAppIdHash();

    try {
      // Exchange refresh token for new access token
      const response = await fetch('https://api-t1.fyers.in/api/v3/refresh-token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
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

      // Store new tokens
      await this.rotateTokens(
        data.access_token,
        data.refresh_token || null,
        data.fy_id || null,
        null,
      );

      this.logger.log('Tokens refreshed successfully');
      return true;
    } catch (error) {
      this.logger.error('Refresh failed', error as Error);
      return false;
    }
  }

  /**
   * Get refresh token status.
   * @returns object with hasRefreshToken and hasPin
   */
  async getRefreshStatus(): Promise<{ hasRefreshToken: boolean; hasPin: boolean }> {
    const hasRefreshToken = (await this.repo.count({ where: { refreshTokenEncrypted: Not(IsNull()) } })) > 0;
    return {
      hasRefreshToken,
      hasPin: !!this.fyersPin && this.fyersPin.trim().length > 0,
    };
  }
}
