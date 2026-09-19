import { MigrationInterface, QueryRunner } from 'typeorm';

export class RenameFyersTokensToProviderTokens1790100000000 implements MigrationInterface {
  name = 'RenameFyersTokensToProviderTokens1790100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Check if source table exists
    const tableExists = await queryRunner.query(`
      SELECT COUNT(*) as cnt FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fyers_tokens'
    `);
    if (tableExists[0].cnt === 0) {
      // Table doesn't exist yet — create it directly as provider_tokens
      await this.createProviderTokensTable(queryRunner);
      return;
    }

    // Table exists — rename it
    await queryRunner.query(`RENAME TABLE fyers_tokens TO provider_tokens`);

    // Add environment column (default 'live' for existing FYERS tokens)
    await queryRunner.query(`
      ALTER TABLE provider_tokens
      ADD COLUMN environment VARCHAR(16) NOT NULL DEFAULT 'live'
      AFTER provider
    `);

    // Rename appId → clientId for clarity (keeping appId data)
    const hasAppId = await queryRunner.query(`
      SELECT COUNT(*) as cnt FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'provider_tokens'
      AND COLUMN_NAME = 'appId'
    `);
    if (hasAppId[0].cnt > 0) {
      await queryRunner.query(`ALTER TABLE provider_tokens CHANGE appId clientId VARCHAR(64) NOT NULL`);
    }

    // Add indexes for multi-provider filtering
    await queryRunner.query(`
      CREATE INDEX idx_ptokens_provider ON provider_tokens (provider)
    `);
    await queryRunner.query(`
      CREATE INDEX idx_ptokens_environment ON provider_tokens (environment)
    `);
    await queryRunner.query(`
      CREATE INDEX idx_ptokens_provider_env ON provider_tokens (provider, environment)
    `);

    // Drop old indexes that referenced fyers_tokens naming
    const oldIndexes = await queryRunner.query(`
      SELECT INDEX_NAME FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'provider_tokens'
      AND INDEX_NAME IN ('idx_appId_status_version')
    `);
    for (const idx of oldIndexes) {
      await queryRunner.query(`DROP INDEX \`${idx.INDEX_NAME}\` ON provider_tokens`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop new indexes
    for (const idx of ['idx_ptokens_provider', 'idx_ptokens_environment', 'idx_ptokens_provider_env']) {
      await queryRunner.query(`DROP INDEX IF EXISTS \`${idx}\` ON provider_tokens`);
    }

    // Rename clientId back to appId
    await queryRunner.query(`
      ALTER TABLE provider_tokens CHANGE clientId appId VARCHAR(64) NOT NULL
    `);

    // Remove environment column
    await queryRunner.query(`ALTER TABLE provider_tokens DROP COLUMN environment`);

    // Rename back
    await queryRunner.query(`RENAME TABLE provider_tokens TO fyers_tokens`);
  }

  private async createProviderTokensTable(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE provider_tokens (
        id VARCHAR(36) NOT NULL PRIMARY KEY,
        provider VARCHAR(32) NOT NULL DEFAULT 'fyers',
        environment VARCHAR(16) NOT NULL DEFAULT 'live',
        clientId VARCHAR(64) NOT NULL,
        accessTokenEncrypted TEXT NOT NULL,
        refreshTokenEncrypted TEXT NULL,
        tokenDate VARCHAR(16) NULL,
        issuedAt DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        expiresAt DATETIME NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'active',
        statusReason VARCHAR(64) NULL,
        userId VARCHAR(64) NULL,
        authCodeHash TEXT NULL,
        revokedAt DATETIME NULL,
        INDEX idx_ptokens_active (status),
        INDEX idx_ptokens_issue_date (issuedAt),
        INDEX idx_ptokens_provider (provider),
        INDEX idx_ptokens_environment (environment),
        INDEX idx_ptokens_provider_env (provider, environment)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }
}
