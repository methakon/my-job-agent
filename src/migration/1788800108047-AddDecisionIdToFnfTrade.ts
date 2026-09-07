import { MigrationInterface, QueryRunner, TableColumn } from "typeorm";

export class AddDecisionIdToFnfTrade1788800108047 implements MigrationInterface {

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.addColumns('fnf_trades', [
            new TableColumn({ name: 'decisionId', type: 'varchar', length: '64', isNullable: true })
        ]);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.dropColumn('fnf_trades', 'decisionId');
    }

}
