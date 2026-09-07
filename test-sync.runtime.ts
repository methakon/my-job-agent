import { NestFactory } from '@nestjs/core';
import { DatabaseModule } from './database-sync/database.module';
import { DatabaseSyncService } from './database-sync/database-sync.service';
import { DatabaseSyncConfigService } from './database-sync/database-sync.config.service';
import { DataSource } from 'typeorm';

async function main() {
  const app = await NestFactory.create(DatabaseModule);
  const syncService = app.get<DatabaseSyncService>(DatabaseSyncService);
  const configService = app.get<DatabaseSyncConfigService>(DatabaseSyncConfigService);

  console.log('=== DATABASE SYNC TEST RUNNER ===');
  console.log('Config:', JSON.stringify(configService.getConfig(), null, 2));
  
  // Check trading hours
  console.log('Current time (IST):', new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }));
  console.log('Is trading hours:', configService.isTradingHours());
  console.log('Sync allowed:', configService.isSyncAllowed());

  // Get initial audit records
  const initialAudit = await syncService.getStatus();
  console.log('\n=== INITIAL STATUS ===');
  console.log('Synchronizable tables:', initialAudit.synchronizableTables.length);
  console.log('Last 5 syncs:', initialAudit.lastSyncs.length);
  initialAudit.lastSyncs.forEach(s => console.log(`  [${s.tableName}] ${s.direction} - ${s.status} ( inserted=${s.rowsInserted}, skipped=${s.rowsSkipped}, failed=${s.rowsFailed} )`));

  // Get row counts before sync
  const oracleDS = await syncService['getOracleDS']();
  const localDS = await syncService['getLocalDS']();

  console.log('\n=== ORACLE ROW COUNTS (BEFORE) ===');
  const oracleTables = initialAudit.synchronizableTables;
  for (const table of oracleTables) {
    const count = await oracleDS.getRepository(table).count();
    console.log(`  ${table}: ${count}`);
  }

  console.log('\n=== LOCAL ROW COUNTS (BEFORE) ===');
  for (const table of oracleTables) {
    const count = await localDS.getRepository(table).count();
    console.log(`  ${table}: ${count}`);
  }

  // Run sync
  console.log('\n=== RUNNING SYNC ===');
  const startTime = Date.now();
  try {
    await syncService.runSync();
    const duration = Date.now() - startTime;
    console.log(`Sync completed in ${duration}ms`);
  } catch (e: any) {
    console.log(`Sync failed: ${e.message}`);
    console.log(e.stack);
  }

  // Get final audit records
  const finalAudit = await syncService.getStatus();
  console.log('\n=== FINAL STATUS ===');
  console.log('Last 5 syncs:', finalAudit.lastSyncs.length);
  finalAudit.lastSyncs.forEach(s => console.log(`  [${s.tableName}] ${s.direction} - ${s.status} (${s.createdAt})`));
  finalAudit.lastSyncs.slice(0, 15).forEach(s => {
    console.log(`    rowsRead=${s.rowsRead}, inserted=${s.rowsInserted}, updated=${s.rowsUpdated}, skipped=${s.rowsSkipped}, failed=${s.rowsFailed}`);
  });

  // Get row counts after sync
  console.log('\n=== ORACLE ROW COUNTS (AFTER) ===');
  for (const table of oracleTables) {
    const count = await oracleDS.getRepository(table).count();
    console.log(`  ${table}: ${count}`);
  }

  console.log('\n=== LOCAL ROW COUNTS (AFTER) ===');
  for (const table of oracleTables) {
    const count = await localDS.getRepository(table).count();
    console.log(`  ${table}: ${count}`);
  }

  // Verify TradeBook separation
  const fnfTrades = await oracleDS.getRepository('fnf_trades').find();
  const tradeBookImports = await localDS.getRepository('trade_book_imports').find();
  
  console.log('\n=== TRADEBOOK SEPARATION CHECK ===');
  console.log(`Oracle fnf_trades count: ${fnfTrades.length}`);
  console.log(`Local trade_book_imports count: ${tradeBookImports.length}`);

  // Check for any local records that might have been synced to Oracle
  if (tradeBookImports.length > 0) {
    console.log('Local trade_book_imports records (should NOT be in Oracle):');
    for (const tb of tradeBookImports) {
      const inOracle = await oracleDS.getRepository('trade_book_imports').findOne({ where: { id: tb.id } });
      console.log(`  id=${tb.id}, inOracle=${inOracle ? 'ERROR - DUPLICATE' : 'OK'}`);
    }
  }

  await app.close();
  process.exit(0);
}

main().catch(async (e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
