import { Injectable } from '@nestjs/common';

/** Store the full user profile in the session (no DB lookup needed). */
@Injectable()
export class SessionSerializer {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  serializeUser(user: any, done: (err: unknown, obj?: any) => void): void {
    done(null, user);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  deserializeUser(user: any, done: (err: unknown, obj?: any) => void): void {
    done(null, user);
  }
}
