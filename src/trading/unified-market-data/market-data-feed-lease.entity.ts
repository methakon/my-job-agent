import { Entity, PrimaryColumn, Column, Index, UpdateDateColumn } from 'typeorm';

/**
 * Cross-process feed lease (brief s2/s6 — one active feed at a time).
 *
 * Producers can live in different processes/hosts: the FYERS WebSocket producer
 * runs in the headless worker on the Dhargent VM, the Upstox REST producer runs
 * in the web app. They coordinate through this table, which is the shared
 * database — each feed publishes what it produces and how recently it ticked,
 * and the arbiter elects a single owner per instrument universe from those rows.
 *
 * Rows are informational + a liveness lease: nothing here is money or execution.
 * A row whose heartbeatAt is older than the TTL is treated as a dead process and
 * ignored (never trusted as "still producing"). All timestamps are written from
 * JS so they round-trip in the writers' timezone — SQL DEFAULT/CURRENT_TIMESTAMP
 * is deliberately not used (its clock semantics differ from the DATETIME columns).
 */
@Entity('market_data_feed_leases')
@Index('idx_mdfl_state', ['state'])
export class MarketDataFeedLease {
  /** Feed identity, e.g. FYERS_WS | UPSTOX_REST. */
  @PrimaryColumn({ length: 32 })
  feedName: string;

  /** Lower wins; PRIMARY FYERS 0, SECONDARY Upstox REST 1. */
  @Column({ type: 'int', default: 1 })
  priority: number;

  /** CSV of underlyings this feed can price ('*' = every universe). */
  @Column({ length: 255, default: '' })
  universes: string;

  @Column({ type: 'tinyint', width: 1, default: 1 })
  enabled: boolean;

  @Column({ name: 'credentialsOk', type: 'tinyint', width: 1, default: 1 })
  credentialsOk: boolean;

  /** ACTIVE (holds ≥1 universe) | STANDBY | DOWN. */
  @Column({ length: 16, default: 'DOWN' })
  state: string;

  @Column({ length: 64, default: '' })
  host: string;

  @Column({ type: 'int', default: 0 })
  pid: number;

  /** Newest observation this feed produced (JS timestamp). */
  @Column({ name: 'lastTickAt', type: 'datetime', nullable: true })
  lastTickAt: Date | null;

  /** Liveness heartbeat; stale beyond the TTL ⇒ the producer is gone. */
  @Column({ name: 'heartbeatAt', type: 'datetime', nullable: true })
  heartbeatAt: Date | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  note: string | null;

  @UpdateDateColumn()
  updatedAt: Date;
}
