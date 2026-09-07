import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('trade_book_import_log')
@Index('idx_import_log_file_hash', ['sourceFilePath', 'fileHash'])
export class TradeBookImportLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 512 })
  sourceFilePath: string;

  @Column({ type: 'varchar', length: 255 })
  sourceFileName: string;

  @Column({ type: 'varchar', length: 64 })
  fileHash: string;

  @Column({ type: 'int' })
  totalLines: number;

  @Column({ type: 'int', default: 0 })
  importedRows: number;

  @Column({ type: 'int', default: 0 })
  failedRows: number;

  @Column({ type: 'datetime' })
  importedAt: Date;

  @Column({ type: 'varchar', length: 16 })
  status: string;

  @Column({ type: 'text', nullable: true })
  messages: string | null;
}

@Entity('trade_book_imports')
@Index('idx_trade_book_import_source', ['sourceFile', 'sourceRow'])
@Index('idx_trade_book_import_date', ['entryTimestamp'])
@Index('idx_trade_book_import_file', ['importLogId'])
export class TradeBookImport {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 36, nullable: true })
  importLogId: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  tradeId: string | null;

  @Column({ type: 'varchar', length: 96, nullable: true })
  symbol: string | null;

  @Column({ type: 'varchar', length: 32 })
  broker: string;

  @Column({ type: 'varchar', length: 16 })
  environment: string;

  @Column({ type: 'varchar', length: 96, nullable: true })
  instrumentKey: string | null;

  @Column({ type: 'varchar', length: 64 })
  underlying: string;

  @Column({ type: 'date', nullable: true })
  expiry: string | null;

  @Column({ type: 'decimal', precision: 14, scale: 2, nullable: true })
  strike: number | null;

  @Column({ type: 'varchar', length: 4, nullable: true })
  optionType: string | null;

  @Column({ type: 'varchar', length: 8 })
  side: string;

  @Column({ type: 'int' })
  quantity: number;

  @Column({ type: 'datetime' })
  entryTimestamp: Date;

  @Column({ type: 'decimal', precision: 14, scale: 4 })
  entryPrice: number;

  @Column({ type: 'datetime', nullable: true })
  exitTimestamp: Date | null;

  @Column({ type: 'decimal', precision: 14, scale: 4, nullable: true })
  exitPrice: number | null;

  @Column({ type: 'decimal', precision: 14, scale: 2, default: 0 })
  fees: number;

  @Column({ type: 'decimal', precision: 14, scale: 2, default: 0 })
  netPnl: number;

  @Column({ type: 'decimal', precision: 14, scale: 2, nullable: true })
  grossPnl: number | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  orderId: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  tradeType: string | null;

  @Column({ type: 'varchar', length: 255 })
  sourceFile: string;

  @Column({ type: 'int' })
  sourceRow: number;

  @Column({ type: 'varchar', length: 16 })
  normalizationStatus: string;

  @Column({ type: 'text', nullable: true })
  normalizationWarnings: string | null;

  @Column({ type: 'text' })
  rawData: string;

  @Column({ type: 'varchar', length: 32, default: 'unmatched' })
  matchStatus: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  matchMethod: string | null;

  @CreateDateColumn()
  importedAt: Date;
}
