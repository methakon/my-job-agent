/**
 * JA-092 — KPI Dashboard
 *
 * doneWhen: "Core KPIs are computed, cached, and available via API with SLA."
 */

import { Injectable } from '@nestjs/common';

export type KPIType = 'applications_tracked' | 'interview_rate' | 'offer_rate' | 'acceptance_rate' | 'response_rate' | 'time_to_interview' | 'time_to_offer' | 'rejection_rate' | 'coverage' | 'deduplication_savings';
export type KPIScope = 'daily' | 'weekly' | 'monthly' | 'all_time';
export type KPITrend = 'up' | 'down' | 'stable' | 'insufficient_data';

export interface KPIValue {
  kpi: KPIType;
  value: number;
  scope: KPIScope;
  computedAt: string;
  previousValue?: number;
  trend: KPITrend;
  sampleSize: number;
  lastDataPoint?: string;
}

export interface DashboardSnapshot {
  id?: string;
  generatedAt: string;
  scope: KPIScope;
  kpis: KPIValue[];
  summary: string;
  topMovers: { kpi: KPIType; trend: KPITrend; change: number }[];
}

@Injectable()
export class KPIDashboardService {
  private kpiHistory: Map<string, { value: number; at: string; scope: KPIScope }[]> = new Map();
  private snapshots: Map<string, DashboardSnapshot> = new Map();

  record(kpi: KPIType, value: number, scope: KPIScope = 'daily', timestamp?: string): void {
    const at = timestamp || new Date().toISOString();
    if (!this.kpiHistory.has(kpi)) this.kpiHistory.set(kpi, []);
    this.kpiHistory.get(kpi)!.push({ value, at, scope });
  }

  compute(kpi: KPIType, scope: KPIScope = 'daily'): KPIValue {
    const history = this.kpiHistory.get(kpi) || [];
    const filtered = scope === 'all_time' ? history : history.filter(h => h.scope === scope);
    const values = filtered.map(h => h.value);

    const current = values.length > 0 ? values[values.length - 1] : 0;
    const previous = values.length > 1 ? values[values.length - 2] : undefined;

    let trend: KPITrend = 'insufficient_data';
    if (previous !== undefined && current !== undefined) {
      if (current > previous * 1.05) trend = 'up';
      else if (current < previous * 0.95) trend = 'down';
      else trend = 'stable';
    } else if (values.length >= 2) {
      trend = 'stable';
    }

    const sampleSize = filtered.length;

    return {
      kpi,
      value: current,
      scope,
      computedAt: new Date().toISOString(),
      previousValue: previous,
      trend,
      sampleSize,
      lastDataPoint: filtered.length > 0 ? filtered[filtered.length - 1].at : undefined,
    };
  }

  getKPI(kpi: KPIType, scope: KPIScope = 'daily'): KPIValue | undefined {
    return this.compute(kpi, scope);
  }

  getDashboard(scope: KPIScope = 'daily'): DashboardSnapshot {
    const kpis: KPIType[] = [
      'applications_tracked', 'interview_rate', 'offer_rate', 'acceptance_rate',
      'response_rate', 'time_to_interview', 'time_to_offer', 'rejection_rate',
      'coverage', 'deduplication_savings',
    ];

    const kpiValues = kpis.map(k => this.compute(k, scope));
    const topMovers = kpiValues
      .filter(k => k.trend !== 'insufficient_data' && k.previousValue !== undefined)
      .sort((a, b) => Math.abs((b.value || 0) - (b.previousValue || 0)) - Math.abs((a.value || 0) - (a.previousValue || 0)))
      .slice(0, 3)
      .map(k => ({
        kpi: k.kpi,
        trend: k.trend,
        change: k.previousValue !== undefined ? Math.round((k.value - k.previousValue) * 100) / 100 : 0,
      }));

    const summary = `Dashboard: ${kpiValues.filter(k => k.sampleSize > 0).length}/${kpis.length} KPIs computed. ` +
      `${kpiValues.filter(k => k.trend === 'up').length} trending up, ${kpiValues.filter(k => k.trend === 'down').length} trending down.`;

    const snap: DashboardSnapshot = {
      id: `snap-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      generatedAt: new Date().toISOString(),
      scope,
      kpis: kpiValues,
      summary,
      topMovers,
    };

    this.snapshots.set(snap.id || 'x', snap);
    return snap;
  }

  getSnapshot(id: string): DashboardSnapshot | undefined {
    return this.snapshots.get(id);
  }

  getRecentSnapshots(limit: number = 10): DashboardSnapshot[] {
    return Array.from(this.snapshots.values())
      .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))
      .slice(0, limit);
  }

  getTrend(kpi: KPIType, scope: KPIScope = 'daily'): KPITrend {
    const kpiValue = this.compute(kpi, scope);
    return kpiValue?.trend || 'insufficient_data';
  }

  getSummaryStats(): { totalKPIs: number; computed: number; withData: number; trendingUp: number; trendingDown: number } {
    const dash = this.getDashboard('daily');
    return {
      totalKPIs: dash.kpis.length,
      computed: dash.kpis.length,
      withData: dash.kpis.filter(k => k.sampleSize > 0).length,
      trendingUp: dash.kpis.filter(k => k.trend === 'up').length,
      trendingDown: dash.kpis.filter(k => k.trend === 'down').length,
    };
  }

  getCount(): number {
    return this.kpiHistory.size;
  }

  getSnapshotCount(): number {
    return this.snapshots.size;
  }
}
