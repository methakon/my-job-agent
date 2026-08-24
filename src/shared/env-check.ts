// Shared credential/environment check — runs at every service bootstrap.
// Fails fast with a clear prompt listing anything missing or not working.

export interface EnvSpec {
  /** Variables that MUST be present (non-empty). */
  required: string[];
  /** Files that MUST exist on disk (e.g. JWT key paths). */
  requiredFiles?: string[];
  /** Service name for error messages. */
  service: string;
}

const BASE_REQUIRED = [
  'MYSQL_HOST',
  'MYSQL_PORT',
  'MYSQL_USER',
  'MYSQL_PASSWORD',
  'GATEWAY_PORT',
  'FRONTEND_URL',
];

const SPECS: Record<string, EnvSpec> = {
  'mylife-gateway': {
    service: 'mylife-gateway',
    required: [...BASE_REQUIRED, 'GATEWAY_PORT', 'JWT_PUBLIC_KEY_PATH', 'JWT_ACCESS_TTL'],
    requiredFiles: ['JWT_PUBLIC_KEY_PATH'],
  },
  'mylife-auth': {
    service: 'mylife-auth',
    required: [...BASE_REQUIRED, 'AUTH_PORT', 'JWT_PRIVATE_KEY_PATH', 'JWT_PUBLIC_KEY_PATH', 'JWT_ACCESS_TTL', 'JWT_REFRESH_TTL', 'BCRYPT_ROUNDS'],
    requiredFiles: ['JWT_PRIVATE_KEY_PATH', 'JWT_PUBLIC_KEY_PATH'],
  },
  'mylife-users': { service: 'mylife-users', required: [...BASE_REQUIRED, 'USERS_PORT'] },
  'mylife-astrology': { service: 'mylife-astrology', required: [...BASE_REQUIRED, 'ASTROLOGY_PORT', 'TIMEZONE_DB_API_KEY'] },
  'mylife-career': { service: 'mylife-career', required: [...BASE_REQUIRED, 'CAREER_PORT'] },
  'mylife-finance': { service: 'mylife-finance', required: [...BASE_REQUIRED, 'FINANCE_PORT', 'OPENAI_API_KEY'] },
  'mylife-learning': { service: 'mylife-learning', required: [...BASE_REQUIRED, 'LEARNING_PORT', 'OPENAI_API_KEY'] },
};

/** Minimal .env loader (no dependency) so the check can run before Nest ConfigModule. */
function loadRootEnv(): void {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const envPath = path.resolve(__dirname, '../../../.env'); // repo root from services/<svc>/dist or src
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

/**
 * Checks all credentials/env vars for a service. Call at the top of main.ts
 * BEFORE NestFactory.create. Exits the process with a readable prompt if
 * anything is missing or broken.
 */
export function checkCredentials(serviceName: string): void {
  loadRootEnv();
  const spec = SPECS[serviceName];
  if (!spec) {
    console.warn(`[env-check] No env spec registered for "${serviceName}" — skipping check.`);
    return;
  }

  const missing: string[] = [];
  const broken: string[] = [];

  for (const key of spec.required) {
    const value = process.env[key];
    if (value === undefined || value.trim() === '') missing.push(key);
  }

  for (const key of spec.requiredFiles ?? []) {
    const rawPath = process.env[key];
    if (!rawPath) continue;
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const p = path.isAbsolute(rawPath) ? rawPath : path.resolve(process.cwd(), '..', '..', rawPath); // relative paths are repo-root-relative
    if (!fs.existsSync(p)) broken.push(`${key} -> file not found: ${rawPath} (looked at ${p})`);
  }

  if (missing.length === 0 && broken.length === 0) {
    console.log(`[env-check] ${spec.service}: all credentials OK (${spec.required.length} vars verified).`);
    return;
  }

  console.error(`\n[env-check] ${spec.service} cannot start — credential check FAILED.\n`);
  if (missing.length > 0) {
    console.error('  Missing or empty variables:');
    for (const key of missing) console.error(`    - ${key}`);
  }
  if (broken.length > 0) {
    console.error('  Not working (file/path problems):');
    for (const b of broken) console.error(`    - ${b}`);
  }
  console.error('\n  Fix: add the missing entries to the root .env file and restart.\n');
  process.exit(1);
}
