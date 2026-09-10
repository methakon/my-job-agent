import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { EncryptionService } from '../../auth/encryption.service';
import { UpstoxLivePaperToken } from './upstox-live-paper-token.entity';

export type TokenStatus =
  | 'AUTHENTICATED'
  | 'TOKEN_VALID'
  | 'TOKEN_EXPIRY'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_MISSING'
  | 'AUTH_REQUIRED';

const STATUS: Record<TokenStatus, TokenStatus> = {
  AUTHENTICATED: 'AUTHENTICATED',
  TOKEN_VALID: 'TOKEN_VALID',
  TOKEN_EXPIRY: 'TOKEN_EXPIRY',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_MISSING: 'TOKEN_MISSING',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
};

@Injectable()
export class UpstoxLivePaperTokenService implements OnModuleInit {
  private readonly logger = new Logger(UpstoxLivePaperTokenService.name);

  private readonly config: ConfigService;
  private readonly repo: Repository<UpstoxLivePaperToken>;
  private readonly encryption: EncryptionService;

  /** Hard safety: never accept tokens for apps we don't recognise. */
  private readonly allowedClientIds: Set<string>;

  private randomBytes: (n: number) => Buffer;

  /**
   * Pending OAuth authorization states. Single-use + TTL-bounded so a callback
   * cannot be replayed and a code cannot be injected by a third party.
   */
  private readonly pendingStates = new Map<string, { createdAt: number; used: boolean }>();

  /** Upstox's documented login dialog (Step 1 of the code flow). */
  private static readonly AUTH_DIALOG_URL = 'https://api.upstox.com/v2/login/authorization/dialog';

  /** Upstox's documented code → access_token exchange (Step 3). */
  private static readonly TOKEN_EXCHANGE_URL = 'https://api.upstox.com/v2/login/authorization/token';

  /** Authorization states live 5 minutes — same envelope as the FYERS flow. */
  private static readonly STATE_TTL_MS = 5 * 60 * 1000;

  constructor(
    config: ConfigService,
    @InjectRepository(UpstoxLivePaperToken)
    repo: Repository<UpstoxLivePaperToken>,
    encryption: EncryptionService,
  ) {
    this.config = config;
    this.repo = repo;
    this.encryption = encryption;

    const configured = (config.get<string>('UPSTOX_LIVE_API_KEY') ?? '').trim();
    const fallback = config.get<string>('UPSTOX_LIVE_ALLOWED_CLIENT_IDS') ?? '';
    const ids = new Set(
      [configured, fallback]
        .join(',')
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
    );
    this.allowedClientIds = ids;

    // Use Node.js crypto randomBytes if available, else fallback.
    const nodeCrypto = (typeof globalThis !== 'undefined' && (globalThis as any).crypto && (globalThis as any).crypto.randomBytes)
      ? (globalThis as any).crypto.randomBytes
      : null;
    this.randomBytes = nodeCrypto
      ? (n: number) => nodeCrypto(n)
      : () => Buffer.from(Math.random().toString(36).slice(2).padEnd(18, '0'));
  }

  async onModuleInit(): Promise<void> {
    await this.ensureSeedRow();
    this.logger.log(`[UPSTOX-LIVE-PAPER] token service ready; allowed client_ids=${[...this.allowedClientIds].join(',') || '(none)'}`);
  }

  // ── status ─────────────────────────────────────────────────────────────────

  async tokenStatus(): Promise<{ status: TokenStatus; clientId: string; issuedAt: string | null; expiresAt: string | null; expiryWithinMinutes: number | null }> {
    const token = await this.latestToken();
    if (!token) {
      return { status: 'TOKEN_MISSING', clientId: '', issuedAt: null, expiresAt: null, expiryWithinMinutes: null };
    }
    const now = Date.now();
    const expiresAtMs = token.expiresAt?.getTime() ?? 0;
    const issuedAtMs = token.issuedAt?.getTime() ?? 0;
    const remainingMs = Math.max(0, expiresAtMs - now);
    const remainingMinutes = expiresAtMs > 0 ? Math.ceil(remainingMs / 60_000) : null;

    let status: TokenStatus;
    if (!remainingMs) {
      status = 'TOKEN_EXPIRED';
    } else if (remainingMinutes !== null && remainingMinutes <= 5) {
      status = 'TOKEN_EXPIRY';
    } else {
      status = 'TOKEN_VALID';
    }

    return {
      status,
      clientId: token.clientId,
      issuedAt: token.issuedAt?.toISOString() ?? null,
      expiresAt: token.expiresAt?.toISOString() ?? null,
      expiryWithinMinutes: remainingMinutes,
    };
  }

  // ── token retrieval (market-data services call this) ───────────────────────

  /**
   * Returns a valid non-expired access_token, or throws if none exists.
   * Market-data services MUST use this; they never call the Upstox token API
   * themselves and never read the token from .env.
   */
  async getValidUpstoxAccessToken(): Promise<{ token: string; clientId: string; expiresAt: Date }> {
    const token = await this.latestToken();
    if (!token) throw new Error('Upstox LIVE access token missing — AUTH_REQUIRED');
    if (!token.expiresAt || token.expiresAt <= new Date()) {
      const s = await this.tokenStatus();
      throw new Error(`Upstox LIVE access token ${s.status} — AUTH_REQUIRED`);
    }
    return {
      token: this.encryption.decrypt(token.accessTokenEncrypted),
      clientId: token.clientId,
      expiresAt: token.expiresAt,
    };
  }

  // ── persistence from OAuth callback / notifier ─────────────────────────────

  /**
   * Persist a token received through the configured Upstox notifier OR OAuth
   * callback. Validates client_id against our allowed set before storing.
   */
  async persistToken(payload: {
    clientId: string;
    accessToken: string;
    tokenType?: string;
    issuedAt?: string | number;
    expiresAt?: string | number;
  }): Promise<UpstoxLivePaperToken> {
    const normalizedClientId = payload.clientId.trim().toUpperCase();
    if (!this.allowedClientIds.size) {
      this.logger.warn('[UPSTOX-LIVE-PAPER] no allowed client_ids configured — rejecting token persist');
      throw new Error('no allowed Upstox client_ids configured');
    }
    if (!this.allowedClientIds.has(normalizedClientId)) {
      this.logger.warn(`[UPSTOX-LIVE-PAPER] token for unknown client_id=${normalizedClientId} rejected`);
      throw new Error(`unknown Upstox client_id: ${payload.clientId}`);
    }

    const expiresAt = this.parseTs(payload.expiresAt);
    const issuedAt = this.parseTs(payload.issuedAt);
    const tokenType = (payload.tokenType ?? 'Bearer').trim() || 'Bearer';

    // Do NOT log the token.
    const encrypted = this.encryption.encrypt(payload.accessToken);
    if (!encrypted) {
      this.logger.error('[UPSTOX-LIVE-PAPER] failed to encrypt access token — not storing');
      throw new Error('token encryption failed');
    }

    const existing = await this.repo.findOne({ where: { clientId: normalizedClientId } });
    const entity = (existing ?? this.repo.create({ broker: 'UPSTOX', clientId: normalizedClientId })) as UpstoxLivePaperToken;
    entity.accessTokenEncrypted = encrypted;
    entity.tokenType = tokenType;
    entity.issuedAt = issuedAt ?? null;
    entity.expiresAt = expiresAt ?? null;
    entity.status = expiresAt && expiresAt > new Date() ? 'TOKEN_VALID' : 'TOKEN_EXPIRY';
    return this.repo.save(entity);
  }

  // ── admin / manual initiation helpers ──────────────────────────────────────

  async initiateTokenRequest(): Promise<{ url: string; state: string }> {
    const clientId = (this.config.get<string>('UPSTOX_LIVE_API_KEY') ?? '').trim();
    if (!clientId) throw new Error('UPSTOX_LIVE_API_KEY not configured — cannot initiate token request');
    const redirectUri = (this.config.get<string>('UPSTOX_LIVE_REDIRECT_URI') ?? '').trim();
    if (!redirectUri) throw new Error('UPSTOX_LIVE_REDIRECT_URI not configured — cannot initiate token request');
    const state = Buffer.from(this.randomBytes ? this.randomBytes(18).toString('hex') : Math.random().toString(36).slice(2)).toString('base64');
    this.registerState(state);
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
    });
    // Upstox's documented dialog host. The previous value
    // (apps.upstox.com/authorization) does not resolve at all, so the
    // "Authorize" link led to a dead page.
    return { url: `${UpstoxLivePaperTokenService.AUTH_DIALOG_URL}?${params.toString()}`, state };
  }

  /**
   * Validate and burn an authorization state. Single-use and TTL-bounded, so a
   * replayed callback or an injected code is refused before anything reaches
   * Upstox.
   */
  consumeState(state: string | undefined): { ok: true } | { ok: false; reason: string } {
    const key = (state ?? '').trim();
    if (!key) return { ok: false, reason: 'Missing OAuth state — this callback was not started from the desk' };
    const entry = this.pendingStates.get(key);
    if (!entry) return { ok: false, reason: 'Unknown or already-used OAuth state — start again from the desk' };
    if (entry.used) return { ok: false, reason: 'OAuth state already used — start again from the desk' };
    if (Date.now() - entry.createdAt > UpstoxLivePaperTokenService.STATE_TTL_MS) {
      this.pendingStates.delete(key);
      return { ok: false, reason: 'OAuth state expired (5 minute limit) — start again from the desk' };
    }
    entry.used = true;
    this.pendingStates.delete(key);
    return { ok: true };
  }

  /**
   * Step 3 of the documented flow: exchange the single-use authorization code
   * for an access token server-side, then persist it. The token is never
   * returned to the caller and never logged.
   */
  async completeAuthorization(code: string): Promise<{ clientId: string; expiresAt: Date | null; tokenType: string }> {
    const clientId = (this.config.get<string>('UPSTOX_LIVE_API_KEY') ?? '').trim();
    const clientSecret = (this.config.get<string>('UPSTOX_LIVE_API_SECRET') ?? '').trim();
    const redirectUri = (this.config.get<string>('UPSTOX_LIVE_REDIRECT_URI') ?? '').trim();
    if (!clientId) throw new Error('UPSTOX_LIVE_API_KEY not configured — cannot exchange the authorization code');
    if (!clientSecret) throw new Error('UPSTOX_LIVE_API_SECRET not configured — cannot exchange the authorization code');
    if (!redirectUri) throw new Error('UPSTOX_LIVE_REDIRECT_URI not configured — cannot exchange the authorization code');
    if (!code.trim()) throw new Error('empty authorization code');

    const body = new URLSearchParams({
      code: code.trim(),
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });

    const response = await fetch(UpstoxLivePaperTokenService.TOKEN_EXCHANGE_URL, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const raw = await response.text();
    let parsed: Record<string, any> | null = null;
    try {
      parsed = JSON.parse(raw) as Record<string, any>;
    } catch {
      parsed = null;
    }

    const accessToken = typeof parsed?.access_token === 'string' ? parsed.access_token.trim() : '';
    if (!response.ok || !accessToken) {
      const detail =
        parsed?.errors?.[0]?.message ?? parsed?.error_description ?? parsed?.message ?? `HTTP ${response.status}`;
      throw new Error(`Upstox token exchange failed: ${detail}`);
    }

    const claims = this.decodeJwtClaims(accessToken);
    const expiresAt = this.expiryFromClaims(claims, parsed);
    if (!expiresAt) {
      throw new Error(
        'Upstox returned no token expiry (no exp claim / expires_in) — refusing to store a token of unknown lifetime',
      );
    }

    const saved = await this.persistToken({
      clientId,
      accessToken,
      tokenType: typeof parsed?.token_type === 'string' ? parsed.token_type : 'Bearer',
      issuedAt: typeof claims?.iat === 'number' ? claims.iat : undefined,
      expiresAt: expiresAt.toISOString(),
    });

    this.logger.log(
      `[UPSTOX-LIVE-PAPER] authorization code exchanged; token stored for client_id=${saved.clientId} exp=${expiresAt.toISOString()}`,
    );
    return { clientId: saved.clientId, expiresAt: saved.expiresAt ?? expiresAt, tokenType: saved.tokenType ?? 'Bearer' };
  }

  // ── internal ───────────────────────────────────────────────────────────────

  private registerState(state: string): void {
    this.pruneStates();
    this.pendingStates.set(state, { createdAt: Date.now(), used: false });
  }

  private pruneStates(): void {
    const cutoff = Date.now() - UpstoxLivePaperTokenService.STATE_TTL_MS;
    for (const [key, entry] of this.pendingStates) {
      if (entry.used || entry.createdAt < cutoff) this.pendingStates.delete(key);
    }
  }

  /** Decode (never verify) a JWT payload — used only to read the token's own exp claim. */
  private decodeJwtClaims(token: string): Record<string, any> | null {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    try {
      const payload = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      const claims = JSON.parse(payload) as Record<string, any>;
      return claims && typeof claims === 'object' ? claims : null;
    } catch {
      return null;
    }
  }

  private expiryFromClaims(
    claims: Record<string, any> | null,
    response: Record<string, any> | null,
  ): Date | null {
    if (claims && typeof claims.exp === 'number' && Number.isFinite(claims.exp)) {
      return new Date(claims.exp * 1000);
    }
    const expiresIn = response?.expires_in;
    if (typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0) {
      return new Date(Date.now() + expiresIn * 1000);
    }
    return this.parseTs(response?.expires_at ?? undefined);
  }

  private async ensureSeedRow(): Promise<void> {
    const configuredClientId = (this.config.get<string>('UPSTOX_LIVE_API_KEY') ?? '').trim().toUpperCase();
    if (!configuredClientId) return;
    const existing = await this.repo.findOne({ where: { clientId: configuredClientId } });
    if (!existing) {
      await this.repo.save(this.repo.create({ broker: 'UPSTOX', clientId: configuredClientId, status: 'TOKEN_MISSING' }));
      this.logger.log(`[UPSTOX-LIVE-PAPER] seeded token row for client_id=${configuredClientId}`);
    }
  }

  private async latestToken(): Promise<UpstoxLivePaperToken | null> {
    // TypeORM 0.3 rejects findOne() without a `where` ("You must provide
    // selection conditions…"), even with an order clause — which made every
    // token read throw, so the desk could never see a token it had stored.
    const rows = await this.repo.find({ order: { updatedAt: 'DESC' }, take: 1 });
    return rows[0] ?? null;
  }

  private parseTs(raw: string | number | undefined): Date | null {
    if (raw === undefined || raw === null) return null;
    if (typeof raw === 'number') {
      const d = new Date(raw * 1000);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    const s = String(raw).trim();
    if (!s) return null;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  /** Public log method for controller traceability. Never logs token values. */
  public log(msg: string): void {
    this.logger.log(msg);
  }
}
