import { TypeOrmModuleOptions } from '@nestjs/typeorm';

/**
 * mysql2 connection/pool reliability knobs, shared by EVERY pool this project
 * opens against the one Oracle Cloud MySQL (reachable only through the SSH
 * tunnel published as 127.0.0.1:3307).
 *
 * Why (measured 2026-09-11): that tunnel drops connections silently, so a pool
 * can end up holding a black-holed socket — a query assigned to it never
 * returns and, with the default configuration, the socket is never detected as
 * dead. The FYERS producer's lease-heartbeat writes froze behind exactly such a
 * socket for minutes while its high-volume tick writes kept succeeding on the
 * healthy members of the SAME pool.
 *
 * All four names are mysql2's OWN supported options — nothing invented:
 *  - `enableKeepAlive` + `keepAliveInitialDelay`: mysql2 applies them to the
 *    socket in `mysql2/lib/base/connection.js`
 *    (`stream.setKeepAlive(true, delay)`), so a dead peer gets TCP probes and
 *    the socket errors out instead of hanging forever.
 *  - `maxIdle` + `idleTimeout`: these arm mysql2's idle-connection reaper
 *    (`mysql2/lib/base/pool.js` → `_removeIdleTimeoutConnections`), which
 *    destroys idle sockets beyond `maxIdle` or older than `idleTimeout`; the
 *    next query then opens a FRESH connection rather than reusing a possibly
 *    stale one. The reaper is armed only when `maxIdle < connectionLimit`,
 *    which is why maxIdle is 2 against mysql2's default limit of 10.
 *
 * This changes only how sockets are recycled. The pool SIZE (connectionLimit)
 * is untouched, no query semantics change, and no trading, risk, sizing,
 * arbitration or ownership behaviour is affected.
 */
export function mysqlPoolTuning(): Record<string, number | boolean> {
	return {
		enableKeepAlive: true,
		keepAliveInitialDelay: 10_000,
		maxIdle: 2,
		idleTimeout: 30_000,
	};
}

/**
 * Shared TypeORM/MySQL connection factory.
 * Every service calls this with its own DATABASE_NAME so each service
 * owns exactly one MySQL schema (database-per-service pattern).
 */
export function mysqlConfig(databaseName: string): TypeOrmModuleOptions {
	return {
		type: 'mysql' as const,
		host: process.env.MYSQL_HOST || 'localhost',
		port: Number(process.env.MYSQL_PORT) || 3306,
		username: process.env.MYSQL_USER || 'mylife',
		password: process.env.MYSQL_PASSWORD || 'mylife-secret',
		database: databaseName,
		autoLoadEntities: true,
		synchronize: true, // always auto-sync in dev — user request
		// Driver-supported pool/connection reliability (see mysqlPoolTuning).
		// TypeORM forwards `extra` verbatim into mysql2's createPool.
		extra: mysqlPoolTuning(),
	};
}

/** Standard service port from env. */
export function servicePort(defaultPort: number): number {
	return Number(process.env.PORT || defaultPort);
}
