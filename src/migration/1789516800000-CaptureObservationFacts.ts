import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Capture-integrity FACTS for the Upstox OI capture.
 *
 * WHY: the OI history a research evaluation depends on is not self-describing.
 * Three facts that decide whether a row may be used at all are missing:
 *
 *   1. WHEN THE MARKET SAID IT. `ts` is CAPTURE time (the host clock at parse
 *      time — `nowUtc()` in the poller). The poller runs 24x7 with no session
 *      gate, and after the bell the provider keeps serving its frozen close
 *      value, so a post-close row carries a FRESH `ts` over STALE market data.
 *      Measured 2026-09-14 on `upstox_live_paper_option_quotes`: 53.8% (NIFTY) to
 *      71.6% (SENSEX) of a weekday's rows fall outside 09:15-15:30 IST, and
 *      100% of the Saturday capture does. Without a provider timestamp there is
 *      no persisted fact that separates a genuine print from a repeat.
 *
 *   2. WHAT `oiChange` IS MEASURED AGAINST. `oiChange` is `openInterest - prevOi`
 *      where `prevOi` is the PROVIDER's own reference. Measured on one contract
 *      over 27h (5,179 rows): `openInterest - oiChange` took exactly TWO distinct
 *      values (the reference moved once) while `openInterest` took 92 — so it is
 *      a PROVIDER-REFERENCE change, NOT a snapshot-to-snapshot delta (a per-tick
 *      delta would have made those two counts equal). `prevOi` was never stored,
 *      so that conclusion could only be reached by inference and is not
 *      verifiable per row. Persisting it makes the semantics checkable.
 *
 *   3. WHETHER A ROW IS A REPEAT. A byte-identical payload re-served by the
 *      provider is currently indistinguishable from a genuine new observation.
 *      `payloadHash` makes an exact repeat detectable instead of guessed at.
 *
 * WHAT THIS MIGRATION DOES: adds three NULLable columns and nothing else.
 *   * `providerTs`  DATETIME NULL — provider's own quote time, when it publishes
 *                    one. NEVER a copy of `ts` (that would relabel capture time
 *                    as market time, which is the defect being fixed).
 *   * `prevOi`      BIGINT   NULL — the provider's previous-OI reference.
 *   * `payloadHash` VARCHAR(64) NULL — sha256 of the raw provider leg.
 *
 * A NULL in any of them means "not published/not derivable" and stays NULL.
 * No row is rewritten, no default is added, no column is tightened, no index
 * changes, and no trading-decision path reads any of them. History stays exactly
 * as recorded: a post-close row cannot be retroactively labelled genuine, so it
 * is left for the read-time classifier to mark by rule (research/capture-integrity.ts).
 */
export class CaptureObservationFacts1789516800000 implements MigrationInterface {
  name = 'CaptureObservationFacts1789516800000';

  private async tableExists(queryRunner: QueryRunner, table: string): Promise<boolean> {
    const rows = await queryRunner.query(
      `SELECT TABLE_NAME FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [table],
    );
    return Array.isArray(rows) && rows.length > 0;
  }

  private async columnExists(queryRunner: QueryRunner, table: string, column: string): Promise<boolean> {
    const rows = await queryRunner.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, column],
    );
    return Array.isArray(rows) && rows.length > 0;
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    const table = 'upstox_live_paper_option_quotes';
    if (!(await this.tableExists(queryRunner, table))) return;

    if (!(await this.columnExists(queryRunner, table, 'providerTs'))) {
      await queryRunner.query(`ALTER TABLE ${table} ADD COLUMN providerTs DATETIME NULL`);
    }
    if (!(await this.columnExists(queryRunner, table, 'prevOi'))) {
      await queryRunner.query(`ALTER TABLE ${table} ADD COLUMN prevOi BIGINT NULL`);
    }
    if (!(await this.columnExists(queryRunner, table, 'payloadHash'))) {
      await queryRunner.query(`ALTER TABLE ${table} ADD COLUMN payloadHash VARCHAR(64) NULL`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const table = 'upstox_live_paper_option_quotes';
    if (!(await this.tableExists(queryRunner, table))) return;
    for (const column of ['providerTs', 'prevOi', 'payloadHash']) {
      if (await this.columnExists(queryRunner, table, column)) {
        await queryRunner.query(`ALTER TABLE ${table} DROP COLUMN ${column}`);
      }
    }
  }
}
