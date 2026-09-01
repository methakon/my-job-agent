/**
 * Yahoo returns the current 1-minute candle on every poll. Only a newer
 * candle timestamp is a new observation for the underlying feed. FYERS is a
 * tick stream and is intentionally not covered by this Yahoo-only guard.
 */
export const shouldAcceptTick = (
  provider: string,
  tickTs: string,
  lastYahooTs: string | undefined,
): boolean => provider.toLowerCase() !== 'yahoo'
  || !lastYahooTs
  || tickTs !== lastYahooTs;
