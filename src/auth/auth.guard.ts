import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';

const LOCALHOST_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '::ffff:127.0.0.1',
]);

export function isLocalhost(req: any): boolean {
  const host = req.headers.host;
  const ip = req.ip;
  if (!host && !ip) return false;
  if (LOCALHOST_HOSTS.has(host)) return true;
  if (LOCALHOST_HOSTS.has(ip)) return true;
  if (host && host.startsWith('127.0.0.1:')) return true;
  if (host && host.startsWith('localhost:')) return true;
  return false;
}

@Injectable()
export class SessionAuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    if (isLocalhost(req)) return true;
    if (req.session && req.session.user) return true;
    throw new UnauthorizedException(
      'Access denied. Please log in with a Google account.',
    );
  }
}
