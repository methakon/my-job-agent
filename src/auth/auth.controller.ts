import { Controller, Get, Req, UseGuards, Redirect, Res, Delete, UnauthorizedException } from '@nestjs/common';
import { Response } from 'express';
import { AuthGuard as GoogleAuthGuard } from '@nestjs/passport';
import { SessionAuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { Request } from 'express';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Get('google')
  @UseGuards(GoogleAuthGuard('google'))
  async googleAuth(@Req() req: Request) {
    console.log('[AuthController] /auth/google hit, passport will redirect to Google');
  }

  @Get('google/callback')
  @UseGuards(GoogleAuthGuard('google'))
  async googleAuthRedirect(
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const user = req.user as any;
    console.log('[AuthController] /auth/google/callback — user:', JSON.stringify(user?.email || user));
    if (!user) {
      return res.redirect('/?error=auth_failed');
    }
    if (req.session) {
      (req.session as any).user = user;
    }
    console.log('[AuthController] Redirecting logged-in user to /dashboard');
    return res.redirect('/dashboard');
  }

  @Get('login')
  @UseGuards(SessionAuthGuard)
  async loginPage(@Req() req: Request, @Res() res: Response) {
    const session = req.session as any;
    if (session?.user) {
      return res.sendFile('./dashboard.html', { root: './public' });
    }
    return res.sendFile('./login.html', { root: './public' });
  }

  @Get('me')
  async getMe(@Req() req: Request, @Res() res: Response) {
    try {
      const session = req.session as any;
      const user = session?.user ?? null;
      return res.json({ user });
    } catch (e: any) {
      return res.status(500).json({ error: 'Session read failed' });
    }
  }

  @Get('allowed-emails')
  async allowedEmails(@Res() res: Response) {
    try {
      return res.json(this.authService.allowedEmails);
    } catch (e: any) {
      return res.status(500).json({ error: 'Could not load allowed emails' });
    }
  }

  @Delete('session')
  async resetSession(@Req() req: Request, @Res() res: Response) {
    try {
      req.session = undefined as any;
      return res.json({ ok: true });
    } catch (e: any) {
      return res.status(500).json({ error: 'Session reset failed' });
    }
  }

  @Get('logout')
  @UseGuards(SessionAuthGuard)
  logout(@Req() req: Request, @Res() res: Response) {
    const session = req.session as any;
    if (session && session.destroy) {
      session.destroy(() => {
        res.clearCookie('connect.sid', { path: '/' });
        res.redirect('/?loggedOut=1');
      });
    } else {
      res.redirect('/?loggedOut=1');
    }
  }
}
