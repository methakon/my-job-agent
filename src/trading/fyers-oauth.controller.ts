import {
  Controller,
  Get,
  Query,
  Res,
  HttpException,
  HttpStatus,
  Redirect,
} from '@nestjs/common';
import { Response } from 'express';
import { BypassAuth } from '../auth/bypass-auth.decorator';
import { FyersTokenService } from './fyers-token.service';
import * as crypto from 'crypto';
import * as querystring from 'querystring';

/**
 * FYERS OAuth v3 automatic login and callback controller.
 * 
 * Flow:
 * 1. Browser calls GET /auth/fyers/login
 * 2. Server generates secure random state, stores it with expiration
 * 3. Browser redirected to FYERS auth URL
 * 4. FYERS redirects back to /auth/fyers/callback?auth_code=...&state=...
 * 5. Server validates state, exchanges auth_code, stores encrypted tokens
 * 6. Browser redirected to success/failure UI
 * 
 * Human FYERS authentication (login/PIN/OTP) is REQUIRED and cannot be bypassed.
 * This controller only automates the callback handling and token persistence.
 */
@Controller('auth/fyers')
export class FyersOAuthController {
  private readonly FYERS_API_BASE = 'https://api-t1.fyers.in/api/v3';

  constructor(private readonly fyersTokenService: FyersTokenService) {}

  /**
   * Step 1: Generate FYERS login URL and redirect browser.
   * 
   * This endpoint:
   * - Verifies FYERS configuration exists
   * - Generates cryptographically secure random OAuth state
   * - Stores state in memory (Redis would be better for production)
   * - Sets short expiration (5 minutes)
   * - Redirects browser to FYERS login page
   */
  @Get('login')
  @BypassAuth()
  async login(@Res() res: Response) {
    const appId = this.fyersTokenService['appId'];
    const appSecret = this.fyersTokenService['appSecret'];
    const redirectUri = this.fyersTokenService['config'].get<string>('FYERS_REDIRECT_URI')?.trim();

    if (!appId || !appSecret || !redirectUri) {
      this.logger.warn('FYERS credentials incomplete');
      return res.status(500).json({
        success: false,
        error: 'missing_credentials',
        detail:
          'Set FYERS_APP_ID, FYERS_APP_SECRET, and FYERS_REDIRECT_URI in .env',
      });
    }

    // Generate secure random state (16 bytes = 128 bits)
    const state = crypto.randomBytes(16).toString('hex');

    // Store state with metadata (in production, use Redis with TTL)
    // For now, store in memory - this is acceptable for single-instance deployments
    const stateKey = `fyers_oauth_${state}`;
    const stateData = {
      appId,
      redirectUri,
      createdAt: Date.now(),
      used: false,
    };

    // Store state in Redis-like in-memory map (simulated for now)
    // In production, replace with Redis or database entry
    this.stateStore.set(stateKey, { ...stateData, appSecret });

    // FYERS OAuth2 auth code endpoint
    const params = {
      client_id: appId,
      redirect_uri: redirectUri,
      response_type: 'code',
      state: state,
    };

    const authUrl = `${this.FYERS_API_BASE}/generate-authcode?${querystring.stringify(params)}`;

    this.logger.log(`Generated auth URL for state=${state}`);

    // Redirect browser to FYERS login page
    return res.redirect(authUrl);
  }

  /**
   * Step 2: FYERS OAuth callback handler.
   * 
   * This endpoint:
   * - Receives auth_code and state from FYERS redirect
   * - Validates state matches (CSRF protection)
   * - Checks state hasn't expired (5 min TTL)
   * - Atomically consumes state (prevents replay)
   * - Exchanges auth_code with FYERS API
   * - Encrypts and stores tokens in MySQL
   * - Redirects browser to success/failure UI
   */
  @Get('callback')
  @BypassAuth()
  async callback(
    @Query('auth_code') authCode: string | undefined,
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Res() res: Response,
  ) {
    // FYERS v3 redirects with auth_code (NOT code). code is accepted as a
    // fallback alias only for manually-constructed test URLs.
    const authCodeValue = authCode || code;

    // Validate required parameters
    if (!authCodeValue || !state) {
      this.logger.warn('Missing auth_code or state in callback');
      return res.redirect(
        '/auth/fyers/error?error=missing_params&detail=' +
          encodeURIComponent('Both auth_code and state are required'),
      );
    }

    // Validate state format (hex string, 32 chars)
    if (!/^[a-f0-9]{32}$/.test(state)) {
      this.logger.warn('Invalid state format');
      return res.redirect(
        '/auth/fyers/error?error=invalid_state&detail=' +
          encodeURIComponent('State must be a 32-character hex string'),
      );
    }

    const stateKey = `fyers_oauth_${state}`;
    const stateData = this.stateStore.get(stateKey);

    // Check state exists
    if (!stateData) {
      this.logger.warn('State not found or expired');
      return res.redirect(
        '/auth/fyers/error?error=state_not_found&detail=' +
          encodeURIComponent('Session expired or invalid state'),
      );
    }

    // Check state not already used (replay protection)
    if (stateData.used) {
      this.logger.warn('State already used (potential replay attack)');
      return res.redirect(
        '/auth/fyers/error?error=state_used&detail=' +
          encodeURIComponent('This session has already been used'),
      );
    }

    // Check state not expired (5 minute TTL)
    const now = Date.now();
    const createdAt = stateData.createdAt;
    const ttl = 5 * 60 * 1000; // 5 minutes
    if (now - createdAt > ttl) {
      this.logger.warn('State expired');
      this.stateStore.delete(stateKey);
      return res.redirect(
        '/auth/fyers/error?error=state_expired&detail=' +
          encodeURIComponent('Session expired'),
      );
    }

    // Atomically consume state
    stateData.used = true;
    this.stateStore.set(stateKey, stateData);

    // Exchange auth_code with FYERS
    try {
      const appIdHash = this.computeAppIdHash(stateData.appId, stateData.appSecret);
      const exchangeResult = await this.exchangeAuthCode(
        authCodeValue,
        appIdHash,
        stateData.appId,
        stateData.appSecret,
        stateData.redirectUri,
      );

      // Store encrypted tokens (single active row — updated in place)
      await this.fyersTokenService.storeTokens(
        exchangeResult.access_token,
        exchangeResult.refresh_token || null,
        exchangeResult.fyId || null,
        authCodeValue,
      );

      this.logger.log('Tokens stored successfully');
      return res.redirect('/auth/fyers/success');
    } catch (error) {
      this.logger.error('Token exchange failed', error as Error);
      return res.redirect(
        '/auth/fyers/error?error=exchange_failed&detail=' +
          encodeURIComponent((error as Error).message),
      );
    }
  }

  /**
   * Token exchange error page.
   */
  @Get('error')
  @BypassAuth()
  async error(
    @Query('error') error: string | undefined,
    @Query('detail') detail: string | undefined,
    @Res() res: Response,
  ) {
    return res.status(400).json({
      success: false,
      error: error || 'unknown_error',
      detail: detail || 'An error occurred during authentication',
    });
  }

  /**
   * Success page (after successful token exchange).
   */
  @Get('success')
  @BypassAuth()
  async success(@Res() res: Response) {
    return res.json({
      success: true,
      message: 'FYERS authentication successful. Tokens stored securely.',
    });
  }

  /**
   * Exchange auth_code for access_token and refresh_token with FYERS API.
   */
  private async exchangeAuthCode(
    code: string,
    appIdHash: string,
    appId: string,
    appSecret: string,
    redirectUri: string,
  ): Promise<{ access_token: string; refresh_token: string | null; fyId: string | null }> {
    const response = await fetch(`${this.FYERS_API_BASE}/validate-authcode`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        appIdHash,
        code,
      }),
    });

    const data = await response.json();

    if (!response.ok || data.s !== 'ok' || !data.access_token) {
      throw new Error(data.message || `Exchange failed with status ${response.status}`);
    }

    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token || null,
      fyId: data.fy_id || null,
    };
  }

  /**
   * Compute SHA-256 hex of appId:appSecret for FYERS API calls.
   */
  private computeAppIdHash(appId: string, appSecret: string): string {
    return crypto.createHash('sha256').update(`${appId}:${appSecret}`).digest('hex');
  }

  // Simple in-memory state store (replace with Redis for production)
  private readonly stateStore = new Map<string, { appId: string; appSecret: string; redirectUri: string; createdAt: number; used: boolean }>();

  private readonly logger = {
    log: (msg: string) => console.log(`[FYERS-OAUTH] ${msg}`),
    warn: (msg: string) => console.warn(`[FYERS-OAUTH] WARN: ${msg}`),
    error: (msg: string, err?: Error) => console.error(`[FYERS-OAUTH] ERROR: ${msg}`, err),
  };
}
