import { Catch, ArgumentsHost, ExceptionFilter, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';

/**
 * UnauthorizedHtmlRedirectFilter — browser UX for the auth wall.
 *
 * The auth wall (ConditionalAuthGuard) throws UnauthorizedException (401) for
 * requests without a session. JSON/API clients (curl, fetch, the security-test
 * harness) must keep getting the plain 401 JSON — that behaviour is asserted by
 * the public security matrix. But a HUMAN navigating to a walled page in a
 * browser (Accept: text/html) would otherwise see raw JSON instead of the
 * login shell. This filter redirects exactly those requests to `/`, where
 * AppFallbackController serves dashboard.html (the login shell, @BypassAuth —
 * it contains no data).
 *
 * Rule: redirect ONLY plain GET navigations that accept text/html. Everything
 * else (POST, fetch, curl, XHR) falls through to the standard 401 JSON.
 */
@Catch(UnauthorizedException)
export class UnauthorizedHtmlRedirectFilter implements ExceptionFilter {
  catch(exception: UnauthorizedException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();

    const acceptsHtml = (req.headers.accept ?? '').includes('text/html');
    const isPageNavigation = req.method === 'GET' && acceptsHtml;
    const path = req.path ?? req.url ?? '';

    if (isPageNavigation && !path.startsWith('/api')) {
      return res.redirect(302, '/');
    }

    res.status(exception.getStatus()).json(exception.getResponse());
  }
}
