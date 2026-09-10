import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UpstoxLivePaperModule } from '../upstox-live-paper/upstox-live-paper.module';
import { PreOpenObservation } from './pre-open-observation.entity';
import { PreOpenCaptureService } from './pre-open-capture.service';
import { PreOpenController } from './pre-open.controller';
import { PreOpenRepository } from './pre-open.repository';
import { PRE_OPEN_QUOTE_SOURCE } from './pre-open-source.interface';
import { UpstoxPreOpenSource } from './upstox-pre-open.source';

/**
 * GATE 2 slice 1 — pre-open / auction capture into point-in-time storage.
 *
 * Layering: the session model, validation, derived features, repository and the
 * capture service are broker-neutral. UpstoxPreOpenSource is the only class that
 * knows a broker REST shape, and it is injected through the PRE_OPEN_QUOTE_SOURCE
 * token, so a second source (or a recorded-fixture source in tests) can replace
 * it without touching capture, validation or storage.
 *
 * UpstoxLivePaperModule is imported for two read-only dependencies only: the
 * market-data access token and the desk's configured instrument universe. No
 * trading-account state, capital, position or order path is read or written
 * here (item 18).
 */
@Module({
  imports: [TypeOrmModule.forFeature([PreOpenObservation]), ConfigModule, UpstoxLivePaperModule],
  controllers: [PreOpenController],
  providers: [
    PreOpenRepository,
    UpstoxPreOpenSource,
    { provide: PRE_OPEN_QUOTE_SOURCE, useExisting: UpstoxPreOpenSource },
    PreOpenCaptureService,
  ],
  exports: [PreOpenRepository, PreOpenCaptureService],
})
export class PreOpenModule {}
