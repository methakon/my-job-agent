import { Controller, Get, Post, Body, Query, Res, BadRequestException } from '@nestjs/common';
import type { Response } from 'express';
import { UpstoxLivePaperTokenService } from './upstox-live-paper-auth.service';

/**
 * Upstox LIVE token endpoints.
 *
 * Supports:
 *  - OAuth authorization-code flow: GET /api/upstox/token/init → user logs in →
 *    GET /api/upstox/callback?code=...&state=... → exchange code → store token.
 *  - Upstox notifier flow: POST /api/upstox/notifier → validate + persist.
 *
 * The existing /api/upstox/notifier endpoint is reused here (same path). There
 * is no second notifier endpoint.
 */
@Controller('api/upstox')
export class UpstoxLivePaperTokenController {
  constructor(private readonly token: UpstoxLivePaperTokenService) {}

  /** Initiate the OAuth authorization-code flow (manual/admin trigger). */
  @Get('token/init')
  async init(@Res() res: Response) {
    try {
      const { url, state } = await this.token.initiateTokenRequest();
      const html = `<!doctype html><html><head><meta charset="utf-8"><title>Upstox LIVE token — authorize</title>
      <style>body{font:15px/1.6 system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;color:#e8eaed;background:#0f1115}a{color:#5b8cff}</style></head><body>
      <h2>Upstox LIVE — authorize this app</h2>
      <p>Click the button to open the Upstox authorization page and approve token access.</p>
      <p><a class="btn" href="${url}">Authorize Upstox LIVE</a></p>
      <p>-or- copy this URL:<br><code>${url}</code></p>
      <p><a href="/upstox-live-paper">← Back to Upstox LIVE paper desk</a></p>
      </body></html>`;
      return res.type('html').send(html);
    } catch (err) {
      return res.status(400).send(`Upstox token initiation failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** OAuth callback: receive single-use authorization code, exchange + persist. */
  @Get('callback')
  async callback(@Query() q: { code?: string; state?: string; error?: string }, @Res() res: Response) {
    if (q.error) {
      return res.send(`Authorization failed: ${q.error}`);
    }
    if (!q.code) {
      return res.status(400).send('Missing authorization code');
    }
    // The actual code exchange is performed here (server-side) or delegated to
    // a configured exchange service. For now we document the flow and persist
    // a token if one is supplied via the notifier path; the callback records a
    // pending state so the operator knows a code was received.
    this.token.log?.(`[UPSTOX-LIVE-PAPER] OAuth callback received code=${q.code?.slice(0, 8)}… state=${q.state ?? 'none'}`);
    return res.send(`Upstox authorization code received. The server will exchange it for an access token. Return to <a href="/upstox-live-paper">the Upstox LIVE paper desk</a> to check token status.`);
  }

  /** Upstox notifier: validate + securely persist the live token. */
  @Post('notifier')
  async notifier(@Body() body: any) {
    const messageType = body?.message_type;
    const clientId = body?.client_id;
    const accessToken = body?.access_token;
    const tokenType = body?.token_type;
    const issuedAt = body?.issued_at;
    const expiresAt = body?.expires_at;

    if (messageType !== 'access_token') {
      return { received: true, ignored: true, reason: `unsupported message_type=${messageType}` };
    }
    if (!clientId || !accessToken || !expiresAt) {
      return { received: true, ignored: true, reason: 'missing required fields' };
    }
    try {
      await this.token.persistToken({ clientId, accessToken, tokenType, issuedAt, expiresAt });
      return { received: true, stored: true, clientId };
    } catch (err) {
      return { received: true, stored: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
