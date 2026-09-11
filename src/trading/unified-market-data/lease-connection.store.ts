import { Connection, createConnection } from 'mysql2/promise';
import { mysqlKeepAliveOptions } from '../../shared/db.config';
import { MarketDataFeedLease } from './market-data-feed-lease.entity';

/**
 * The two lease operations the arbiter needs, and nothing else. `FeedArbitrationService`
 * talks to this shape only, so the TRANSPORT can change (it used to be the shared
 * TypeORM repository) without touching a single arbitration rule.
 */
export type LeaseStore = {
	find(): Promise<MarketDataFeedLease[]>;
	upsert(row: Partial<MarketDataFeedLease>, keys?: string[]): Promise<unknown>;
	/**
	 * Drop the transport after a failed/timed-out operation. Optional so fakes in
	 * tests that only implement find/upsert stay valid.
	 */
	recycle?(reason?: string): void;
};

export type LeaseConnectionFactory = () => Promise<Connection>;

/** DI token — a factory provider keeps Nest's constructor metadata simple. */
export const LEASE_STORE = 'FEED_ARBITRATION_LEASE_STORE';

export const LEASE_TABLE = 'market_data_feed_leases';

export const LEASE_SELECT_SQL =
	`SELECT feedName, priority, universes, enabled, credentialsOk, state, host, pid, lastTickAt, heartbeatAt, note, updatedAt FROM ${LEASE_TABLE}`;

/**
 * `feedName` is the primary key, so ON DUPLICATE KEY UPDATE renews that feed's own
 * lease and can never create a second row for one feed. Timestamps are bound as JS
 * Dates — the module deliberately never uses SQL NOW()/CURRENT_TIMESTAMP, whose
 * clock semantics differ from the DATETIME columns the producers write.
 */
export const LEASE_UPSERT_SQL =
	`INSERT INTO ${LEASE_TABLE} (feedName, priority, universes, enabled, credentialsOk, state, host, pid, lastTickAt, heartbeatAt, note, updatedAt)
	 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	 ON DUPLICATE KEY UPDATE priority = VALUES(priority), universes = VALUES(universes), enabled = VALUES(enabled),
	   credentialsOk = VALUES(credentialsOk), state = VALUES(state), host = VALUES(host), pid = VALUES(pid),
	   lastTickAt = VALUES(lastTickAt), heartbeatAt = VALUES(heartbeatAt), note = VALUES(note), updatedAt = VALUES(updatedAt)`;

/**
 * How long ONE connect attempt may take (FEED_LEASE_CONNECT_TIMEOUT_MS). Bounded on
 * purpose: the arbitration control path must never sit on a socket that never
 * completes, and a connection that cannot be opened must fail so the TTL rules can
 * do their job instead of leaving a stale lease looking alive.
 */
export const DEFAULT_LEASE_CONNECT_TIMEOUT_MS = 15_000;

/** Open the dedicated arbitration connection from the same .env as every other pool. */
export function defaultLeaseConnectionFactory(): Promise<Connection> {
	const connectTimeout = Math.max(
		1_000,
		Number(process.env.FEED_LEASE_CONNECT_TIMEOUT_MS ?? DEFAULT_LEASE_CONNECT_TIMEOUT_MS),
	);
	return createConnection({
		host: process.env.MYSQL_HOST || '127.0.0.1',
		port: Number(process.env.MYSQL_PORT) || 3306,
		user: process.env.MYSQL_USER || 'mylife',
		password: process.env.MYSQL_PASSWORD || 'mylife-secret',
		database: process.env.MYSQL_DATABASE || process.env.DATABASE_NAME || 'myjob_agent',
		...mysqlKeepAliveOptions(),
		connectTimeout,
	});
}

/**
 * Feed-arbitration lease/heartbeat transport on ONE dedicated MySQL connection.
 *
 * Why it is separate (measured 2026-09-11): on the shared application pool the
 * arbitration lease operations timed out while the same pool kept serving ~48
 * market-data inserts/s — the provider's heartbeat froze for minutes, so the other
 * process kept treating it as dead and the universe stayed on the standby. Isolating
 * the control path means a busy data path can never starve it.
 *
 * Guarantees this class provides, and only these:
 *  - exactly one connection, opened lazily and reused (no per-op acquire/release);
 *  - a bounded connect (connectTimeout) and keepalive so a dead peer is detected;
 *  - `recycle()` destroys the connection after any failed/timed-out operation, so a
 *    wedged socket is never reused and the next operation opens a fresh one;
 *  - nothing here decides ownership: the arbiter's TTL rules do. A lease that is not
 *    renewed simply ages out of its TTL and the provider loses the universe.
 *
 * It does NOT touch the application pool's size, market-data writes, risk, capital,
 * instrument coverage or paper accounting.
 */
export class DedicatedLeaseStore implements LeaseStore {
	private readonly factory: LeaseConnectionFactory;
	private conn: Connection | null = null;
	private opening: Promise<Connection> | null = null;
	private recycleCount = 0;

	constructor(factory: LeaseConnectionFactory = defaultLeaseConnectionFactory) {
		this.factory = factory;
	}

	/** Transport diagnostics (used by logs/tests; never arbitration input). */
	get stats(): { connected: boolean; opening: boolean; recycles: number } {
		return { connected: Boolean(this.conn), opening: Boolean(this.opening), recycles: this.recycleCount };
	}

	private open(): Promise<Connection> {
		if (this.conn) return Promise.resolve(this.conn);
		if (this.opening) return this.opening;
		const opening: Promise<Connection> = this.factory().then(
			(connection) => {
				this.conn = connection;
				if (this.opening === opening) this.opening = null;
				return connection;
			},
			(error) => {
				if (this.opening === opening) this.opening = null;
				throw error;
			},
		);
		// A caller that already gave up (its own timeout fired) must not leave an
		// unhandled rejection behind when this connect later fails.
		opening.catch(() => undefined);
		this.opening = opening;
		return opening;
	}

	async find(): Promise<MarketDataFeedLease[]> {
		const connection = await this.open();
		const [rows] = await connection.query(LEASE_SELECT_SQL);
		return (rows as Array<Record<string, unknown>>).map(
			(row) =>
				({
					...row,
					enabled: Boolean(row.enabled),
					credentialsOk: Boolean(row.credentialsOk),
					lastTickAt: (row.lastTickAt as Date | null) ?? null,
					heartbeatAt: (row.heartbeatAt as Date | null) ?? null,
					note: (row.note as string | null) ?? null,
				}) as unknown as MarketDataFeedLease,
		);
	}

	async upsert(row: Partial<MarketDataFeedLease>): Promise<unknown> {
		const feedName = row.feedName;
		if (!feedName) throw new Error('lease upsert requires feedName');
		const connection = await this.open();
		const params: Array<string | number | Date | null> = [
			feedName,
			Number(row.priority ?? 1),
			String(row.universes ?? ''),
			row.enabled === false ? 0 : 1,
			row.credentialsOk === false ? 0 : 1,
			String(row.state ?? 'DOWN'),
			String(row.host ?? ''),
			Number(row.pid ?? 0),
			row.lastTickAt ?? null,
			row.heartbeatAt ?? null,
			row.note ?? null,
			new Date(),
		];
		const [result] = await connection.execute(LEASE_UPSERT_SQL, params);
		return result;
	}

	/**
	 * Destroy the dedicated connection so the next operation opens a fresh one.
	 * Called by the arbiter after ANY failed or timed-out lease operation.
	 */
	recycle(reason = 'lease operation failed'): void {
		const connection = this.conn;
		const opening = this.opening;
		this.conn = null;
		this.opening = null;
		this.recycleCount += 1;
		const destroy = (target: Connection | null): void => {
			if (!target) return;
			try {
				target.destroy();
			} catch {
				/* already gone */
			}
		};
		destroy(connection);
		if (opening) void opening.then(destroy, () => undefined);
		void reason;
	}

	async close(): Promise<void> {
		const connection = this.conn;
		this.conn = null;
		if (!connection) return;
		try {
			await connection.end();
		} catch {
			try {
				connection.destroy();
			} catch {
				/* already gone */
			}
		}
	}
}
