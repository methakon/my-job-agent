import { DataSource, createQueryBuilder } from 'typeorm';
import { readFileSync } from 'fs';
import * as dotenv from 'dotenv';

// Load .env
dotenv.config({ path: '.env' });

// Create data sources
const oracleDS = new DataSource({
  type: 'mysql',
  host: process.env.ORACLE_DB_HOST || '127.0.0.1',
  port: parseInt(process.env.ORACLE_DB_PORT || '3307', 10),
  username: process.env.ORACLE_DB_USER || 'mylife',
  password: process.env.ORACLE_DB_PASSWORD || process.env.MYSQL_PASSWORD || '',
  database: process.env.ORACLE_DB_NAME || process.env.DATABASE_NAME || 'myjob_agent',
  synchronize: false,
  logging: false,
});

const localDS = new DataSource({
  type: 'mysql',
  host: process.env.LOCAL_DB_HOST || '127.0.0.1',
  port: parseInt(process.env.LOCAL_DB_PORT || '3306', 10),
  username: process.env.LOCAL_DB_USER || 'mylife',
  password: process.env.LOCAL_DB_PASSWORD || process.env.MYSQL_PASSWORD || '',
  database: process.env.LOCAL_DB_NAME || process.env.DATABASE_NAME || 'myjob_agent',
  synchronize: false,
  logging: false,
});

async function main() {
  console.log('=== DATABASE SYNC TEST RUNNER (Direct TypeORM) ===\n');

  // Test connections
  console.log('Testing Oracle connection...');
  await oracleDS.initialize();
  console.log('✓ Oracle connected');

  console.log('Testing Local connection...');
  await localDS.initialize();
  console.log('✓ Local connected');

  // Define synchronizable tables (same as in service)
  const TABLE_OWNERSHIP: Record<string, string> = {
    fnf_trades: 'ORACLE_AUTHORITATIVE',
    fnf_decision_journal: 'ORACLE_AUTHORITATIVE',
    fnf_market_snapshots: 'ORACLE_AUTHORITATIVE',
    fnf_market_snapshots_history: 'ORACLE_AUTHORITATIVE',
    fnf_option_quotes: 'ORACLE_AUTHORITATIVE',
    fnf_option_quotes_history: 'ORACLE_AUTHORITATIVE',
    fnf_option_contracts: 'ORACLE_AUTHORITATIVE',
    fnf_decay_calibrations: 'ORACLE_AUTHORITATIVE',
    fnf_portfolios: 'ORACLE_AUTHORITATIVE',
    fnf_trade_reflections: 'ORACLE_AUTHORITATIVE',
    fnf_trade_reports: 'ORACLE_AUTHORITATIVE',
    fyers_tokens: 'ORACLE_AUTHORITATIVE',
    sandbox_ticks: 'ORACLE_AUTHORITATIVE',
    trade_book_imports: 'LOCAL_AUTHORITATIVE',
    trade_book_import_log: 'LOCAL_AUTHORITATIVE',
    applications: 'SHARED_APPEND_ONLY',
    job_leads: 'SHARED_APPEND_ONLY',
    candidate_profile: 'SHARED_APPEND_ONLY',
    cv_region_formats: 'SHARED_APPEND_ONLY',
    status_updates: 'SHARED_APPEND_ONLY',
    learning_weights: 'SHARED_APPEND_ONLY',
    muhurta_windows: 'SHARED_APPEND_ONLY',
    pre_apply_items: 'SHARED_APPEND_ONLY',
    portal_users: 'SHARED_APPEND_ONLY',
    question_answers: 'SHARED_APPEND_ONLY',
    project_checklist_items: 'SHARED_APPEND_ONLY',
    interview_questions: 'SHARED_APPEND_ONLY',
    side_income_opportunities: 'SHARED_APPEND_ONLY',
    mail_accounts: 'SHARED_APPEND_ONLY',
    apply_settings: 'SHARED_APPEND_ONLY',
    agent_todo_log: 'SHARED_APPEND_ONLY',
  };

  const SYNCHRONIZABLE_TABLES = Object.keys(TABLE_OWNERSHIP).filter(k => TABLE_OWNERSHIP[k] !== 'EXCLUDED');

  // Get row counts BEFORE sync
  console.log('\n=== ROW COUNTS BEFORE SYNC ===');
  
  const oracleCounts: Record<string, number> = {};
  const localCounts: Record<string, number> = {};

  for (const table of SYNCHRONIZABLE_TABLES) {
    const oracleCount = await oracleDS.getRepository(table).count();
    const localCount = await localDS.getRepository(table).count();
    oracleCounts[table] = oracleCount;
    localCounts[table] = localCount;
    console.log(`${table.padEnd(35)} Oracle: ${oracleCount.toString().padEnd(8)} Local: ${localCount}`);
  }

  // Configure sync settings
  const enabled = process.env.DB_SYNC_ENABLED?.toLowerCase() === 'true';
  const batchSize = parseInt(process.env.DB_SYNC_BATCH_SIZE || '1000', 10);
  
  console.log('\n=== SYNC CONFIG ===');
  console.log(`DB_SYNC_ENABLED: ${enabled ? 'TRUE' : 'FALSE'}`);
  console.log(`Batch Size: ${batchSize}`);
  console.log(`Outside Trading Only: ${process.env.DB_SYNC_OUTSIDE_TRADING_ONLY !== 'false'}`);

  // If sync enabled, perform sync
  if (!enabled) {
    console.log('\n=== SYNC DISABLED - SKIPPING ===');
    console.log('Set DB_SYNC_ENABLED=true to perform actual sync');
  } else {
    console.log('\n=== PERFORMING SYNC (ORACLE -> LOCAL) ===');
    const startTime = Date.now();
    let totalInserted = 0;
    let totalUpdated = 0;
    let totalSkipped = 0;
    let totalFailed = 0;

    for (const table of SYNCHRONIZABLE_TABLES) {
      const ownership = TABLE_OWNERSHIP[table];
      
      if (ownership === 'ORACLE_AUTHORITATIVE' || ownership === 'SHARED_APPEND_ONLY') {
        console.log(`\nSyncing ${table} (${ownership})...`);
        
        const sourceRepo = oracleDS.getRepository(table);
        const destRepo = localDS.getRepository(table);
        
        // Get metadata to find ID column
        const metadata = sourceRepo.metadata;
        const idCol = metadata.primaryColumns[0];
        const idField = idCol.propertyName;
        const idType = idCol.type;
        
        let checkpointLastId: string | number | null = null;
        
        // Get checkpoint from database_sync_audit if available
        const auditRepo = localDS.getRepository('database_sync_audit');
        const lastAudit = await auditRepo.findOne({
          where: { tableName: table, status: 'COMPLETED' },
          order: { completedAt: 'DESC' }
        });
        
        if (lastAudit?.checkpointAfter) {
          try {
            const checkpoint = JSON.parse(lastAudit.checkpointAfter);
            checkpointLastId = checkpoint.lastId || null;
          } catch (e) {}
        }

        // Fetch records
        let records;
        if (checkpointLastId) {
          if (idType === 'uuid' || idType === 'varchar' || idType === 'string') {
            records = await sourceRepo.createQueryBuilder()
              .where(`${idField} > :lastId`, { lastId: checkpointLastId })
              .take(batchSize)
              .getMany();
          } else {
            records = await sourceRepo.createQueryBuilder()
              .where(`${idField} > :lastId`, { lastId: checkpointLastId })
              .take(batchSize)
              .getMany();
          }
        } else {
          records = await sourceRepo.find({ take: batchSize });
        }

        console.log(`  Records to sync: ${records.length}`);

        for (const record of records) {
          const idVal = record[idField];
          try {
            const existing = await destRepo.findOne({ where: { [idField]: idVal } });

            if (existing) {
              // If shared append only, skip
              if (ownership === 'SHARED_APPEND_ONLY') {
                totalSkipped++;
                continue;
              }
              // If oracle authoritative, skip existing
              if (ownership === 'ORACLE_AUTHORITATIVE') {
                totalSkipped++;
                continue;
              }
              // Otherwise update
              Object.assign(existing, record);
              await destRepo.save(existing);
              totalUpdated++;
            } else {
              await destRepo.save(record);
              totalInserted++;
            }

            // Update checkpoint
            checkpointLastId = idVal;
          } catch (e: any) {
            totalFailed++;
            console.log(`    FAILED: ${table}/${idVal} - ${e.message}`);
          }
        }

        // Save audit record
        const audit = auditRepo.create({
          direction: 'ORACLE_TO_LOCAL',
          tableName: table,
          startedAt: new Date(),
          status: 'COMPLETED',
          completedAt: new Date(),
          rowsRead: records.length,
          rowsInserted: totalInserted,
          rowsUpdated: totalUpdated,
          rowsSkipped: totalSkipped,
          rowsFailed: totalFailed,
          checkpointAfter: JSON.stringify({ tableName: table, lastId: checkpointLastId, lastBatchSize: records.length }),
        });
        await auditRepo.save(audit);

        console.log(`  Inserted: ${totalInserted}, Updated: ${totalUpdated}, Skipped: ${totalSkipped}, Failed: ${totalFailed}`);
      }
    }

    const duration = Date.now() - startTime;
    console.log(`\n=== SYNC COMPLETE (${duration}ms) ===`);
    console.log(`Total: ${totalInserted + totalUpdated + totalSkipped + totalFailed} records processed`);
    console.log(`  Inserted: ${totalInserted}, Updated: ${totalUpdated}, Skipped: ${totalSkipped}, Failed: ${totalFailed}`);
  }

  // Get row counts AFTER sync
  console.log('\n=== ROW COUNTS AFTER SYNC ===');
  
  for (const table of SYNCHRONIZABLE_TABLES) {
    const oracleCount = await oracleDS.getRepository(table).count();
    const localCount = await localDS.getRepository(table).count();
    console.log(`${table.padEnd(35)} Oracle: ${oracleCount.toString().padEnd(8)} Local: ${localCount}`);
  }

  // Verify TradeBook separation
  console.log('\n=== TRADEBOOK SEPARATION CHECK ===');
  const fnfTrades = await oracleDS.getRepository('fnf_trades').find();
  const tradeBookImports = await localDS.getRepository('trade_book_imports').find();
  
  console.log(`Oracle fnf_trades: ${fnfTrades.length} records`);
  console.log(`Local trade_book_imports: ${tradeBookImports.length} records`);
  
  if (tradeBookImports.length > 0) {
    // Check first record that it's NOT in Oracle
    const firstTb = tradeBookImports[0];
    const inOracle = await oracleDS.getRepository('trade_book_imports').findOne({ where: { id: firstTb.id } });
    console.log(`Sample trade_book_import id=${firstTb.id} exists in Oracle: ${inOracle ? 'ERROR' : 'OK'}`);
  }

  // Check database_sync_audit records
  console.log('\n=== DATABASE_SYNC_AUDIT RECORDS ===');
  const auditRepo = localDS.getRepository('database_sync_audit');
  const audits = await auditRepo.find({ order: { createdAt: 'DESC' }, take: 10 });
  console.log(`Total audit records: ${audits.length}`);
  audits.forEach(a => {
    console.log(`  [${a.tableName.padEnd(30)}] ${a.direction.padEnd(20)} inserted=${a.rowsInserted} skipped=${a.rowsSkipped} failed=${a.rowsFailed}`);
  });

  // Close connections
  await oracleDS.destroy();
  await localDS.destroy();

  console.log('\n=== TEST COMPLETE ===');
  process.exit(0);
}

main().catch(async (e) => {
  console.error('ERROR:', e);
  await oracleDS?.destroy();
  await localDS?.destroy();
  process.exit(1);
});
