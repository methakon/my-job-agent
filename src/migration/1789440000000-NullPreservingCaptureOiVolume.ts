import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Absence-preserving CAPTURE tables (extension of the Stage-1 D4 rule).
 *
 * WHY: Stage-1 D4 relaxed `unified_option_quotes` / `unified_market_snapshots`,
 * but the two tables that actually accumulate the strike-wise OI history a
 * research evaluation depends on were left NOT NULL DEFAULT 0:
 *
 *   * `upstox_live_paper_option_quotes.volume|openInterest|oiChange` — the only
 *     table holding GENUINE Upstox OI, ΔOI and underlyingPrice per strike/expiry;
 *   * `fnf_option_quotes` / `fnf_option_quotes_history.volume|openInterest` — the
 *     source of the 3.9M-row archive.
 *
 * Because those columns are NOT NULL DEFAULT 0 AND the write paths coerce with
 * `finite(x) ?? 0`, "the provider published nothing" was stored as a real 0.
 * Measured on 2026-09-14: `fnf_option_quotes_history` holds 3,900,914 zeros and
 * only 3 non-zero OI values in 3,900,917 rows — the archive is unusable for any
 * OI feature, and the fabricated zeros are indistinguishable from real zeros.
 *
 * A stored 0 is NOT backfilled: a fabricated zero and a genuine zero cannot be
 * told apart after the fact, so inventing a value for them would be a second
 * fabrication. History stays as-recorded; only FUTURE rows improve.
 *
 * Every change is a pure relaxation to NULL — no column is tightened, no row is
 * rewritten, no index changes, and no trading path reads these columns for a
 * decision, so PAPER/LIVE behaviour is untouched.
 */
export class NullPreservingCaptureOiVolume1789440000000 implements MigrationInterface {
  name = 'NullPreservingCaptureOiVolume1789440000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const tableExists = async (table: string): Promise<boolean> => {
      const rows = await queryRunner.query(
        `SELECT TABLE_NAME FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
        [table],
      );
      return Array.isArray(rows) && rows.length > 0;
    };

    // The genuine OI capture: volume, OI and ΔOI must be able to say "unknown".
    if (await tableExists('upstox_live_paper_option_quotes')) {
      await queryRunner.query(`
        ALTER TABLE upstox_live_paper_option_quotes
          MODIFY COLUMN volume BIGINT NULL,
          MODIFY COLUMN openInterest BIGINT NULL,
          MODIFY COLUMN oiChange BIGINT NULL
      `);
    }

    // The same capture's underlying snapshot carries the spot for every OI row.
    if (await tableExists('upstox_live_paper_market_snapshots')) {
      await queryRunner.query(`
        ALTER TABLE upstox_live_paper_market_snapshots
          MODIFY COLUMN volume BIGINT NULL
      `);
    }

    // FNF: the live table is the SOURCE of the archive, so relaxing only the
    // history table would leave the fabrication in place.
    if (await tableExists('fnf_option_quotes')) {
      await queryRunner.query(`
        ALTER TABLE fnf_option_quotes
          MODIFY COLUMN volume DECIMAL(18,2) NULL,
          MODIFY COLUMN openInterest DECIMAL(18,2) NULL
      `);
    }
    if (await tableExists('fnf_option_quotes_history')) {
      await queryRunner.query(`
        ALTER TABLE fnf_option_quotes_history
          MODIFY COLUMN volume DECIMAL(18,2) NULL,
          MODIFY COLUMN openInterest DECIMAL(18,2) NULL
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reversing needs a value for every NULL. 0 is restored ONLY because the
    // column must be NOT NULL again — it is the old fabricated default, not a
    // recovered measurement.
    for (const table of ['upstox_live_paper_option_quotes', 'fnf_option_quotes', 'fnf_option_quotes_history']) {
      const column = table === 'upstox_live_paper_option_quotes' ? 'openInterest' : 'openInterest';
      await queryRunner.query(`UPDATE ${table} SET volume = 0 WHERE volume IS NULL`);
      await queryRunner.query(`UPDATE ${table} SET ${column} = 0 WHERE ${column} IS NULL`);
    }
    await queryRunner.query(`ALTER TABLE upstox_live_paper_option_quotes MODIFY COLUMN volume BIGINT NOT NULL DEFAULT 0, MODIFY COLUMN openInterest BIGINT NOT NULL DEFAULT 0, MODIFY COLUMN oiChange BIGINT NOT NULL DEFAULT 0`);
    await queryRunner.query(`ALTER TABLE fnf_option_quotes MODIFY COLUMN volume DECIMAL(18,2) NOT NULL DEFAULT 0, MODIFY COLUMN openInterest DECIMAL(18,2) NOT NULL DEFAULT 0`);
    await queryRunner.query(`ALTER TABLE fnf_option_quotes_history MODIFY COLUMN volume DECIMAL(18,2) NOT NULL DEFAULT 0, MODIFY COLUMN openInterest DECIMAL(18,2) NOT NULL DEFAULT 0`);
    await queryRunner.query(`UPDATE upstox_live_paper_market_snapshots SET volume = 0 WHERE volume IS NULL`);
    await queryRunner.query(`ALTER TABLE upstox_live_paper_market_snapshots MODIFY COLUMN volume BIGINT NOT NULL DEFAULT 0`);
  }
}
