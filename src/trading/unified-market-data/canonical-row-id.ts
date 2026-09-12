import { v5 as uuidv5 } from 'uuid';
import { payloadHash, stableStringify } from './canonical/canonical-tick';

/**
 * Deterministic canonical ROW identity — the prerequisite for replay-safe batch persistence.
 *
 * WHY
 * ---
 * `unified_option_quotes`, `unified_market_snapshots`, `fnf_option_quotes` and the Upstox paper
 * tables all use a RANDOM uuid primary key (`@PrimaryGeneratedColumn('uuid')`), and their natural
 * keys are NOT unique (measured 2026-09-12: 65% duplicate `(contractSymbol, ts)` pairs in a peak FNF
 * window, 35% on unified). So an at-least-once batch replay would duplicate rows today.
 *
 * This module derives the row id from the tick's canonical identity instead: identical economic
 * ticks map to the same id (dedupe), different ticks map to different ids (no loss). Writing with
 * `INSERT ... ON DUPLICATE KEY UPDATE` against the EXISTING primary key then makes a replayed batch
 * idempotent with NO DDL and no schema migration.
 *
 * WHAT IS IN THE IDENTITY (and what is deliberately NOT)
 * -----------------------------------------------------
 *   in:  source (FYERS | UPSTOX | ... — provenance is never merged away)
 *        instrumentKey (the canonical identity every desk keys on)
 *        sourceTimestamp (declared-basis instant, normalised to ISO so equal instants agree)
 *        the tick's own economic content (ltp/bid/ask/sizes/volume/oi), hashed
 *        the interpreter's provider payload hash when one exists (preferred: audit-grade)
 *   NOT: the per-process `sequenceNumber` (it is a counter that resets on restart, so including it
 *        would make the "same" tick produce a different id after every restart — exactly the
 *        replay-safety this exists to provide), nor `receivedTimestamp` (ingest-time, not identity),
 *        nor any row-level bookkeeping (createdAt, archivedAt, dataQuality).
 *
 * A refusal (null) is deliberate: if nothing distinguishes the tick, the caller must not invent an
 * id — the batch writer treats null as "cannot persist idempotently" and fails loudly rather than
 * writing a row that a replay could duplicate.
 */

/** Fixed namespace: must never change, or every previously persisted deterministic id shifts. */
export const CANONICAL_ROW_ID_NAMESPACE = '6f3a1c2e-9d47-5c8b-8f21-2b7a4e5d91c3';

/** Version tag of the identity tuple. Bump ONLY with a migration plan for existing ids. */
export const CANONICAL_ROW_ID_VERSION = 'rowid-v1';

/** uuid v5 shape (version nibble 5, RFC-4122 variant) — 36 chars, fits the existing varchar PK. */
export const CANONICAL_ROW_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type CanonicalRowIdentity = {
	/** Provider provenance: FYERS / UPSTOX / ... Two providers' copies stay distinct rows. */
	source: string;
	/** Canonical instrument identity, e.g. NSE:NIFTY26SEP23000PE. */
	instrumentKey: string;
	/** Declared-basis source timestamp (Date object, ISO string, or null). */
	sourceTimestamp: Date | string | null;
	/** The tick's economic content: only finite numeric fields participate. */
	content?: Record<string, number | null | undefined>;
	/** The interpreter's provider payload hash, when available (preferred over `content`). */
	providerPayloadHash?: string | null;
};

const num = (v: number | null | undefined): number | null =>
	typeof v === 'number' && Number.isFinite(v) ? v : null;

/**
 * The exact tuple the id is derived from — exposed so a reviewer/audit can reproduce and compare it.
 * Returns null when the identity is NOT strong enough to be replay-safe.
 */
export function canonicalRowIdSource(identity: CanonicalRowIdentity): string | null {
	const source = String(identity.source ?? '').trim().toUpperCase();
	const instrumentKey = String(identity.instrumentKey ?? '').trim().toUpperCase();
	if (!source || !instrumentKey) return null;

	const ts =
		identity.sourceTimestamp instanceof Date
			? identity.sourceTimestamp.toISOString()
			: String(identity.sourceTimestamp ?? '').trim();

	// economic content: finite numbers only, sorted via the canonical layer's stable stringifier
	const content: Record<string, number> = {};
	for (const [k, v] of Object.entries(identity.content ?? {})) {
		const n = num(v);
		if (n !== null) content[k] = n;
	}
	const contentSignature = Object.keys(content).length ? payloadHash(content) : '';
	const providerHash = String(identity.providerPayloadHash ?? '').trim().toLowerCase();

	// A tick with no economic content and no provider hash carries nothing to distinguish it from any
	// other tick of the same contract: refuse rather than mint a weak identity.
	if (!contentSignature && !providerHash) return null;
	if (!ts && !providerHash) return null; // no instant and no payload hash -> cannot be replay-safe

	return [CANONICAL_ROW_ID_VERSION, source, instrumentKey, ts, providerHash, contentSignature].join('|');
}

/** Deterministic row id, or null when the identity is too weak (caller must fail loudly). */
export function canonicalRowId(identity: CanonicalRowIdentity): string | null {
	const source = canonicalRowIdSource(identity);
	if (!source) return null;
	return uuidv5(source, CANONICAL_ROW_ID_NAMESPACE);
}

/** True when `id` is a deterministic v5 id from this module (as opposed to a legacy random uuid). */
export function isDeterministicRowId(id: unknown): boolean {
	return typeof id === 'string' && CANONICAL_ROW_ID_RE.test(id.toLowerCase());
}

/** Re-exported so callers of this module do not need a second import for canonical hashing. */
export { stableStringify };
