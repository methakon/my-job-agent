import {
  Controller,
  Get,
  Query,
  Res,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';
import { BypassAuth } from '../auth/bypass-auth.decorator';
import { FyersTokenService } from './fyers-token.service';
import * as querystring from 'querystring';

/**
 * FYERS OAuth2 authentication endpoints.
 * 
 * Flow (v3 canonical):
 * 1. GET /trading/fyers/auth-url → returns authorization URL
 * 2. User opens URL, authorizes, gets redirected with auth_code
 * 3. The callback (or this exchange-token endpoint) exchanges the auth_code
 *    and STORES the resulting tokens encrypted in fyers_tokens (single active
 *    row, updated in place — never a new row).
 * 4. Runtime consumers (market data, history scripts) read the token from the
 *    DATABASE; nothing is written to .env.
 * 
 * Token exchange uses validate-authcode with appIdHash (SHA-256 hex of APP_ID:SECRET).
 */
@Controller('trading/fyers')
export class FyersAuthController {
  private readonly FYERS_API_BASE = 'https://api-t1.fyers.in/api/v3';

  constructor(private readonly fyersTokenService: FyersTokenService) {}

  // Compute SHA-256 hex of APP_ID:SECRET for validate-authcode
  private computeAppIdHash(appId: string, appSecret: string): string {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(`${appId}:${appSecret}`).digest('hex');
  }

  /**
   * Generate FYERS authorization URL.
   * User opens this URL in browser, authorizes, and gets redirected with auth_code.
   */
  @Get('auth-url')
  @BypassAuth()
  async getAuthUrl(@Res() res: Response) {
    const appId = process.env.FYERS_APP_ID?.trim();
    const appSecret = process.env.FYERS_APP_SECRET?.trim();
    const redirectUri = process.env.FYERS_REDIRECT_URI?.trim();

    if (!appId || !appSecret || !redirectUri) {
      throw new HttpException(
        {
          error: 'missing_credentials',
          detail:
            'Set FYERS_APP_ID, FYERS_APP_SECRET, and FYERS_REDIRECT_URI in .env',
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    // FYERS OAuth2 auth code endpoint
    // State optional - omitting to avoid state mismatch issues
    const params = {
      client_id: appId,
      redirect_uri: redirectUri,
      response_type: 'code',
    };

    const authUrl = `${this.FYERS_API_BASE}/generate-authcode?${querystring.stringify(params)}`;

    return res.json({
      authUrl,
      instructions: [
        '1. Open the URL above in your browser',
        '2. Login with your FYERS credentials',
        '3. Authorize the app',
        '4. You will be redirected to your redirect_uri with ?auth_code=...',
        '5. Copy the full redirected URL and call /exchange-token with the auth_code parameter',
      ],
    });
  }

  /**
   * Exchange auth_code for access_token and refresh_token.
   * Call this after user authorizes and gets redirected with auth_code.
   * The exchanged tokens are stored encrypted in the DATABASE (single active
   * row — updated in place, never a new row). Raw tokens are never returned
   * in the response and never written to .env.
   */
  @Get('exchange-token')
  @BypassAuth()
  async exchangeToken(
    @Query('auth_code') authCode: string | undefined,
    @Query('code') code: string | undefined,
    @Res() res: Response,
  ) {
    // FYERS v3 redirects with auth_code (NOT code); code is kept as a fallback
    // alias for manually-constructed test URLs.
    const authCodeValue = authCode || code;
    if (!authCodeValue) {
      throw new HttpException(
        {
          error: 'missing_code',
          detail: 'Query param ?auth_code=<code from FYERS redirect> required',
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    const appId = process.env.FYERS_APP_ID?.trim();
    const appSecret = process.env.FYERS_APP_SECRET?.trim();
    const redirectUri = process.env.FYERS_REDIRECT_URI?.trim();

    if (!appId || !appSecret || !redirectUri) {
      throw new HttpException(
        {
          error: 'missing_credentials',
          detail:
            'Set FYERS_APP_ID, FYERS_APP_SECRET, and FYERS_REDIRECT_URI in .env',
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    try {
      // FYERS v3 validate-authcode requires appIdHash (SHA-256 hex of APP_ID:SECRET)
      const appIdHash = this.computeAppIdHash(appId, appSecret);
      const response = await fetch(`${this.FYERS_API_BASE}/validate-authcode`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          appIdHash,
          code: authCodeValue,
        }),
      });

      const data = await response.json();

      if (data.s !== 'ok' || !data.access_token) {
        throw new HttpException(
          {
            error: 'token_exchange_failed',
            detail: data.message || JSON.stringify(data),
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      // Persist in DB (single active row, updated in place — no new rows).
      await this.fyersTokenService.storeTokens(
        data.access_token,
        data.refresh_token || null,
        data.fy_id || null,
        authCodeValue,
      );

      return res.json({
        success: true,
        message:
          'FYERS token exchanged and stored securely in the database (fyers_tokens, encrypted, single active row). Runtime reads the token from the DB — no .env update needed.',
      });
    } catch (error) {
      throw new HttpException(
        {
          error: 'exchange_request_failed',
          detail: (error as Error).message,
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  /**
   * Refresh the access token using the refresh token stored in the DATABASE.
   * The refreshed token updates the same single active DB row (no new row).
   * Requires FYERS_PIN to be configured in .env (PIN is never stored in DB).
   */
  @Get('refresh-token')
  @BypassAuth()
  async refreshToken(@Res() res: Response) {
    const ok = await this.fyersTokenService.refreshAccessToken();
    if (!ok) {
      throw new HttpException(
        {
          error: 'refresh_failed',
          detail:
            'Refresh failed — is FYERS_PIN configured in .env and is a refresh token stored in the DB? Alternatively re-login via GET /auth/fyers/login.',
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    return res.json({
      success: true,
      message: 'Access token refreshed and rotated in place in the database (single active row).',
    });
  }
}
