import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { PreOpenCaptureService } from './pre-open-capture.service';
import { PreOpenRepository } from './pre-open.repository';
import { derivePreOpenFeatures, finiteOrNull, ObservationQuality } from './pre-open-features';
import { PreOpenObservation } from './pre-open-observation.entity';
import { SessionPhase, istDateString, sessionPhaseAt } from './pre-open-session';

/**
 * GATE 2 — read-only pre-open observability (item 16).
 *
 * Every answer here comes from stored point-in-time observations. Nothing is
 * recomputed from a later price, and a missing value is reported as missing
 * rather than substituted. Mirrors the market-data inspection controller: a
 * diagnostic surface, no writes.
 */
@Controller('trading/pre-open')
export class PreOpenController {
  constructor(
    private readonly capture: PreOpenCaptureService,
    private readonly repo: PreOpenRepository,
  ) {}

  @Get('status')
  status() {
    return { ok: true, capture: this.capture.status(), clockPhase: sessionPhaseAt(Date.now()) };
  }

  /** Raw stored observations for a session, newest event time first. */
  @Get('observations')
  async observations(
    @Query('instrument') instrument?: string,
    @Query('day') day?: string,
    @Query('phase') phase?: string,
    @Query('limit') limit?: string,
  ) {
    const sessionDate = day || istDateString(Date.now());
    const rows = await this.repo.list({
      instrumentKey: instrument,
      sessionDate,
      sessionPhase: phase,
      limit: toLimit(limit),
    });
    return { ok: true, sessionDate, count: rows.length, observations: rows.map((r) => publicView(r, Date.now())) };
  }

  /** Latest observation per instrument: source, timestamps, quality, derived gap and imbalance. */
  @Get('latest')
  async latest(@Query('day') day?: string) {
    const sessionDate = day || istDateString(Date.now());
    const rows = await this.repo.latestByInstrument(sessionDate);
    return { ok: true, sessionDate, count: rows.length, latest: rows.map((r) => publicView(r, Date.now())) };
  }

  /**
   * Point-in-time read: strictly what was known at `at` (item 4). Rows whose
   * event time falls after that instant are excluded, so an earlier decision
   * can never be reconstructed with a later price.
   */
  @Get('asof')
  async asOf(@Query('instrument') instrument?: string, @Query('at') at?: string) {
    if (!instrument) throw new BadRequestException('instrument is required (e.g. BSE_INDEX|SENSEX)');
    const atMs = parseInstant(at);
    const row = await this.repo.latestAsOf(instrument, new Date(atMs));
    return {
      ok: true,
      instrument,
      at: new Date(atMs).toISOString(),
      known: row ? publicView(row, atMs) : null,
      note: row ? null : 'no stored observation at or before this instant',
    };
  }

  /** Derived opening features only — the formulas live in one pure module. */
  @Get('features')
  async features(@Query('instrument') instrument?: string, @Query('at') at?: string) {
    if (!instrument) throw new BadRequestException('instrument is required (e.g. BSE_INDEX|SENSEX)');
    const atMs = at ? parseInstant(at) : Date.now();
    const rows = await this.repo.list({ instrumentKey: instrument, limit: 1 });
    let row: PreOpenObservation | null = rows[0] ?? null;
    if (at) row = await this.repo.latestAsOf(instrument, new Date(atMs));
    if (!row) {
      return { ok: true, instrument, features: null, note: 'no stored pre-open observation for this instrument' };
    }
    return {
      ok: true,
      instrument,
      source: row.source,
      quality: row.quality,
      sessionPhase: row.sessionPhase,
      features: derivePreOpenFeatures(asFeatureInput(row), gateCtx(row, atMs)),
    };
  }
}

const toLimit = (raw?: string): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 100;
};

const parseInstant = (raw?: string): number => {
  const ms = raw ? Date.parse(raw) : NaN;
  if (!Number.isFinite(ms)) {
    throw new BadRequestException('at must be an ISO-8601 instant, e.g. 2026-09-11T09:05:00+05:30');
  }
  return ms;
};

/** A stored phase string is only trusted if it is one the session model can name. */
const asFeatureInput = (row: PreOpenObservation) => ({
  instrumentKey: row.instrumentKey,
  sessionDate: row.sessionDate,
  sessionPhase: (row.sessionPhase as SessionPhase) ?? 'UNKNOWN',
  eventTime: row.eventTime,
  // MySQL DECIMAL columns come back as strings from TypeORM, so every numeric
  // column is coerced here. Without this the formulas would treat good stored
  // values as unusable and report UNAVAILABLE for data that is actually present.
  previousClose: finiteOrNull(row.previousClose),
  indicativePrice: finiteOrNull(row.indicativePrice),
  buyQuantity: finiteOrNull(row.buyQuantity),
  sellQuantity: finiteOrNull(row.sellQuantity),
});

/** Stored values with their quality and provenance — never a fabricated stand-in. */
const publicView = (row: PreOpenObservation, asOfMs: number) => ({
  id: row.id,
  instrument: row.instrumentKey,
  symbol: row.symbol,
  underlying: row.underlying,
  exchange: row.exchange,
  sessionDate: row.sessionDate,
  sessionPhase: row.sessionPhase,
  sourceStatus: row.sourceStatus,
  eventTime: row.eventTime ? row.eventTime.toISOString() : null,
  receivedAt: row.receivedAt.toISOString(),
  dataAgeMs: row.dataAgeMs,
  source: row.source,
  quality: row.quality,
  fieldQuality: row.fieldQuality,
  previousClose: row.previousClose,
  previousCloseSource: row.previousCloseSource,
  referencePrice: row.referencePrice,
  indicativePrice: row.indicativePrice,
  indicativeQuantity: row.indicativeQuantity,
  buyQuantity: row.buyQuantity,
  sellQuantity: row.sellQuantity,
  lastPrice: row.lastPrice,
  volume: row.volume,
  bestBid: row.bestBid,
  bestBidQty: row.bestBidQty,
  bestAsk: row.bestAsk,
  bestAskQty: row.bestAskQty,
  derived: derivePreOpenFeatures(asFeatureInput(row), gateCtx(row, asOfMs)),
  // The STORED decision-time block (row 22) — read back as written, never recomputed.
  oaiSeries: (row.derived as { oaiSeries?: unknown } | null)?.oaiSeries ?? null,
});

/**
 * Read-time gate: the stored quality plus the instant being asked about. This is
 * what makes a stale/unavailable row answer UNAVAILABLE instead of being served
 * as a live opening signal.
 */
const gateCtx = (row: PreOpenObservation, asOfMs: number) => ({
  observationQuality: row.quality as ObservationQuality,
  asOfMs,
  staleMaxAgeMs: Number(process.env.PRE_OPEN_STALE_MAX_AGE_MS) || undefined,
});
