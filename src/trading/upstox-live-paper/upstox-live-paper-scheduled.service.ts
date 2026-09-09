import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { UpstoxLivePaperWeeklyReportService } from './upstox-live-paper-weekly-report.service';
import { UpstoxLivePaperWeeklyReport } from './upstox-live-paper-entities';

/**
 * Scheduled tasks for the Upstox LIVE paper system.
 *
 * - Weekly report generation after the trading week ends.
 * - Status / monitoring bookkeeping.
 */
@Injectable()
export class UpstoxLivePaperScheduledService {
  private readonly logger = new Logger(UpstoxLivePaperScheduledService.name);

  constructor(private readonly weeklyReport: UpstoxLivePaperWeeklyReportService) {}

  /**
   * Generate the weekly report once per weekday at 18:30 IST (after Indian
   * market close 15:30). This runs ~every day; the report service itself
   * dedups by ISO week so only the first run after the week closes actually
   * writes a report.
   */
  @Cron('0 30 18 * * 1-5', { name: 'upstox-live-paper-weekly-report' })
  async generateWeeklyReport(): Promise<void> {
    try {
      await this.weeklyReport.generateWeeklyReport();
      this.logger.log('[UPSTOX-LIVE-PAPER] scheduled weekly report generated');
    } catch (err) {
      this.logger.error(`[UPSTOX-LIVE-PAPER] scheduled weekly report failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Human-triggered report (admin / CLI). */
  async triggerReport(manualWeek? : string): Promise<{ id: string; week: string }> {
    const result = await this.weeklyReport.generateWeeklyReport(manualWeek);
    return { id: result.id, week: result.week };
  }

  /** Ensure the reports directory exists (cheap, safe). */
  ensureReportsDir(): void {
    const dir = join(process.cwd(), 'reports', 'upstox-live-paper');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}
