import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as csv from 'csv-parse/sync';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TradeBookImport, TradeBookImportLog } from './trade-book.entity';

@Injectable()
export class TradeBookImporterService {
  private readonly logger = new Logger(TradeBookImporterService.name);

  constructor(
    @InjectRepository(TradeBookImport)
    private readonly tradeBookRepo: Repository<TradeBookImport>,
    @InjectRepository(TradeBookImportLog)
    private readonly importLogRepo: Repository<TradeBookImportLog>,
  ) {}

  async importFile(filePath: string): Promise<{
    status: 'skipped' | 'new' | 'updated' | 'failed';
    importedRows: number;
    failedRows: number;
    alreadyImported: boolean;
    fileHash: string;
    totalLines: number;
    warnings: string[];
  }> {
    const fullPath = path.resolve(filePath);
    if (!fs.existsSync(fullPath)) {
      throw new BadRequestException(`File not found: ${fullPath}`);
    }

    const fileName = path.basename(fullPath);
    this.logger.log(`Processing trade book: ${fileName}`);

    const fileContent = fs.readFileSync(fullPath, 'utf-8');
    const fileHash = crypto.createHash('sha256').update(fileContent).digest('hex');

    const existingLog = await this.importLogRepo.findOne({
      where: { sourceFilePath: fullPath, fileHash },
    });

    if (existingLog) {
      this.logger.log(`File already imported (hash match): ${fileName}`);
      return {
        status: 'skipped',
        importedRows: existingLog.importedRows,
        failedRows: existingLog.failedRows,
        alreadyImported: true,
        fileHash,
        totalLines: existingLog.totalLines,
        warnings: existingLog.messages ? [existingLog.messages] : [],
      };
    }

    const records = csv.parse(fileContent, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    });

    const importedRows: TradeBookImport[] = [];
    const warnings: string[] = [];
    let failedCount = 0;

    for (let i = 0; i < records.length; i++) {
      const row = records[i];
      const rowNumber = i + 2;

      try {
        const normalized = this.normalizeRow(row, fullPath, rowNumber, fileName);
        importedRows.push(normalized);
      } catch (error) {
        failedCount++;
        warnings.push(`Row ${rowNumber}: ${error.message}`);
      }
    }

    const importLog = this.importLogRepo.create({
      sourceFilePath: fullPath,
      sourceFileName: fileName,
      fileHash,
      totalLines: records.length,
      importedRows: importedRows.length,
      failedRows: failedCount,
      importedAt: new Date(),
      status: failedCount > 0 ? 'partial' : 'complete',
      messages: warnings.length > 0 ? warnings.join('; ') : null,
    });

    await this.importLogRepo.save(importLog);

    for (const trade of importedRows) {
      trade.importLogId = importLog.id;
    }

    await this.tradeBookRepo.save(importedRows);

    this.logger.log(`Imported ${importedRows.length} rows from ${fileName} (failed: ${failedCount})`);

    return {
      status: 'new',
      importedRows: importedRows.length,
      failedRows: failedCount,
      alreadyImported: false,
      fileHash,
      totalLines: records.length,
      warnings,
    };
  }

  async importDirectory(directory: string): Promise<{
    totalFiles: number;
    newImports: number;
    skippedFiles: number;
    failedFiles: number;
    totalRowsImported: number;
    stats: Record<string, any>;
  }> {
    const dirPath = path.resolve(directory);
    const files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.csv'));

    this.logger.log(`Found ${files.length} CSV files in ${dirPath}`);

    const results: any[] = [];
    let newImports = 0;
    let skippedFiles = 0;
    let failedFiles = 0;
    let totalRows = 0;

    for (const file of files) {
      try {
        const result = await this.importFile(path.join(dirPath, file));
        results.push({ file, ...result });

        if (result.status === 'skipped') {
          skippedFiles++;
        } else {
          newImports++;
        }
        totalRows += result.importedRows;
      } catch (error) {
        failedFiles++;
        this.logger.error(`Failed to import ${file}: ${error.message}`);
      }
    }

    const stats = await this.getImportStats();

    return {
      totalFiles: files.length,
      newImports,
      skippedFiles,
      failedFiles,
      totalRowsImported: totalRows,
      stats,
    };
  }

  private normalizeRow(
    row: Record<string, string>,
    sourceFile: string,
    sourceRow: number,
    fileName: string,
  ): TradeBookImport {
    const warnings: string[] = [];
    const rawData = JSON.stringify(row);

    const symbol = row.symbol?.trim() || null;
    const tradeDate = row.trade_date?.trim();
    const exchange = row.exchange?.trim() || 'NSE';
    const tradeType = row.trade_type?.trim()?.toUpperCase();
    const quantityStr = row.quantity?.trim();
    const priceStr = row.price?.trim();
    const tradeId = row.trade_id?.trim() || null;
    const orderId = row.order_id?.trim() || null;
    const expiryDate = row.expiry_date?.trim();

    const quantity = parseInt(quantityStr || '0', 10);
    if (isNaN(quantity) || quantity <= 0) {
      throw new Error(`Invalid quantity: ${quantityStr}`);
    }

    const price = parseFloat(priceStr || '0');
    if (isNaN(price)) {
      throw new Error(`Invalid price: ${priceStr}`);
    }

    if (!tradeDate || !/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) {
      throw new Error(`Invalid trade_date: ${tradeDate}`);
    }
    const entryTimestamp = new Date(`${tradeDate}T00:00:00`);

    let side: 'BUY' | 'SELL' | null = null;
    if (tradeType === 'buy') {
      side = 'BUY';
    } else if (tradeType === 'sell') {
      side = 'SELL';
    }
    if (!side) {
      throw new Error(`Invalid trade_type: ${tradeType}`);
    }

    const exitPrice: number | null = null;
    const exitTimestamp: Date | null = null;
    const fees = 0;
    const netPnl = 0;

    let underlying = '';
    let strike: number | null = null;
    let optionType: 'CE' | 'PE' | null = null;
    let expiry: string | null = null;

    if (symbol) {
      let match: RegExpMatchArray | null = null;
      
      match = symbol.match(/^(NIFTY)(\d{2})([A-Z]{3})(\d+)(CE|PE)$/);
      if (match) {
        underlying = 'NIFTY';
        const day = match[2];
        const month = match[3];
        const year = '20' + match[4];
        strike = parseFloat(match[5]);
        const monthMap: Record<string, string> = {
          JAN: '01', FEB: '02', MAR: '03', APR: '04',
          MAY: '05', JUN: '06', JUL: '07', AUG: '08',
          SEP: '09', OCT: '10', NOV: '11', DEC: '12',
        };
        expiry = `${year}-${monthMap[month] || '01'}-${day}`;
        optionType = match[6] as 'CE' | 'PE';
      } else {
        match = symbol.match(/^(SENSEX)(\d{2})(\d{2})(\d{4})(CE|PE)$/);
        if (match) {
          underlying = 'SENSEX';
          const month = match[2];
          const day = match[3];
          const year = '20' + match[4];
          strike = parseFloat(match[5]);
          expiry = `${year}-${month}-${day}`;
          optionType = match[6] as 'CE' | 'PE';
        } else {
          underlying = symbol.replace(/[0-9]+(CE|PE|PE|CE)$/i, '') || 'UNKNOWN';
          warnings.push(`Unable to parse option contract from symbol: ${symbol}`);
        }
      }
    }

    if (expiryDate && !expiry) {
      expiry = expiryDate;
    }

    const instrumentKey = symbol ? `${exchange}:${symbol}` : null;

    return this.tradeBookRepo.create({
      importLogId: null,
      tradeId,
      symbol,
      broker: 'zerodha',
      environment: 'REAL',
      instrumentKey,
      underlying: underlying || 'UNKNOWN',
      expiry: expiry || null,
      strike: strike || null,
      optionType: optionType || null,
      side,
      quantity,
      entryTimestamp,
      entryPrice: price,
      exitTimestamp,
      exitPrice,
      fees,
      netPnl,
      grossPnl: null,
      orderId,
      tradeType: 'directional',
      sourceFile: fileName,
      sourceRow,
      normalizationStatus: 'complete',
      normalizationWarnings: warnings.length > 0 ? warnings.join('; ') : null,
      rawData,
      matchStatus: 'unmatched',
      matchMethod: null,
    });
  }

  async getImportStats(): Promise<{
    totalTrades: number;
    totalFiles: number;
    byBroker: Record<string, number>;
    byUnderlying: Record<string, number>;
    bySide: Record<string, number>;
    byYear: Record<string, number>;
    byMonth: Record<string, number>;
    profitCount: number;
    lossCount: number;
    breakevenCount: number;
    unmatchedTrades: number;
    matchedTrades: number;
  }> {
    const trades = await this.tradeBookRepo.find();
    const logs = await this.importLogRepo.find();

    const brokerStats: Record<string, number> = {};
    const underlyingStats: Record<string, number> = {};
    const sideStats: Record<string, number> = {};
    const yearStats: Record<string, number> = {};
    const monthStats: Record<string, number> = {};
    let profitCount = 0;
    let lossCount = 0;
    let breakevenCount = 0;
    let unmatched = 0;
    let matched = 0;

    for (const trade of trades) {
      brokerStats[trade.broker] = (brokerStats[trade.broker] || 0) + 1;
      underlyingStats[trade.underlying] = (underlyingStats[trade.underlying] || 0) + 1;
      sideStats[trade.side] = (sideStats[trade.side] || 0) + 1;

      const year = trade.entryTimestamp.getFullYear().toString();
      const month = (trade.entryTimestamp.getMonth() + 1).toString().padStart(2, '0');
      yearStats[year] = (yearStats[year] || 0) + 1;
      const monthKey = `${year}-${month}`;
      monthStats[monthKey] = (monthStats[monthKey] || 0) + 1;

      if (trade.exitPrice && trade.grossPnl !== null) {
        if (trade.grossPnl > 0) profitCount++;
        else if (trade.grossPnl < 0) lossCount++;
        else breakevenCount++;
      }

      if (trade.matchStatus === 'unmatched') {
        unmatched++;
      } else {
        matched++;
      }
    }

    return {
      totalTrades: trades.length,
      totalFiles: logs.length,
      byBroker: brokerStats,
      byUnderlying: underlyingStats,
      bySide: sideStats,
      byYear: yearStats,
      byMonth: monthStats,
      profitCount,
      lossCount,
      breakevenCount,
      unmatchedTrades: unmatched,
      matchedTrades: matched,
    };
  }

  async getTrades(): Promise<TradeBookImport[]> {
    return this.tradeBookRepo.find({ order: { entryTimestamp: 'DESC' } });
  }

  async getTradesByFilter(filter: {
    broker?: string;
    underlying?: string;
    year?: number;
    month?: number;
    hasMatch?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<TradeBookImport[]> {
    const qb = this.tradeBookRepo.createQueryBuilder('trade');

    if (filter.broker) qb.andWhere('trade.broker = :broker', { broker: filter.broker });
    if (filter.underlying) qb.andWhere('trade.underlying = :underlying', { underlying: filter.underlying });
    if (filter.year) qb.andWhere('YEAR(trade.entryTimestamp) = :year', { year: filter.year });
    if (filter.month) qb.andWhere('MONTH(trade.entryTimestamp) = :month', { month: filter.month });
    if (filter.hasMatch !== undefined) {
      qb.andWhere('trade.matchStatus != :status', { status: 'unmatched' });
    }

    if (filter.limit) qb.take(filter.limit);
    if (filter.offset) qb.skip(filter.offset);

    return qb.orderBy('trade.entryTimestamp', 'DESC').getMany();
  }

  async getImportLogs(): Promise<TradeBookImportLog[]> {
    return this.importLogRepo.find({ order: { importedAt: 'DESC' } });
  }
}
