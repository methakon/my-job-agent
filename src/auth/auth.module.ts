import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConditionalAuthGuard } from './conditional-auth.guard';

/**
 * Auth wiring:
 *  - ConditionalAuthGuard registered as the GLOBAL guard (APP_GUARD) — every
 *    route is behind the operator wall (local AND public access, per the
 *    2026-09-02 requirement change) unless the request carries a session or
 *    password, or the route is marked @BypassAuth / @AllowIps (3rd-party
 *    callbacks, webhooks, server-to-server endpoints, the login shell).
 *
 * NOTE: AuthController intentionally lives in AppModule.controllers, directly
 * before AppFallbackController — Nest registers a module's own controllers
 * before imported modules' controllers, so an '*' fallback declared in an
 * imported module would otherwise swallow the /auth/* routes.
 */
@Module({
  providers: [{ provide: APP_GUARD, useClass: ConditionalAuthGuard }],
})
export class AuthModule {}
