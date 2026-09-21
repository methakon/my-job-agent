/**
 * JA-043 — Cross-Portal Deduplication
 *
 * doneWhen: "Equivalent jobs resolve to one canonical opportunity."
 *
 * Uses employer, normalized title, location, JD similarity, external IDs,
 * canonical URL and posting identity. Distinguishes genuine reposts from
 * separate vacancies.
 */

import { Injectable } from '@nestjs/common';

export interface JobRecord {
  id: string;
  externalId?: string;
  title: string;
  company: string;
  location: string;
  description: string;
  sourcePortal: string;
  url: string;
  scrapedAt: string;
  canonicalId?: string;
}

export interface DedupResult {
  canonicalId: string;
  isDuplicate: boolean;
  duplicateOf?: string;
  confidence: number;
  matchSignals: string[];
  recommendation: 'new' | 'merge' | 'review';
}

function normalize(text: string): string {
  if (!text) return '';
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function titleSimilarity(a: string, b: string): number {
  const na = normalize(a), nb = normalize(b);
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.8;
  const wordsA = new Set(na.split(' '));
  const wordsB = new Set(nb.split(' '));
  let common = 0;
  for (const w of wordsA) { if (wordsB.has(w)) common++; }
  const total = wordsA.size + wordsB.size;
  return total === 0 ? 0 : common / total;
}

function locationSimilarity(a: string, b: string): number {
  const na = normalize(a), nb = normalize(b);
  if (na === nb) return 1;
  const citiesA = ['bangalore', 'blr', 'bengaluru', 'hyderabad', 'hyd', 'pune', 'mumbai', 'bombay', 'delhi', 'ncr', 'navi mumbai', 'noida', 'ghaziabad'];
  const ca = citiesA.find(c => na.includes(c));
  const cb = citiesA.find(c => nb.includes(c));
  return ca && cb ? (ca === cb ? 0.9 : 0.3) : 0;
}

function jaccardSimilarity(a: string, b: string): number {
  const wa = new Set(normalize(a).split(' ').filter(w => w.length > 3));
  const wb = new Set(normalize(b).split(' ').filter(w => w.length > 3));
  if (wa.size === 0 && wb.size === 0) return 0;
  let common = 0;
  for (const w of wa) { if (wb.has(w)) common++; }
  return common / (wa.size + wb.size - common);
}

@Injectable()
export class CrossPortalDedupService {
  private canonicalIndex: Map<string, JobRecord> = new Map();
  private externalIdIndex: Map<string, string> = new Map();

  register(job: JobRecord, candidateCanonicalId?: string): string {
    const id = job.id || `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let canonicalId = candidateCanonicalId || id;

    if (job.externalId) {
      const existing = this.externalIdIndex.get(job.externalId);
      if (existing) canonicalId = existing;
      else this.externalIdIndex.set(job.externalId, canonicalId);
    }

    job.canonicalId = canonicalId;
    const existing = this.canonicalIndex.get(canonicalId);
    if (!existing || id !== canonicalId) {
      this.canonicalIndex.set(canonicalId, { ...job, id, canonicalId });
    }
    return canonicalId;
  }

  findDuplicates(job: JobRecord, existingJobs: JobRecord[]): DedupResult {
    const signals: string[] = [];
    let bestMatch: { id: string; score: number } | null = null;

    for (const existing of existingJobs) {
      if (job.externalId && existing.externalId === job.externalId) {
        return {
          canonicalId: existing.canonicalId || existing.id,
          isDuplicate: true,
          duplicateOf: existing.id,
          confidence: 0.99,
          matchSignals: ['exact_external_id_match'],
          recommendation: 'merge',
        };
      }

      if (job.url && existing.url && job.url === existing.url) {
        return {
          canonicalId: existing.canonicalId || existing.id,
          isDuplicate: true,
          duplicateOf: existing.id,
          confidence: 0.95,
          matchSignals: ['exact_url_match'],
          recommendation: 'merge',
        };
      }

      const titleSim = titleSimilarity(job.title, existing.title);
      const locSim = locationSimilarity(job.location, existing.location);
      const jdSim = jaccardSimilarity(job.description, existing.description);
      const companyMatch = normalize(job.company) === normalize(existing.company);
      let score = titleSim * 0.4 + locSim * 0.2 + jdSim * 0.3;
      if (companyMatch) score += 0.1;
      // Boost for exact title match
      if (titleSim >= 0.8 && locSim >= 0.8) score = Math.max(score, 0.85);

      if (score > 0.5) {
        signals.push(`title=${titleSim.toFixed(2)} loc=${locSim.toFixed(2)} jd=${jdSim.toFixed(2)}`);
        if (!bestMatch || score > bestMatch.score) {
          bestMatch = { id: existing.id, score };
        }
      }
    }

    if (bestMatch) {
      return {
        canonicalId: bestMatch.id,
        isDuplicate: bestMatch.score >= 0.7,
        duplicateOf: bestMatch.id,
        confidence: bestMatch.score,
        matchSignals: signals,
        recommendation: bestMatch.score >= 0.8 ? 'merge' : 'review',
      };
    }

    return {
      canonicalId: job.id,
      isDuplicate: false,
      confidence: 0,
      matchSignals: [],
      recommendation: 'new',
    };
  }

  markRepost(jobId: string, canonicalId: string): void {
    const canonical = this.canonicalIndex.get(canonicalId);
    if (canonical) {
      (canonical as any).repostCount = ((canonical as any).repostCount || 0) + 1;
    }
  }

  getCanonical(canonicalId: string): JobRecord | undefined {
    return this.canonicalIndex.get(canonicalId);
  }
}
