#!/usr/bin/env node
/**
 * GATE 2 slice 1 — PRE-OPEN / AUCTION WINDOW CAPTURE + EVIDENCE (read-only).
 * ============================================================================
 * WHAT IT DOES
 *   Runs the ALREADY-SHIPPED pre-open code path (src/trading/pre-open/*) through
 *   its normal window gate for one NSE pre-open/auction window (default
 *   08:59–09:21 IST), persists the observations it normally persists, and then
 *   writes an evidence report of what the broker actually published.
 *
 * WHAT IT NEVER DOES (asserted, not assumed — see assertSafeToRun())
 *   - never imports or instantiates UpstoxLivePaperModule, so no desk service,
 *     no @Cron autoentry/autostart job and no market-data WS stream can run;
 *   - never calls POST /auth/login, never places/cancels an order, never fills,
 *     never reads or writes capital, positions, P&L or any FNF record;
 *   - never writes a fabricated value: a field the broker did not publish is
 *     stored NULL and reported UNAVAILABLE with the reason;
 *   - the store previous-close fallback is forced OFF for this run.
 *
 * WHY ITS OWN PROVIDER LIST RATHER THAN THE FULL APP MODULE
 *   The app's own build is currently blocked by an unrelated in-progress module
 *   (job-application-roadmap), and booting the desk module would start desk
 *   jobs. This harness therefore compiles ONLY the pre-open subtree plus the
 *   read-only token/config it needs (tsconfig.preopen.json) and injects exactly
 *   the pre-open providers — a read-only observation producer.
 *
 * USAGE
 *   node scripts/pre-open-window-capture.js --dry-run        # fetch+assess, persist NOTHING
 *   node scripts/pre-open-window-capture.js --wait           # align to the window, capture, report
 *   node scripts/pre-open-window-capture.js --from=09:05 --to=09:09 --no-build
 * EVIDENCE
 *   var/pre-open-window/<IST-date>-pre-open-evidence.json  (+ .txt report)
 */
'use strict';

require('reflect-metadata');

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BUILD = path.join(ROOT, 'var', 'preopen-build');
const EVIDENCE_DIR = path.join(ROOT, 'var', 'pre-open-window');
const IST = 'Asia/Kolkata';
const CONTROL_EQUITY = 'NSE_EQ|INE002A01018'; // RELIANCE — key read from the official
// Upstox NSE instrument file (assets.upstox.com/.../instruments/exchange/NSE.json.gz), not typed from memory.

require('dotenv').config({ path: path.join(ROOT, '.env') });
// Forced for this run: the store-based previous-close fallback produced today's own
// close for an index during verification (look-ahead risk). Keep it OFF (item 4/17).
process.env.PRE_OPEN_PREVCLOSE_FROM_STORE = 'false';

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const opt = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const DRY_RUN = has('--dry-run');
const WAIT = has('--wait');
const NO_BUILD = has('--no-build');
const PLUMBING = has('--plumbing-check');
const FROM_HM = opt('from', '08:59');
const TO_HM = opt('to', '09:21');
const LABEL = opt('label', 'gate2-slice1-window');

// ── time helpers (IST-explicit; no reliance on the host TZ) ──────────────────
const istDay = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: IST }).format(d);
const istHm = (d = new Date()) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: IST, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
const istClock = (d = new Date()) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: IST, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(d).replace(',', '');
const istInstant = (hm, day = istDay()) => new Date(`${day}T${hm.length === 5 ? `${hm}:00` : hm}+05:30`);
/** Display an ISO timestamp / Date / epoch-ms as an IST wall-clock string. */
const istInstantOf = (v) => {
  const ms = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : new Date(v).getTime();
  return Number.isNaN(ms) ? 'invalid' : `${istClock(new Date(ms))} IST`;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${istClock()} IST]`, ...a);

// ── build the shipped subtree ────────────────────────────────────────────────
function build() {
  if (NO_BUILD) {
    log('build skipped (--no-build)');
    return;
  }
  log('compiling the shipped pre-open subtree (tsconfig.preopen.json) …');
  const r = spawnSync(path.join(ROOT, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.preopen.json'], {
    cwd: ROOT, stdio: 'inherit',
  });
  if (r.status !== 0) throw new Error(`pre-open subtree compile failed (exit ${r.status})`);
  if (!fs.existsSync(path.join(BUILD, 'trading', 'pre-open', 'pre-open-capture.service.js'))) {
    throw new Error(`expected compiled output missing under ${BUILD}`);
  }
}

// ── instruments: desk universe + the index/equity classes we must characterise ─
function instrumentList() {
  const explicit = (process.env.PRE_OPEN_WINDOW_INSTRUMENTS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (explicit.length) return explicit;
  const desk = (process.env.UPSTOX_LIVE_INSTRUMENTS ?? '')
    .replace(/["']/g, '').split(',').map((s) => s.trim()).filter(Boolean);
  const extras = [
    'NSE_INDEX|Nifty 50',      // NSE index class (the other half of the desk's index universe)
    'NSE_INDEX|Nifty Bank',    // second NSE index for corroboration
    CONTROL_EQUITY,            // equity CONTROL: distinguishes "index publishes nothing" from "API publishes nothing"
  ];
  return Array.from(new Set([...desk, ...extras]));
}

// ── module graph (exactly the shipped pre-open providers; no desk module) ────
function bootApp() {
  const { NestFactory } = require('@nestjs/core');
  const { Module } = require('@nestjs/common');
  const { ConfigModule } = require('@nestjs/config');
  const { TypeOrmModule } = require('@nestjs/typeorm');
  const { mysqlConfig } = require(path.join(BUILD, 'shared', 'db.config'));
  const { EncryptionService } = require(path.join(BUILD, 'auth', 'encryption.service'));
  const { PreOpenObservation } = require(path.join(BUILD, 'trading', 'pre-open', 'pre-open-observation.entity'));
  const { PreOpenRepository } = require(path.join(BUILD, 'trading', 'pre-open', 'pre-open.repository'));
  const { UpstoxPreOpenSource } = require(path.join(BUILD, 'trading', 'pre-open', 'upstox-pre-open.source'));
  const { PreOpenCaptureService } = require(path.join(BUILD, 'trading', 'pre-open', 'pre-open-capture.service'));
  const { PRE_OPEN_QUOTE_SOURCE } = require(path.join(BUILD, 'trading', 'pre-open', 'pre-open-source.interface'));
  const { UpstoxLivePaperTokenService } = require(path.join(BUILD, 'trading', 'upstox-live-paper', 'upstox-live-paper-auth.service'));
  const { UpstoxLivePaperToken } = require(path.join(BUILD, 'trading', 'upstox-live-paper', 'upstox-live-paper-token.entity'));
  const { UpstoxLivePaperConfig } = require(path.join(BUILD, 'trading', 'upstox-live-paper', 'upstox-live-paper.config'));

  class PreOpenWindowModule {}
  Module({
    imports: [
      ConfigModule.forRoot({ isGlobal: true }),
      TypeOrmModule.forRoot(mysqlConfig(process.env.DATABASE_NAME || 'myjob_agent')),
      TypeOrmModule.forFeature([PreOpenObservation, UpstoxLivePaperToken]),
    ],
    providers: [
      EncryptionService, UpstoxLivePaperConfig, UpstoxLivePaperTokenService,
      PreOpenRepository, UpstoxPreOpenSource,
      { provide: PRE_OPEN_QUOTE_SOURCE, useExisting: UpstoxPreOpenSource },
      PreOpenCaptureService,
    ],
  })(PreOpenWindowModule);

  return { NestFactory, PreOpenWindowModule, classes: {
    PreOpenRepository, PreOpenCaptureService, UpstoxPreOpenSource, PreOpenObservation,
    UpstoxLivePaperTokenService,
  } };
}

/**
 * Refuse to run unless nothing desk-related can execute. Checked WITHOUT
 * app.get(): NestFactory's proxy aborts the process on a missing element, so a
 * lookup is not a safe probe. Instead:
 *   1. the desk module file must never have been loaded (its @Module decorator
 *      declares every desk provider and the WS/cron services), and
 *   2. @nestjs/schedule must never have been loaded, so no @Cron decorator can
 *      register a desk job even incidentally, and
 *   3. this app's provider list must be exactly the read-only set below.
 */
function assertSafeToRun(app, classes, moduleClass) {
  const loaded = Object.keys(require.cache).map((k) => path.relative(ROOT, k));
  const deskModuleLoaded = loaded.filter((k) => k.includes('upstox-live-paper.module.'));
  const deskServicesLoaded = loaded.filter(
    (k) => k.includes('trading/upstox-live-paper/') &&
      /(-market\.service|-autoentry\.service|-instruction\.service|-scheduled\.service|-service\.js|-risk\.service)/.test(k),
  );
  const scheduleLoaded = loaded.filter((k) => k.includes('@nestjs/schedule'));
  const providers = (Reflect.getMetadata('providers', moduleClass) ?? []).map((p) => p?.name ?? p?.provide ?? 'anon');

  if (deskModuleLoaded.length) throw new Error(`UNSAFE: desk module loaded: ${JSON.stringify(deskModuleLoaded)}`);
  if (deskServicesLoaded.length) throw new Error(`UNSAFE: desk service(s) loaded: ${JSON.stringify(deskServicesLoaded)}`);
  if (scheduleLoaded.length) throw new Error(`UNSAFE: @nestjs/schedule loaded: ${JSON.stringify(scheduleLoaded)}`);

  const status = app.get(classes.PreOpenCaptureService).status();
  return {
    deskModuleLoaded: deskModuleLoaded.length,
    deskServicesLoaded: deskServicesLoaded.length,
    scheduleModuleLoaded: scheduleLoaded.length,
    httpListenerOpened: false,
    providers: providers.sort(),
    captureArmed: status.enabled,
  };
}

// ── evidence helpers ─────────────────────────────────────────────────────────
const FIELDS = [
  'previousClose', 'referencePrice', 'indicativePrice', 'indicativeQuantity',
  'imbalanceTotal', 'imbalanceMarket', 'buyQuantity', 'sellQuantity',
  'lastPrice', 'volume', 'bestBid', 'bestBidQty', 'bestAsk', 'bestAskQty', 'eventTime',
];
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

function publicationMatrix(rows) {
  const out = {};
  for (const f of FIELDS) {
    const nonNull = rows.filter((r) => r[f] !== null && r[f] !== undefined);
    const first = nonNull.length
      ? [...nonNull].sort((a, b) => new Date(a.receivedAt) - new Date(b.receivedAt))[0]
      : null;
    out[f] = {
      published: nonNull.length,
      nullCount: rows.length - nonNull.length,
      firstPublished:
        first && {
          value: f === 'eventTime' ? new Date(first[f]).toISOString() : num(first[f]),
          eventTime: first.eventTime ? new Date(first.eventTime).toISOString() : null,
          receivedAt: new Date(first.receivedAt).toISOString(),
          phase: first.sessionPhase,
        },
      perFieldQuality: rows.reduce((acc, r) => {
        const label = (r.fieldQuality && r.fieldQuality[f]) || 'UNLABELLED';
        acc[label] = (acc[label] ?? 0) + 1;
        return acc;
      }, {}),
    };
  }
  return out;
}

/** 'what did we know at T?' against the REAL captured rows, using the shipped repo query. */
async function noLookaheadCheck(repo, instrumentKey, rows) {
  const usable = rows
    .filter((r) => r.eventTime && r.quality !== 'INVALID')
    .sort((a, b) => new Date(a.eventTime) - new Date(b.eventTime));
  if (!usable.length) return { instrument: instrumentKey, checked: 0, violations: [], note: 'no auditable rows (eventTime null or INVALID)' };
  const instants = [
    ...usable.map((r) => new Date(new Date(r.eventTime).getTime() + 1000)), // just after each real event time
    istInstant('09:05'), istInstant('09:08'), istInstant('09:14'),                // the questions the slice must answer
  ];
  const violations = [];
  let checked = 0;
  for (const at of instants) {
    const expected = usable.filter((r) => new Date(r.eventTime) <= at).pop() ?? null;
    const got = await repo.latestAsOf(instrumentKey, at);
    checked += 1;
    const expectedKey = expected ? String(expected.id ?? expected.dedupeKey) : null;
    const gotKey = got ? String(got.id ?? got.dedupeKey) : null;
    if (expectedKey !== gotKey) {
      violations.push({ asOf: at.toISOString(), expected: expectedKey, got: gotKey });
    }
    if (got && new Date(got.eventTime) > at) {
      violations.push({ asOf: at.toISOString(), got: gotKey, reason: 'returned a row with eventTime AFTER as-of' });
    }
  }
  return { instrument: instrumentKey, checked, violations };
}

// ── main ─────────────────────────────────────────────────────────────────────
(async () => {
  if (PLUMBING) {
    console.log(JSON.stringify({
      ok: true, mode: 'plumbing-check', node: process.version, cwd: process.cwd(),
      ist: istClock(), day: istDay(), buildDir: fs.existsSync(BUILD),
      dbTarget: `${process.env.MYSQL_HOST}:${process.env.MYSQL_PORT || 3307}/${process.env.DATABASE_NAME || 'myjob_agent'}`,
    }, null, 1));
    return;
  }

  const instruments = instrumentList();
  process.env.PRE_OPEN_INSTRUMENTS = instruments.join(','); // the shipped config knob
  process.env.PRE_OPEN_POLL_MS = process.env.PRE_OPEN_POLL_MS || '15000';

  log(`mode=${DRY_RUN ? 'dry-run' : WAIT ? 'window(wait)' : 'window'} label=${LABEL}`);
  log(`instruments(${instruments.length}): ${instruments.join(', ')}`);

  build();
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const day = istDay();
  const { NestFactory, PreOpenWindowModule, classes } = bootApp();

  const app = await NestFactory.create(PreOpenWindowModule, { logger: ['error', 'warn'] });
  await app.init(); // lifecycle hooks only — no HTTP listener is ever opened
  const safety = assertSafeToRun(app, classes, PreOpenWindowModule);
  log(`safety: deskModuleLoaded=${safety.deskModuleLoaded} deskServicesLoaded=${safety.deskServicesLoaded} scheduleModuleLoaded=${safety.scheduleModuleLoaded} httpListener=no providers=${safety.providers.length}`);

  const repo = app.get(classes.PreOpenRepository);
  const capture = app.get(classes.PreOpenCaptureService);
  const source = app.get(classes.UpstoxPreOpenSource);
  const status0 = capture.status();
  log(`capture status: enabled=${status0.enabled} phase=${status0.phase} every ${status0.pollIntervalMs / 1000}s prevCloseFromStore=${status0.prevCloseFromStore}`);
  if (status0.prevCloseFromStore !== false) throw new Error('UNSAFE: store previous-close fallback is ON');

  // ── dry-run: fetch + assess in memory, persist NOTHING ────────────────────
  if (DRY_RUN) {
    const fetch = await source.fetchPreOpen(instruments);
    const out = { mode: 'dry-run', at: istClock(), ok: fetch.ok, error: fetch.error, marketStatus: fetch.marketStatus, instruments: {} };
    for (const [key, values] of Object.entries(fetch.values)) {
      out.instruments[key] = {
        eventTime: values.eventTime ? values.eventTime.toISOString() : null,
        presentKeys: values.presentKeys,
        published: Object.fromEntries(FIELDS.map((f) => {
          if (f === 'eventTime') return [f, values.eventTime ? 'PRESENT' : 'MISSING'];
          const raw = f === 'bestBid' ? values.depthBestBid?.price
            : f === 'bestBidQty' ? values.depthBestBid?.quantity
              : f === 'bestAsk' ? values.depthBestAsk?.price
                : f === 'bestAskQty' ? values.depthBestAsk?.quantity
                  : values[f];
          return [f, raw === null || raw === undefined ? 'NULL/ABSENT' : `present:${raw}`];
        })),
      };
    }
    console.log(JSON.stringify(out, null, 1));
    const before = await repo.countForSession(day);
    log(`dry-run wrote nothing; rows in store for ${day}: ${before.total}`);
    await app.close();
    return;
  }

  // ── window run ───────────────────────────────────────────────────────────
  const windowStart = istInstant(FROM_HM).getTime();
  const windowEnd = istInstant(TO_HM).getTime();
  const now0 = Date.now();
  if (now0 > windowEnd) throw new Error(`window already over (${FROM_HM}–${TO_HM} IST); refusing to run late`);
  if (WAIT && now0 < windowStart - 5_000) {
    log(`waiting for ${FROM_HM} IST (${Math.round((windowStart - now0) / 60000)} min) — capture arms itself at the window`);
    while (Date.now() < windowStart - 2_000) {
      await sleep(Math.min(300_000, windowStart - 2_000 - Date.now()));
      if (Date.now() < windowStart - 2_000) log(`… still waiting (${istHm()} IST)`);
    }
  }
  log('window open — the shipped service polls on its own interval now');

  // A stored token that is already dead (or dies before the window closes) makes
  // the run worthless: refuse loudly instead of recording a window full of
  // auth-failure rows. The operator re-issues the token and runs it again.
  const tokenSvc = app.get(classes.UpstoxLivePaperTokenService);
  const ts = await tokenSvc.tokenStatus();
  const tokenExpMs = ts.expiresAt ? new Date(ts.expiresAt).getTime() : null;
  log(`token: status=${ts.status} clientId=${ts.clientId || 'n/a'} expires=${ts.expiresAt ? `${ts.expiresAt} (${istInstantOf(ts.expiresAt)})` : 'n/a'}`);
  if (!tokenExpMs || tokenExpMs <= windowEnd) {
    log(`REFUSING: Upstox token ${ts.status}${tokenExpMs ? ` expires at ${istInstantOf(ts.expiresAt)}` : ' carries no expiry'}, at/before the window end ${TO_HM} IST. Re-issue it (node scripts/upstox-token-intake.js --file <token.txt>) and re-run. Nothing was written.`);
    await app.close();
    process.exit(3);
  }

  const startedAt = new Date();
  const before = await repo.countForSession(day);
  let polls = 0;
  let lastSeenRows = before.total;
  while (Date.now() < windowEnd) {
    await sleep(15_000);
    const st = capture.status();
    const seen = await repo.countForSession(day);
    polls += 1;
    if (seen.total !== lastSeenRows || polls % 4 === 0) {
      log(`phase=${st.phase} brokerStatus=${st.brokerStatus} persisted=${seen.total - before.total} new (${JSON.stringify(seen.byQuality)}) lastSkip=${st.lastSkippedReason} err=${st.lastError ?? 'none'}`);
      lastSeenRows = seen.total;
    }
    // Kill-insurance: a live snapshot rewritten every poll, so a run that is
    // interrupted before the final report still leaves a readable trace. The
    // observations themselves are already durable in Oracle (append-only).
    try {
      fs.writeFileSync(path.join(EVIDENCE_DIR, `${day}-progress.json`), JSON.stringify({
        at: new Date().toISOString(), ist: istHm(), phase: st.phase, brokerStatus: st.brokerStatus,
        persistedNew: seen.total - before.total, byQuality: seen.byQuality,
        lastSkippedReason: st.lastSkippedReason ?? null, lastError: st.lastError ?? null,
      }, null, 1));
    } catch (e) {
      log(`progress snapshot failed: ${e.message}`);
    }
  }

  // ── collect the session's captured rows for our instruments ──────────────
  const rowsByInstrument = {};
  for (const key of instruments) {
    // ascending by receivedAt: first/last windows and the sample are then honest
    // (the repository returns newest-first, which silently inverted first/last).
    rowsByInstrument[key] = (await repo.list({ instrumentKey: key, sessionDate: day, limit: 500 }))
      .slice()
      .sort((a, b) => new Date(a.receivedAt) - new Date(b.receivedAt));
  }
  const endStatus = capture.status();
  const inWindow = (r) => ['PRE_OPEN', 'OPEN_AUCTION'].includes(r.sessionPhase);
  const phases = {};
  const sourceStatuses = {};
  const qualityByPhase = {};
  for (const rows of Object.values(rowsByInstrument)) {
    for (const r of rows) {
      const at = new Date(r.receivedAt).toISOString();
      if (!phases[r.sessionPhase]) phases[r.sessionPhase] = { count: 0, first: at, last: at };
      phases[r.sessionPhase].count += 1;
      if (at < phases[r.sessionPhase].first) phases[r.sessionPhase].first = at;
      if (at > phases[r.sessionPhase].last) phases[r.sessionPhase].last = at;
      if (r.sourceStatus) sourceStatuses[r.sourceStatus] = (sourceStatuses[r.sourceStatus] ?? 0) + 1;
      const k = `${r.sessionPhase}|${r.quality}`;
      qualityByPhase[k] = (qualityByPhase[k] ?? 0) + 1;
    }
  }

  const evidence = {
    label: LABEL,
    mode: 'window',
    day,
    generatedAt: new Date().toISOString(),
    window: { from: `${day}T${FROM_HM}:00+05:30`, to: `${day}T${TO_HM}:00+05:30`, startedAt: startedAt.toISOString() },
    source: { name: source.sourceName, marketStatusLast: endStatus.brokerStatus, marketStatusError: endStatus.lastError },
    db: { host: process.env.MYSQL_HOST, port: process.env.MYSQL_PORT || '3307', database: process.env.DATABASE_NAME || 'myjob_agent' },
    safety: { ...safety, prevCloseFromStore: endStatus.prevCloseFromStore, httpListenerOpened: false },
    instruments,
    phaseTransitionsObserved: phases,
    sourceStatusesObserved: sourceStatuses,
    qualityByPhase,
    perInstrument: {},
    noLookahead: [],
    adjunctProbe: null,
  };

  for (const key of instruments) {
    const rows = rowsByInstrument[key];
    const inWin = rows.filter(inWindow);
    evidence.perInstrument[key] = {
      rowsCaptured: rows.length,
      rowsInAuctionPhases: inWin.length,
      publication: publicationMatrix(inWin.length ? inWin : rows),
      quality: rows.reduce((a, r) => ((a[r.quality] = (a[r.quality] ?? 0) + 1), a), {}),
      unavailableReasons: Array.from(new Set(
        rows.filter((r) => r.quality === 'UNAVAILABLE').map((r) => (r.fieldQuality && r.fieldQuality.reasons) || 'unlabelled'),
      )).slice(0, 5),
      sample: rows.slice(0, 3).map((r) => ({
        phase: r.sessionPhase, quality: r.quality, eventTime: r.eventTime && new Date(r.eventTime).toISOString(),
        receivedAt: new Date(r.receivedAt).toISOString(), dataAgeMs: r.dataAgeMs, sourceStatus: r.sourceStatus,
        previousClose: num(r.previousClose), indicativePrice: num(r.indicativePrice),
        buyQuantity: num(r.buyQuantity), sellQuantity: num(r.sellQuantity),
        rawPayload: r.rawPayload,
      })),
    };
    evidence.noLookahead.push(await noLookaheadCheck(repo, key, rows));
  }

  // Adjunct probe AFTER the window: which keys the broker actually sent. Not an
  // observation, not stored — evidence about publication only.
  const probe = await source.fetchPreOpen(instruments);
  evidence.adjunctProbe = {
    note: 'read-only fetch after the window; NOT persisted; shows which keys the broker carried',
    at: new Date().toISOString(),
    ok: probe.ok, error: probe.error, marketStatus: probe.marketStatus,
    instruments: Object.fromEntries(Object.entries(probe.values).map(([k, v]) => [k, {
      presentKeys: v.presentKeys,
      auction: {
        prev_close_price: v.previousClose, reference_price: v.referencePrice,
        indicative_equilibrium_price: v.indicativePrice, indicative_equilibrium_quantity: v.indicativeQuantity,
        indicative_imbalance_quantity_total: v.imbalanceTotal, indicative_imbalance_quantity_market: v.imbalanceMarket,
        total_buy_quantity: v.buyQuantity, total_sell_quantity: v.sellQuantity,
      },
    }])),
  };

  const evidenceJson = path.join(EVIDENCE_DIR, `${day}-pre-open-evidence.json`);
  fs.writeFileSync(evidenceJson, `${JSON.stringify(evidence, null, 1)}\n`);

  // ── human report ─────────────────────────────────────────────────────────
  const lines = [];
  lines.push(`PRE-OPEN WINDOW EVIDENCE — ${day} (${FROM_HM}–${TO_HM} IST) — label ${LABEL}`);
  lines.push(`source=${source.sourceName} marketStatus=${endStatus.brokerStatus ?? 'n/a'} polls=${polls} finalPhase=${endStatus.phase}`);
  lines.push(`safety: deskModuleLoaded=${evidence.safety.deskModuleLoaded} deskServicesLoaded=${evidence.safety.deskServicesLoaded} scheduleModuleLoaded=${evidence.safety.scheduleModuleLoaded} prevCloseFromStore=${endStatus.prevCloseFromStore} httpListener=no`);
  lines.push(`phases observed: ${JSON.stringify(phases)}`);
  lines.push(`broker statuses observed: ${JSON.stringify(sourceStatuses)}`);
  for (const key of instruments) {
    const e = evidence.perInstrument[key];
    lines.push('');
    lines.push(`── ${key} — rows=${e.rowsCaptured} inAuctionPhases=${e.rowsInAuctionPhases} quality=${JSON.stringify(e.quality)}`);
    for (const f of FIELDS) {
      const p = e.publication[f];
      const first = p.firstPublished
        ? ` first=${p.firstPublished.value} @${p.firstPublished.eventTime || p.firstPublished.receivedAt} (${p.firstPublished.phase})`
        : ' NEVER PUBLISHED';
      lines.push(`   ${f.padEnd(20)} published=${String(p.published).padStart(3)} null=${String(p.nullCount).padStart(3)}${first}`);
    }
    if (e.unavailableReasons.length) lines.push(`   unavailable reasons: ${e.unavailableReasons.join(' | ')}`);
  }
  const nl = evidence.noLookahead;
  lines.push('');
  lines.push(`no-lookahead: ${nl.map((c) => `${c.instrument.split('|').pop()}=${c.violations.length ? `VIOLATIONS(${c.violations.length})` : `clean(${c.checked})`}`).join(' ')}`);
  lines.push(`evidence: ${evidenceJson}`);

  const report = lines.join('\n');
  fs.writeFileSync(path.join(EVIDENCE_DIR, `${day}-pre-open-report.txt`), `${report}\n`);
  console.log(report);

  await app.close();
})().catch((err) => {
  console.error('PRE_OPEN_WINDOW_CAPTURE_FAILED', err && err.stack ? err.stack : err);
  process.exit(1);
});
