export type MarketSnapshotLike = {
  id?: string;
  instrument: string;
  price: number;
  volume: number;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  close?: number | null;
  ts: Date | string;
  createdAt?: Date | string;
};

export type MarketSnapshotFilters = {
  instrument?: string;
  from?: Date;
  to?: Date;
  minPrice?: number;
  maxPrice?: number;
  minVolume?: number;
  maxVolume?: number;
  ohlc?: 'complete' | 'partial' | 'missing';
  latestOnly?: boolean;
};

const hasValue = (value: unknown): boolean => value !== null && value !== undefined && value !== '';

const ohlcState = (row: MarketSnapshotLike): 'complete' | 'partial' | 'missing' => {
  const count = [row.open, row.high, row.low, row.close].filter(hasValue).length;
  return count === 4 ? 'complete' : count === 0 ? 'missing' : 'partial';
};

/** Pure filtering used by the REST endpoint and its smoke tests. */
export function filterMarketSnapshots<T extends MarketSnapshotLike>(rows: T[], filters: MarketSnapshotFilters): T[] {
  const instrument = filters.instrument?.trim().toLowerCase();
  const filtered = rows.filter((row) => {
    const rowInstrument = String(row.instrument ?? '').toLowerCase();
    const price = Number(row.price);
    const volume = Number(row.volume);
    const ts = new Date(row.ts).getTime();

    if (instrument && !rowInstrument.includes(instrument)) return false;
    if (filters.from && (!Number.isFinite(ts) || ts < filters.from.getTime())) return false;
    if (filters.to && (!Number.isFinite(ts) || ts > filters.to.getTime())) return false;
    if (filters.minPrice !== undefined && (!Number.isFinite(price) || price < filters.minPrice)) return false;
    if (filters.maxPrice !== undefined && (!Number.isFinite(price) || price > filters.maxPrice)) return false;
    if (filters.minVolume !== undefined && (!Number.isFinite(volume) || volume < filters.minVolume)) return false;
    if (filters.maxVolume !== undefined && (!Number.isFinite(volume) || volume > filters.maxVolume)) return false;
    if (filters.ohlc && ohlcState(row) !== filters.ohlc) return false;
    return true;
  });

  if (!filters.latestOnly) return filtered;
  const latest = new Map<string, T>();
  for (const row of filtered) {
    const key = String(row.instrument ?? '');
    const current = latest.get(key);
    if (!current || new Date(row.ts).getTime() > new Date(current.ts).getTime()) latest.set(key, row);
  }
  return [...latest.values()].sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
}

export function snapshotOhlcState(row: MarketSnapshotLike): 'complete' | 'partial' | 'missing' {
  return ohlcState(row);
}
