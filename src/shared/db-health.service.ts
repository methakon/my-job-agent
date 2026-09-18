/**
 * Independent DB health probes (Phase 6 — 2026-09-18 runtime reliability).
 *
 * Separates six distinct failure domains that were previously collapsed into
 * a single "DB is up/down" flag:
 *
 *   1. sshTunnel   — is the SSH tunnel (port 3307) reachable?
 *   2. mysqlTcp    — can we open a TCP socket to MySQL?
 *   3. mysqlQuery  — can we execute SELECT 1?
 *   4. typeorm     — is the TypeORM connection pool accepting queries?
 *   5. persistence — is the write-behind flush succeeding?
 *   6. synchronize — is schema sync running (boot only)?
 *
 * The 2026-09-18 failure combined multiple domains: tunnel was alive, MySQL
 * was reachable, but TypeORM's synchronize locked tables for 5+ minutes and
 * the write-behind pool became wedged.  Each probe is independent so callers
 * can make informed decisions.
 */

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PersistenceHealthMachine, PersistenceState } from './persistence-state';

/** Health state for one probe layer. */
export type ProbeState = 'HEALTHY' | 'DEGRADED' | 'DOWN' | 'UNKNOWN';

export type ProbeResult = {
  state: ProbeState;
  latencyMs: number | null;
  error: string | null;
  asOf: Date;
};

/** Composite DB health report. */
export type DbHealthReport = {
  sshTunnel: ProbeResult;
  mysqlTcp: ProbeResult;
  mysqlQuery: ProbeResult;
  typeorm: ProbeResult;
  persistence: ProbeState;
  synchronize: 'IDLE' | 'RUNNING';
  overall: 'HEALTHY' | 'DEGRADED' | 'DOWN';
  asOf: Date;
};

/**
 * Environment-configurable timeouts for each probe.
 */
const envInt = (name: string, fallback: number): number => {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 100 ? Math.floor(raw) : fallback;
};

const SSH_TUNNEL_PROBE_TIMEOUT_MS = envInt('DB_PROBE_SSH_TIMEOUT_MS', 3_000);
const MYSQL_TCP_PROBE_TIMEOUT_MS = envInt('DB_PROBE_TCP_TIMEOUT_MS', 3_000);
const MYSQL_QUERY_PROBE_TIMEOUT_MS = envInt('DB_PROBE_QUERY_TIMEOUT_MS', 5_000);

/**
 * Utility: race a promise against a timeout.
 */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`probe timed out after ${ms}ms`)), ms);
  });
  void work.catch(() => undefined);
  return Promise.race([work, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Probe whether the SSH tunnel port is reachable (TCP connect).
 */
async function probeSshTunnel(host: string, port: number): Promise<ProbeResult> {
  const start = Date.now();
  try {
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        const net = require('net');
        const socket = new net.Socket();
        socket.setTimeout(MYSQL_TCP_PROBE_TIMEOUT_MS);
        socket.once('connect', () => {
          socket.destroy();
          resolve();
        });
        socket.once('error', (err: Error) => {
          socket.destroy();
          reject(err);
        });
        socket.once('timeout', () => {
          socket.destroy();
          reject(new Error('TCP connect timed out'));
        });
        socket.connect(port, host);
      }),
      SSH_TUNNEL_PROBE_TIMEOUT_MS,
    );
    return { state: 'HEALTHY', latencyMs: Date.now() - start, error: null, asOf: new Date() };
  } catch (error) {
    return { state: 'DOWN', latencyMs: Date.now() - start, error: (error as Error).message, asOf: new Date() };
  }
}

/**
 * Probe MySQL TCP connectivity (bypasses TypeORM).
 */
async function probeMysqlTcp(host: string, port: number, timeoutMs: number): Promise<ProbeResult> {
  const start = Date.now();
  try {
    // Use mysql2 directly to test raw connectivity.
    const mysql = require('mysql2/promise');
    const conn: any = await withTimeout(
      mysql.createConnection({
        host,
        port,
        user: process.env.MYSQL_USER || 'mylife',
        password: process.env.MYSQL_PASSWORD || 'mylife-secret',
        database: process.env.DATABASE_NAME || 'myjob_agent',
        connectTimeout: timeoutMs,
      }),
      timeoutMs,
    );
    await conn.ping();
    await conn.end();
    return { state: 'HEALTHY', latencyMs: Date.now() - start, error: null, asOf: new Date() };
  } catch (error) {
    return { state: 'DOWN', latencyMs: Date.now() - start, error: (error as Error).message, asOf: new Date() };
  }
}

/**
 * Independent health service for DB path diagnostics.
 *
 * Each probe is self-contained and timeout-bounded.  The service does NOT
 * cache probe results — callers decide how often to probe.  The service
 * owns no connection pool; it creates disposable connections for each probe.
 */
@Injectable()
export class DbHealthService {
  private readonly logger = new Logger(DbHealthService.name);
  private synchronizeState: 'IDLE' | 'RUNNING' = 'IDLE';
  private readonly host: string;
  private readonly port: number;

  constructor(
    @InjectRepository('UnifiedOptionQuote' as any)
    private readonly quotesRepo: Repository<any>,
    private readonly persistenceHealth: PersistenceHealthMachine,
  ) {
    this.host = process.env.MYSQL_HOST || 'localhost';
    this.port = Number(process.env.MYSQL_PORT) || 3306;
  }

  /** Mark schema synchronization as running (called during TypeORM bootstrap). */
  markSynchronizeRunning(): void {
    this.synchronizeState = 'RUNNING';
  }

  /** Mark schema synchronization as complete. */
  markSynchronizeIdle(): void {
    this.synchronizeState = 'IDLE';
  }

  /** Record a persistence failure (delegates to the health machine). */
  recordPersistenceFailure(reason: string, dropped = 0): void {
    this.persistenceHealth.recordFailure(reason, dropped);
  }

  /** Record a persistence success. */
  recordPersistenceSuccess(count = 1): void {
    this.persistenceHealth.recordSuccess(count);
  }

  /** Full health report with all independent probes. */
  async fullReport(): Promise<DbHealthReport> {
    const host = this.host;
    const port = this.port;

    // Run probes concurrently (each is independent).
    const [sshResult, tcpResult] = await Promise.all([
      probeSshTunnel(host, port),
      probeMysqlTcp(host, port, MYSQL_TCP_PROBE_TIMEOUT_MS),
    ]);

    // TypeORM health: can the shared pool execute a query?
    let typeormResult: ProbeResult;
    const start = Date.now();
    try {
      await withTimeout(
        this.quotesRepo.query('SELECT 1 AS alive'),
        MYSQL_QUERY_PROBE_TIMEOUT_MS,
      );
      typeormResult = { state: 'HEALTHY', latencyMs: Date.now() - start, error: null, asOf: new Date() };
    } catch (error) {
      typeormResult = { state: 'DOWN', latencyMs: Date.now() - start, error: (error as Error).message, asOf: new Date() };
    }

    const persistence = this.persistenceHealth.currentState();
    const probes = [sshResult.state, tcpResult.state, typeormResult.state];
    const overall = probes.includes('DOWN') || persistence === 'DOWN'
      ? 'DOWN'
      : probes.includes('DEGRADED') || persistence === 'DEGRADED'
        ? 'DEGRADED'
        : 'HEALTHY';

    return {
      sshTunnel: sshResult,
      mysqlTcp: tcpResult,
      mysqlQuery: typeormResult,
      typeorm: typeormResult,
      persistence,
      synchronize: this.synchronizeState,
      overall,
      asOf: new Date(),
    };
  }

  /** Lightweight check: is the TypeORM pool accepting queries? */
  async isTypeOrmHealthy(): Promise<boolean> {
    try {
      await withTimeout(
        this.quotesRepo.query('SELECT 1 AS alive'),
        MYSQL_QUERY_PROBE_TIMEOUT_MS,
      );
      return true;
    } catch {
      return false;
    }
  }
}
