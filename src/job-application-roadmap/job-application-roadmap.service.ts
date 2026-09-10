import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JobApplicationRoadmapItem } from './job-application-roadmap-item.entity';
import SEED from './job-application-roadmap.seed.json';

/**
 * Separate control-plane service for the Job Application Agent roadmap.
 *
 * This runs AGAINST a different table (`job_application_roadmap_items`, via the
 * new entity) from the Trading `/project-status` checklist (`project_checklist_items`).
 * The two must never be read/written through one another.
 *
 * Seeding is deliberately one-shot and idempotent: rows whose
 * (roadmapIdentity, itemId) pair already exist are left untouched, so re-deploys
 * never clobber operator edits.
 */
@Injectable()
export class JobApplicationRoadmapService implements OnModuleInit {
  constructor(
    @InjectRepository(JobApplicationRoadmapItem)
    private readonly repo: Repository<JobApplicationRoadmapItem>,
  ) {}

  async onModuleInit() {
    await this.ensureSeeded();
  }

  // ---- idempotent seed ----

  async ensureSeeded() {
    return this.ensureSeededInternal();
  }

  private async ensureSeededInternal() {
    const existing = await this.repo.find({
      select: ['itemId'],
      where: { roadmapIdentity: JOB_APP_ROADMAP_IDENTITY },
    });
    const existingIds = new Set(existing.map((r) => r.itemId));
    const toInsert: Partial<JobApplicationRoadmapItem>[] = [];

    for (const phase of SEED) {
      for (let i = 0; i < phase.items.length; i++) {
        const it = phase.items[i];
        if (!existingIds.has(it.itemId)) {
          toInsert.push({
            roadmapIdentity: JOB_APP_ROADMAP_IDENTITY,
            phase: phase.phase,
            phaseOrder: phase.phaseOrder,
            goal: phase.goal ?? '',
            itemOrder: i + 1,
            itemId: it.itemId,
            item: it.item,
            status: it.status ?? 'pending',
            priority: it.priority ?? 'p1',
            doneWhen: it.doneWhen ?? null,
            instr: it.instr ?? null,
            edition: 'v1',
          });
        }
      }
    }

    if (toInsert.length) {
      await this.repo.save(toInsert as JobApplicationRoadmapItem[]);
    }

    return toInsert.length;
  }

  // ---- identity / metadata ----

  static readonly IDENTITY = 'my-job-agent-job-application';
  static readonly NAME = 'JOB APPLICATION AGENT ROADMAP';

  // ---- reads ----

  async findAll(): Promise<JobApplicationRoadmapItem[]> {
    return this.repo.find({
      where: { roadmapIdentity: JOB_APP_ROADMAP_IDENTITY },
      order: { phaseOrder: 'ASC', itemOrder: 'ASC' },
    });
  }

  async findOneByItemId(itemId: string): Promise<JobApplicationRoadmapItem | null> {
    return this.repo.findOne({ where: { roadmapIdentity: JOB_APP_ROADMAP_IDENTITY, itemId } });
  }

  async findOneById(id: number): Promise<JobApplicationRoadmapItem | null> {
    return this.repo.findOne({ where: { id } });
  }

  // ---- mutations ----

  async setStatus(
    itemId: string,
    status: string,
    evidence: string,
    commitSha: string,
    verifiedAt?: string,
  ): Promise<JobApplicationRoadmapItem> {
    const allowed = new Set(['pending', 'in_progress', 'done', 'blocked']);
    if (!allowed.has(status)) {
      throw new Error(`Invalid roadmap status "${status}". Allowed: ${[...allowed].join(', ')}`);
    }

    if (status === 'done') {
      if (!evidence || evidence.trim().length === 0) {
        throw new Error('done requires non-empty evidence');
      }
      if (!commitSha || commitSha.trim().length === 0) {
        throw new Error('done requires a commit SHA');
      }
    }

    const item = await this.findOneByItemId(itemId);
    if (!item) {
      throw new Error(`Job Application roadmap row not found: ${itemId}`);
    }

    item.status = status;

    const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const block = `[${ts}] ${evidence}`;
    if (item.note && item.note.length > 0) {
      const combined = `${item.note}\n\n${block}`;
      item.note = combined.length > 500 ? combined.slice(-500) : combined;
    } else {
      item.note = block;
    }

    if (commitSha.trim().length > 0) {
      item.lastCommitSha = commitSha.trim();
    }

    if (verifiedAt) {
      const d = new Date(verifiedAt);
      if (!isNaN(d.getTime())) {
        item.lastVerifiedAt = d;
      } else {
        item.lastVerifiedAt = new Date();
      }
    } else {
      item.lastVerifiedAt = new Date();
    }

    return this.repo.save(item);
  }

  async appendNote(itemId: string, note: string): Promise<JobApplicationRoadmapItem> {
    const row = await this.findOneByItemId(itemId);
    if (!row) {
      throw new Error(`Job Application roadmap row not found: ${itemId}`);
    }
    if (!note || note.trim().length === 0) {
      throw new Error('note must be non-empty');
    }
    const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const block = `[${ts}] ${note}`;
    if (row.note && row.note.length > 0) {
      const combined = `${row.note}\n\n${block}`;
      row.note = combined.length > 500 ? combined.slice(-500) : combined;
    } else {
      row.note = block;
    }
    row.lastVerifiedAt = new Date();
    return this.repo.save(row);
  }

  async clearEvidence(itemId: string): Promise<JobApplicationRoadmapItem> {
    const row = await this.findOneByItemId(itemId);
    if (!row) {
      throw new Error(`Job Application roadmap row not found: ${itemId}`);
    }
    row.note = '';
    row.lastVerifiedAt = null as any;
    row.lastCommitSha = '';
    return this.repo.save(row);
  }
}

const JOB_APP_ROADMAP_IDENTITY = JobApplicationRoadmapService.IDENTITY;
