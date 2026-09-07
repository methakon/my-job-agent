import { DataSource } from 'typeorm';
import * as path from 'path';

// Use LOCAL_DB_* for local MySQL
const localConfig = {
  type: 'mysql',
  host: process.env.LOCAL_DB_HOST || '127.0.0.1',
  port: Number(process.env.LOCAL_DB_PORT || 3306),
  username: process.env.LOCAL_DB_USER || 'root',
  password: process.env.LOCAL_DB_PASSWORD || 'wbsd99',
  database: process.env.LOCAL_DB_NAME || 'myjob_agent',
  synchronize: false,
  logging: true,
  entities: [path.join(process.cwd(), 'dist', '**', '*.entity.js')],
  subscribers: [path.join(process.cwd(), 'dist', '**', '*.subscriber.js')],
  migrations: [path.join(process.cwd(), 'dist', 'migration', '*{.ts,.js}')],
  migrationsTableName: 'typeorm_migrations',
};

const localDataSource = new DataSource(localConfig);

async function runMigrations() {
  console.log('Connecting to local MySQL...');
  await localDataSource.initialize();
  console.log('Connected to local MySQL');

  const pendingMigrations = await localDataSource.query(
    `SELECT m.name FROM typeorm_migrations m 
     WHERE m.name NOT IN (\`1726643200000-CreateDatabaseSyncAuditTable1726643200000\`, \`1788800108047-AddDecisionIdToFnfTrade1788800108047\`, \`1788800108048-CreateTradeBookTables1788800108048\`, \`1788800200000-CreateFyersTokenTable1788800200000\`, \`1788800300000-FixFyersTokenTable1788800300000\`)
  `);

  console.log('Checking for pending migrations...');

  // Run all migrations
  const result = await localDataSource.runMigrations();
  
  if (result && result.length > 0) {
    console.log(`Successfully ran ${result.length} migrations:`);
    result.forEach(m => console.log(`  - ${m.name}`));
  } else {
    console.log('No migrations to run (all already applied or no migrations found).');
  }

  // Verify typeorm_migrations table exists and has entries
  const migrationRecords = await localDataSource.query(
    'SELECT id, timestamp, name FROM typeorm_migrations ORDER BY timestamp'
  );
  console.log(`\nTotal migrations in typeorm_migrations: ${migrationRecords.length}`);
  migrationRecords.forEach(m => console.log(`  ${m.id}: ${m.name} @ ${new Date(m.timestamp)}`));

  await localDataSource.destroy();
  console.log('\nMigration run completed.');
}

runMigrations().catch(err => {
  console.error('Migration run failed:', err);
  process.exit(1);
});
