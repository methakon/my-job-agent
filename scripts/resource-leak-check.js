#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const DIST = path.resolve(__dirname, '..', 'dist');

const patterns = [
  {
    regex: /(?<!\/\/.*)(?:var|let|const|)\s*(?:\w+\s*=\s*)?setInterval\s*\(/g,
    type: 'setInterval',
    severity: 'MEDIUM',
    recommendation: 'Ensure clearInterval is called when the interval is no longer needed. Store the interval ID in a variable.',
  },
  {
    regex: /\.(?:addEventListener|on)\s*\(\s*['"](?:message|data|error|close|end|connect)['"]\s*,/g,
    type: 'addEventListener_without_cleanup',
    severity: 'MEDIUM',
    recommendation: 'Ensure corresponding removeEventListener/removeListener is called during cleanup or shutdown.',
  },
  {
    regex: /new Map\s*\(\s*\)/g,
    type: 'new_Map',
    severity: 'LOW',
    recommendation: 'Module-level Maps may grow unbounded. Verify there is a cleanup mechanism or size limit.',
  },
  {
    regex: /new Set\s*\(\s*\)/g,
    type: 'new_Set',
    severity: 'LOW',
    recommendation: 'Module-level Sets may grow unbounded. Verify there is a cleanup mechanism or size limit.',
  },
  {
    regex: /fs\.watch(?:File)?\s*\(/g,
    type: 'fs_watch',
    severity: 'MEDIUM',
    recommendation: 'Ensure watcher.close() or fs.unwatchFile() is called when no longer needed.',
  },
  {
    regex: /new WebSocket\s*\(/g,
    type: 'websocket_creation',
    severity: 'MEDIUM',
    recommendation: 'Ensure WebSocket connections are closed on shutdown and have error/close handlers.',
  },
  {
    regex: /setInterval\s*\([^)]+\)\s*;/g,
    type: 'setInterval_lost_reference',
    severity: 'HIGH',
    recommendation: 'setInterval return value is not captured — timer cannot be cleared. Store in a variable.',
  },
];

function scanFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const findings = [];

  for (const { regex, type, severity, recommendation } of patterns) {
    const re = new RegExp(regex.source, regex.flags);
    let match;
    while ((match = re.exec(content)) !== null) {
      const beforeMatch = content.substring(0, match.index);
      const lineNum = beforeMatch.split('\n').length;
      findings.push({
        file: path.relative(DIST, filePath),
        line: lineNum,
        pattern_type: type,
        severity,
        recommendation,
      });
    }
  }
  return findings;
}

function walk(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walk(full));
    } else if (entry.name.endsWith('.js')) {
      results.push(full);
    }
  }
  return results;
}

let allFindings = [];
if (fs.existsSync(DIST)) {
  const files = walk(DIST);
  for (const f of files) {
    allFindings.push(...scanFile(f));
  }
}

// De-duplicate by file+line+type
const seen = new Set();
allFindings = allFindings.filter(f => {
  const key = `${f.file}:${f.line}:${f.pattern_type}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

// Sort: HIGH first, then MEDIUM, then LOW
const order = { HIGH: 0, MEDIUM: 1, LOW: 2 };
allFindings.sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));

process.stdout.write(JSON.stringify(allFindings, null, 2) + '\n');
process.exit(0);
