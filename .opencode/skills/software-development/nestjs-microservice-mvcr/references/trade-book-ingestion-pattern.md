# Trade-Book Ingestion Pattern

## Overview

For trade-book CSV ingestion into TypeORM-managed PostgreSQL:

1. **File deduplication via SHA256 checksum** — store hash in import log before processing
2. **Normalization status tracking** — `normalizationStatus: 'complete' | 'partial' | 'pending'`
3. **Raw data preservation** — store original CSV JSON in `rawData` column
4. **Warning collection** — non-critical parsing issues stored in `normalizationWarnings`

## Schema Design

### TradeBookImportLog (File Tracking)
| Column | Type | Purpose |
|--------|------|---------|
| sourceFilePath | varchar(512) | Full file path |
| sourceFileName | varchar(255) | File name only |
| fileHash | varchar(64) | SHA256 for duplicate detection |
| totalLines | int | Total CSV lines |
| importedRows | int | Successfully imported |
| failedRows | int | Parse failures |
| importedAt | datetime | Import timestamp |
| status | varchar(16) | 'complete' \| 'partial' \| 'failed' |
| messages | text | Warnings/messages |

### TradeBookImport (Normalized Trades)
| Column | Type | Purpose |
|--------|------|---------|
| importLogId | varchar(36) | Link to file metadata |
| rawData | text | Original CSV JSON (audit trail) |
| normalizationStatus | varchar(16) | Processing state |
| normalizeWarnings | text | Non-critical issues |
| matchStatus | varchar(32) | 'unmatched' (default) |
| broker, underlying, expiry, strike, optionType | various | Contract metadata |
| side, quantity, entryPrice, fees, netPnl | various | Trade data |

## Key Methods

### importFile(filePath)
- Resolve full path, verify file exists
- Calculate SHA256 hash
- Query `TradeBookImportLog` for existing hash match
- Skip if hash matches (idempotent)
- Parse CSV with `csv-parse/sync`
- Normalize each row with warnings collection
- Save import log BEFORE saving trades (reference integrity)
- Bulk insert trades with `importLogId` link

### importDirectory(directory)
- Scan directory for `.csv` files
- Invoke `importFile()` for each
- Aggregate statistics (total, new, skipped, failed, rows)

## Pitfalls

- **CSV column case sensitivity** — Zerodha uses snake_case in newer files, header-case in older. Normalize: `trade_date` → `trade_date` in mapping.
- **Quantity parsing** — may be float (300.000000), parseInt with base 10.
- **Null handling for optional fields** — expiryDate, strike, optionType may be absent; set to null explicitly.
- **Timestamp format** — Zerodha uses ISO 8601 (`2025-08-19T10:22:46`); parse with `new Date()`.
- **Option symbol parsing** — NIFTY25XXX26850CE → extract underlying, expiry, strike, optionType via regex.

## Matching Strategy

After ingestion, `TradeMatcherService` enriches records with market data:

1. Parse option symbol to extract `underlying`, `strike`, `expiry`, `optionType`
2. Query snapshots/ticks by instrument key
3. Time window: ±300s (5 min) around entry timestamp
4. Match by: symbol match + time proximity
5. Update `matchStatus: 'unmatched'` → 'MATCHED_SYMBOL_TIME' or 'MATCHED_PARTIAL'

## Security

- **Never log credentials** — replace DB passwords with `[REDACTED]` in logs
- **Raw CSV kept** — contains original data and may have sensitive fields
- **Import log tracks hash** — prevents accidental reprocessing
