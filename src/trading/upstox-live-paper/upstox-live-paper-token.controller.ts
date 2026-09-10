import { Controller, Get, Post, Body, Query, Res, BadRequestException } from '@nestjs/common';
import type { Response } from 'express';
import { BypassAuth } from '../../auth/bypass-auth.decorator';
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
      <p style="color:#9aa0aa;font-size:13px">After you approve, Upstox redirects straight back to this app and the token is stored automatically — there is nothing to copy or paste. This link is single-use and expires in 5 minutes.</p>
      <p>-or- copy this URL:<br><code>${url}</code></p>
      <p><a href="/upstox-live-paper.html">← Back to Upstox LIVE paper desk</a></p>
      </body></html>`;
      return res.type('html').send(html);
    } catch (err) {
      return res.status(400).send(`Upstox token initiation failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * OAuth callback (Step 2 + 3 of Upstox's documented flow): receive the
   * single-use authorization code, validate the state this desk minted, exchange
   * the code server-side and persist the token.
   *
   * Public by design — the redirect arrives from Upstox's domain — so the
   * single-use, TTL-bounded state is what authorizes the exchange, never the
   * caller's identity. The code and the token are never logged.
   */
  @Get('callback')
  @BypassAuth()
  async callback(
    @Query() q: { code?: string; state?: string; error?: string; error_description?: string; format?: string },
    @Res() res: Response,
  ) {
    const desk = '/upstox-live-paper.html';
    const finish = (outcome: Record<string, string>) => {
      if (q.format === 'json') {
        return res.status(outcome.upstox === 'ok' ? 200 : 400).json(outcome);
      }
      return res.redirect(`${desk}?${new URLSearchParams(outcome).toString()}`);
    };

    if (q.error) {
      return finish({ upstox: 'error', reason: q.error_description || q.error });
    }
    if (!q.code) {
      return finish({ upstox: 'error', reason: 'missing authorization code' });
    }

    const stateCheck = this.token.consumeState(q.state);
    if (!stateCheck.ok) {
      this.token.log(`[UPSTOX-LIVE-PAPER] OAuth callback refused: ${stateCheck.reason}`);
      return finish({ upstox: 'error', reason: stateCheck.reason });
    }

    try {
      this.token.log(`[UPSTOX-LIVE-PAPER] OAuth callback: exchanging authorization code (length ${q.code.length})`);
      const stored = await this.token.completeAuthorization(q.code);
      return finish({
        upstox: 'ok',
        client_id: stored.clientId,
        expires: stored.expiresAt ? stored.expiresAt.toISOString() : '',
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.token.log(`[UPSTOX-LIVE-PAPER] OAuth callback failed: ${reason}`);
      return finish({ upstox: 'error', reason });
    }
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
