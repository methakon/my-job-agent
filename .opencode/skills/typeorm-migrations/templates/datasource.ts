import { DataSource, DataSourceOptions } from 'typeorm';
import * as path from 'path';

/**
 * TypeORM runtime DataSource for NestJS+TypeORM v0.3.
 * Credentials are loaded from .env via process.env.*
 * Never commit this file with actual values.
 */
const config: DataSourceOptions = {
  type: 'mysql',
  host: process.env.MYSQL_HOST,
  port: Number(process.env.MYSQL_PORT),
  username: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.DATABASE_NAME,
  synchronize: false, // Never auto-sync. Migrations are authoritative.
  logging: false,
  entities: [path.join(__dirname, '..', '**', '*.entity.ts')],
  subscribers: [path.join(__dirname, '..', '**', '*.subscriber.ts')],
  migrations: [path.join(__dirname, '..', 'migration', '*.ts')],
};

const dataSource = new DataSource(config);

export default dataSource;