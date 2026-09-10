/**
 * Pure decision rules for pre-cleared desk instructions.
 *
 * No DB, no clock, no network: everything a decision depends on is passed in.
 * That is deliberate — the rules that decide whether real (paper) money moves
 * must be readable and testable on their own, and the important ones are
 * REFUSALS: when anything needed for an honest order is missing, the answer is
 * "skip with a reason", never a guessed size or a fabricated price.
 */

export type InstructionSide = 'BUY' | 'SELL';

export interface InstructionLike {
  enabled: boolean;
  side: InstructionSide;
  instrument: string;
  underlying: string | null;
  lots: number | null;
  lotSize: number | null;
  maxCapital: number | null;
  sessionDate: string | null;
  lastExecutedSession: string | null;
}

export interface InstructionPlanInput {
  /** IST session date, 'YYYY-MM-DD'. */
  todayIst: string;
  /** Universes this desk is registered to trade. Empty = no restriction. */
  universes: string[];
  /** Lot size resolved from the instruction / env / broker contract master. */
  lotSize: number | null;
  /** Where that lot size came from (for the audit trail). */
  lotSizeSource: string;
  /** Fill-side premium from a live quote (ask for BUY, bid for SELL, else LTP). */
  premium: number | null;
}

export type InstructionPlan =
  | { execute: true; lots: number; lotSize: number; units: number; outlay: number; capitalCap: number; expected: number }
  | { execute: false; skipped: string };

/** IST is UTC+05:30 with no DST — the market's calendar, not the host's. */
export const IST_OFFSET_MS = 5.5 * 3_600_000;
export const istDateOf = (nowMs: number): string => new Date(nowMs + IST_OFFSET_MS).toISOString().slice(0, 10);
export const istMinutesOfDay = (nowMs: number): number => {
  const shifted = new Date(nowMs + IST_OFFSET_MS);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
};
/** The cash session closes at 15:30 IST (the desk's own session boundary). */
export const IST_SESSION_CLOSE_MINUTES = 15 * 60 + 30;
/**
 * Epoch ms of the 15:30 IST close of the IST trading date that contains `atMs`.
 * Stored quotes live on in the hours after the bell, so this is what evidence
 * windows are clamped to: a measurement may never read past it.
 */
export const istSessionCloseMs = (atMs: number): number => {
  const shifted = new Date(atMs + IST_OFFSET_MS);
  const istMidnightAsUtc = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  return istMidnightAsUtc + IST_SESSION_CLOSE_MINUTES * 60_000 - IST_OFFSET_MS;
};

/**
 * When the auto-start may act, in IST wall-clock minutes. Session open is 09:15;
 * entries stop well before the 15:30 close so a fresh instruction cannot be
 * opened into the close. These are operational windows, not trading levels.
 */
export const SESSION_OPEN_MINUTES = 9 * 60 + 15;
export const SESSION_LAST_ENTRY_MINUTES = 15 * 60 + 20;

export const withinSessionWindow = (nowMs: number): boolean => {
  const minutes = istMinutesOfDay(nowMs);
  return minutes >= SESSION_OPEN_MINUTES && minutes <= SESSION_LAST_ENTRY_MINUTES;
};

/** 'HH:MM' for a minute-of-day, for logs and operator messages. */
export const istClockLabel = (minutesOfDay: number): string =>
  `${String(Math.floor(minutesOfDay / 60)).padStart(2, '0')}:${String(minutesOfDay % 60).padStart(2, '0')}`;

/** The entry window as a human label, e.g. '09:15 → 15:20 IST'. */
export const sessionWindowLabel = (): string =>
  `${istClockLabel(SESSION_OPEN_MINUTES)} → ${istClockLabel(SESSION_LAST_ENTRY_MINUTES)} IST`;

/** Due = armed, not yet fired for THIS session, and not a stale one-shot. */
export const isInstructionDue = (instruction: InstructionLike, todayIst: string): boolean =>
  Boolean(instruction.enabled) &&
  (instruction.sessionDate ? String(instruction.sessionDate).slice(0, 10) === todayIst : true) &&
  instruction.lastExecutedSession !== todayIst;

/** Options only — the desk cannot hold an index position (existing desk rule). */
export const isOptionContract = (instrument: string): boolean => /(CE|PE)$/i.test(String(instrument ?? '').trim());

export const planInstruction = (instruction: InstructionLike, input: InstructionPlanInput): InstructionPlan => {
  if (!instruction.enabled) return { execute: false, skipped: 'instruction is disabled' };

  const oneShot = instruction.sessionDate ? String(instruction.sessionDate).slice(0, 10) : null;
  if (oneShot && oneShot !== input.todayIst) {
    return { execute: false, skipped: `one-shot instruction is for ${oneShot}, today is ${input.todayIst}` };
  }
  if (instruction.lastExecutedSession === input.todayIst) {
    return { execute: false, skipped: `already executed for session ${input.todayIst}` };
  }

  const instrument = String(instruction.instrument ?? '').trim().toUpperCase();
  if (!isOptionContract(instrument)) {
    return { execute: false, skipped: `instrument ${instrument || '(blank)'} does not end in CE/PE — the desk trades option contracts, index positions are reference-only` };
  }

  const underlying = instruction.underlying ? String(instruction.underlying).trim().toUpperCase() : null;
  const universes = (input.universes ?? []).map((u) => String(u).toUpperCase());
  if (universes.length && underlying && !universes.includes(underlying)) {
    return { execute: false, skipped: `the desk does not trade ${underlying} (registered: ${universes.join(', ')})` };
  }

  const lotSize = Number(input.lotSize);
  if (!Number.isFinite(lotSize) || lotSize < 1) {
    return {
      execute: false,
      skipped: `no lot size for ${instrument} — set it on the instruction, or UPSTOX_LIVE_PAPER_LOT_SIZE, or let the desk read the broker contract master (never guessed)`,
    };
  }

  const premium = Number(input.premium);
  if (!Number.isFinite(premium) || premium <= 0) {
    return { execute: false, skipped: `no traded premium for ${instrument} yet — waiting for a live quote` };
  }

  const cap = Number(instruction.maxCapital);
  if (!Number.isFinite(cap) || cap <= 0) {
    return { execute: false, skipped: 'instruction has no maxCapital — refusing to size an order without a per-position capital cap' };
  }

  const requested = Number(instruction.lots);
  const lots = Number.isFinite(requested) && requested >= 1
    ? Math.trunc(requested)
    : Math.floor(cap / (premium * lotSize));
  if (lots < 1) {
    return {
      execute: false,
      skipped: `one lot costs ₹${(premium * lotSize).toFixed(2)} which exceeds the per-position cap ₹${cap.toFixed(2)}`,
    };
  }

  const units = lots * lotSize;
  const outlay = units * premium;
  if (outlay > cap) {
    return {
      execute: false,
      skipped: `outlay ₹${outlay.toFixed(2)} (${lots} lot(s) × ${lotSize} × ₹${premium.toFixed(2)}) exceeds the per-position cap ₹${cap.toFixed(2)}`,
    };
  }

  return { execute: true, lots, lotSize: Math.trunc(lotSize), units, outlay, capitalCap: cap, expected: premium };
};
