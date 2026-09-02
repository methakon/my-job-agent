import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import * as express from 'express';
import session from 'express-session';
import * as path from 'path';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { cors: true });

  // Cloudflare tunnel / reverse proxy: honour X-Forwarded-* so req.ip and
  // rate-limit keys reflect the real caller, not 127.0.0.1.
  app.set('trust proxy', 1);

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'https:'],
          connectSrc: ["'self'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: null, // disable: would force http://localhost subresources to https and break local dev
        },
      },
    }),
  );
  app.use(
    rateLimit({
      windowMs: 60_000,
      max: 100,
      standardHeaders: true,
      legacyHeaders: false,
      message: 'Too many requests, please try again later.',
    }),
  );

  // Strict limiters on the password endpoints only (brute-force / mail-bomb guard).
  const strictLimiter = (max: number, minutes: number) =>
    rateLimit({
      windowMs: minutes * 60_000,
      max,
      standardHeaders: true,
      legacyHeaders: false,
      message: 'Too many attempts — try again later.',
    });
  app.use('/auth/login', strictLimiter(10, 15));
  app.use('/auth/forgot-password', strictLimiter(5, 15));
  app.use('/auth/change-password', strictLimiter(10, 15));

  app.use(
    session({
      name: process.env.SESSION_NAME || 'MYJOB_SESSION',
      secret: process.env.SESSION_SECRET || 'CHANGE_ME_IN_PRODUCTION_USE_A_REAL_RANDOM_SECRET',
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        maxAge: 24 * 60 * 60 * 1000,
      },
    }),
  );

  const publicDir = path.join(__dirname, '..', 'public');
  app.use('/assets', express.static(path.join(publicDir, 'assets')));
  app.use(express.static(publicDir));

  // NOTE: no app.use('/', ...) catch-all here — Nest mounts controller routes
  // after bootstrap middleware, so a middleware catch-all would swallow every
  // real route (the bug that made all paths return the login page).
  // Unmatched GETs are served dashboard.html by AppFallbackController, which
  // is registered LAST inside the router (see app.module.ts).

  await app.listen(3010);
  console.log(`my-job-agent listening on port 3010`);
}

bootstrap();
