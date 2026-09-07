import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

/**
 * FYERS OAuth tokens stored securely encrypted under ENCRYPTION_KEY.
 * Retains historical tokens for audit; only status='active' is used by trading agent.
 * 
 * Token expiry is NOT returned by FYERS; we infer 5:30 IST next business day
 * as the standard market close time. For refresh tokens, expiry is 15 days from issue.
 */
@Entity('fyers_tokens')
@Index('idx_tokens_active', ['status'])
@Index('idx_tokens_issue_date', ['issuedAt'])
export class FyersToken {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Provider identifier (always 'fyers' for this entity) */
  @Column({ type: 'varchar', length: 32, default: 'fyers' })
  provider: string;

  /** FYERS App ID (e.g., TQHWHBA2SZ-200) for audit */
  @Column({ type: 'varchar', length: 64 })
  appId: string;

  /** Original token date (YYYY-MM-DD) for reference */
  @Column({ type: 'varchar', length: 16, nullable: true })
  tokenDate: string | null;

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
   * Token expiry (inferred from FYERS v3 doc: market close next business day).
   * FYERS does NOT return expiry; we estimate based on trading calendar.
   * For refresh tokens: 15 days from issue (documented behavior).
   */
  @Column({ type: 'datetime', nullable: true })
  expiresAt: Date | null;

  /**
   * Token status: active|expired|revoked.
   * Only one row can have status='active' at a time.
   */
  @Column({ type: 'varchar', length: 16, default: 'active' })
  status: string;

  /**
   * Reason for status (e.g., 'expired', 'replaced_by_rotate', 'user_revoked').
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  statusReason: string | null;

  /**
   * FYERS user ID (FY ID) for audit - NOT encrypted as it's non-secret metadata.
   */
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
}
