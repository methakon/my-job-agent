import { TypeOrmModuleOptions } from '@nestjs/typeorm';

/**
 * mysql2 connection/pool reliability knobs, shared by EVERY connection this
 * project opens against the one Oracle Cloud MySQL (reachable only through the
 * SSH tunnel published as 127.0.0.1:3307).
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
 * This changes how sockets are recycled plus the pool size itself (see the
 * measured `connectionLimit` note below). No query semantics change, and no
 * trading, risk, sizing, arbitration or ownership behaviour is affected.
 */

/**
 * TCP keepalive for ANY mysql2 connection this project opens — a pool member or
 * a single long-lived connection (the dedicated feed-arbitration lease
 * connection uses this without the pool-only reaper options).
 */
export function mysqlKeepAliveOptions(): Record<string, number | boolean> {
	return {
		enableKeepAlive: true,
		keepAliveInitialDelay: 10_000,
	};
}

/** Keepalive + the pool-only bounded idle reaping (see the note above). */
export function mysqlPoolTuning(): Record<string, number | boolean> {
	return {
		...mysqlKeepAliveOptions(),
		maxIdle: 2,
		idleTimeout: 30_000,
		// Pool SIZE — mysql2's default is 10 slots and that ceiling is too low
		// for this deployment's transport. Measured 2026-09-28: every statement
		// through the SSH tunnel costs ~186 ms, so 10 slots cap a process at
		// ~54 statements/s while market-hours persistence demand (per-row
		// canonical writes + journal + batched flushes) sits at/above that edge;
		// acquires pile up unserved (observed: 4,235 queued on the trading
		// process) and each write-behind flush burns its full 20 s ceiling.
		// 25 slots x ~5.4 stmt/s ~= 135 stmt/s keeps real headroom: a 25-way
		// parallel connect+query through the SAME tunnel completed in 656 ms.
		// Override with MYSQL_POOL_SIZE if a host needs otherwise.
		connectionLimit: Math.max(1, Number(process.env.MYSQL_POOL_SIZE || 25)),
		// queueLimit bounds how many INSERTs can pile up when every pool slot is
		// occupied by a half-dead connection.  0 = unlimited — withTimeout (120 s)
		// already bounds query lifetime; releasePoolConnections (RingQueue fix)
		// now actually destroys dead sockets after recycleAfterTimeouts fires.
		queueLimit: 0,
	};
}

/**
 * Shared TypeORM/MySQL connection factory.
 * Every service calls this with its own DATABASE_NAME so each service
 * owns exactly one MySQL schema (database-per-service pattern).
 */
/** Production MUST NOT run synchronize — it ALTERs 4M-row tables.
 * Set DB_SYNC_ENABLED=true only for intentional dev/schema migration. */
export function mysqlConfig(databaseName: string): TypeOrmModuleOptions {
	return {
		type: 'mysql' as const,
		host: process.env.MYSQL_HOST || 'localhost',
		port: Number(process.env.MYSQL_PORT) || 3306,
		username: process.env.MYSQL_USER || 'mylife',
		password: process.env.MYSQL_PASSWORD || 'mylife-secret',
		database: databaseName,
		autoLoadEntities: true,
		synchronize: process.env.DB_SYNC_ENABLED === 'true',
		/** Hard timeout on the initial TCP connect — prevents a dead tunnel from
		 *  wedging the entire NestJS bootstrap. */
		connectTimeout: 15_000,
		/** TypeORM DataSource retry policy for transient connection failures. */
		retryAttempts: 3,
		retryDelay: 2_000,
		// Driver-supported pool/connection reliability (see mysqlPoolTuning).
		// TypeORM forwards `extra` verbatim into mysql2's createPool.
		extra: mysqlPoolTuning(),
	};
}

/** Standard service port from env. */
export function servicePort(defaultPort: number): number {
	return Number(process.env.PORT || defaultPort);
}
