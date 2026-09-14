import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Stage 1 (D4/D5/D6) — stop fabricating zeros, give index/underlying
 * observations somewhere to keep their book, and put pre-open rows in the
 * canonical identity space.
 *
 * D4: `unified_option_quotes.volume|oi` and `unified_market_snapshots.volume`
 *     were NOT NULL DEFAULT 0 while the ingest path wrote `finite(x) ?? 0`, so
 *     "the provider sent nothing" was stored as a real 0. Absence and a genuine
 *     zero are indistinguishable afterwards. The columns are relaxed to NULL so
 *     absence stays absent. No backfill is attempted: a stored 0 cannot be told
 *     apart from a fabricated one after the fact.
 *
 * D5: `unified_market_snapshots` (index/underlying) had no bid/ask/size/depth
 *     columns at all, unlike `unified_option_quotes`, so provider L1 sizes and a
 *     depth block were silently dropped on write. Added NULLABLE.
 *
 * D6: `pre_open_observations` carries the broker's own key spelling; a canonical
 *     consumer could not join it to the common store. A canonical key column
 *     puts both stores in ONE identity space without mirroring auction prices
 *     into the tradable tables.
 *
 * Every change is a relaxation or an additive nullable column: no existing row
 * is rewritten, no NOT NULL is tightened, no trading path changes.
 */
export class NullPreservingVolumeOiAndIndexDepth1789430400000 implements MigrationInterface {
  name = 'NullPreservingVolumeOiAndIndexDepth1789430400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const hasColumn = async (table: string, column: string): Promise<boolean> => {
      const rows = await queryRunner.query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [table, column],
      );
      return Array.isArray(rows) && rows.length > 0;
    };
    const hasIndex = async (table: string, index: string): Promise<boolean> => {
      const rows = await queryRunner.query(
        `SELECT INDEX_NAME FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
        [table, index],
      );
      return Array.isArray(rows) && rows.length > 0;
    };

    // D4 — absence must be storable as NULL, never as a manufactured 0.
    await queryRunner.query(`
      ALTER TABLE unified_option_quotes
        MODIFY COLUMN volume DECIMAL(18,2) NULL,
        MODIFY COLUMN oi DECIMAL(18,2) NULL
    `);
    await queryRunner.query(`
      ALTER TABLE unified_market_snapshots
        MODIFY COLUMN volume DECIMAL(18,2) NULL
    `);

    // D5 — index/underlying L1 sizes + depth (additive, nullable).
    if (!(await hasColumn('unified_market_snapshots', 'bid'))) {
      await queryRunner.query(`
        ALTER TABLE unified_market_snapshots
          ADD COLUMN bid DECIMAL(14,4) NULL,
          ADD COLUMN ask DECIMAL(14,4) NULL,
          ADD COLUMN bidQty INT NULL,
          ADD COLUMN askQty INT NULL,
          ADD COLUMN depth JSON NULL
      `);
    }

    // D6 — one identity space for pre-open rows (additive, nullable).
    if (!(await hasColumn('pre_open_observations', 'canonicalKey'))) {
      await queryRunner.query(`ALTER TABLE pre_open_observations ADD COLUMN canonicalKey VARCHAR(96) NULL`);
    }
    if (!(await hasIndex('pre_open_observations', 'idx_pre_open_obs_canonical'))) {
      await queryRunner.query(
        `CREATE INDEX idx_pre_open_obs_canonical ON pre_open_observations (canonicalKey, eventTime)`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE unified_market_snapshots
        DROP COLUMN bid, DROP COLUMN ask, DROP COLUMN bidQty, DROP COLUMN askQty, DROP COLUMN depth
    `);

    // Reversing D4 needs a value for every NULL. 0 is the OLD fabricated
    // default, restored only because the column must be NOT NULL again.
    await queryRunner.query(`UPDATE unified_market_snapshots SET volume = 0 WHERE volume IS NULL`);
    await queryRunner.query(
      `ALTER TABLE unified_market_snapshots MODIFY COLUMN volume DECIMAL(18,2) NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(`UPDATE unified_option_quotes SET volume = 0 WHERE volume IS NULL`);
    await queryRunner.query(`UPDATE unified_option_quotes SET oi = 0 WHERE oi IS NULL`);
    await queryRunner.query(`
      ALTER TABLE unified_option_quotes
        MODIFY COLUMN volume DECIMAL(18,2) NOT NULL DEFAULT 0,
        MODIFY COLUMN oi DECIMAL(18,2) NOT NULL DEFAULT 0
    `);

    await queryRunner.query(`DROP INDEX idx_pre_open_obs_canonical ON pre_open_observations`);
    await queryRunner.query(`ALTER TABLE pre_open_observations DROP COLUMN canonicalKey`);
  }
}
