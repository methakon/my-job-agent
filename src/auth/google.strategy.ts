import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, VerifyCallback } from 'passport-google-oauth20';

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  private readonly allowedEmails: string[];

  constructor(config: ConfigService) {
    super({
      clientID: config.get<string>('GOOGLE_CLIENT_ID') || '',
      clientSecret: config.get<string>('GOOGLE_CLIENT_SECRET') || '',
      callbackURL: config.get<string>('GOOGLE_CALLBACK_URL') || 'https://berhampore.in/auth/google/callback',
      scope: ['email', 'profile'],
    });
    // Only these two Google accounts can log in
    this.allowedEmails = [
      config.get<string>('GOOGLE_ALLOWED_EMAIL_1', '').toLowerCase(),
      config.get<string>('GOOGLE_ALLOWED_EMAIL_2', '').toLowerCase(),
    ].filter(Boolean);
  }

  async validate(
    accessToken: string,
    refreshToken: string,
    profile: any,
    done: VerifyCallback,
  ): Promise<any> {
    const email = (profile?.emails?.[0]?.value || '').toLowerCase();
    if (!email) {
      return done(null, false, { message: 'No email from Google' });
    }
    if (!this.allowedEmails.includes(email)) {
      return done(null, false, { message: 'Account not authorised' });
    }
    return done(null, {
      email,
      name: profile.displayName || email,
      picture: profile.photos?.[0]?.value || null,
      googleId: profile.id,
    });
  }
}
