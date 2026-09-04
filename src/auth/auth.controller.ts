import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Logger,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import * as nodemailer from 'nodemailer';
import 'express-session';
import { BypassAuth } from './bypass-auth.decorator';
import { OPERATOR_EMAIL, OPERATOR_NAME, operatorPasswordOk } from './conditional-auth.guard';
import { PortalUserService } from './portal-user.service';

const SESSION_COOKIE_NAME = (): string => process.env.SESSION_NAME || 'MYJOB_SESSION';
const RECOVERY_EMAIL = (): string => process.env.RECOVERY_EMAIL || 'bapay.9@gmail.com';

/**
 * Operator password auth — the ONLY authentication, for local AND public
 * (IP / domain) access. Login is required everywhere since 2026-09-02; the
 * page calls /auth/me to decide login vs dashboard.
 *
 * All routes are @BypassAuth: they are the wall itself, so they must be
 * reachable before any session or password exists. 3rd-party callbacks and
 * server-to-server endpoints that need to skip the wall use @BypassAuth /
 * @AllowIps elsewhere — see bypass-auth.decorator.ts.
 */
@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(private readonly users: PortalUserService) {}

  /** Password login. Success mints req.session.user (sent back as a cookie).
   *  Password verified against the encrypted portal_users row (DB-authoritative
   *  since 2026-09-05); .env consulted only as legacy fallback while unseeded. */
  @Post('login')
  @HttpCode(200)
  @BypassAuth()
  async login(@Body() body: { password?: string }, @Req() req: Request, @Res() res: Response) {
    const password = body && typeof body.password === 'string' ? body.password : '';
    const dbOk = await this.users.verifyOwnerPassword(password).catch(() => false);
    if (!dbOk && !operatorPasswordOk(password)) {
      return res.status(401).json({ error: 'invalid_password' });
    }
    // Identity: prefer the DB owner row when seeded, else legacy constants.
    const owner = await this.users.findByEmail(RECOVERY_EMAIL()).catch(() => null);
    req.session!.user = owner
      ? { email: owner.email, name: owner.name }
      : { email: OPERATOR_EMAIL, name: OPERATOR_NAME };
    return res.json({ ok: true, user: req.session!.user });
  }

  /** Decrypted profile for the authenticated owner (encrypted at rest in the
   *  portal_users row under ENCRYPTION_KEY). Requires a session. */
  @Get('profile')
  @BypassAuth()
  async profile(@Req() req: Request) {
    if (!req.session?.user) return { user: null, profile: null };
    const owner = await this.users.findByEmail(req.session.user.email).catch(() => null);
    return {
      user: req.session.user,
      profile: owner ? this.users.profileOf(owner) : null,
    };
  }

  /** Session probe for the SPA — decides wall vs dashboard, no auth required. */
  @Get('me')
  @BypassAuth()
  me(@Req() req: Request) {
    return { user: req.session?.user ?? null };
  }

  @Post('logout')
  @HttpCode(200)
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
   * inbox (bapay.9@gmail.com). Reads the decrypted value from the portal_users
   * row (DB is authoritative since 2026-09-05; .env is no longer consulted).
   * Only enabled when SMTP creds exist in .env.
   */
  @Post('forgot-password')
  @HttpCode(200)
  @BypassAuth()
  async forgotPassword(@Res() res: Response) {
    const password = await this.users.ownerPassword().catch(() => '');
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
        from: `"Dhar-egent" <${user}>`,
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
   * identity). Persists the new one AES-encrypted into the portal_users row
   * and strips SESSION_PASSWORD from .env entirely (2026-09-05 directive:
   * the login password must not live in .env).
   */
  @Post('change-password')
  @HttpCode(200)
  @BypassAuth()
  async changePassword(
    @Body() body: { oldPassword?: string; newPassword?: string },
    @Res() res: Response,
  ) {
    const oldPassword = body && typeof body.oldPassword === 'string' ? body.oldPassword : '';
    const newPassword = body && typeof body.newPassword === 'string' ? body.newPassword : '';
    const oldOk = await this.users.verifyOwnerPassword(oldPassword).catch(() => false);
    if (!oldOk && !operatorPasswordOk(oldPassword)) {
      return res.status(401).json({ error: 'invalid_old_password' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'new_password_too_short', detail: 'Use at least 8 characters.' });
    }
    if (newPassword === oldPassword) {
      return res.status(400).json({ error: 'new_password_same', detail: 'The new password must differ from the old one.' });
    }
    try {
      await this.users.changeOwnerPassword(newPassword);
      this.logger.log('operator password changed (DB-encrypted, .env stripped)');
      return res.json({ ok: true });
    } catch (err) {
      this.logger.error(`change-password persist failed: ${String(err).slice(0, 200)}`);
      return res.status(500).json({ error: 'persist_failed', detail: String(err).slice(0, 200) });
    }
  }
}
