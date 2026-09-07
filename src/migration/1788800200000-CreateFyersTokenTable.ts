import {MigrationInterface, QueryRunner, Table, TableIndex} from "typeorm";

export class CreateFyersTokenTable1788800200000 implements MigrationInterface {

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.createTable(new Table({
            name: 'fyers_tokens',
            columns: [
                {
                    name: 'id',
                    type: 'varchar',
                    length: '36',
                    isPrimary: true,
                    isNullable: false,
                },
                {
                    name: 'provider',
                    type: 'varchar',
                    length: '50',
                    isNullable: false,
                    default: "'fyers'",
                },
                {
                    name: 'appId',
                    type: 'varchar',
                    length: '100',
                    isNullable: false,
                },
                {
                    name: 'tokenDate',
                    type: 'varchar',
                    length: '50',
                    isNullable: true,
                    comment: 'Date string from FYERS response (if available)',
                },
                {
                    name: 'accessTokenEncrypted',
                    type: 'text',
                    isNullable: false,
                    comment: 'AES-256-CBC encrypted access token',
                },
                {
                    name: 'refreshTokenEncrypted',
                    type: 'text',
                    isNullable: true,
                    comment: 'AES-256-CBC encrypted refresh token (nullable if not provided)',
                },
                {
                    name: 'userId',
                    type: 'varchar',
                    length: '50',
                    isNullable: true,
                    comment: 'FYERS user ID (FY ID) for audit',
                },
                {
                    name: 'authCodeHash',
                    type: 'varchar',
                    length: '64',
                    isNullable: true,
                    comment: 'SHA-256 hash of auth_code for audit (never store plaintext)',
                },
                {
                    name: 'issuedAt',
                    type: 'bigint',
                    isNullable: true,
                    comment: 'Epoch timestamp when token was issued (from FYERS response if available)',
                },
                {
                    name: 'expiresAt',
                    type: 'bigint',
                    isNullable: true,
                    comment: 'Epoch timestamp when token expires (inferred from FYERS v3 doc if not provided)',
                },
                {
                    name: 'status',
                    type: 'varchar',
                    length: '20',
                    isNullable: false,
                    default: "'active'",
                    comment: 'active, revoked, expired',
                },
                {
                    name: 'statusReason',
                    type: 'varchar',
                    length: '255',
                    isNullable: true,
                    comment: 'Reason for status change (e.g., replaced_by_new_tokens, user_revoked)',
                },
                {
                    name: 'revokedAt',
                    type: 'bigint',
                    isNullable: true,
                    comment: 'Epoch timestamp when token was revoked',
                },
                {
                    name: 'createdAt',
                    type: 'datetime',
                    precision: 3,
                    default: 'CURRENT_TIMESTAMP(3)',
                    isNullable: false,
                },
                {
                    name: 'updatedAt',
                    type: 'datetime',
                    precision: 3,
                    default: 'CURRENT_TIMESTAMP(3)',
                    onUpdate: 'CURRENT_TIMESTAMP(3)',
                    isNullable: false,
                },
            ],
        }), true);

        // Create indexes for common queries
        await queryRunner.createIndices('fyers_tokens', [
            new TableIndex({
                name: 'IDX_FYERS_TOKEN_STATUS',
                columnNames: ['status'],
            }),
            new TableIndex({
                name: 'IDX_FYERS_TOKEN_ISSUED_AT',
                columnNames: ['issuedAt'],
            }),
            new TableIndex({
                name: 'IDX_FYERS_TOKEN_AUTH_CODE_HASH',
                columnNames: ['authCodeHash'],
            }),
            new TableIndex({
                name: 'IDX_FYERS_TOKEN_USER_ID',
                columnNames: ['userId'],
            }),
        ]);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.dropTable('fyers_tokens');
    }
}
