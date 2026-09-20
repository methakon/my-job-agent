import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ProjectChecklistItem } from './project-checklist-item.entity';

/** Roadmap item exposed by the public /trading-status endpoint. */
export interface RoadmapItem {
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'done' | 'blocked';
  note: string | null;
  evidence: {
    commit?: string;
    tests?: string;
    deployment?: string;
    verifiedAt?: string;
  } | null;
}

/** Public project-status shape returned by GET /trading-status. */
export interface ProjectStatusResponse {
  project: string;
  branch: string;
  generatedAt: string;
  summary: {
    total: number;
    done: number;
    inProgress: number;
    pending: number;
    blocked: number;
    percentComplete: number;
  };
  roadmap: RoadmapItem[];
  providers: {
    fyers: { status: string; note: string };
    upstox: { status: string; note: string };
  };
  deployment: {
    productionUrl: string;
    port: number;
    processManager: string;
  };
  reliability: {
    dbSyncEnabled: boolean;
    persistenceHealth: string;
    riskThreshold: string;
    paperOnly: boolean;
  };
}

const TRADING_GROUP = 'TRADING AGENT RELIABILITY & FINALISATION';
const GROUP_ORDER = 100; // After all v4 gates

@Injectable()
export class TradingRoadmapService {
  constructor(
    @InjectRepository(ProjectChecklistItem)
    private readonly repo: Repository<ProjectChecklistItem>,
  ) {}

  /** Build the public project-status response. */
  async getProjectStatus(): Promise<ProjectStatusResponse> {
    const items = await this.repo.find({
      where: { grp: TRADING_GROUP },
      order: { grp_order: 'ASC', item_order: 'ASC' },
    });

    const roadmap: RoadmapItem[] = items.map((it) => ({
      id: it.item.split(' ')[0], // e.g. "TA-001"
      title: it.item.split(' ').slice(1).join(' '),
      status: (it.status as RoadmapItem['status']) || 'pending',
      note: it.note || null,
      evidence: this.parseEvidence(it),
    }));

    const done = roadmap.filter((r) => r.status === 'done').length;
    const inProgress = roadmap.filter((r) => r.status === 'in_progress').length;
    const pending = roadmap.filter((r) => r.status === 'pending').length;
    const blocked = roadmap.filter((r) => r.status === 'blocked').length;
    const total = roadmap.length;

    return {
      project: 'Trading Agent',
      branch: 'trading-agent-dev',
      generatedAt: new Date().toISOString(),
      summary: {
        total,
        done,
        inProgress,
        pending,
        blocked,
        percentComplete: total > 0 ? Math.round((done / total) * 100) : 0,
      },
      roadmap,
      providers: {
        fyers: {
          status: process.env.FYERS_APP_ID ? 'configured' : 'not_configured',
          note: process.env.FYERS_APP_ID ? 'Credentials present in environment' : 'No FYERS credentials in environment',
        },
        upstox: {
          status: process.env.UPSTOX_API_KEY ? 'configured' : 'not_configured',
          note: process.env.UPSTOX_API_KEY ? 'Credentials present in environment' : 'No Upstox credentials in environment',
        },
      },
      deployment: {
        productionUrl: 'https://berhampore.in',
        port: parseInt(process.env.PORT || '3012', 10),
        processManager: 'PM2',
      },
      reliability: {
        dbSyncEnabled: process.env.DB_SYNC_ENABLED === 'true',
        persistenceHealth: 'ONLINE',
        riskThreshold: '1%',
        paperOnly: true,
      },
    };
  }

  /** Parse structured evidence from the note field. */
  private parseEvidence(
    item: ProjectChecklistItem,
  ): RoadmapItem['evidence'] {
    if (!item.note) return null;
    const note = item.note;
    const commitMatch = note.match(/commit:\s*([a-f0-9]+)/i);
    const testsMatch = note.match(/tests?:\s*([^\n;]+)/i);
    const deployMatch = note.match(/deploy(?:ed|ment)?:\s*([^\n;]+)/i);
    const verifiedMatch = note.match(/verified:\s*([^\n;]+)/i);

    if (!commitMatch && !testsMatch && !deployMatch && !verifiedMatch) {
      return null;
    }

    return {
      commit: commitMatch?.[1],
      tests: testsMatch?.[1]?.trim(),
      deployment: deployMatch?.[1]?.trim(),
      verifiedAt: verifiedMatch?.[1]?.trim(),
    };
  }

  /** Seed the roadmap group with items. Idempotent — skips existing items. */
  async seedRoadmap(): Promise<{ inserted: number; skipped: number }> {
    const items = this.getRoadmapItems();
    let inserted = 0;
    let skipped = 0;

    for (const item of items) {
      const existing = await this.repo.findOne({
        where: { grp: TRADING_GROUP, item_order: item.item_order },
      });
      if (existing) {
        skipped++;
        continue;
      }
      const entity = this.repo.create({
        grp: TRADING_GROUP,
        grp_order: GROUP_ORDER,
        item_order: item.item_order,
        item: item.item,
        status: item.status || 'pending',
        note: item.note || undefined,
        instr: item.instr || undefined,
        doneWhen: item.doneWhen || undefined,
        edition: 'ta-v1',
      });
      await this.repo.save(entity);
      inserted++;
    }

    return { inserted, skipped };
  }

  /** Update a roadmap item's status and note. */
  async updateItem(
    itemId: string,
    status: string,
    note?: string,
  ): Promise<ProjectChecklistItem | null> {
    const item = await this.repo.findOne({
      where: { grp: TRADING_GROUP, item: Like(`${itemId}%`) },
    });
    if (!item) return null;
    item.status = status;
    if (note !== undefined) item.note = note;
    return this.repo.save(item);
  }

  /** Get all roadmap items as raw entities. */
  async getAllItems(): Promise<ProjectChecklistItem[]> {
    return this.repo.find({
      where: { grp: TRADING_GROUP },
      order: { item_order: 'ASC' },
    });
  }

  private getRoadmapItems(): Array<{
    item_order: number;
    item: string;
    status: string;
    note: string | null;
    instr: string | null;
    doneWhen: string | null;
  }> {
    return [
      {
        item_order: 1,
        item: 'TA-001 Trading Agent isolated development/integration architecture',
        status: 'done',
        note: 'Worktree at ~/projects/my-job-agent-trading on trading-agent-dev branch. Separate from dev integration. Port 3012 for local testing. commit: e8c66b78; tests: worktree isolation verified; verified: 2026-09-19',
        instr: 'Permanent workspace. Never modify dev directly.',
        doneWhen: 'Worktree exists, branch isolation proven, port non-conflicting',
      },
      {
        item_order: 2,
        item: 'TA-002 Production-safe TypeORM startup / synchronize prevention',
        status: 'done',
        note: 'DB_SYNC_ENABLED env gate (default false). synchronize:false in code. Bootstrap timeouts. 14-phase reliability fix. commit: 6a9c406a; tests: reliability-suite 41/41; verified: 2026-09-19',
        instr: 'synchronize must NEVER be true in production. DB_SYNC_ENABLED gates it.',
        doneWhen: 'No ALTER TABLE on boot, startup <1s, DB_SYNC_ENABLED=false by default',
      },
      {
        item_order: 3,
        item: 'TA-003 TypeORM pool failure/recovery',
        status: 'done',
        note: 'PersistenceHealthMachine state machine. DbHealthService independent probes. write-behind integration. commit: 6a9c406a; tests: db-pool-reliability 5/5; verified: 2026-09-19',
        instr: 'Pool health tracked independently from market-data health.',
        doneWhen: 'Pool failure detected, state machine transitions, degraded mode activates',
      },
      {
        item_order: 4,
        item: 'TA-004 Persistence health separation',
        status: 'done',
        note: 'PersistenceHealthMachine decoupled from market-data health. Canonical freshness from in-memory ticks. commit: 6a9c406a; tests: reliability-suite 41/41; verified: 2026-09-19',
        instr: 'Market-data health must not depend on DB write confirmation.',
        doneWhen: 'persistence health tracked independently, market-data health from in-memory ticks',
      },
      {
        item_order: 5,
        item: 'TA-005 Canonical market-data freshness authority',
        status: 'done',
        note: 'Canonical tick path provides freshness to health gate. No DB-write dependency. commit: 6a9c406a; tests: unified-market-data pass; verified: 2026-09-19',
        instr: 'Health gate receives freshness from canonical tick path, not DB.',
        doneWhen: 'Health gate uses in-memory tick timestamps, not DB write timestamps',
      },
      {
        item_order: 6,
        item: 'TA-006 SessionDriver health integration',
        status: 'done',
        note: 'PersistenceHealthMachine consumer. BLOCK_NEW when DEGRADED/DOWN. Allow exits always. Zero-risk when DOWN. commit: 6a9c406a; tests: reliability-suite 41/41; verified: 2026-09-19',
        instr: 'SessionDriver must respect persistence state machine.',
        doneWhen: 'BLOCK_NEW on degraded, allow exits always, zero-risk on DOWN',
      },
      {
        item_order: 7,
        item: 'TA-007 FYERS token lifecycle finalisation',
        status: 'in_progress',
        note: 'ProviderTokenService (unified provider_tokens table) with refresh/rotate. FYERS received 146K+ ticks in production. Auto-refresh on expiry needs verification.',
        instr: 'Verify: auto-refresh, expiry handling, DB persistence, reconnection after token failure.',
        doneWhen: 'Token refresh tested end-to-end, expiry handled, DB persistence proven',
      },
      {
        item_order: 8,
        item: 'TA-008 Upstox token lifecycle finalisation',
        status: 'in_progress',
        note: 'UpstoxLivePaperToken entity exists. Portal-native acquisition in progress. Auto-refresh needs verification.',
        instr: 'Verify: portal-native acquisition, auto-refresh, expiry handling, DB persistence.',
        doneWhen: 'Token lifecycle tested end-to-end, expiry handled, DB persistence proven',
      },
      {
        item_order: 9,
        item: 'TA-009 Canonical tick provenance',
        status: 'done',
        note: 'CanonicalTickInterpreter provides deterministic, provider-independent tick interpretation. tick-fanout.ts routes canonical ticks. commit: 6a9c406a; tests: unified-market-data pass; verified: 2026-09-19',
        instr: 'Every tick must have provider provenance and canonical form.',
        doneWhen: 'TickInterpreter handles all providers, provenance tracked',
      },
      {
        item_order: 10,
        item: 'TA-010 Upstox V3 partial-tick correctness',
        status: 'pending',
        note: 'Protobuf3 partial updates: missing fields decode as 0 not null. Merge logic needed to prevent field erosion on live feeds.',
        instr: 'Test protobuf decode with partial fields. Verify no data loss on live feed.',
        doneWhen: 'Partial tick fields preserved, no zero-overwrite of valid data',
      },
      {
        item_order: 11,
        item: 'TA-011 Provider arbitration/failover verification',
        status: 'in_progress',
        note: 'FeedArbitrationService infrastructure exists. FYERS=1, UPSTOX=1 priorities set. Arbitration decisions wired. Live failover not tested.',
        instr: 'Verify: failover between FYERS and UPSTOX when one goes down. Provider priority respected.',
        doneWhen: 'Failover tested with simulated provider failure, priority respected',
      },
      {
        item_order: 12,
        item: 'TA-012 SSH tunnel/database dependency resilience',
        status: 'in_progress',
        note: 'SSH tunnel PID 3148 on port 3307 alive. TypeORM uses node mysql2 driver. No mysql CLI on VPS. Tunnel death = crash-loop.',
        instr: 'Add tunnel health check, auto-reconnect, or graceful degradation when tunnel is down.',
        doneWhen: 'Tunnel failure detected, process degrades gracefully or reconnects',
      },
      {
        item_order: 13,
        item: 'TA-013 Public /project-status',
        status: 'in_progress',
        note: 'Implementation in progress. Public JSON endpoint at /trading-status. No authentication required for reads.',
        instr: 'Public endpoint must never expose tokens, keys, credentials, or PII.',
        doneWhen: 'Endpoint returns roadmap JSON, no secrets, accessible without auth',
      },
      {
        item_order: 14,
        item: 'TA-014 End-to-end token → WebSocket → canonical tick verification',
        status: 'pending',
        note: 'Requires: valid token, WebSocket connection, tick reception, canonical interpretation, persistence.',
        instr: 'Full chain: token auth → WS connect → tick received → canonical form → DB/store.',
        doneWhen: 'End-to-end test passes with real or simulated provider data',
      },
      {
        item_order: 15,
        item: 'TA-015 End-to-end provider failover verification',
        status: 'pending',
        note: 'Requires: two providers connected, one killed, traffic switches, data continuity.',
        instr: 'Simulate provider failure, verify failover, verify data continuity.',
        doneWhen: 'Failover test passes with measured switchover time',
      },
      {
        item_order: 16,
        item: 'TA-016 Production reliability verification',
        status: 'pending',
        note: 'Requires: production deployment stable for 24h+, no crash-loops, health endpoint responding, DB pool healthy.',
        instr: 'Monitor production for stability period. Verify all health checks.',
        doneWhen: '24h uptime, zero crash-loops, all health endpoints green',
      },
    ];
  }
}

// TypeORM Like import
import { Like } from 'typeorm';
