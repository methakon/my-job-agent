#!/usr/bin/env node
/**
 * ja-roadmap-status — sanitize-opinionated CLI wrapper around
 * POST /job-application-roadmap/item/:id/status
 *
 * Usage:
 *   node scripts/ja-roadmap-status.js --id JA-010 --status done \
 *     --evidence "test: ja-010-qualification-engine 14/0/14; commit abc123; tsc clean; build clean" \
 *     --commit abc123def456
 *
 *   node scripts/ja-roadmap-status.js --id JA-012 --status in_progress \
 *     --evidence "test: ja-012 scripts in progress; awaiting final verification"
 *
 *   node scripts/ja-roadmap-status.js --help
 *
 * The wrapper sanitizes inputs before forwarding to the API:
 *   - itemId: only [A-Za-z0-9_\-] allowed.
 *   - status: must be one of pending|in_progress|done|blocked.
 *   - evidence: non-empty; leading [timestamp] block is auto-prefixed if
 *     the evidence doesn't already start with one. Max 800 chars.
 *   - commit: forwarded as-is (service slices to 10 chars).
 *   - verifiedAt: optional ISO timestamp; defaults to now.
 *
 * The endpoint is @BypassAuth, so no session is needed — authentication
 * is via the x-operator-password header, read from JA_ROADMAP_PASSWORD
 * env (fallback SESSION_PASSWORD).
 */
'use strict';

const http = require('http');

const PASSWORD = process.env.JA_ROADMAP_PASSWORD || process.env.SESSION_PASSWORD;
if (!PASSWORD) {
  console.error('ERROR: set JA_ROADMAP_PASSWORD or SESSION_PASSWORD env');
  process.exit(1);
}

const HOST = process.env.JA_ROADMAP_HOST || '127.0.0.1';
const PORT = process.env.JA_ROADMAP_PORT || 3010;
const ENDPOINT = `http://${HOST}:${PORT}/job-application-roadmap/item`;

const VALID_STATUSES = new Set(['pending', 'in_progress', 'done', 'blocked']);
const ITEM_ID_RE = /^[A-Za-z0-9_\-]{1,64}$/;

function fail(msg) {
  console.error('ERROR:', msg);
  process.exit(1);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { id: null, status: null, evidence: null, commit: null, verifiedAt: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const v = args[i + 1];
    if (a === '--id' && v) { opts.id = v; i++; }
    else if (a === '--status' && v) { opts.status = v; i++; }
    else if (a === '--evidence' && v) { opts.evidence = v; i++; }
    else if (a === '--commit' && v) { opts.commit = v; i++; }
    else if (a === '--verifiedAt' && v) { opts.verifiedAt = v; i++; }
    else if (a === '--help' || a === '-h') {
      console.log(`
Usage: node scripts/ja-roadmap-status.js --id <itemId> --status <status> [options]

Required:
  --id <itemId>      Roadmap row itemId (e.g. JA-010, JA-012, P5-1)
  --status <status>  One of: pending | in_progress | done | blocked

Options:
  --evidence <text>  Evidence note (sanitized: auto-prefixed with [timestamp]
                     if not already timestamped; max 800 chars)
  --commit <sha>     Optional commit SHA (forwarded as-is; service slices to 10)
  --verifiedAt <iso> Optional ISO timestamp (default: now)

Env:
  JA_ROADMAP_PASSWORD / SESSION_PASSWORD  operator password for x-operator-password
  JA_ROADMAP_HOST (default 127.0.0.1)
  JA_ROADMAP_PORT (default 3010)

Examples:
  node scripts/ja-roadmap-status.js --id JA-010 --status done \\
    --evidence "test: ja-010-qualification-engine 14/0/14 pass; commit a1b2c3d" \\
    --commit a1b2c3d4e5f6

  node scripts/ja-roadmap-status.js --id JA-012 --status in_progress \\
    --evidence "test: ja-012 scripts running; awaiting final verification"
`);
      process.exit(0);
    }
  }
  return opts;
}

function nowStamp() {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

function sanitizeEvidence(raw) {
  if (!raw || raw.trim().length === 0) {
    return `[${nowStamp()}] status update via ja-roadmap-status CLI (no evidence provided)`;
  }
  let s = String(raw).trim();
  if (s.length > 800) s = s.slice(0, 800);
  // If evidence doesn't already start with [timestamp], prepend one.
  if (!/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]/.test(s)) {
    s = `[${nowStamp()}] ${s}`;
  }
  return s;
}

function doPost(itemId, status, evidence, commit, verifiedAt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      status,
      evidence,
      commitSha: commit || undefined,
      verifiedAt: verifiedAt || undefined,
    });
    const url = new URL(`${ENDPOINT}/${encodeURIComponent(itemId)}/status`);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'x-operator-password': PASSWORD,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ status: res.statusCode, body: data });
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data || res.statusMessage}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function main() {
  const opts = parseArgs();
  if (!opts.id) fail('--id is required');
  if (!opts.status) fail('--status is required');
  if (!ITEM_ID_RE.test(opts.id)) fail(`invalid --id "${opts.id}" (only [A-Za-z0-9_\-] allowed, max 64 chars)`);
  if (!VALID_STATUSES.has(opts.status)) fail(`invalid --status "${opts.status}" (must be one of: ${[...VALID_STATUSES].join(', ')})`);

  const evidence = sanitizeEvidence(opts.evidence);
  const commit = opts.commit || undefined;
  const verifiedAt = opts.verifiedAt || undefined;

  console.log(`POST ${ENDPOINT}/${encodeURIComponent(opts.id)}/status`);
  console.log(`  status      = ${opts.status}`);
  console.log(`  evidence    = ${evidence}`);
  console.log(`  commit      = ${commit || '(none)'}`);
  console.log(`  verifiedAt  = ${verifiedAt || '(now)'}`);

  doPost(opts.id, opts.status, evidence, commit, verifiedAt)
    .then((r) => {
      console.log(`OK — HTTP ${r.status}`);
      process.exit(0);
    })
    .catch((e) => {
      console.error('FAILED:', e.message);
      process.exit(1);
    });
}

main();
