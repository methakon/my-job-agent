/**
 * Upstox LIVE paper module — shared constants barrel.
 */
export const UPSTOX_LIVE_DATA_ISOLATION = {
  dataSource: 'UPSTOX',
  executionMode: 'PAPER',
};

export type { LiveOptionTick, LiveMarketTick, LiveFeedStatus } from './upstox-live-paper-market.service';
