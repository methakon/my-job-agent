/**
 * GATE 2 — broker-neutral pre-open quote source interface.
 *
 * The capture service talks ONLY to this interface, so the broker-specific REST
 * shape lives in one adapter (item 18 / standing constraint: "use adapters or
 * interfaces where broker-specific code must be isolated"). Swapping or adding a
 * source never touches capture, validation or storage logic.
 */
import { PreOpenSourceValues } from './pre-open-features';

export type PreOpenFetchResult = {
  ok: boolean;
  error: string | null;
  /** instrumentKey → normalize-ready values. Missing instruments are absent. */
  values: Record<string, PreOpenSourceValues>;
  /** Best-effort exchange market status (provenance only). */
  marketStatus: string | null;
  marketStatusError: string | null;
};

export interface PreOpenQuoteSource {
  /** Source identity stamped on every observation, e.g. UPSTOX_V3_LIVE. */
  readonly sourceName: string;
  /** Fetch + normalize pre-open observations for the given instruments. */
  fetchPreOpen(instrumentKeys: string[]): Promise<PreOpenFetchResult>;
}

/**
 * DI token for the active source. Interfaces do not exist at runtime, so the
 * adapter is bound to this explicit token and the capture service injects the
 * token — never a concrete broker class.
 */
export const PRE_OPEN_QUOTE_SOURCE = 'PRE_OPEN_QUOTE_SOURCE';
