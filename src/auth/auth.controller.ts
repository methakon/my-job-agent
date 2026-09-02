import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Logger,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import * as nodemailer from 'nodemailer';
import 'express-session';
import { BypassAuth } from './bypass-auth.decorator';
import { OPERATOR_EMAIL, OPERATOR_NAME, operatorPasswordOk } from './conditional-auth.guard';

const SESSION_COOKIE_NAME = (): string => process.env.SESSION_NAME || 'MYJOB_SESSION';
const RECOVERY_EMAIL = (): string => process.env.RECOVERY_EMAIL || 'bapay.9@gmail.com';

/**
 * Operator password auth — the ONLY authentication for public IP / domain
 * access. Local (localhost) access never needs these endpoints; the page
 * still calls /auth/me to decide which UI to show.
 *
 * All routes are @BypassAuth: they are the wall itself, so they must be
 * reachable before any session or password exists. 3rd-party callbacks and
 * server-to-server endpoints that need to skip the wall use @BypassAuth /
 * @AllowIps elsewhere — see bypass-auth.decorator.ts.
 */
@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  /** Password login. Success mints req.session.user (sent back as a cookie). */
  @Post('login')
  @BypassAuth()
  login(@Body() body: { password?: string }, @Req() req: Request, @Res() res: Response) {
    const password = body && typeof body.password === 'string' ? body.password : '';
    if (!operatorPasswordOk(password)) {
      return res.status(401).json({ error: 'invalid_password' });
    }
    req.session!.user = { email: OPERATOR_EMAIL, name: OPERATOR_NAME };
    return res.json({ ok: true, user: req.session!.user });
  }

  /** Session probe for the SPA — decides wall vs dashboard, no auth required. */
  @Get('me')
  @BypassAuth()
  me(@Req() req: Request) {
    return { user: req.session?.user ?? null };
  }

  @Post('logout')
  @BypassAuth()
  logout(@Req() req: Request, @Res() res: Response) {
    const session = req.session as (Request['session'] & { destroy?: (cb: () => void) => void }) | undefined;
    const respond = () => {
      res.clearCookie(SESSION_COOKIE_NAME(), { path: '/' });
      res.json({ ok: true });
    };
    if (session && typeof session.destroy === 'function') {
      session.destroy(() => respond());
    } else {
      respond();
    }
  }

  /**
   * Forgot password: emails the current operator password to the recovery
   * inbox (default bapay.9@gmail.com, override with RECOVERY_EMAIL).
   * Only enabled when SMTP creds exist in .env.
   */
  @Post('forgot-password')
  @BypassAuth()
  async forgotPassword(@Res() res: Response) {
    const password = process.env.SESSION_PASSWORD;
    if (!password) {
      return res.status(500).json({ error: 'no_password_configured' });
    }
    const host = process.env.SMTP_HOST;
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASSWORD;
    if (!host || !user || !pass) {
      return res.status(503).json({
        error: 'smtp_not_configured',
        detail: 'Set SMTP_HOST, SMTP_USER and SMTP_PASSWORD in .env to enable password recovery email.',
      });
    }
    const to = RECOVERY_EMAIL();
    try {
      const port = Number(process.env.SMTP_PORT || 587);
      const transport = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: { user, pass },
      });
      await transport.sendMail({
        from: `"my-job-agent" <${user}>`,
        to,
        subject: 'my-job-agent password recovery',
        text: `The dashboard password for my-job-agent is:\n\n${password}\n\nYou can change it from the sign-in screen by providing the old and a new password.`,
      });
      this.logger.log(`password recovery email sent to ${to}`);
      return res.json({ ok: true, sentTo: to });
    } catch (err) {
      this.logger.error(`forgot-password email failed: ${String(err).slice(0, 300)}`);
      return res.status(502).json({ error: 'email_send_failed', detail: String(err).slice(0, 200) });
    }
  }

  /**
   * Change password. Requires the OLD password (that IS the proof of
   * identity), persists the new one into .env (SESSION_PASSWORD) and applies
   * it to the running process immediately.
   */
  @Post('change-password')
  @BypassAuth()
  changePassword(
    @Body() body: { oldPassword?: string; newPassword?: string },
    @Res() res: Response,
  ) {
    const oldPassword = body && typeof body.oldPassword === 'string' ? body.oldPassword : '';
    const newPassword = body && typeof body.newPassword === 'string' ? body.newPassword : '';
    if (!operatorPasswordOk(oldPassword)) {
      return res.status(401).json({ error: 'invalid_old_password' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'new_password_too_short', detail: 'Use at least 8 characters.' });
    }
    if (newPassword === oldPassword) {
      return res.status(400).json({ error: 'new_password_same', detail: 'The new password must differ from the old one.' });
    }

    const envPath = this.resolveEnvFile();
    try {
      const raw = fs.readFileSync(envPath, 'utf8');
      const next = raw
        .split('\n')
        .map((line) => (/^SESSION_PASSWORD=/.test(line) ? `SESSION_PASSWORD=${newPassword}` : line))
        .join('\n');
      if (next === raw) {
        fs.appendFileSync(envPath, `\nSESSION_PASSWORD=${newPassword}\n`);
      } else {
        fs.writeFileSync(envPath, next);
      }
      process.env.SESSION_PASSWORD = newPassword; // take effect without a restart
      this.logger.log('operator password changed');
      return res.json({ ok: true });
    } catch (err) {
      this.logger.error(`change-password persist failed: ${String(err).slice(0, 200)}`);
      return res.status(500).json({ error: 'persist_failed', detail: String(err).slice(0, 200) });
    }
  }

  /** Locate the tracked .env that ConfigModule loaded (repo root or parent). */
  private resolveEnvFile(): string {
    for (const candidate of ['.env', path.join('..', '..', '.env')]) {
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        /* keep looking */
      }
    }
    return '.env';
  }
}
