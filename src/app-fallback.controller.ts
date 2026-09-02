import { All, Controller, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import * as path from 'path';

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
 */
@Controller()
export class AppFallbackController {
  @All('*')
  fallback(@Req() req: Request, @Res() res: Response) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // Unknown non-GET paths: real 404 JSON instead of silently swallowing.
      return res.status(404).json({ error: 'not_found', path: req.path });
    }
    return res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html'));
  }
}
