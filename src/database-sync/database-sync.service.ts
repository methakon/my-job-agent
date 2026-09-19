import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, MoreThan, createQueryBuilder } from 'typeorm';
import { DatabaseSyncAudit, SyncDirection, SyncStatus } from './database-sync.entity';
import { DatabaseSyncConfigService, SyncCheckpoint } from './database-sync.config.service';

export const TABLE_OWNERSHIP: Record<string, 'ORACLE_AUTHORITATIVE' | 'LOCAL_AUTHORITATIVE' | 'SHARED_APPEND_ONLY' | 'EXCLUDED'> = {
	fnf_trades: 'ORACLE_AUTHORITATIVE',
	fnf_decision_journal: 'ORACLE_AUTHORITATIVE',
	fnf_market_snapshots: 'ORACLE_AUTHORITATIVE',
	fnf_market_snapshots_history: 'ORACLE_AUTHORITATIVE',
	fnf_option_quotes: 'ORACLE_AUTHORITATIVE',
	fnf_option_quotes_history: 'ORACLE_AUTHORITATIVE',
	fnf_option_contracts: 'ORACLE_AUTHORITATIVE',
	fnf_decay_calibrations: 'ORACLE_AUTHORITATIVE',
	fnf_portfolios: 'ORACLE_AUTHORITATIVE',
	fnf_trade_reflections: 'ORACLE_AUTHORITATIVE',
	fnf_trade_reports: 'ORACLE_AUTHORITATIVE',
	provider_tokens: 'ORACLE_AUTHORITATIVE',
	sandbox_ticks: 'ORACLE_AUTHORITATIVE',
	trade_book_imports: 'LOCAL_AUTHORITATIVE',
	trade_book_import_log: 'LOCAL_AUTHORITATIVE',
	applications: 'SHARED_APPEND_ONLY',
	job_leads: 'SHARED_APPEND_ONLY',
	candidate_profile: 'SHARED_APPEND_ONLY',
	cv_region_formats: 'SHARED_APPEND_ONLY',
	status_updates: 'SHARED_APPEND_ONLY',
	learning_weights: 'SHARED_APPEND_ONLY',
	muhurta_windows: 'SHARED_APPEND_ONLY',
	pre_apply_items: 'SHARED_APPEND_ONLY',
	portal_users: 'SHARED_APPEND_ONLY',
	question_answers: 'SHARED_APPEND_ONLY',
	project_checklist_items: 'SHARED_APPEND_ONLY',
	interview_questions: 'SHARED_APPEND_ONLY',
	side_income_opportunities: 'SHARED_APPEND_ONLY',
	mail_accounts: 'SHARED_APPEND_ONLY',
	apply_settings: 'SHARED_APPEND_ONLY',
	agent_todo_log: 'SHARED_APPEND_ONLY',
	sessions: 'EXCLUDED',
	typeorm_migrations: 'EXCLUDED',
	database_sync_audit: 'EXCLUDED',
};

const SYNCHRONIZABLE_TABLES = Object.keys(TABLE_OWNERSHIP).filter(k => TABLE_OWNERSHIP[k] !== 'EXCLUDED');

@Injectable()
export class DatabaseSyncService {
	private readonly logger = new Logger(DatabaseSyncService.name);
	private oracleDS: DataSource | null = null;
	private localDS: DataSource | null = null;

	constructor(
		private readonly config: DatabaseSyncConfigService,
		@InjectRepository(DatabaseSyncAudit)
		private readonly auditRepo: Repository<DatabaseSyncAudit>,
		private readonly dataSource: DataSource,
	) {}

	private async getOracleDS(): Promise<DataSource> {
		if (!this.oracleDS) {
			this.oracleDS = await new DataSource({
				type: 'mysql',
				host: process.env.ORACLE_DB_HOST || '127.0.0.1',
				port: parseInt(process.env.ORACLE_DB_PORT || '3307', 10),
				username: process.env.ORACLE_DB_USER || 'mylife',
				password: process.env.ORACLE_DB_PASSWORD || process.env.MYSQL_PASSWORD || '',
				database: process.env.ORACLE_DB_NAME || process.env.DATABASE_NAME || 'myjob_agent',
				synchronize: false,
				logging: false,
			}).initialize();
		}
		return this.oracleDS;
	}

	private async getLocalDS(): Promise<DataSource> {
		if (!this.localDS) {
			this.localDS = await new DataSource({
				type: 'mysql',
				host: process.env.LOCAL_DB_HOST || '127.0.0.1',
				port: parseInt(process.env.LOCAL_DB_PORT || '3306', 10),
				username: process.env.LOCAL_DB_USER || 'mylife',
				password: process.env.LOCAL_DB_PASSWORD || process.env.MYSQL_PASSWORD || '',
				database: process.env.LOCAL_DB_NAME || process.env.DATABASE_NAME || 'myjob_agent',
				synchronize: false,
				logging: false,
			}).initialize();
		}
		return this.localDS;
	}

	private async getCheckpoint(tableName: string): Promise<SyncCheckpoint> {
		const last = await this.auditRepo.findOne({
			where: { tableName, status: 'COMPLETED' },
			order: { completedAt: 'DESC' },
		});
		if (last?.checkpointAfter) {
			try {
				return JSON.parse(last.checkpointAfter);
			} catch (e) {}
		}
		return { tableName };
	}

	private transformRecordForSync(tableName: string, record: any): any {
		// For agent_todo_log, convert empty todoId strings to null
		if (tableName === 'agent_todo_log' && record.todoId === '') {
			record.todoId = null;
		}
		return record;
	}

	private async syncTable(tableName: string, direction: SyncDirection): Promise<void> {
		const batchSize = this.config.getConfig().batchSize;
		const checkpoint = await this.getCheckpoint(tableName);

		const sourceDS = direction === 'ORACLE_TO_LOCAL' ? await this.getOracleDS() : await this.getLocalDS();
		const destDS = direction === 'ORACLE_TO_LOCAL' ? await this.getLocalDS() : await this.getOracleDS();

		const metadata = sourceDS.getMetadata(tableName);
		const idCol = metadata.primaryColumns[0];
		const idField = idCol.propertyName;
		const idType = idCol.type;

		let where: any;
		if (checkpoint.lastId) {
			if (idType === 'uuid' || idType === 'varchar') {
				where = { [idField]: MoreThan(checkpoint.lastId) };
			} else {
				where = { [idField]: MoreThan(parseInt(checkpoint.lastId, 10)) };
			}
		}

		const sourceRepo = sourceDS.getRepository(tableName);
		const destRepo = destDS.getRepository(tableName);

		const records = where 
			? await sourceRepo.find({ where, take: batchSize })
			: await sourceRepo.find({ take: batchSize });

		if (records.length === 0) return;

		let rowsInserted = 0;
		let rowsUpdated = 0;
		let rowsSkipped = 0;
		let rowsFailed = 0;

		for (const record of records) {
			try {
				const transformed = this.transformRecordForSync(tableName, { ...record });
				const idVal = transformed[idField];
				const existing = await destRepo.findOne({ where: { [idField]: idVal } });

				if (existing) {
					const ownership = TABLE_OWNERSHIP[tableName];
					if (ownership === 'SHARED_APPEND_ONLY') {
						rowsSkipped++;
						continue;
					}
					if (direction === 'ORACLE_TO_LOCAL' && ownership === 'ORACLE_AUTHORITATIVE') {
						rowsSkipped++;
						continue;
					}
					if (direction === 'LOCAL_TO_ORACLE' && ownership === 'LOCAL_AUTHORITATIVE') {
						rowsSkipped++;
						continue;
					}
					Object.assign(existing, transformed);
					await destRepo.save(existing);
					rowsUpdated++;
				} else {
					await destRepo.save(transformed);
					rowsInserted++;
				}
				checkpoint.lastId = idVal;
			} catch (e: any) {
				rowsFailed++;
				this.logger.error(`Sync failed for ${tableName}/${record[idField]}: ${e.message}`);
				throw e;
			}
		}

		checkpoint.lastBatchSize = records.length;
		const audit = this.auditRepo.create({
			direction,
			tableName,
			startedAt: new Date(),
			status: 'COMPLETED',
			rowsRead: records.length,
			rowsInserted,
			rowsUpdated,
			rowsSkipped,
			rowsFailed,
			checkpointAfter: JSON.stringify(checkpoint),
		});
		await this.auditRepo.save(audit);
	}

	public async runSync(): Promise<void> {
		if (!this.config.getConfig().enabled) {
			this.logger.log('Database sync is disabled');
			return;
		}
		if (this.config.getConfig().outsideTradingOnly && this.config.isTradingHours()) {
			this.logger.log('Sync deferred during trading hours');
			return;
		}

		for (const table of SYNCHRONIZABLE_TABLES) {
			const ownership = TABLE_OWNERSHIP[table];
			if (ownership === 'ORACLE_AUTHORITATIVE' || ownership === 'SHARED_APPEND_ONLY') {
				await this.syncTable(table, 'ORACLE_TO_LOCAL');
			}
			if (ownership === 'LOCAL_AUTHORITATIVE') {
				await this.syncTable(table, 'LOCAL_TO_ORACLE');
			}
		}
	}

	public async getStatus(): Promise<any> {
		const last = await this.auditRepo.find({
			order: { createdAt: 'DESC' },
			take: 10,
		});
		return {
			config: this.config.getConfig(),
			isTradingHours: this.config.isTradingHours(),
			lastSyncs: last,
			synchronizableTables: SYNCHRONIZABLE_TABLES,
			tableOwnership: TABLE_OWNERSHIP,
		};
	}
}
