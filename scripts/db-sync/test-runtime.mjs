#!/usr/bin/env node
/**
 * Direct DatabaseSyncService Runtime Test
 * Invokes the actual service to verify runtime metrics
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../dist/app.module.js';
import { DatabaseSyncService } from '../../dist/database-sync/database-sync.service.js';
import * as dotenv from 'dotenv';

// Load .env
dotenv.config();

async function testSync() {
  console.log('=== DatabaseSyncService Runtime Test ===\n');
  
  // Check config first
  const enabled = process.env.DB_SYNC_ENABLED?.toLowerCase() === 'true';
  console.log(`DB_SYNC_ENABLED: ${enabled}`);
  
  if (!enabled) {
    console.log('\nSync is disabled. Set DB_SYNC_ENABLED=true to test runtime sync.');
    console.log('After enabling, re-run: node scripts/db-sync/test-runtime.mjs');
    return;
  }
  
  console.log('\nBuilding NestJS context...');
  
  try {
    const app = await NestFactory.createApplicationContext(AppModule);
    
    const syncService = app.get(DatabaseSyncService);
    
    // Check if trading hours
    const configService = app.get(app.get('DatabaseSyncConfigService').constructor);
    const isTrading = configService.isTradingHours();
    console.log(`Trading hours check: ${isTrading}`);
    
    if (isTrading) {
      console.log('\nSync deferred during trading hours (09:15-15:30 IST)');
      await app.close();
      return;
    }
    
    console.log('\nRunning sync...');
    await syncService.runSync();
    
    console.log('\nSync completed. Checking audit records...');
    
    // Get audit records
    const audits = await syncService.getStatus();
    console.log(`\nLast 5 audit records:`);
    for (const a of audits.lastSyncs.slice(0, 5)) {
      console.log(`  [${a.tableName}] ${a.direction} - ${a.status}`);
      console.log(`    inserted=${a.rowsInserted}, updated=${a.rowsUpdated}, skipped=${a.rowsSkipped}, failed=${a.rowsFailed}`);
    }
    
    await app.close();
    
  } catch (e) {
    console.error(`Error: ${e.message}`);
    console.error(e.stack);
    process.exit(1);
  }
}

testSync();
