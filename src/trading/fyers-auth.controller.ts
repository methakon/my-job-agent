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
import * as querystring from 'querystring';

/**
 * FYERS OAuth2 authentication endpoints.
 * 
 * Flow (v3 canonical):
 * 1. GET /trading/fyers/auth-url → returns authorization URL
 * 2. User opens URL, authorizes, gets redirected with auth_code
 * 3. GET /trading/fyers/exchange-token?code=<auth_code> → returns access_token + refresh_token
 * 
 * Token exchange uses validate-authcode with appIdHash (SHA-256 hex of APP_ID:SECRET).
 */
@Controller('trading/fyers')
export class FyersAuthController {
  private readonly FYERS_API_BASE = 'https://api-t1.fyers.in/api/v3';

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
    const params = {
      client_id: appId,
      redirect_uri: redirectUri,
      response_type: 'code',
      state: 'my-job-agent-auth', // Can be any string for CSRF protection
    };

    const authUrl = `${this.FYERS_API_BASE}/generate-authcode?${querystring.stringify(params)}`;

    return res.json({
      authUrl,
      instructions: [
        '1. Open the URL above in your browser',
        '2. Login with your FYERS credentials',
        '3. Authorize the app',
        '4. You will be redirected to your redirect_uri with ?auth_code=...',
        '5. Copy the full redirected URL and call /exchange-token with the code parameter',
      ],
    });
  }

  /**
   * Exchange auth_code for access_token and refresh_token.
   * Call this after user authorizes and gets redirected with auth_code.
   */
  @Get('exchange-token')
  @BypassAuth()
  async exchangeToken(@Query('code') code: string, @Res() res: Response) {
    if (!code) {
      throw new HttpException(
        { error: 'missing_code', detail: 'Query param ?code=<auth_code> required' },
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
          code,
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

      return res.json({
        success: true,
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_in: data.expires_in,
        instructions: [
          'Update .env with:',
          `FYERS_ACCESS_TOKEN=${data.access_token}`,
          `FYERS_REFRESH_TOKEN=${data.refresh_token}`,
          'Then restart trading-agent with `pm2 restart trading-agent --update-env`',
        ],
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
   * Generate access token from refresh token (when access_token expires).
   */
  @Get('refresh-token')
  @BypassAuth()
  async refreshToken(@Res() res: Response) {
    const appId = process.env.FYERS_APP_ID?.trim();
    const appSecret = process.env.FYERS_APP_SECRET?.trim();
    const refreshToken = process.env.FYERS_REFRESH_TOKEN?.trim();

    if (!appId || !appSecret || !refreshToken) {
      throw new HttpException(
        {
          error: 'missing_credentials',
          detail:
            'Set FYERS_APP_ID, FYERS_APP_SECRET, and FYERS_REFRESH_TOKEN in .env',
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    try {
      // FYERS v3 refresh-token uses the same appIdHash format as validate-authcode
      const appIdHash = this.computeAppIdHash(appId, appSecret);
      const response = await fetch(`${this.FYERS_API_BASE}/refresh-token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `${appIdHash}:${refreshToken}`,
        },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          appIdHash,
          refresh_token: refreshToken,
        }),
      });

      const data = await response.json();

      if (data.s !== 'ok' || !data.access_token) {
        throw new HttpException(
          {
            error: 'refresh_failed',
            detail: data.message || JSON.stringify(data),
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      return res.json({
        success: true,
        access_token: data.access_token,
        refresh_token: data.refresh_token || refreshToken, // May be same or new
        instructions: [
          'Update .env with new access_token:',
          `FYERS_ACCESS_TOKEN=${data.access_token}`,
          'Then restart trading-agent with `pm2 restart trading-agent --update-env`',
        ],
      });
    } catch (error) {
      throw new HttpException(
        {
          error: 'refresh_request_failed',
          detail: (error as Error).message,
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }
}
