import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import * as express from 'express';
import session from 'express-session';
import * as path from 'path';
import passport from 'passport';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { cors: true });

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

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

  app.use(passport.initialize());
  app.use(passport.session());

  const env = process.env;

  app.use((req, res, next) => {
    const raw = env.GOOGLE_ALLOWED_EMAILS || '';
    const allowed = raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    (res as any).locals.allowedEmails = allowed;
    next();
  });

  const publicDir = path.join(__dirname, '..', 'public');
  app.use('/assets', express.static(path.join(publicDir, 'assets')));
  app.use(express.static(publicDir));

  await app.listen(3010);
  console.log(`my-job-agent listening on port 3010`);
}

bootstrap();
