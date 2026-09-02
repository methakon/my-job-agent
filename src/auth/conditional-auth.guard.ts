import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import 'express-session';

// Typed session payload used across the app (login mints req.session.user).
declare module 'express-session' {
  interface Session {
    user?: { email: string; name: string };
  }
}

export const BYPASS_AUTH_KEY = 'bypassAuth';
export const IpWhitelistKey = 'ipWhitelist';

export const OPERATOR_EMAIL = 'operator@berhampore.in';
export const OPERATOR_NAME = 'Operator';

/** HTTP header a server-to-server caller may present instead of a session. */
export const AUTH_HEADER = 'x-operator-password';

/**
 * Single source of truth for the operator password check (env SESSION_PASSWORD).
 * Shared by the guard (header/body password) and AuthController
 * (login / change-password / forgot-password).
 */
export function operatorPasswordOk(input: unknown): boolean {
  if (typeof input !== 'string' || input.length === 0) return false;
  const expected = process.env.SESSION_PASSWORD;
  return !!expected && input === expected;
}

/**
 * Localhost detection MUST be HOST-based, never IP-based:
 * the Cloudflare tunnel (berhampore.in) reaches this server as 127.0.0.1,
 * so any ipLocal bypass would open the public domain to everyone.
 * A request is "local" only when its Host header names a loopback host.
 */
export function isLocalRequest(req: Request): boolean {
  const rawHost = (req.headers.host || '').toLowerCase().trim();
  const hostname = rawHost.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  if (rawHost === '') {
    // No Host header (HTTP/1.0 / raw socket): trust only a loopback socket peer.
    const ip = (req.socket?.remoteAddress || req.ip || '').replace(/^::ffff:/, '');
    return ip === '127.0.0.1' || ip === '::1' || ip.startsWith('127.');
  }
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

/**
 * The operator auth wall, applied globally (APP_GUARD) with these rules:
 *   1. @BypassAuth routes always pass (3rd-party callbacks, webhooks,
 *      server-to-server endpoints, the auth endpoints themselves).
 *   2. Localhost (Host header is localhost/127.0.0.1/::1) passes — the spec:
 *      no authentication for local access.
 *   3. A browser session minted by POST /auth/login passes.
 *   4. @AllowIps(...) fixed IPs pass (machine peers).
 *   5. A correct operator password in header x-operator-password or JSON body
 *      passes and mints a session (server-to-server convenience).
 * Anything else -> 401.
 */
@Injectable()
export class ConditionalAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();

    const bypass = this.reflector.getAllAndOverride<boolean>(BYPASS_AUTH_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (bypass) return true;

    if (isLocalRequest(req)) return true;

    if (req.session?.user) return true;

    const allowIps = this.reflector.getAllAndOverride<string[] | undefined>(IpWhitelistKey, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (allowIps && allowIps.length > 0) {
      const ip = (req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
      if (allowIps.includes(ip)) return true;
    }

    const body: Record<string, unknown> = (req as Request & { body?: Record<string, unknown> }).body ?? {};
    const header = req.headers[AUTH_HEADER];
    const candidate =
      (typeof header === 'string' ? header : undefined) ??
      (typeof body.password === 'string' ? body.password : undefined) ??
      (typeof body.operatorPassword === 'string' ? body.operatorPassword : undefined);
    if (operatorPasswordOk(candidate)) {
      // Machine callers that authenticate with the password also get a session.
      req.session!.user = { email: OPERATOR_EMAIL, name: OPERATOR_NAME };
      return true;
    }

    throw new UnauthorizedException('Operator password required for remote access.');
  }
}
