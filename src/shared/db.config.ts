import { TypeOrmModuleOptions } from '@nestjs/typeorm';

/**
 * Shared TypeORM/MySQL connection factory.
 * Every service calls this with its own DATABASE_NAME so each service
 * owns exactly one MySQL schema (database-per-service pattern).
 */
export function mysqlConfig(databaseName: string): TypeOrmModuleOptions {
	return {
		type: 'mysql' as const,
		host: process.env.MYSQL_HOST || 'localhost',
		port: Number(process.env.MYSQL_PORT || 3306),
		username: process.env.MYSQL_USER || 'mylife',
		password: process.env.MYSQL_PASSWORD || 'mylife-secret',
		database: databaseName,
		autoLoadEntities: true,
		synchronize: true, // always auto-sync in dev — user request
	};
}

/** Standard service port from env. */
export function servicePort(defaultPort: number): number {
	return Number(process.env.PORT || defaultPort);
}
