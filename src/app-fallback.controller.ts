import { Controller, Get, Head, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import * as path from 'path';
import { BypassAuth } from './auth/bypass-auth.decorator';

/**
 * SPA fallback — MUST stay the LAST entry in AppModule.controllers.
 *
 * Why this exists: the previous design used an app.use('/', ...) middleware
 * catch-all in main.ts. Nest mounts controller routes AFTER bootstrap
 * middleware, so that catch-all answered EVERY request (including real API
 * routes) with dashboard.html — the entire HTTP API was unreachable and every
 * path showed the login page. Moving the fallback INTO the router (this
 * controller) lets all real routes win first, and only unmatched requests
 * get the dashboard shell.
 *
 * @BypassAuth: the shell HTML contains no data (the login form lives in it,
 * and every data call goes through guarded APIs), so it must be reachable
 * before any session exists — otherwise remote visitors would get a raw 401
 * instead of the login page.
 */
@Controller()
@BypassAuth()
export class AppFallbackController {
  @Get('*')
  fallback(@Req() req: Request, @Res() res: Response) {
    return res.sendFile(
      path.join(__dirname, '..', 'public', 'dashboard.html'),
    );
  }

  @Head('*')
  headFallback(@Req() req: Request, @Res() res: Response) {
    return res.sendFile(
      path.join(__dirname, '..', 'public', 'dashboard.html'),
    );
  }
}