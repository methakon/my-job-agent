import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

/**
 * Unified provider token storage — encrypted under ENCRYPTION_KEY.
 * One table for ALL provider tokens (FYERS, Upstox, etc.).
 * Retains historical tokens for audit; only status='active' is used at runtime.
 *
 * - provider: identifies the broker/platform (e.g., 'fyers', 'upstox')
 * - environment: 'sandbox', 'live', or 'paper' — distinguishes token context
 * - Each token row has issuedAt, expiresAt, revokedAt for full lifecycle tracking
 */
@Entity('provider_tokens')
@Index('idx_ptokens_active', ['status'])
@Index('idx_ptokens_provider', ['provider'])
@Index('idx_ptokens_environment', ['environment'])
@Index('idx_ptokens_provider_env', ['provider', 'environment'])
export class ProviderToken {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Provider identifier: 'fyers', 'upstox', etc. */
  @Column({ type: 'varchar', length: 32 })
  provider: string;

  /** Environment: 'sandbox', 'live', 'paper' */
  @Column({ type: 'varchar', length: 16, default: 'live' })
  environment: string;

  /** App/client ID for audit (FYERS App ID, Upstox client_id, etc.) */
  @Column({ type: 'varchar', length: 64 })
  clientId: string;

  /**
   * ACCESS TOKEN encrypted with AES-256-CBC.
   * Format: ivHex:cipherHex (same as EncryptionService).
   */
  @Column({ type: 'text' })
  accessTokenEncrypted: string;

  /**
   * REFRESH TOKEN encrypted with AES-256-CBC.
   * Nullable: may not be returned by all flows.
   */
  @Column({ type: 'text', nullable: true })
  refreshTokenEncrypted: string | null;

  /** When tokens were issued (UTC timestamp) */
  @CreateDateColumn()
  issuedAt: Date;

  /**
   * Token expiry datetime.
   * FYERS: inferred (market close next business day). Refresh tokens: 15 days.
   * Upstox: from OAuth response or estimated.
   */
  @Column({ type: 'datetime', nullable: true })
  expiresAt: Date | null;

  /**
   * Token status: active|expired|revoked.
   * Only one row can have status='active' per provider+environment.
   */
  @Column({ type: 'varchar', length: 16, default: 'active' })
  status: string;

  /**
   * Reason for status (e.g., 'expired', 'replaced_by_rotate', 'user_revoked').
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  statusReason: string | null;

  /** User ID for audit - NOT encrypted as it's non-secret metadata. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  userId: string | null;

  /**
   * Original auth_code used to obtain these tokens (for audit only, never re-used).
   * We DO NOT store this long-term in case of breach; only for debugging.
   */
  @Column({ type: 'text', nullable: true })
  authCodeHash: string | null;

  /** When this token was marked inactive (NULL if still active) */
  @Column({ type: 'datetime', nullable: true })
  revokedAt: Date | null;

  /** Legacy FYERS token date (YYYY-MM-DD) for reference — nullable, provider-specific */
  @Column({ type: 'varchar', length: 16, nullable: true })
  tokenDate: string | null;
}
