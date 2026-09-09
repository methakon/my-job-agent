import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index, UpdateDateColumn } from 'typeorm';

/**
 * Encrypted Upstox LIVE access token persistence.
 *
 * Holds the short-lived LIVE access token so market-data services obtain it
 * through UpstoxLivePaperTokenService and NEVER duplicate token handling.
 *
 * - access_token_encrypted is AES-256-CBC under ENCRYPTION_KEY (same scheme as
 *   portal_users). The raw token is NEVER logged and NEVER stored in .env.
 * - One row per broker/client_id; updated on each valid token refresh.
 */
@Entity('upstox_live_paper_tokens')
@Index('idx_ulpt_broker', ['broker'])
@Index('idx_ulpt_expires', ['expiresAt'])
export class UpstoxLivePaperToken {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Broker name. Always 'UPSTOX' for this module. */
  @Column({ length: 32, default: 'UPSTOX' })
  broker: string;

  /** Upstox client_id (stable app identifier). */
  @Column({ name: 'clientId', length: 64 })
  clientId: string;

  /** AES-256-CBC encrypted access_token. Never the raw value. Null until the first successful OAuth intake (TOKEN_MISSING seed rows carry none). */
  @Column({ name: 'accessTokenEncrypted', type: 'text', nullable: true })
  accessTokenEncrypted: string | null;

  /** e.g. 'Bearer'. */
  @Column({ name: 'tokenType', length: 16, default: 'Bearer' })
  tokenType: string;

  /** Issued-at timestamp (Upstox gives this in the notifier payload). */
  @Column({ name: 'issuedAt', type: 'datetime', nullable: true })
  issuedAt: Date | null;

  /** Expiry timestamp. Token is invalid at or past this moment. */
  @Column({ name: 'expiresAt', type: 'datetime', nullable: true })
  expiresAt: Date | null;

  /** Status for monitoring (see UpstoxLivePaperTokenService.TokenStatus). */
  @Column({ length: 24, default: 'TOKEN_MISSING' })
  status: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
