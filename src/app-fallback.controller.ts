import { Controller, Get, Head, Next, Req, Res } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import * as path from 'path';
import { BypassAuth } from './auth/bypass-auth.decorator';

/**
 * Sub-paths that belong to a real route owned by an IMPORTED module. They must
 * never be answered with the SPA shell: Nest registers the root module's
 * controllers BEFORE the imported modules' controllers, so this `*` route is
 * evaluated first for every GET/HEAD and would otherwise swallow
 * sibling-module routes — exactly what made /api/upstox/token/init (the OAuth
 * login URL) and the whole /upstox-live-paper API unreachable: they returned
 * the login shell with HTTP 200. POST/PUT/PATCH/DELETE are unaffected; this
 * controller only registers GET and HEAD.
 *
 * Deliberately narrow: only API-shaped sub-paths are handed back. Bare page
 * paths (e.g. /upstox-live-paper) keep the shell, so nothing a user types
 * starts 404-ing.
 *
 * `/market-data/` is delegated for the same reason: /market-data/health,
 * /market-data/arbitration and /market-data/canonical are JSON APIs owned by
 * UnifiedMarketDataModule (imported), and they were being answered with the
 * login shell — HTTP 200, no data — which silently hid the market-data health
 * and canonical-pipeline read-outs from every scripted check.
 */
const DELEGATED_PREFIXES = ['/api/', '/upstox-live-paper/', '/fnf-trading/', '/market-data/'];

/**
 * SPA fallback — MUST stay the LAST entry in AppModule.controllers.
 *
 * Why this exists: the previous design used an app.use('/', ...) middleware
 * catch-all in main.ts. Nest mounts controller routes AFTER bootstrap
 * middleware, so that catch-all answered EVERY request (including real API
 * routes) with dashboard.html — the entire HTTP API was unreachable and every
 * path showed the login page. Moving the fallback INTO the router (this
 * controller) lets routes from the same module win, and only unmatched
 * requests get the dashboard shell.
 *
 * For routes owned by imported modules, order cannot help, so the prefixes
 * above are handed back to the router with next(): the real handler runs if
 * one exists, otherwise Express answers its honest 404 (an unknown API path
 * must not masquerade as the login page with a 200).
 *
 * @BypassAuth: the shell HTML contains no data (the login form lives in it,
 * and every data call goes through guarded APIs), so it must be reachable
 * before any session exists — otherwise remote visitors would get a raw 401
 * instead of the login page.
 */
@Controller()
@BypassAuth()
export class AppFallbackController {
  private delegated(pathname: string): boolean {
    return DELEGATED_PREFIXES.some((p) => pathname.startsWith(p));
  }

  @Get('*')
  fallback(@Req() req: Request, @Res() res: Response, @Next() next: NextFunction) {
    if (this.delegated(req.path)) return next();
    return res.sendFile(
      path.join(__dirname, '..', 'public', 'dashboard.html'),
    );
  }

  @Head('*')
  headFallback(@Req() req: Request, @Res() res: Response, @Next() next: NextFunction) {
    if (this.delegated(req.path)) return next();
    return res.sendFile(
      path.join(__dirname, '..', 'public', 'dashboard.html'),
    );
  }
}
