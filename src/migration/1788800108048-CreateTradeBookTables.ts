import { MigrationInterface, QueryRunner, Table } from "typeorm";

export class CreateTradeBookTables1788800108048 implements MigrationInterface {

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.createTable(new Table({
            name: 'trade_book_import_log',
            columns: [
                {
                    name: 'id',
                    type: 'varchar',
                    length: '36',
                    isPrimary: true,
                },
                {
                    name: 'sourceFilePath',
                    type: 'varchar',
                    length: '512',
                },
                {
                    name: 'sourceFileName',
                    type: 'varchar',
                    length: '255',
                },
                {
                    name: 'fileHash',
                    type: 'varchar',
                    length: '64',
                },
                {
                    name: 'totalLines',
                    type: 'int',
                },
                {
                    name: 'importedRows',
                    type: 'int',
                    default: 0,
                },
                {
                    name: 'failedRows',
                    type: 'int',
                    default: 0,
                },
                {
                    name: 'importedAt',
                    type: 'datetime',
                },
                {
                    name: 'status',
                    type: 'varchar',
                    length: '16',
                },
                {
                    name: 'messages',
                    type: 'text',
                    isNullable: true,
                },
            ],
        }), true);

        await queryRunner.createTable(new Table({
            name: 'trade_book_imports',
            columns: [
                {
                    name: 'id',
                    type: 'varchar',
                    length: '36',
                    isPrimary: true,
                },
                {
                    name: 'importLogId',
                    type: 'varchar',
                    length: '36',
                    isNullable: true,
                },
                {
                    name: 'tradeId',
                    type: 'varchar',
                    length: '64',
                    isNullable: true,
                },
                {
                    name: 'symbol',
                    type: 'varchar',
                    length: '96',
                    isNullable: true,
                },
                {
                    name: 'broker',
                    type: 'varchar',
                    length: '64',
                },
                {
                    name: 'environment',
                    type: 'varchar',
                    length: '16',
                },
                {
                    name: 'instrumentKey',
                    type: 'varchar',
                    length: '96',
                    isNullable: true,
                },
                {
                    name: 'underlying',
                    type: 'varchar',
                    length: '64',
                },
                {
                    name: 'expiry',
                    type: 'date',
                    isNullable: true,
                },
                {
                    name: 'strike',
                    type: 'decimal',
                    precision: 14,
                    scale: 2,
                    isNullable: true,
                },
                {
                    name: 'optionType',
                    type: 'varchar',
                    length: '4',
                    isNullable: true,
                },
                {
                    name: 'side',
                    type: 'varchar',
                    length: '8',
                },
                {
                    name: 'quantity',
                    type: 'int',
                },
                {
                    name: 'entryTimestamp',
                    type: 'datetime',
                },
                {
                    name: 'entryPrice',
                    type: 'decimal',
                    precision: 14,
                    scale: 4,
                },
                {
                    name: 'exitTimestamp',
                    type: 'datetime',
                    isNullable: true,
                },
                {
                    name: 'exitPrice',
                    type: 'decimal',
                    precision: 14,
                    scale: 4,
                    isNullable: true,
                },
                {
                    name: 'fees',
                    type: 'decimal',
                    precision: 14,
                    scale: 2,
                    isNullable: true,
                },
                {
                    name: 'netPnl',
                    type: 'decimal',
                    precision: 14,
                    scale: 2,
                    isNullable: true,
                },
                {
                    name: 'grossPnl',
                    type: 'decimal',
                    precision: 14,
                    scale: 2,
                    isNullable: true,
                },
                {
                    name: 'orderId',
                    type: 'varchar',
                    length: '64',
                    isNullable: true,
                },
                {
                    name: 'tradeType',
                    type: 'varchar',
                    length: '32',
                    isNullable: true,
                },
                {
                    name: 'sourceFile',
                    type: 'varchar',
                    length: '255',
                },
                {
                    name: 'sourceRow',
                    type: 'int',
                },
                {
                    name: 'normalizationStatus',
                    type: 'varchar',
                    length: '16',
                },
                {
                    name: 'normalizationWarnings',
                    type: 'text',
                    isNullable: true,
                },
                {
                    name: 'rawData',
                    type: 'text',
                },
                {
                    name: 'matchStatus',
                    type: 'varchar',
                    length: '16',
                    default: "'unmatched'",
                },
                {
                    name: 'matchMethod',
                    type: 'varchar',
                    length: '64',
                    isNullable: true,
                },
                {
                    name: 'importedAt',
                    type: 'datetime',
                    isPrimary: false,
                    default: 'CURRENT_TIMESTAMP',
                },
            ],
        }), true);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.dropTable('trade_book_imports');
        await queryRunner.dropTable('trade_book_import_log');
    }

}
