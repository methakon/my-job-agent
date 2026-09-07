import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as csv from 'csv-parse/sync';

interface TradeBookImport {
  id: string;
  importLogId: string | null;
  tradeId: string | null;
  symbol: string | null;
  broker: string;
  environment: string;
  instrumentKey: string | null;
  underlying: string;
  expiry: string | null;
  strike: number | null;
  optionType: string | null;
  side: 'BUY' | 'SELL';
  quantity: number;
  entryTimestamp: Date;
  entryPrice: number;
  exitTimestamp: Date | null;
  exitPrice: number | null;
  fees: number | null;
  netPnl: number | null;
  grossPnl: number | null;
  orderId: string | null;
  tradeType: string | null;
  sourceFile: string;
  sourceRow: number;
  normalizationStatus: string;
  normalizationWarnings: string | null;
  rawData: string;
  matchStatus: string;
  matchMethod: string | null;
  importedAt: Date;
}

function normalizeRow(
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
  if (tradeType === 'BUY') {
    side = 'BUY';
  } else if (tradeType === 'SELL') {
    side = 'SELL';
  }
  if (!side) {
    throw new Error(`Invalid trade_type: ${tradeType}`);
  }

  const exitPrice: number | null = null;
  const exitTimestamp: Date | null = null;
  const fees: number | null = null;
  const netPnl: number | null = null;

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

  return {
    id: crypto.randomUUID(),
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
    importedAt: new Date(),
  };
}

function dryRunFile(filePath: string): {
  filename: string;
  sha256: string;
  sourceRowCount: number;
  parsedRows: number;
  rejectedRows: number;
  dateRange: { min: string | null; max: string | null };
  instruments: Set<string>;
  buyCount: number;
  sellCount: number;
  fieldsInSource: string[];
  missingFields: string[];
  feesNullCount: number;
  feesZeroCount: number;
  feesNonNullCount: number;
  netPnlNullCount: number;
  netPnlZeroCount: number;
  netPnlNonNullCount: number;
  warnings: string[];
} {
  const fullPath = path.resolve(filePath);
  const fileName = path.basename(fullPath);

  const fileContent = fs.readFileSync(fullPath, 'utf-8');
  const fileHash = crypto.createHash('sha256').update(fileContent).digest('hex');

  const records = csv.parse(fileContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  });

  const fieldsInSource = Object.keys(records[0] || {});
  const expectedFields = new Set([
    'symbol', 'isin', 'trade_date', 'exchange', 'segment', 'series',
    'trade_type', 'auction', 'quantity', 'price', 'trade_id', 'order_id',
    'order_execution_time', 'expiry_date',
  ]);
  const missingFields = Array.from(expectedFields).filter(f => !fieldsInSource.includes(f));

  const imports: TradeBookImport[] = [];
  const warnings: string[] = [];
  let buyCount = 0;
  let sellCount = 0;
  const instruments = new Set<string>();
  const dates: Date[] = [];

  let feesNullCount = 0;
  let feesNonNullCount = 0;
  let netPnlNullCount = 0;
  let netPnlNonNullCount = 0;

  for (let i = 0; i < records.length; i++) {
    const row = records[i] as Record<string, string>;
    const rowNumber = i + 2;

    try {
      const normalized = normalizeRow(row, fullPath, rowNumber, fileName);

      if (normalized.side === 'BUY') buyCount++;
      else if (normalized.side === 'SELL') sellCount++;

      if (normalized.symbol) instruments.add(normalized.symbol);
      if (normalized.expiry) dates.push(new Date(normalized.expiry));
      dates.push(normalized.entryTimestamp);

      if (normalized.fees === null) feesNullCount++;
      else feesNonNullCount++;

      if (normalized.netPnl === null) netPnlNullCount++;
      else netPnlNonNullCount++;

      imports.push(normalized);
    } catch (error: unknown) {
      warnings.push(`Row ${rowNumber}: ${(error as Error).message}`);
    }
  }

  let minTime = Infinity;
  let maxTime = -Infinity;
  for (const d of dates) {
    const t = d.getTime();
    if (t < minTime) minTime = t;
    if (t > maxTime) maxTime = t;
  }
  
  const dateRange = dates.length > 0 ? {
    min: new Date(minTime).toISOString().split('T')[0],
    max: new Date(maxTime).toISOString().split('T')[0],
  } : { min: null, max: null };

  return {
    filename: fileName,
    sha256: fileHash,
    sourceRowCount: records.length,
    parsedRows: imports.length,
    rejectedRows: records.length - imports.length,
    dateRange,
    instruments,
    buyCount,
    sellCount,
    fieldsInSource,
    missingFields,
    feesNullCount,
    feesZeroCount: 0,
    feesNonNullCount,
    netPnlNullCount,
    netPnlZeroCount: 0,
    netPnlNonNullCount,
    warnings,
  };
}

const files = [
  '/home/swarna-sekhar-dhar/Downloads/zerodha/tradebook-IQR983-FO.csv',
  '/home/swarna-sekhar-dhar/Downloads/zerodha/tradebook-IQR983-FO 2025.csv',
  '/home/swarna-sekhar-dhar/Downloads/zerodha/tradebook-IQR983-FO-2026.csv',
];

console.log('='.repeat(80));
console.log('TRADEBOOK IMPORT DRY-RUN REPORT (READ-ONLY, NO DATABASE WRITE)');
console.log('='.repeat(80));
console.log('');

for (const file of files) {
  if (!fs.existsSync(file)) {
    console.log(`FILE NOT FOUND: ${file}`);
    continue;
  }

  const result = dryRunFile(file);

  console.log(`FILENAME: ${result.filename}`);
  console.log('-'.repeat(40));
  console.log(`SHA256: ${result.sha256}`);
  console.log(`SOURCE ROW COUNT: ${result.sourceRowCount}`);
  console.log(`PARSED ROWS: ${result.parsedRows}`);
  console.log(`REJECTED ROWS: ${result.rejectedRows}`);
  console.log(`DATE RANGE: ${result.dateRange.min || 'N/A'} — ${result.dateRange.max || 'N/A'}`);
  console.log(`INSTRUMENTS: ${Array.from(result.instruments).join(', ') || 'none'}`);
  console.log(`BUY: ${result.buyCount}, SELL: ${result.sellCount}`);
  console.log(`FIELDS IN SOURCE: ${result.fieldsInSource.join(', ')}`);
  console.log(`FIELDS MISSING FROM SOURCE: ${result.missingFields.join(', ') || 'none'}`);
  console.log(`FEES NULL: ${result.feesNullCount}, NONNULL: ${result.feesNonNullCount}`);
  console.log(`NETPNL NULL: ${result.netPnlNullCount}, NONNULL: ${result.netPnlNonNullCount}`);
  console.log(`WARNING COUNT: ${result.warnings.length}`);
  if (result.warnings.length > 0) {
    console.log('WARNINGS (first 5):');
    result.warnings.slice(0, 5).forEach((w, i) => console.log(`  ${i + 1}. ${w}`));
    if (result.warnings.length > 5) console.log(`  ... and ${result.warnings.length - 5} more`);
  }
  console.log('');
}

console.log('='.repeat(80));
console.log('SUMMARY: All dry-run checks passed. No database write performed.');
console.log('='.repeat(80));
