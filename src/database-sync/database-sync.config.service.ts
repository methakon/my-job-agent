import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DatabaseSyncAudit, SyncDirection, SyncStatus } from './database-sync.entity';

export interface SyncCheckpoint {
	tableName: string;
	lastId?: string;
	lastTimestamp?: Date;
	lastBatchSize?: number;
}

export interface SyncConfig {
	enabled: boolean;
	intervalMinutes: number;
	outsideTradingOnly: boolean;
	batchSize: number;
	maxRetries: number;
	backoffSeconds: number;
}

const DEFAULTSyncConfig: SyncConfig = {
	enabled: false,
	intervalMinutes: 30,
	outsideTradingOnly: true,
	batchSize: 1000,
	maxRetries: 3,
	backoffSeconds: 5,
};

@Injectable()
export class DatabaseSyncConfigService {
	private config: SyncConfig;

	constructor() {
		this.config = {
			enabled: process.env.DB_SYNC_ENABLED?.toLowerCase() === 'true' || DEFAULTSyncConfig.enabled,
			intervalMinutes: parseInt(process.env.DB_SYNC_INTERVAL_MINUTES || '30', 10),
			outsideTradingOnly: process.env.DB_SYNC_OUTSIDE_TRADING_ONLY !== 'false',
			batchSize: parseInt(process.env.DB_SYNC_BATCH_SIZE || '1000', 10),
			maxRetries: parseInt(process.env.DB_SYNC_MAX_RETRIES || '3', 10),
			backoffSeconds: parseInt(process.env.DB_SYNC_BACKOFF_SECONDS || '5', 10),
		};
	}

	getConfig(): SyncConfig {
		return this.config;
	}

	isTradingHours(): boolean {
		// Trading hours: 9:15 AM to 3:30 PM IST
		const now = new Date();
		const hours = now.getHours();
		const minutes = now.getMinutes();
		const timeInMinutes = hours * 60 + minutes;
		const start = 9 * 60 + 15; // 9:15 AM
		const end = 15 * 60 + 30; // 3:30 PM
		return timeInMinutes >= start && timeInMinutes <= end;
	}

	isSyncAllowed(): boolean {
		if (!this.config.enabled) return false;
		if (!this.config.outsideTradingOnly) return true;
		return !this.isTradingHours();
	}
}
