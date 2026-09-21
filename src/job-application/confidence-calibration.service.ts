/**
 * JA-054 — Confidence Calibration
 *
 * doneWhen: "Calibration metrics are available and monitored."
 *
 * Compare predicted confidence with outcomes; track calibration,
 * false positives, false negatives and uncertainty.
 */

import { Injectable } from '@nestjs/common';

export interface CalibrationEntry {
  id?: string;
  predictionId?: string;
  predictedConfidence: number;
  predictedLabel?: 'positive' | 'negative' | 'neutral';
  outcome?: 'positive' | 'negative' | 'pending';
  outcomeAt?: string;
  features?: Record<string, number | string>;
  recordedAt: string;
}

export interface CalibrationMetrics {
  totalPredictions: number;
  resolvedPredictions: number;
  avgPredictedConfidence: number;
  actualPositiveRate: number;
  calibrationError: number;
  brierScore: number;
  falsePositiveRate: number;
  falseNegativeRate: number;
  calibrated: boolean;
  uncertaintyLevel: 'low' | 'medium' | 'high';
}

@Injectable()
export class ConfidenceCalibrationService {
  private entries: Map<string, CalibrationEntry> = new Map();

  record(entry: Partial<CalibrationEntry>): CalibrationEntry {
    const now = new Date().toISOString();
    const e: CalibrationEntry = {
      ...entry,
      id: entry.id || `cal-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      predictedConfidence: entry.predictedConfidence ?? 0.5,
      predictedLabel: entry.predictedLabel || 'neutral',
      recordedAt: now,
    };
    this.entries.set(e.id || 'x', e);
    return e;
  }

  resolve(id: string, outcome: 'positive' | 'negative'): CalibrationEntry | undefined {
    const e = this.entries.get(id);
    if (!e) return undefined;
    e.outcome = outcome;
    e.outcomeAt = new Date().toISOString();
    return e;
  }

  computeMetrics(): CalibrationMetrics {
    const list = Array.from(this.entries.values());
    const resolved = list.filter(e => e.outcome);
    const total = list.length;
    const resolvedCount = resolved.length;

    let sumConf = 0, sumSquaredErr = 0;
    let fp = 0, fn = 0, tp = 0, tn = 0;

    for (const e of list) {
      sumConf += e.predictedConfidence;
      if (e.outcome) {
        const predPositive = e.predictedLabel === 'positive';
        const actualPositive = e.outcome === 'positive';
        const err = e.predictedConfidence - (actualPositive ? 1 : 0);
        sumSquaredErr += err * err;

        if (predPositive && actualPositive) tp++;
        else if (predPositive && !actualPositive) fp++;
        else if (!predPositive && actualPositive) fn++;
        else tn++;
      }
    }

    const avgConf = total > 0 ? sumConf / total : 0;
    const actualPosRate = resolvedCount > 0 ? resolved.filter(e => e.outcome === 'positive').length / resolvedCount : 0;
    const calibrationError = resolvedCount > 0 ? sumSquaredErr / resolvedCount : 0;
    const brierScore = resolvedCount > 0 ? sumSquaredErr / resolvedCount : 0;

    const fpRate = (tp + fp) > 0 ? fp / (tp + fp) : 0;
    const fnRate = (tn + fn) > 0 ? fn / (tn + fn) : 0;

    const gap = Math.abs(avgConf - actualPosRate);
    const calibrated = resolvedCount >= 10 && gap < 0.15;

    let uncertainty: 'low' | 'medium' | 'high' = 'low';
    if (resolvedCount < 5) uncertainty = 'high';
    else if (resolvedCount < 20 || gap > 0.1) uncertainty = 'medium';

    return {
      totalPredictions: total,
      resolvedPredictions: resolvedCount,
      avgPredictedConfidence: avgConf,
      actualPositiveRate: actualPosRate,
      calibrationError,
      brierScore,
      falsePositiveRate: fpRate,
      falseNegativeRate: fnRate,
      calibrated,
      uncertaintyLevel: uncertainty,
    };
  }

  getCount(): number {
    return this.entries.size;
  }
}
