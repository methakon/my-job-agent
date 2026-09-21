/**
 * JA-091 — Learning Safety and Guardrails
 *
 * doneWhen: "Guardrails prevent harmful model updates and data contamination."
 */

import { Injectable } from '@nestjs/common';

export type GuardrailType = 'rate_limit' | 'confidence_threshold' | 'anomaly_detection' | 'data_quality' | 'rollback_guard' | 'audit_trail';
export type GuardrailStatus = 'pass' | 'warn' | 'block';
export type ViolationSeverity = 'info' | 'warning' | 'critical';

export interface GuardrailConfig {
  id?: string;
  type: GuardrailType;
  name: string;
  enabled: boolean;
  threshold?: number;
  window?: number;
  action: 'allow' | 'warn' | 'block';
  description: string;
}

export interface GuardrailViolation {
  id?: string;
  guardrailId?: string;
  type: GuardrailType;
  severity: ViolationSeverity;
  description: string;
  details?: Record<string, unknown>;
  detectedAt: string;
  actionTaken: string;
}

export interface GuardrailCheckResult {
  guardrailId: string;
  type: GuardrailType;
  status: GuardrailStatus;
  message: string;
  value?: number;
  threshold?: number;
}

export interface LearningSafetyState {
  totalChecks: number;
  passedChecks: number;
  warnedChecks: number;
  blockedChecks: number;
  violations: GuardrailViolation[];
  configCount: number;
}

@Injectable()
export class LearningSafetyGuardrailsService {
  private configs: Map<string, GuardrailConfig> = new Map();
  private violations: Map<string, GuardrailViolation> = new Map();
  private checkHistory: { guardrailId: string; passed: boolean; at: string }[] = [];

  addConfig(config: Partial<GuardrailConfig>): GuardrailConfig {
    const c: GuardrailConfig = {
      id: config.id || `guard-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type: config.type || 'rate_limit',
      name: config.name || 'Unnamed Guardrail',
      enabled: config.enabled ?? true,
      threshold: config.threshold,
      window: config.window,
      action: config.action || 'warn',
      description: config.description || '',
    };
    this.configs.set(c.id || 'x', c);
    return c;
  }

  check(guardrailId: string, value?: number): GuardrailCheckResult {
    const config = this.configs.get(guardrailId);
    if (!config || !config.enabled) {
      return {
        guardrailId,
        type: config?.type || 'rate_limit',
        status: 'pass',
        message: 'Guardrail not configured or disabled',
      };
    }

    const threshold = config.threshold ?? Infinity;
    const action = config.action || 'warn';

    if (value !== undefined && threshold !== undefined && value > threshold) {
      if (action === 'block') {
        this.recordViolation(guardrailId, 'critical', `Value ${value} exceeds threshold ${threshold}`, { value, threshold });
        return {
          guardrailId,
          type: config.type,
          status: 'block',
          message: `BLOCKED: value ${value} exceeds threshold ${threshold}`,
          value,
          threshold,
        };
      } else {
        this.recordViolation(guardrailId, 'warning', `Value ${value} exceeds threshold ${threshold}`, { value, threshold });
        return {
          guardrailId,
          type: config.type,
          status: 'warn',
          message: `WARNING: value ${value} exceeds threshold ${threshold}`,
          value,
          threshold,
        };
      }
    }

    this.checkHistory.push({ guardrailId, passed: true, at: new Date().toISOString() });
    return {
      guardrailId,
      type: config.type,
      status: 'pass',
      message: 'Check passed',
      value,
      threshold,
    };
  }

  private recordViolation(guardrailId: string, severity: ViolationSeverity, description: string, details?: Record<string, unknown>): void {
    const v: GuardrailViolation = {
      id: `violation-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      guardrailId,
      type: 'rate_limit',
      severity,
      description,
      details,
      detectedAt: new Date().toISOString(),
      actionTaken: 'logged',
    };
    this.violations.set(v.id || 'x', v);
  }

  getViolation(id: string): GuardrailViolation | undefined {
    return this.violations.get(id);
  }

  getViolations(): GuardrailViolation[] {
    return Array.from(this.violations.values())
      .sort((a, b) => b.detectedAt.localeCompare(a.detectedAt));
  }

  getRecentViolations(limit: number): GuardrailViolation[] {
    return this.getViolations().slice(0, limit);
  }

  getConfig(id: string): GuardrailConfig | undefined {
    return this.configs.get(id);
  }

  getConfigs(): GuardrailConfig[] {
    return Array.from(this.configs.values())
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  enable(id: string): GuardrailConfig | undefined {
    const c = this.configs.get(id);
    if (c) c.enabled = true;
    return c;
  }

  disable(id: string): GuardrailConfig | undefined {
    const c = this.configs.get(id);
    if (c) c.enabled = false;
    return c;
  }

  evaluateAll(value?: number): GuardrailCheckResult[] {
    return Array.from(this.configs.values())
      .filter(c => c.enabled)
      .map(c => this.check(c.id || 'x', value));
  }

  getState(): LearningSafetyState {
    const results = this.evaluateAll();
    const passed = results.filter(r => r.status === 'pass').length;
    const warned = results.filter(r => r.status === 'warn').length;
    const blocked = results.filter(r => r.status === 'block').length;

    return {
      totalChecks: results.length,
      passedChecks: passed,
      warnedChecks: warned,
      blockedChecks: blocked,
      violations: this.getViolations(),
      configCount: this.configs.size,
    };
  }

  getCount(): number {
    return this.configs.size;
  }

  getViolationCount(): number {
    return this.violations.size;
  }
}
