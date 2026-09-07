import { MigrationInterface, QueryRunner } from 'typeorm';

export class FixFyersTokenTable1788800300000 implements MigrationInterface {
	name = 'FixFyersTokenTable1788800300000';

	public async up(queryRunner: QueryRunner): Promise<void> {
		// MySQL 8.0 doesn't support DROP INDEX IF EXISTS - check first
		const indexes = await queryRunner.query(`
			SELECT INDEX_NAME FROM information_schema.STATISTICS 
			WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fyers_tokens' 
			AND INDEX_NAME LIKE 'IDX_FYERS_TOKEN_%'
		`);
		for (const idx of indexes) {
			await queryRunner.query(`DROP INDEX \`${idx.INDEX_NAME}\` ON fyers_tokens`);
		}

		// Drop the table and recreate with correct schema
		await queryRunner.query(`DROP TABLE IF EXISTS fyers_tokens`);

		await queryRunner.query(`
			CREATE TABLE fyers_tokens (
				id VARCHAR(36) NOT NULL PRIMARY KEY,
				provider VARCHAR(32) NOT NULL DEFAULT 'fyers',
				appId VARCHAR(64) NOT NULL,
				accessTokenEncrypted TEXT NOT NULL,
				refreshTokenEncrypted TEXT NULL,
				pinEnc TEXT NULL,
				tokenDate VARCHAR(16) NULL,
				issuedAt DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
				expiresAt DATETIME NULL,
				status VARCHAR(16) NOT NULL DEFAULT 'active',
				statusReason VARCHAR(64) NULL,
				userId VARCHAR(64) NULL,
				authCodeHash TEXT NULL,
				revokedAt DATETIME NULL,
				consumedAt DATETIME NULL,
				createdAt DATETIME NULL,
				updatedAt DATETIME NULL,
				version INT NOT NULL DEFAULT 1,
				INDEX idx_tokens_issue_date (issuedAt),
				INDEX idx_tokens_active (status),
				INDEX idx_appId_status_version (appId, status, version)
			) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
		`);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		// Rollback: Drop new table and recreate old schema if needed
		// For now, we'll just drop the new table since we can't predict previous structure
		await queryRunner.query(`DROP TABLE IF EXISTS fyers_tokens`);
	}
}
