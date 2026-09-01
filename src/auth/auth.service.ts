import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AuthService {
  constructor(private config: ConfigService) {}

  /** The two Google accounts that may log in (lowercase, trimmed). */
  get allowedEmails(): string[] {
    return [
      this.config.get<string>('GOOGLE_ALLOWED_EMAIL_1', '').toLowerCase().trim(),
      this.config.get<string>('GOOGLE_ALLOWED_EMAIL_2', '').toLowerCase().trim(),
    ].filter(Boolean);
  }
}
