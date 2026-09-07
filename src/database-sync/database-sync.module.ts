import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DatabaseSyncAudit } from './database-sync.entity';
import { DatabaseSyncService } from './database-sync.service';
import { DatabaseSyncConfigService } from './database-sync.config.service';

@Module({
	imports: [TypeOrmModule, TypeOrmModule.forFeature([DatabaseSyncAudit])],
	providers: [DatabaseSyncService, DatabaseSyncConfigService],
	exports: [DatabaseSyncService, DatabaseSyncConfigService],
})
export class DatabaseSyncModule {}
