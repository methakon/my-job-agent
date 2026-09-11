/**
 * sandbox-safety.ts — JA-002 deterministic sandbox / kill-switch guard.
 *
 * Every real submission boundary imports this module and calls
 * isSubmissionBlocked() BEFORE performing a real send or submit.
 *
 * Fail-closed: when SANDBOX=true OR APPLY_KILL_SWITCH=true, no real SMTP
 * send and no browser submit may occur.  Fill-only browser behaviour is
 * intentionally NOT blocked.
 *
 * The two env var names are the canonical source of truth; nothing else
 * decides whether a submission is blocked.
 */

import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

const ENV_FILE = path.resolve(process.cwd(), '.env');

function readEnvBool(name: string, def: boolean = false): boolean {
  // honour an already-set process.env value first (e.g. set by SandboxService
  // at runtime), then fall back to the persisted .env file.
  const pe = process.env[name];
  if (pe !== undefined) return pe === 'true';
  try {
    const raw = fs.readFileSync(ENV_FILE, 'utf-8');
    const m = dotenv.parse(raw);
    return m[name] === 'true';
  } catch {
    return def;
  }
}

/**
 * True when submission safety conditions require every real submission path
 * to be blocked.
 *
 * Consults, in order:
 *   1. process.env.SANDBOX            (runtime override set by SandboxService)
 *   2. .env SANDBOX
 *   3. process.env.APPLY_KILL_SWITCH
 *   4. .env APPLY_KILL_SWITCH
 */
export function isSubmissionBlocked(): boolean {
  return (
    readEnvBool('SANDBOX') || readEnvBool('APPLY_KILL_SWITCH')
  );
}
