import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, QueryDeepPartialEntity, Repository } from 'typeorm';
import { PreOpenObservation } from './pre-open-observation.entity';

export type PriorClose = {
  price: number;
  asOfTs: Date;
  symbol: string;
  source: string;
  note: string;
};

/**
 * ALL database access for pre-open intelligence (MVCR: repositories own queries).
 *
 * Append-only by construction: the only write path is insertIgnore(), which
 * collapses a repeated source tick onto its dedupe key. Nothing here can UPDATE
 * or DELETE an observation, so a later value can never overwrite history
 * (item 4 — no look-ahead, auditable point-in-time record).
 */
@Injectable()
export class PreOpenRepository {
  constructor(
    @InjectRepository(PreOpenObservation) private readonly repo: Repository<PreOpenObservation>,
  ) {}

  /**
   * Insert observations, ignoring rows whose dedupeKey already exists.
   * Returns the number of rows actually inserted (affectedRows).
   */
  async insertIgnore(rows: PreOpenObservation[]): Promise<number> {
    if (!rows.length) return 0;
    const res = await this.repo
      .createQueryBuilder()
      .insert()
      .into(PreOpenObservation)
      // A json column's deep-partial type cannot express a generic record, so the
      // row set is cast here; the entity itself stays strictly typed.
      .values(rows as unknown as QueryDeepPartialEntity<PreOpenObservation>[])
      .orIgnore()
      .execute();
    const affected = (res.raw as { affectedRows?: number } | undefined)?.affectedRows;
    return typeof affected === 'number' ? affected : rows.length;
  }

  /** Observations for a session date (newest event time first). */
  async list(filter: {
    instrumentKey?: string;
    sessionDate?: string;
    sessionPhase?: string;
    limit?: number;
  }): Promise<PreOpenObservation[]> {
    const qb = this.repo.createQueryBuilder('o').orderBy('o.eventTime', 'DESC').addOrderBy('o.receivedAt', 'DESC');
    if (filter.instrumentKey) qb.andWhere('o.instrumentKey = :k', { k: filter.instrumentKey });
    if (filter.sessionDate) qb.andWhere('o.sessionDate = :d', { d: filter.sessionDate });
    if (filter.sessionPhase) qb.andWhere('o.sessionPhase = :p', { p: filter.sessionPhase });
    qb.take(Math.max(1, Math.min(500, filter.limit ?? 50)));
    return qb.getMany();
  }

  /**
   * The newest observation whose EVENT time is at or before `at` — the honest
   * answer to "what did we know at 09:05?". Rows with a later event time, and
   * rows whose event time is null (unauditable), are excluded.
   */
  async latestAsOf(instrumentKey: string, at: Date): Promise<PreOpenObservation | null> {
    const rows = await this.repo
      .createQueryBuilder('o')
      .where('o.instrumentKey = :k', { k: instrumentKey })
      .andWhere('o.eventTime IS NOT NULL')
      .andWhere('o.eventTime <= :at', { at })
      .andWhere("o.quality != 'INVALID'")
      .orderBy('o.eventTime', 'DESC')
      .take(1)
      .getMany();
    return rows[0] ?? null;
  }

  /** Newest observation per instrument for a session date. */
  async latestByInstrument(sessionDate: string): Promise<PreOpenObservation[]> {
    const rows = await this.repo.find({
      where: { sessionDate },
      order: { eventTime: 'DESC', receivedAt: 'DESC' },
      take: 500,
    });
    const seen = new Map<string, PreOpenObservation>();
    for (const row of rows) if (!seen.has(row.instrumentKey)) seen.set(row.instrumentKey, row);
    return Array.from(seen.values());
  }

  async countForSession(sessionDate: string): Promise<{ total: number; byQuality: Record<string, number>; instruments: number }> {
    const rows = await this.repo.find({ where: { sessionDate }, select: ['quality', 'instrumentKey'] });
    const byQuality: Record<string, number> = {};
    const instruments = new Set<string>();
    for (const r of rows) {
      byQuality[r.quality] = (byQuality[r.quality] ?? 0) + 1;
      instruments.add(r.instrumentKey);
    }
    return { total: rows.length, byQuality, instruments: instruments.size };
  }

  /**
   * Previous-session close from OUR OWN normalized store, for instruments whose
   * source does not publish one (measured: index keys return prev_close_price =
   * null). Provenance is returned so the caller can label the value
   * STORE_PRIOR_SESSION and a reviewer can see it is not source-published.
   *
   * Strictly point-in-time: only observations strictly BEFORE the current
   * session's start are considered, so today's own prints can never be used to
   * reconstruct an earlier pre-open decision.
   */
  async priorSessionClose(instrumentKey: string, sessionStart: Date): Promise<PriorClose | null> {
    const short = instrumentKey.split('|').pop() ?? instrumentKey;
    const bare = short.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const rows = await this.repo.manager.query(
      `SELECT symbol, source, ts, close, ltp
         FROM unified_market_snapshots
        WHERE ts < ?
          AND (UPPER(REPLACE(REPLACE(symbol,'-',''),' ','')) LIKE ?
               OR UPPER(REPLACE(REPLACE(symbol,'-',''),' ','')) LIKE ?)
        ORDER BY ts DESC
        LIMIT 1`,
      [sessionStart, `%${bare}%`, `%${short.toUpperCase()}%`],
    ).catch(() => [] as Array<Record<string, unknown>>);
    const row = (rows as Array<Record<string, unknown>>)[0];
    if (!row) return null;
    const price = Number(row.close ?? row.ltp);
    if (!Number.isFinite(price) || price <= 0) return null;
    return {
      price,
      asOfTs: new Date(String(row.ts)),
      symbol: String(row.symbol),
      source: String(row.source),
      note: 'prior-session close from unified_market_snapshots (source did not publish prev_close_price)',
    };
  }

  /** Hard cap helper used by retention/verification tooling. */
  async before(ts: Date): Promise<number> {
    const res = await this.repo.count({ where: { receivedAt: LessThan(ts) } });
    return res;
  }
}
