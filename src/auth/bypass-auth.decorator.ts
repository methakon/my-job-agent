import { SetMetadata } from '@nestjs/common';
import { BYPASS_AUTH_KEY, IpWhitelistKey } from './conditional-auth.guard';

/**
 * Opt a route (or whole controller) out of the global password wall.
 * Required for every endpoint a 3rd party or another server calls without a
 * browser session and without the operator password:
 *   - 3rd-party OAuth redirects / callbacks (e.g. FYERS /auth/fyers/callback)
 *   - inbound webhooks
 *   - server-to-server endpoints
 * Also used on the auth endpoints themselves (login/me/forgot/change/logout),
 * which must be reachable before any session exists.
 */
export const BypassAuth = () => SetMetadata(BYPASS_AUTH_KEY, true);

/**
 * Allow specific caller IPs through the wall without a password/session.
 * Decorator for known server-to-server peers that cannot do browser login.
 * Works for public IPs (trust proxy is on); loopback-only callers behind the
 * Cloudflare tunnel are NOT covered by this — use @BypassAuth for those.
 */
export const AllowIps = (...ips: string[]) => SetMetadata(IpWhitelistKey, ips);
