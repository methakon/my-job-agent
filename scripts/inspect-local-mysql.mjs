#!/usr/bin/env node
/**
 * Inspect local MySQL (port 3306) schema for database sync verification.
 * This script compares local schema against expected Oracle schema.
 */

import mysql from 'mysql2/promise';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const localConfig = {
  host: '127.0.0.1',
  port: 3306,
  user: 'mylife',
  password: process.env.LOCAL_DB_PASSWORD || 'rDJNh2...Aa1!',
  database: process.env.LOCAL_DB_NAME || 'myjob_agent',
};

const oracleConfig = {
  host: '127.0.0.1',
  port: 3307,
  user: 'mylife',
  password: process.env.MYSQL_PASSWORD || 'rDJNh2...Aa1!',
  database: process.env.DATABASE_NAME || 'myjob_agent',
};

async function dbConnection(config, name) {
  try {
    const connection = await mysql.createConnection(config);
    console.log(`Connected to ${name} (${config.host}:${config.port})`);
    return connection;
  } catch (err) {
    console.error(`Failed to connect to ${name}:`, err.message);
    process.exit(1);
  }
}

async function getTables(connection) {
  const [rows] = await connection.query('SHOW TABLES');
  return rows.map(r => Object.values(r)[0]);
}

async function getTableStructure(connection, tableName) {
  const [columns] = await connection.query(`DESCRIBE ${tableName}`);
  return columns.map(col => ({
    Field: col.Field,
    Type: col.Type,
    Null: col.Null,
    Key: col.Key,
    Default: col.Default,
    Extra: col.Extra,
  }));
}

async function getTableCount(connection, tableName) {
  const [rows] = await connection.query(`SELECT COUNT(*) as count FROM ${tableName}`);
  return rows[0].count;
}

async function getMigrationHistory(connection) {
  const [rows] = await connection.query('SELECT * FROM typeorm_migrations ORDER BY timestamp');
  return rows;
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('        LOCAL MYSQL INSPECTION (FOR DATABASE SYNC VERIFICATION)');
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');

  // Connect to local MySQL (port 3306)
  const localDb = await dbConnection(localConfig, 'Local MySQL');
  const oracleDb = await dbConnection(oracleConfig, 'Oracle MySQL (port 3307)');

  try {
    // Get tables from both databases
    const localTables = await getTables(localDb);
    const oracleTables = await getTables(oracleDb);

    console.log('LOCAL MYSQL TABLES:', localTables.length);
    console.log(localTables.map(t => `  - ${t}`).join('\n'));
    console.log('\nORACLE MYSQL TABLES:', oracleTables.length);
    console.log(oracleTables.map(t => `  - ${t}`).join('\n'));

    // Show common tables and their row counts
    const commonTables = localTables.filter(t => oracleTables.includes(t));
    console.log('\n─── COMMON TABLES (row counts) ───');
    for (const table of commonTables) {
      if (table === 'typeorm_migrations' || table === 'database_sync_audit') continue;
      const localCount = await getTableCount(localDb, table);
      const oracleCount = await getTableCount(oracleDb, table);
      const match = localCount === oracleCount ? '✓' : '✗';
      console.log(`  ${match} ${table}: local=${localCount}, oracle=${oracleCount}`);
    }

    // Show tables only in local (not in Oracle)
    const localOnly = localTables.filter(t => !oracleTables.includes(t));
    if (localOnly.length > 0) {
      console.log('\n─── TABLES ONLY IN LOCAL (EXTRA) ───');
      localOnly.forEach(t => console.log(`  - ${t}`));
    }

    // Show tables only in Oracle (need to be created locally)
    const oracleOnly = oracleTables.filter(t => !localTables.includes(t));
    if (oracleOnly.length > 0) {
      console.log('\n─── TABLES ONLY IN ORACLE (MISSING IN LOCAL) ───');
      oracleOnly.forEach(t => console.log(`  - ${t}`));
    }

    // Get migration history
    const localMigrations = await getMigrationHistory(localDb);
    const oracleMigrations = await getMigrationHistory(oracleDb);

    console.log('\n─── MIGRATION HISTORY ───');
    console.log('Local migrations:', localMigrations.length);
    localMigrations.forEach(m => console.log(`  - ${m.migration} (${m.timestamp})`));
    console.log('\nOracle migrations:', oracleMigrations.length);
    oracleMigrations.forEach(m => console.log(`  - ${m.migration} (${m.timestamp})`));

    // Show missing migrations (in Oracle but not in Local)
    const localMigrationNames = localMigrations.map(m => m.migration);
    const missingMigrations = oracleMigrations.filter(m => !localMigrationNames.includes(m.migration));
    if (missingMigrations.length > 0) {
      console.log('\n─── MISSING MIGRATIONS IN LOCAL (RUN: npx typeorm migration:run) ───');
      missingMigrations.forEach(m => console.log(`  - ${m.migration} (${m.timestamp})`));
    }

    // Schema comparison for key tables
    const keyTables = [
      'fnf_trades',
      'fnf_decision_journal',
      'fnf_market_snapshots',
      'fnf_option_quotes',
      'trade_book_imports',
      'trade_book_import_log',
      'database_sync_audit',
    ];

    console.log('\n─── SCHEMA COMPARISON (key tables) ───');
    for (const table of keyTables) {
      if (!oracleTables.includes(table)) {
        console.log(`  ✓ ${table}: NOT IN ORACLE (expected)`);
        continue;
      }
      
      const oracleSchema = await getTableStructure(oracleDb, table);
      const localHasTable = localTables.includes(table);
      
      if (!localHasTable) {
        console.log(`  ✗ ${table}: MISSING in LOCAL`);
        continue;
      }
      
      const localSchema = await getTableStructure(localDb, table);
      
      const oracleCols = oracleSchema.map(c => c.Field);
      const localCols = localSchema.map(c => c.Field);
      
      const missingCols = oracleCols.filter(c => !localCols.includes(c));
      const extraCols = localCols.filter(c => !oracleCols.includes(c));
      
      if (missingCols.length === 0 && extraCols.length === 0) {
        console.log(`  ✓ ${table}: SCHEMA MATCHES (${oracleCols.length} columns)`);
      } else {
        console.log(`  ✗ ${table}: MISMATCH`);
        if (missingCols.length > 0) {
          console.log(`    Missing columns: ${missingCols.join(', ')}`);
        }
        if (extraCols.length > 0) {
          console.log(`    Extra columns: ${extraCols.join(', ')}`);
        }
      }
    }

    console.log('\n═══════════════════════════════════════════════════════════════════════════════');
    console.log('                        INSPECTION COMPLETE');
    console.log('═══════════════════════════════════════════════════════════════════════════════');

  } finally {
    await localDb.end();
    await oracleDb.end();
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
