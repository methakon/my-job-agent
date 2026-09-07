import { MigrationInterface, QueryRunner, Table } from 'typeorm';

export class CreateDatabaseSyncAuditTable1726643200000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.createTable(new Table({
            name: 'database_sync_audit',
            columns: [
                {
                    name: 'id',
                    type: 'int',
                    isPrimary: true,
                    isGenerated: true,
                    generationStrategy: 'increment',
                },
                {
                    name: 'direction',
                    type: 'varchar',
                    length: '20',
                    comment: 'Sync direction: ORACLE_TO_LOCAL or LOCAL_TO_ORACLE',
                },
                {
                    name: 'tableName',
                    type: 'varchar',
                    length: '64',
                    comment: 'Name of the table being synced',
                },
                {
                    name: 'status',
                    type: 'varchar',
                    length: '20',
                    comment: 'Sync status: PENDING, RUNNING, COMPLETED, FAILED',
                },
                {
                    name: 'startedAt',
                    type: 'timestamp',
                    default: 'CURRENT_TIMESTAMP',
                    comment: 'When sync started',
                },
                {
                    name: 'completedAt',
                    type: 'timestamp',
                    isNullable: true,
                    comment: 'When sync completed',
                },
                {
                    name: 'rowsRead',
                    type: 'int',
                    default: '0',
                    comment: 'Number of rows read from source',
                },
                {
                    name: 'rowsInserted',
                    type: 'int',
                    default: '0',
                    comment: 'Number of rows inserted into destination',
                },
                {
                    name: 'rowsUpdated',
                    type: 'int',
                    default: '0',
                    comment: 'Number of rows updated in destination',
                },
                {
                    name: 'rowsSkipped',
                    type: 'int',
                    default: '0',
                    comment: 'Number of rows skipped (conflicts, exclusions)',
                },
                {
                    name: 'rowsFailed',
                    type: 'int',
                    default: '0',
                    comment: 'Number of rows that failed to sync',
                },
                {
                    name: 'checkpointAfter',
                    type: 'text',
                    isNullable: true,
                    comment: 'JSON checkpoint state after this batch',
                },
                {
                    name: 'errorMessage',
                    type: 'text',
                    isNullable: true,
                    comment: 'Error message if sync failed',
                },
                {
                    name: 'createdAt',
                    type: 'timestamp',
                    default: 'CURRENT_TIMESTAMP',
                },
                {
                    name: 'updatedAt',
                    type: 'timestamp',
                    default: 'CURRENT_TIMESTAMP',
                },
            ],
        }), true);

        await queryRunner.createIndex('database_sync_audit', {
            name: 'IDX_DATABASE_SYNC_AUDIT_TABLE_DATE',
            columnNames: ['tableName', 'createdAt'],
        } as any);
        await queryRunner.createIndex('database_sync_audit', {
            name: 'IDX_DATABASE_SYNC_AUDIT_TABLE_STATUS',
            columnNames: ['tableName', 'status'],
        } as any);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.dropTable('database_sync_audit');
    }
}
