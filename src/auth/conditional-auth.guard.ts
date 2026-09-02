import { Injectable, CanActivate, ExecutionContext, UnauthorizedException, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';

export const BYPASS_AUTH_KEY = 'bypassAuth';
export const IpWhitelistKey = 'ipWhitelist';

export interface AuthenticatedRequest extends Request {
  user?: any;
}

@Injectable()
export class ConditionalAuthGuard implements CanActivate {
  private readonly logger = new Logger(ConditionalAuthGuard.name);
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // respect explicit bypass decorators
    const bypass = this.reflector.getAllAndOverride<boolean>(BYPASS_AUTH_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (bypass) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const host = (request.headers.host || '').toLowerCase();
    const ip = (request.ip || request.socket?.remoteAddress || '127.0.0.1');

    // localhost / loopback: no auth wall — operator is on the machine
    if (this.isLocalhost(host, ip)) {
      return true;
    }

    // session-based auth (Google OAuth session)
    if (request.session?.user) {
      return true;
    }

    // operator password fallback for public domain access
    const password = this.extractPassword(request);
    if (password && this.checkPassword(password)) {
      request.session!.user = { email: 'operator@berhampore.in', name: 'Operator' };
      return true;
    }

    throw new UnauthorizedException('Authentication required');
  }

  private isLocalhost(host: string, ip: string): boolean {
    const hostLocal = !host || host.includes('localhost') || host.includes('127.0.0.1');
    const ipLocal =
      ip === '127.0.0.1' ||
      ip === '::1' ||
      ip.startsWith('127.0.0.1') ||
      ip.startsWith('::1') ||
      ip === '::ffff:127.0.0.1';
    return hostLocal || ipLocal;
  }

  private extractPassword(request: AuthenticatedRequest): string | undefined {
    // header-based operator password (for curl/programmatic access)
    const header = request.headers['x-operator-password'];
    if (typeof header === 'string' && header) return header;
    if (Array.isArray(header) && header.length) return header[0];

    // form/body field for browser POSTs
    if (request.body && typeof request.body === 'object') {
      const body = request.body as any;
      if (typeof body.operatorPassword === 'string' && body.operatorPassword) return body.operatorPassword;
    }
    return undefined;
  }

  private checkPassword(input: string): boolean {
    const expectedRaw = process.env.SESSION_PASSWORD;
    const expectedHash = process.env.SESSION_PASSWORD_HASH;
    if (!expectedRaw && !expectedHash) {
      // no password configured — let session-only path handle it
      return false;
    }
    if (expectedRaw && input === expectedRaw) return true;
    if (expectedHash && expectedRaw) {
      try {
        const bcrypt = require('bcrypt');
        // eslint-disable-next-line
      } catch {}
    }
    return false;
  }
}
