/**
 * Minimal structured logger for the trading system.
 *
 * Wraps NestJS Logger and adds machine-readable context to every log entry.
 * Designed to be a drop-in enhancement, not a competing framework.
 *
 * Usage:
 *   private readonly logger = createStructuredLogger('MyComponent');
 *
 *   // Structured error with classification
 *   this.logger.errorClassified({
 *     classification: ErrorClassification.DEGRADED,
 *     component: 'FeedArbitration',
 *     operation: 'heartbeat',
 *     message: 'Provider FyresProvider stale for 30s',
 *     provider: 'FYERS',
 *     recoveryAction: 'switching to secondary',
 *   });
 *
 *   // Structured warn with correlation
 *   this.logger.warnWithContext('Tick rejected', {
 *     component: 'CanonicalTick',
 *     operation: 'interpret',
 *     instrument: 'NIFTY26SEP23000CE',
 *     errorCode: 'PRICE_ZERO',
 *     latencyMs: 12,
 *   });
 *
 * SECURITY: Never log access tokens, refresh tokens, API secrets,
 * passwords, or authorization headers.
 */

import { Logger } from '@nestjs/common';
import { ErrorClassification, StructuredErrorContext } from './error-classifications';

type LogContext = {
  component?: string;
  provider?: string;
  errorCode?: string;
  operation?: string;
  message?: string;
  correlationId?: string;
  instrument?: string;
  session?: string;
  recoveryAction?: string;
  recovered?: boolean;
  latencyMs?: number;
};

type StructuredLogger = Logger & {
  errorClassified: (ctx: StructuredErrorContext) => void;
  warnWithContext: (message: string, ctx?: LogContext) => void;
  logWithContext: (message: string, ctx?: LogContext) => void;
};

function formatContext(ctx?: LogContext): string {
  if (!ctx) return '';
  const parts: string[] = [];
  if (ctx.component) parts.push(`component=${ctx.component}`);
  if (ctx.provider) parts.push(`provider=${ctx.provider}`);
  if (ctx.errorCode) parts.push(`code=${ctx.errorCode}`);
  if (ctx.operation) parts.push(`op=${ctx.operation}`);
  if (ctx.correlationId) parts.push(`corr=${ctx.correlationId}`);
  if (ctx.instrument) parts.push(`inst=${ctx.instrument}`);
  if (ctx.session) parts.push(`sess=${ctx.session}`);
  if (ctx.recoveryAction) parts.push(`recovery=${ctx.recoveryAction}`);
  if (ctx.recovered !== undefined) parts.push(`recovered=${ctx.recovered}`);
  if (ctx.latencyMs !== undefined) parts.push(`latency=${ctx.latencyMs}ms`);
  return parts.length > 0 ? ` [${parts.join(' ')}]` : '';
}

export function createStructuredLogger(component: string): StructuredLogger {
  const base = new Logger(component);

  const structured: StructuredLogger = Object.assign(base, {
    errorClassified(ctx: StructuredErrorContext): void {
      const ts = new Date().toISOString();
      const context = formatContext({
        component: ctx.component,
        provider: ctx.provider,
        errorCode: ctx.errorCode,
        operation: ctx.operation,
        correlationId: ctx.correlationId,
        instrument: ctx.instrument,
        session: ctx.session,
        recoveryAction: ctx.recoveryAction,
        recovered: ctx.recovered,
        latencyMs: ctx.latencyMs,
      });
      // SECURITY: Never log credentials, tokens, or secrets
      const msg = `[${ctx.classification}] ${ctx.message}`;
      base.error(`${ts}${context} ${msg}`);
    },

    warnWithContext(message: string, ctx?: LogContext): void {
      const ts = new Date().toISOString();
      const context = formatContext(ctx);
      base.warn(`${ts}${context} ${message}`);
    },

    logWithContext(message: string, ctx?: LogContext): void {
      const ts = new Date().toISOString();
      const context = formatContext(ctx);
      base.log(`${ts}${context} ${message}`);
    },
  });

  return structured;
}
