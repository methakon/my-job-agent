import { DataSource, DataSourceOptions } from 'typeorm';
import * as path from 'path';

/**
 * TypeORM CLI configuration.
 * Credentials are loaded from .env via process.env.*
 * Never commit this file with actual values.
 */
const config: DataSourceOptions = {
  type: 'mysql',
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: Number(process.env.MYSQL_PORT || 3307),
  username: process.env.MYSQL_USER || 'mylife',
  password: process.env.MYSQL_PASSWORD || 'mylife-secret',
  database: process.env.DATABASE_NAME || 'myjob_agent',
  synchronize: false, // Never auto-sync. Migrations are authoritative.
  logging: false,
  entities: [path.join(__dirname, 'src', '**', '*.entity.ts')],
  subscribers: [path.join(__dirname, 'src', '**', '*.subscriber.ts')],
  migrations: [path.join(__dirname, 'src', 'migration', '*.ts')],
  migrationsTableName: 'typeorm_migrations',
};

const dataSource = new DataSource(config);

export default dataSource;
