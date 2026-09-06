import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash, timingSafeEqual } from 'crypto';
import type { Request } from 'express';
import 'express-session';
import { PortalUserService, OWNER_EMAIL } from './portal-user.service';

// Typed session payload used across the app (login mints req.session.user).
declare module 'express-session' {
  interface Session {
    user?: { email: string; name: string };
  }
}

export const BYPASS_AUTH_KEY = 'bypassAuth';
export const IpWhitelistKey = 'ipWhitelist';

/** Route metadata key set by @AllowAiTestToken() (opt-in /ai/test probe routes). */
export const AI_TEST_TOKEN_KEY = 'aiTestToken';
/** HTTP header carrying the /ai/test probe token. */
export const AI_TEST_HEADER = 'x-hermes-ai-test-token';

export const OPERATOR_EMAIL = 'operator@berhampore.in';
export const OPERATOR_NAME = 'Operator';

/** HTTP header a server-to-server caller may present instead of a session. */
export const AUTH_HEADER = 'x-operator-password';

/**
 * Single source of truth for the operator password check.
 * Since 2026-09-05 the authoritative store is the encrypted portal_users row
 * (PortalUserService); the env SESSION_PASSWORD is consulted ONLY as a legacy
 * fallback while the DB row is still unseeded. New passwords never go to .env.
 */
export function operatorPasswordOk(input: unknown): boolean {
  if (typeof input !== 'string' || input.length === 0) return false;
  const expected = process.env.SESSION_PASSWORD;
  return !!expected && input === expected;
}

/**
 * Constant-time check of the /ai/test probe token (x-hermes-ai-test-token)
 * against the configured HERMES_AI_TEST_TOKEN. Fail-closed: no configured
 * token, a non-string/empty header, or a mismatch all return false. The token
 * and its configured value are never logged. SHA-256 digests are compared so
 * timingSafeEqual never sees unequal lengths.
 */
export function aiTestTokenOk(input: unknown): boolean {
  if (typeof input !== 'string' || input.length === 0) return false;
  const expected = process.env.HERMES_AI_TEST_TOKEN;
  if (!expected || expected.length === 0) return false;
  const a = createHash('sha256').update(input).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * The operator auth wall, applied globally (APP_GUARD) with these rules:
 *   1. @BypassAuth routes always pass (3rd-party callbacks, webhooks,
 *      server-to-server endpoints, the auth endpoints themselves, and the
 *      SPA shell controller that serves the login page).
 *   2. A browser session minted by POST /auth/login passes.
 *   3. @AllowIps(...) fixed IPs pass (machine peers).
 *   4. A correct operator password in header x-operator-password or JSON body
 *      passes and mints a session (server-to-server convenience).
 * Anything else -> 401.
 *
 * There is deliberately NO localhost / loopback exemption anymore (2026-09-02
 * requirement change: login is required for local access too). The Cloudflare
 * tunnel reaches this server as 127.0.0.1, so any loopback/IP-based bypass
 * would open berhampore.in to everyone — never reintroduce one.
 */
@Injectable()
export class ConditionalAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly users?: PortalUserService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();

    const bypass = this.reflector.getAllAndOverride<boolean>(BYPASS_AUTH_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (bypass) return true;

    if (req.session?.user) return true;

    const allowIps = this.reflector.getAllAndOverride<string[] | undefined>(IpWhitelistKey, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (allowIps && allowIps.length > 0) {
      const ip = (req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
      if (allowIps.includes(ip)) return true;
    }

    // Route-scoped probe token (@AllowAiTestToken, used by POST /ai/test): a
    // machine probe may authenticate with x-hermes-ai-test-token instead of the
    // operator password. Checked ONLY on routes that carry the metadata, so the
    // token can never open any other route; deliberately mints no session (the
    // token is not an identity). Fail-closed via aiTestTokenOk().
    const wantsAiTestToken = this.reflector.getAllAndOverride<boolean>(AI_TEST_TOKEN_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (wantsAiTestToken && aiTestTokenOk(req.headers[AI_TEST_HEADER])) return true;

    const body: Record<string, unknown> = (req as Request & { body?: Record<string, unknown> }).body ?? {};
    const header = req.headers[AUTH_HEADER];
    const candidate =
      (typeof header === 'string' ? header : undefined) ??
      (typeof body.password === 'string' ? body.password : undefined) ??
      (typeof body.operatorPassword === 'string' ? body.operatorPassword : undefined);
    if (await this.passwordOk(candidate)) {
      // Machine callers that authenticate with the password also get a session.
      const identity = this.users ? await this.users.findByEmail(OWNER_EMAIL).catch(() => null) : null;
      req.session!.user = identity
        ? { email: identity.email, name: identity.name }
        : { email: OPERATOR_EMAIL, name: OPERATOR_NAME };
      return true;
    }

    throw new UnauthorizedException('Operator password required.');
  }

  /** DB-first (portal_users encrypted row); legacy .env fallback while unseeded. */
  private async passwordOk(candidate: string | undefined): Promise<boolean> {
    if (typeof candidate !== 'string' || candidate.length === 0) return false;
    if (this.users) {
      const ok = await this.users.verifyOwnerPassword(candidate).catch(() => false);
      if (ok) return true;
    }
    return operatorPasswordOk(candidate);
  }
}
