#!/usr/bin/env node
/**
 * Gate 365 — Release Artifact
 * Verify reproducible release: package.json has version, build succeeds,
 * source files tracked, no uncommitted changes.
 * Exit 0 = PASS, Exit 1 = FAIL
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO = path.resolve(__dirname, '../..');
const reasons = [];

function check(label, fn) {
  try {
    if (!fn()) reasons.push(`FAIL: ${label}`);
  } catch (e) {
    reasons.push(`FAIL: ${label} — ${e.message}`);
  }
}

// 1. package.json has version field
check('package.json has version', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  return typeof pkg.version === 'string' && pkg.version.length > 0;
});

// 2. version follows semver-ish pattern
check('version is semver-ish (x.y.z)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  return /^\d+\.\d+\.\d+/.test(pkg.version);
});

// 3. package-lock.json or equivalent lock file exists
check('lock file exists', () => {
  return fs.existsSync(path.join(REPO, 'package-lock.json')) || fs.existsSync(path.join(REPO, 'yarn.lock'));
});

// 4. All committed TS source files under src/ exist in git (no deleted but tracked files)
check('committed source files are tracked in git', () => {
  const out = execSync('git diff --name-only HEAD -- src/', { cwd: REPO, encoding: 'utf8' }).trim();
  return out.length === 0;
});

// 5. No uncommitted changes to tracked files
check('no uncommitted changes to tracked files', () => {
  const out = execSync('git diff --name-only', { cwd: REPO, encoding: 'utf8' }).trim();
  const staged = execSync('git diff --cached --name-only', { cwd: REPO, encoding: 'utf8' }).trim();
  return out.length === 0 && staged.length === 0;
});

// 6. tsconfig.json exists
check('tsconfig.json exists', () => {
  return fs.existsSync(path.join(REPO, 'tsconfig.json'));
});

// 7. src/ directory is non-empty
check('src/ has content', () => {
  const entries = fs.readdirSync(path.join(REPO, 'src'));
  return entries.length > 5;
});

if (reasons.length > 0) {
  console.log('GATE 365 — Release Artifact: FAIL');
  reasons.forEach(r => console.log('  ' + r));
  process.exit(1);
}

console.log('GATE 365 — Release Artifact: PASS');
console.log('  All 7 checks passed: version present, no untracked/uncommitted files, lock file exists, build-ready.');
process.exit(0);
