import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EncryptionService } from '../../auth/encryption.service';
import { ProviderTokenService } from '../provider-token.service';

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

/**
 * Upstox LIVE token service — OAuth state handling, code→token exchange and
 * token status for the Upstox market-data consumers (pre-open source + live
 * market service).
 *
 * STORAGE (2026-09-23): tokens are persisted through the unified, encrypted
 * ProviderTokenService store — table `provider_tokens`, provider='upstox',
 * environment='live', status='active', ONE active row per provider+environment
 * updated in place — the exact same store the FYERS feed consumes. The desk's
 * legacy `upstox_live_paper_tokens` table is historical only; the runtime path
 * neither reads nor writes it.
 *
 * SAFETY:
 *  - The access token is never returned to a browser and never logged.
 *  - No consumer ever falls back to a .env or hard-coded token
 *    (getValidUpstoxAccessToken reads the DB store only).
 *  - The code→token exchange runs server-side; the single-use, TTL-bounded
 *    OAuth state is what authorizes it, never the caller's identity.
 */
@Injectable()
export class UpstoxLivePaperTokenService implements OnModuleInit {
  private readonly logger = new Logger(UpstoxLivePaperTokenService.name);

  private readonly config: ConfigService;
  private readonly encryption: EncryptionService;
  private readonly providerTokens: ProviderTokenService;

  /** Hard safety: never accept tokens for apps we don't recognise. */
  private readonly allowedClientIds: Set<string>;

  private randomBytes: (n: number) => Buffer;

  /**
   * Pending OAuth authorization states. Single-use + TTL-bounded so a callback
   * cannot be replayed and a code cannot be injected by a third party. Each
   * entry also remembers the same-origin path the browser should land on after
   * the callback (`returnTo`): '/fnf-trading' for the FNF portal button;
   * null → the Upstox desk page (default).
   */
  private readonly pendingStates = new Map<
    string,
    { createdAt: number; used: boolean; returnTo: string | null }
  >();

  /** Upstox's documented login dialog (Step 1 of the code flow). */
  private static readonly AUTH_DIALOG_URL = 'https://api.upstox.com/v2/login/authorization/dialog';

  /** Upstox's documented code → access_token exchange (Step 3). */
  private static readonly TOKEN_EXCHANGE_URL = 'https://api.upstox.com/v2/login/authorization/token';

  /** Authorization states live 5 minutes — same envelope as the FYERS flow. */
  private static readonly STATE_TTL_MS = 5 * 60 * 1000;

  constructor(
    config: ConfigService,
    encryption: EncryptionService,
    providerTokens: ProviderTokenService,
  ) {
    this.config = config;
    this.encryption = encryption;
    this.providerTokens = providerTokens;

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
    this.logger.log(
      `[UPSTOX-LIVE-PAPER] token service ready (store=provider_tokens provider=upstox environment=live); allowed client_ids=${[...this.allowedClientIds].join(',') || '(none)'}`,
    );
  }

  // ── status ─────────────────────────────────────────────────────────────────

  async tokenStatus(): Promise<{ status: TokenStatus; clientId: string; issuedAt: string | null; expiresAt: string | null; expiryWithinMinutes: number | null }> {
    const row = await this.providerTokens.getCurrentToken('upstox', 'live');
    if (!row?.accessTokenEncrypted) {
      return { status: 'TOKEN_MISSING', clientId: '', issuedAt: null, expiresAt: null, expiryWithinMinutes: null };
    }
    const info = await this.providerTokens.getActiveTokenInfo('upstox', 'live');
    const expiresAt = info?.expiresAt ?? row.expiresAt ?? null;
    const expiresAtMs = expiresAt?.getTime() ?? 0;
    const remainingMs = Math.max(0, expiresAtMs - Date.now());
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
      clientId: row.clientId,
      issuedAt: row.issuedAt?.toISOString() ?? null,
      expiresAt: expiresAt?.toISOString() ?? null,
      expiryWithinMinutes: remainingMinutes,
    };
  }

  // ── token retrieval (market-data services call this) ───────────────────────

  /**
   * Returns a valid non-expired access_token, or throws if none exists.
   * Market-data services MUST use this; they never call the Upstox token API
   * themselves and never read the token from .env or any hard-coded value.
   */
  async getValidUpstoxAccessToken(): Promise<{ token: string; clientId: string; expiresAt: Date }> {
    const row = await this.providerTokens.getCurrentToken('upstox', 'live');
    if (!row) throw new Error('Upstox LIVE access token missing — AUTH_REQUIRED');
    const info = await this.providerTokens.getActiveTokenInfo('upstox', 'live');
    const expiresAt = info?.expiresAt ?? row.expiresAt ?? null;
    if (!expiresAt || expiresAt <= new Date()) {
      const s = await this.tokenStatus();
      throw new Error(`Upstox LIVE access token ${s.status} — AUTH_REQUIRED`);
    }
    const token = await this.providerTokens.getActiveAccessToken('upstox', 'live');
    if (!token) throw new Error('Upstox LIVE access token missing — AUTH_REQUIRED');
    return { token, clientId: row.clientId, expiresAt };
  }

  // ── persistence from OAuth callback / notifier ─────────────────────────────

  /**
   * Persist a token received through the configured Upstox notifier OR OAuth
   * callback. Validates client_id against our allowed set before storing.
   *
   * The write goes to the unified encrypted provider store
   * (provider='upstox', environment='live', status='active'): ProviderTokenService
   * updates the single active row IN PLACE, so a fresh token atomically replaces
   * the previous one — there is never a moment where two active Upstox rows
   * could be selected. Provenance (expiresAt from the token's own claims, IST
   * token date) is preserved on the row.
   */
  async persistToken(payload: {
    clientId: string;
    accessToken: string;
    tokenType?: string;
    issuedAt?: string | number;
    expiresAt?: string | number;
  }): Promise<{ clientId: string; expiresAt: Date | null; tokenType: string }> {
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

    // Encryption pre-flight: same guard the desk used before — if the AES
    // pipeline is broken, fail loudly and store nothing.
    if (!this.encryption.encrypt(payload.accessToken)) {
      this.logger.error('[UPSTOX-LIVE-PAPER] failed to encrypt access token — not storing');
      throw new Error('token encryption failed');
    }

    // Do NOT log the token. Encrypted at rest with AES-256-CBC under
    // ENCRYPTION_KEY by ProviderTokenService (same mechanism as FYERS).
    await this.providerTokens.storeTokens(
      payload.accessToken,
      null,
      normalizedClientId,
      'upstox',
      'live',
      null,
      { expiresAt, tokenDate: this.istDateString(issuedAt ?? new Date()) },
    );

    this.logger.log(
      `[UPSTOX-LIVE-PAPER] token persisted (provider=upstox environment=live client_id=${normalizedClientId} exp=${expiresAt?.toISOString() ?? 'n/a'})`,
    );
    return { clientId: normalizedClientId, expiresAt, tokenType };
  }

  // ── admin / manual initiation helpers ──────────────────────────────────────

  /**
   * Build the Upstox authorization URL and register its single-use state.
   * `returnTo` is an optional same-origin path the callback redirects back to
   * (e.g. '/fnf-trading' for the FNF portal button); anything else is ignored
   * and the callback falls back to the Upstox desk page.
   */
  async initiateTokenRequest(returnTo?: string): Promise<{ url: string; state: string }> {
    const clientId = (this.config.get<string>('UPSTOX_LIVE_API_KEY') ?? '').trim();
    if (!clientId) throw new Error('UPSTOX_LIVE_API_KEY not configured — cannot initiate token request');
    const redirectUri = (this.config.get<string>('UPSTOX_LIVE_REDIRECT_URI') ?? '').trim();
    if (!redirectUri) throw new Error('UPSTOX_LIVE_REDIRECT_URI not configured — cannot initiate token request');
    const state = Buffer.from(this.randomBytes ? this.randomBytes(18).toString('hex') : Math.random().toString(36).slice(2)).toString('base64');
    this.registerState(state, returnTo);
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
    });
    // Upstox's documented dialog host — the FNF portal button and this desk's
    // init page both redirect here.
    return { url: `${UpstoxLivePaperTokenService.AUTH_DIALOG_URL}?${params.toString()}`, state };
  }

  /**
   * Validate and burn an authorization state. Single-use and TTL-bounded, so a
   * replayed callback or an injected code is refused before anything reaches
   * Upstox. Returns the returnTo path the flow was started with (when any).
   */
  consumeState(state: string | undefined): { ok: true; returnTo: string | null } | { ok: false; reason: string } {
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
    return { ok: true, returnTo: entry.returnTo ?? null };
  }

  /**
   * Step 3 of the documented flow: exchange the single-use authorization code
   * for an access token server-side, then persist it. The token is never
   * returned to the caller and never logged.
   *
   * Expiry semantics (documented Upstox behaviour): an access token obtained
   * through this flow is valid until 3:30 AM IST the following day. We do not
   * invent a lifetime — the token's own exp claim (JWT) is authoritative and is
   * what gets stored; `expires_in` / `expires_at` from the response are honoured
   * next; a token with no discoverable lifetime is REFUSED rather than guessed.
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
      `[UPSTOX-LIVE-PAPER] authorization code exchanged; token stored for client_id=${saved.clientId} exp=${(saved.expiresAt ?? expiresAt).toISOString()}`,
    );
    return { clientId: saved.clientId, expiresAt: saved.expiresAt ?? expiresAt, tokenType: saved.tokenType ?? 'Bearer' };
  }

  // ── internal ───────────────────────────────────────────────────────────────

  private registerState(state: string, returnTo?: string): void {
    this.pruneStates();
    this.pendingStates.set(state, { createdAt: Date.now(), used: false, returnTo: this.sanitizeReturnTo(returnTo) });
  }

  /** Same-origin path only ('/fnf-trading', '/upstox-live-paper.html'); else null. */
  private sanitizeReturnTo(returnTo: string | undefined): string | null {
    const value = (returnTo ?? '').trim();
    if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\') || /[\r\n]/.test(value)) return null;
    return value;
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

  /** IST calendar date (YYYY-MM-DD) for row provenance (provider_tokens.tokenDate). */
  private istDateString(when: Date): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(when);
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
