#!/usr/bin/env npx ts-node
/**
 * Historical migration: unified live → history tables.
 *
 * Features:
 *   - Resumable: checkpoint file tracks last processed ID per table
 *   - Idempotent: INSERT IGNORE handles crash recovery
 *   - Batched: 5000 rows per transaction
 *   - Source-preserving: DELETE only after INSERT+VERIFY
 *   - Auditable: logs every chunk result
 *
 * Usage:
 *   npx ts-node scripts/migrate-unified-history.ts          # dry-run (default)
 *   npx ts-node scripts/migrate-unified-history.ts --exec   # execute migration
 *   npx ts-node scripts/migrate-unified-history.ts --reconcile  # verify only
 */
import { DataSource } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';

// ─── Configuration ───────────────────────────────────────────────────
const BATCH_SIZE = 5000;
const CHECKPOINT_FILE = path.join(__dirname, '..', '.migration-checkpoint.json');

const TABLES = [
  {
    live: 'unified_market_snapshots',
    history: 'unified_market_snapshots_history',
    insertCols: 'id, symbol, underlying, exchange, ltp, volume, bid, ask, bidQty, askQty, open, high, low, close, depth, source, sourceTimestamp, receivedTimestamp, sequenceNumber, dataQuality, ts, createdAt, archivedAt',
    selectCols: 'id, symbol, underlying, exchange, ltp, volume, bid, ask, bidQty, askQty, open, high, low, close, depth, source, sourceTimestamp, receivedTimestamp, sequenceNumber, dataQuality, ts, createdAt, NOW() as archivedAt',
  },
  {
    live: 'unified_option_quotes',
    history: 'unified_option_quotes_history',
    insertCols: 'id, instrumentKey, underlying, exchange, segment, instrumentType, expiry, strike, optionType, ltp, bid, ask, bidQty, askQty, volume, oi, previousOi, changeOi, iv, delta, gamma, theta, vega, depth, source, sourceTimestamp, receivedTimestamp, sequenceNumber, dataQuality, ts, createdAt, archivedAt',
    selectCols: 'id, instrumentKey, underlying, exchange, segment, instrumentType, expiry, strike, optionType, ltp, bid, ask, bidQty, askQty, volume, oi, previousOi, changeOi, iv, delta, gamma, theta, vega, depth, source, sourceTimestamp, receivedTimestamp, sequenceNumber, dataQuality, ts, createdAt, NOW() as archivedAt',
  },
] as const;

// ─── Checkpoint ──────────────────────────────────────────────────────
interface Checkpoint {
  [tableName: string]: { lastId: string; migrated: number; verified: number; deleted: number };
}

function loadCheckpoint(): Checkpoint {
  if (fs.existsSync(CHECKPOINT_FILE)) {
    return JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf-8'));
  }
  return {};
}

function saveCheckpoint(cp: Checkpoint): void {
  fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(cp, null, 2));
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const execMode = args.includes('--exec');
  const reconcileMode = args.includes('--reconcile');
  const dryRun = !execMode && !reconcileMode;

  const ds = new DataSource({
    type: 'mysql',
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: Number(process.env.MYSQL_PORT) || 3307,
    username: process.env.MYSQL_USER || 'mylife',
    password: process.env.MYSQL_PASSWORD,
    database: process.env.DB_NAME || 'myjob_agent',
    connectTimeout: 30_000,
    acquireTimeout: 30_000,
    extra: { enableKeepAlive: true, keepAliveInitialDelay: 10_000 },
  });

  await ds.initialize();
  console.log(`[migration] connected to ${process.env.MYSQL_HOST || '127.0.0.1'}:${process.env.MYSQL_PORT || 3307}`);

  const cp = loadCheckpoint();

  if (reconcileMode) {
    console.log('\n=== RECONCILIATION MODE ===\n');
    for (const t of TABLES) {
      const [liveCount] = await ds.query(`SELECT COUNT(*) as n FROM \`${t.live}\``);
      const [histCount] = await ds.query(`SELECT COUNT(*) as n FROM \`${t.history}\``);
      const liveN = Number(liveCount.n);
      const histN = Number(histCount.n);
      const match = liveN === 0 && histN > 0;
      console.log(`${t.live}: live=${liveN} history=${histN} ${match ? '✅ FULLY MIGRATED' : '❌ NEEDS MIGRATION'}`);
    }
    await ds.destroy();
    return;
  }

  console.log(`\n=== ${dryRun ? 'DRY RUN' : 'EXECUTE'} MODE ===`);
  console.log(`batch_size=${BATCH_SIZE}\n`);

  for (const t of TABLES) {
    console.log(`--- ${t.live} → ${t.history} ---`);

    const [liveCount] = await ds.query(`SELECT COUNT(*) as n FROM \`${t.live}\``);
    const total = Number(liveCount.n);
    const already = cp[t.live]?.migrated || 0;
    console.log(`  live_rows=${total} already_migrated=${already}`);

    if (total === 0) {
      console.log(`  SKIPPED: no live rows\n`);
      continue;
    }

    let lastId = cp[t.live]?.lastId || '';
    let chunkNum = 0;
    let totalMigrated = already;
    let totalVerified = cp[t.live]?.verified || 0;
    let totalDeleted = cp[t.live]?.deleted || 0;

    while (true) {
      const whereClause = lastId ? `WHERE id > ?` : '';
      const params = lastId ? [lastId, BATCH_SIZE] : [BATCH_SIZE];
      const candidates: Array<{ id: string }> = await ds.query(
        `SELECT id FROM \`${t.live}\` ${whereClause} ORDER BY id ASC LIMIT ?`,
        params,
      );

      if (candidates.length === 0) break;

      chunkNum++;
      const ids = candidates.map((r) => r.id);
      const placeholders = ids.map(() => '?').join(',');
      const batchStart = candidates[0].id;
      const batchEnd = candidates[candidates.length - 1].id;

      if (dryRun) {
        console.log(`  chunk ${chunkNum}: [${batchStart}..${batchEnd}] ${ids.length} rows (dry-run)`);
        lastId = batchEnd;
        continue;
      }

      // Execute: INSERT IGNORE → VERIFY → DELETE in transaction
      const qr = ds.createQueryRunner();
      await qr.connect();
      try {
        await qr.startTransaction();

        await qr.query(
          `INSERT IGNORE INTO \`${t.history}\` (${t.insertCols})
           SELECT ${t.selectCols} FROM \`${t.live}\` WHERE id IN (${placeholders})`,
          ids,
        );

        const [verifyRow] = await qr.query(
          `SELECT COUNT(*) as n FROM \`${t.history}\` WHERE id IN (${placeholders})`,
          ids,
        );
        const verified = Number(verifyRow.n);

        if (verified !== ids.length) {
          await qr.rollbackTransaction();
          console.log(`  chunk ${chunkNum}: VERIFICATION FAILED (${verified}/${ids.length}) — ROLLED BACK`);
          break;
        }

        const delResult: any = await qr.query(
          `DELETE FROM \`${t.live}\` WHERE id IN (${placeholders})`,
          ids,
        );
        const deleted = Number(delResult.affectedRows ?? 0);

        await qr.commitTransaction();

        totalMigrated += ids.length;
        totalVerified += verified;
        totalDeleted += deleted;
        lastId = batchEnd;

        cp[t.live] = { lastId, migrated: totalMigrated, verified: totalVerified, deleted: totalDeleted };
        saveCheckpoint(cp);

        console.log(`  chunk ${chunkNum}: [${batchStart}..${batchEnd}] ${ids.length} rows migrated (${totalMigrated}/${total})`);
      } catch (err) {
        await qr.rollbackTransaction();
        console.log(`  chunk ${chunkNum}: ERROR — ${(err as Error).message}`);
        break;
      } finally {
        await qr.release();
      }
    }

    console.log(`  COMPLETE: ${totalMigrated} migrated, ${totalVerified} verified, ${totalDeleted} deleted\n`);
  }

  console.log('=== RECONCILIATION ===\n');
  for (const t of TABLES) {
    const [liveCount] = await ds.query(`SELECT COUNT(*) as n FROM \`${t.live}\``);
    const [histCount] = await ds.query(`SELECT COUNT(*) as n FROM \`${t.history}\``);
    console.log(`${t.live}: live=${Number(liveCount.n)} history=${Number(histCount.n)}`);
  }

  await ds.destroy();
  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
