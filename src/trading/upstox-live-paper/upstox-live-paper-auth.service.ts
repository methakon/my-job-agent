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
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      state,
    });
    return { url: `https://apps.upstox.com/authorization?${params.toString()}`, state };
  }


  // ── internal ───────────────────────────────────────────────────────────────

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
    return this.repo.findOne({ order: { updatedAt: 'DESC' } });
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
