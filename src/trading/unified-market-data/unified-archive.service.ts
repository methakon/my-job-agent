import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { UnifiedOptionQuote } from './unified-option-quote.entity';
import { UnifiedMarketSnapshot } from './unified-market-snapshot.entity';
import { UnifiedOptionQuoteHistory } from './unified-option-quote-history.entity';
import { UnifiedMarketSnapshotHistory } from './unified-market-snapshot-history.entity';

/** Result of one archive chunk operation. */
export interface ArchiveChunkResult {
  selected: number;
  inserted: number;
  verified: number;
  deleted: number;
  /** Present only when a safety check failed and the chunk was rolled back. */
  error?: string;
}

/** Cumulative result of an archive run. */
export interface ArchiveRunResult {
  boundary: string;
  quotes: ArchiveChunkResult;
  snapshots: ArchiveChunkResult;
  durationMs: number;
  success: boolean;
  error?: string;
}

/**
 * Safe archival of unified market-data ticks from live tables to history tables.
 *
 * Design guarantees:
 *  - NO DATA LOSS: rows are inserted into history before being deleted from live.
 *  - NO DUPLICATES: INSERT IGNORE + deterministic UUID PK; a previously archived
 *    row is silently skipped on retry.
 *  - NO PARTIAL ARCHIVE: each chunk runs in a transaction; if INSERT, verify,
 *    or DELETE fails, the chunk is rolled back entirely.
 *  - SAFE RETRY: idempotent by construction — re-running after a crash is safe.
 *  - SAFE CRASH RECOVERY: if the process dies after INSERT but before DELETE,
 *    the next run sees the rows in both tables; INSERT IGNORE skips the history
 *    copy, verification passes, and DELETE removes the live rows.
 *  - LIVE INGESTION CONTINUES: chunks are small (default 5000 rows) with fast
 *    transactions (~150 ms), so the write-behind pipeline is never blocked.
 *
 * Concurrency: a simple in-flight flag prevents overlapping runs.
 */
@Injectable()
export class UnifiedArchiveService {
  private readonly logger = new Logger(UnifiedArchiveService.name);
  private archiving = false;

  /** Default rows per transactional chunk. Tunable via env. */
  private readonly chunkSize: number;

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(UnifiedOptionQuote)
    private readonly quotes: Repository<UnifiedOptionQuote>,
    @InjectRepository(UnifiedMarketSnapshot)
    private readonly snapshots: Repository<UnifiedMarketSnapshot>,
    @InjectRepository(UnifiedOptionQuoteHistory)
    private readonly quoteHistory: Repository<UnifiedOptionQuoteHistory>,
    @InjectRepository(UnifiedMarketSnapshotHistory)
    private readonly snapshotHistory: Repository<UnifiedMarketSnapshotHistory>,
  ) {
    const raw = Number(process.env.UNIFIED_ARCHIVE_CHUNK_SIZE);
    this.chunkSize = Number.isFinite(raw) && raw >= 100 ? Math.floor(raw) : 5000;
  }

  /**
   * Archive all ticks received before `boundaryIst` from live → history.
   *
   * @param boundaryIst  IST-naive 'YYYY-MM-DD HH:MM:SS' string. Rows with
   *                     receivedTimestamp < boundary are eligible.
   * @returns            Aggregate metrics; success=true means every chunk
   *                     committed cleanly.
   */
  async archiveTicksBefore(boundaryIst: string): Promise<ArchiveRunResult> {
    const t0 = Date.now();
    const result: ArchiveRunResult = {
      boundary: boundaryIst,
      quotes: { selected: 0, inserted: 0, verified: 0, deleted: 0 },
      snapshots: { selected: 0, inserted: 0, verified: 0, deleted: 0 },
      durationMs: 0,
      success: false,
    };

    if (this.archiving) {
      result.error = 'concurrent_archive_skipped';
      result.durationMs = Date.now() - t0;
      this.logger.warn('unified archive: skipped — previous run still in progress');
      return result;
    }

    this.archiving = true;
    try {
      // Archive snapshots first (smaller table), then quotes.
      result.snapshots = await this.archiveTable(
        'unified_market_snapshots',
        'unified_market_snapshots_history',
        boundaryIst,
      );
      result.quotes = await this.archiveTable(
        'unified_option_quotes',
        'unified_option_quotes_history',
        boundaryIst,
      );
      result.success = !result.quotes.error && !result.snapshots.error;
    } catch (error) {
      result.error = (error as Error).message;
      this.logger.error(`unified archive failed: ${result.error}`);
    } finally {
      this.archiving = false;
      result.durationMs = Date.now() - t0;
    }

    if (result.success && (result.quotes.deleted || result.snapshots.deleted)) {
      this.logger.log(
        `unified archive @ ${boundaryIst}: ${result.snapshots.deleted} snapshot(s), ` +
          `${result.quotes.deleted} quote(s) → history (${result.durationMs}ms)`,
      );
    }
    return result;
  }

  /**
   * Chunked transactional archive for one table pair.
   *
   * Algorithm per chunk:
   *   1. SELECT candidate IDs from live WHERE receivedTimestamp < boundary LIMIT chunkSize
   *   2. BEGIN TRANSACTION
   *   3. INSERT IGNORE INTO history SELECT ... FROM live WHERE id IN (candidates)
   *      — INSERT IGNORE is idempotent: if a row was already archived (crash
   *        recovery), it is silently skipped.
   *   4. Verify all candidate IDs exist in history
   *   5. DELETE FROM live WHERE id IN (candidates)
   *   6. COMMIT
   *   7. If any step fails → ROLLBACK, report error, stop chunking this table.
   */
  private async archiveTable(
    liveTable: string,
    historyTable: string,
    boundaryIst: string,
  ): Promise<ArchiveChunkResult> {
    const cumulative: ArchiveChunkResult = { selected: 0, inserted: 0, verified: 0, deleted: 0 };
    let hasMore = true;

    while (hasMore) {
      const chunk = await this.archiveChunk(liveTable, historyTable, boundaryIst, this.chunkSize);
      cumulative.selected += chunk.selected;
      cumulative.inserted += chunk.inserted;
      cumulative.verified += chunk.verified;
      cumulative.deleted += chunk.deleted;

      if (chunk.error) {
        cumulative.error = chunk.error;
        this.logger.error(`${liveTable} archive chunk failed: ${chunk.error} (${chunk.selected} selected, ${chunk.inserted} inserted, ${chunk.verified} verified, ${chunk.deleted} deleted)`);
        break;
      }

      hasMore = chunk.selected >= this.chunkSize;
    }

    return cumulative;
  }

  private async archiveChunk(
    liveTable: string,
    historyTable: string,
    boundaryIst: string,
    chunkSize: number,
  ): Promise<ArchiveChunkResult> {
    const result: ArchiveChunkResult = { selected: 0, inserted: 0, verified: 0, deleted: 0 };

    // Step 1: Identify candidates via the DataSource (not inside a transaction).
    const candidates = (await this.dataSource.query(
      `SELECT id FROM \`${liveTable}\` WHERE receivedTimestamp < ? ORDER BY receivedTimestamp ASC LIMIT ?`,
      [boundaryIst, chunkSize],
    )) as Array<{ id: string }>;

    result.selected = candidates.length;
    if (!candidates.length) return result;

    const ids = candidates.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(',');

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      await queryRunner.startTransaction();

      // Step 2: INSERT IGNORE into history (idempotent — PK duplicates are skipped).
      const insertCols =
        'id, instrumentKey, underlying, exchange, segment, instrumentType, expiry, strike, optionType, ' +
        'ltp, bid, ask, bidQty, askQty, volume, oi, previousOi, changeOi, iv, delta, gamma, theta, vega, ' +
        'depth, source, sourceTimestamp, receivedTimestamp, sequenceNumber, dataQuality, ts, createdAt, archivedAt';

      // NOW() as archivedAt is the same for both tables.
      const selectCols = insertCols.replace('archivedAt', 'NOW() as archivedAt');

      const insertResult = (await queryRunner.query(
        `INSERT IGNORE INTO \`${historyTable}\` (${insertCols})
         SELECT ${selectCols} FROM \`${liveTable}\` WHERE id IN (${placeholders})`,
        ids,
      )) as { affectedRows?: number };

      result.inserted = insertResult?.affectedRows ?? 0;

      // Step 3: Verify all candidate IDs exist in history.
      const verifyResult = (await queryRunner.query(
        `SELECT COUNT(*) as n FROM \`${historyTable}\` WHERE id IN (${placeholders})`,
        ids,
      )) as Array<{ n: string | number }>;

      result.verified = Number(verifyResult[0]?.n ?? 0);

      if (result.verified !== ids.length) {
        await queryRunner.rollbackTransaction();
        result.error = `verification_mismatch: expected ${ids.length}, got ${result.verified}`;
        return result;
      }

      // Step 4: DELETE from live.
      const deleteResult = (await queryRunner.query(
        `DELETE FROM \`${liveTable}\` WHERE id IN (${placeholders})`,
        ids,
      )) as { affectedRows?: number };

      result.deleted = deleteResult?.affectedRows ?? 0;

      // Step 5: Commit.
      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      result.error = (error as Error).message;
    } finally {
      await queryRunner.release();
    }

    return result;
  }
}
