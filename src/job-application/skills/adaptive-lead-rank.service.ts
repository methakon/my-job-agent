import { Injectable } from '@nestjs/common';
import { JobLead } from '../../leads/job-lead.entity';
import { AdaptationVerdict, AdaptationMatcherService } from './adaptation-matcher.service';

/**
 * JA-014 adaptive lead ranking.
 *
 * Takes a set of already-evaluated leads (each with a profile + AdaptationVerdict)
 * and returns them ranked by composite fit, with gap severity breaking ties.
 *
 * Pure ranking logic over prefetched verdicts — no I/O, no new DB queries.
 * The caller (p5 ApplyEngine / p6 AutoApplyLoop) is responsible for fetching
 * leads, profiles, and producing AdaptationVerdict for each pair.
 */

export interface RankedLead {
  readonly lead: JobLead;
  readonly verdict: AdaptationVerdict;
  readonly rank: number;            // 1-based, lower = better
  readonly rankReason: string;      // why this position
  readonly action: 'apply' | 'review' | 'skip';
}

@Injectable()
export class AdaptiveLeadRankerService {
  constructor(private readonly matcher: AdaptationMatcherService) {}

  /**
   * Rank a batch of (lead, verdict) pairs.
   *
   * Rules:
   *  - fitScore descending is the primary order.
   *  - Among equal fitScore bands, transferable-skill count breaks ties upward.
   *  - BLOCKING verdicts always rank below any non-blocking.
   *  - NO-GO verdicts are flagged for skip but not dropped — caller decides.
   *
   * Deterministic: same input array → same ranked output (stable sort).
   */
  rank(entries: Array<{ lead: JobLead; verdict: AdaptationVerdict }>): RankedLead[] {
    const scored = entries.map(e => this.scoreEntry(e));
    // stable sort: higher fitScore first, then more transferable, then lower gap severity rank
    scored.sort((a, b) => {
      const aScore = a.verdict.fitScore;
      const bScore = b.verdict.fitScore;
      if (bScore !== aScore) return bScore - aScore;
      if (b.verdict.transferable.length !== a.verdict.transferable.length) {
        return b.verdict.transferable.length - a.verdict.transferable.length;
      }
      return severityRank(a.verdict.gapSeverity) - severityRank(b.verdict.gapSeverity);
    });
    return scored.map((e, i) => ({ ...e, rank: i + 1 }));
  }

  /**
   * Single-entry convenience: rank one lead among nothing — returns rank 1.
   */
  rankOne(lead: JobLead, verdict: AdaptationVerdict): RankedLead {
    return { lead, verdict, rank: 1, rankReason: 'only entry in batch', action: this.decideAction(verdict) };
  }

  // ---- internal ----

  private scoreEntry(entry: { lead: JobLead; verdict: AdaptationVerdict }): RankedLead {
    const v = entry.verdict;
    const action = this.decideAction(v);
    const reason = this.reasonFor(v, entry.lead);
    return { lead: entry.lead, verdict: v, rank: 0, rankReason: reason, action };
  }

  private decideAction(v: AdaptationVerdict): 'apply' | 'review' | 'skip' {
    if (v.applyReadiness === 'no-go') return 'skip';
    if (v.applyReadiness === 'ready') return 'apply';
    // partial | risky → review
    return 'review';
  }

  private reasonFor(v: AdaptationVerdict, lead: JobLead): string {
    const parts: string[] = [];
    parts.push(`fitScore ${v.fitScore}`);
    parts.push(`gap ${v.gapSeverity}`);
    parts.push(`readiness ${v.applyReadiness}`);
    if (v.mustMissing.length) parts.push(`${v.mustMissing.length} must-have missing`);
    if (v.preferredMissing.length && v.gapSeverity !== 'BLOCKING') parts.push(`${v.preferredMissing.length} preferred missing`);
    if (v.transferable.length) parts.push(`${v.transferable.length} transferable`);
    if (v.reasons.length) parts.push(v.reasons.slice(0, 2).join('; '));
    return `(${parts.join(' | ')})`;
  }
}

function severityRank(s: AdaptationVerdict['gapSeverity']): number {
  return { NONE: 0, MINOR: 1, MODERATE: 2, MAJOR: 3, BLOCKING: 4, UNKNOWN: 5 }[s] ?? 3;
}
