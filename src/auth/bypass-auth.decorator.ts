import { SetMetadata } from '@nestjs/common';
import { BYPASS_AUTH_KEY, IpWhitelistKey, AI_TEST_TOKEN_KEY } from './conditional-auth.guard';

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
export const BypassAuth = (): MethodDecorator & ClassDecorator => SetMetadata(BYPASS_AUTH_KEY, true);

/**
 * Allow specific caller IPs through the wall without a password/session.
 * Decorator for known server-to-server peers that cannot do browser login.
 * Works for public IPs (trust proxy is on); loopback-only callers behind the
 * Cloudflare tunnel are NOT covered by this — use @BypassAuth for those.
 */
export const AllowIps = (...ips: string[]) => SetMetadata(IpWhitelistKey, ips);

/**
 * Opt a handler into the x-hermes-ai-test-token probe header (used by
 * POST /ai/test). Unlike @BypassAuth this does NOT lift the password wall:
 * the global guard still runs and only lets the request through when the
 * token matches the configured HERMES_AI_TEST_TOKEN. Routes without this
 * metadata ignore the header entirely, so the token authenticates nothing
 * else. Read from environment only — never hard-code a token.
 */
export const AllowAiTestToken = () => SetMetadata(AI_TEST_TOKEN_KEY, true);
