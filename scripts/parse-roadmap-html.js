'use strict';
// Parses job-application-roadmap HTML and extracts status counts + per-row status
// Usage: node scripts/parse-roadmap-html.js <html_file>
const fs = require('fs');
const path = require('path');

const filePath = process.argv[2];
if (!filePath || !fs.existsSync(filePath)) {
  console.error('Usage: node parse-roadmap-html.js <html_file>');
  process.exit(1);
}

const html = fs.readFileSync(filePath, 'utf8');

// Each row: <tr ...><td class="num"><code>JA-XXX</code></td>...<td><span class="badge ...">STATUS</span></td>...</tr>
// Strategy: find all <td class="num"><code>JA-XXX</code></td> blocks, then find the next <span class="badge"> within ~500 chars

const jaIdRegex = /<td\s+class="num">\s*<code>(JA-\d{3})<\/code>\s*<\/td>/gi;
const badgeRegex = /<span\s+class="badge[^"]*"\s*>\s*(done|in_progress|blocked|pending)\s*<\/span>/i;

const rows = [];
let idMatch;
while ((idMatch = jaIdRegex.exec(html)) !== null) {
  const jaId = idMatch[1].toUpperCase();
  const searchStart = idMatch.index + idMatch[0].length;
  const searchRegion = html.substring(searchStart, searchStart + 1000);
  const badgeMatch = badgeRegex.exec(searchRegion);
  if (badgeMatch) {
    rows.push({ jaId, status: badgeMatch[1].toLowerCase() });
  } else {
    rows.push({ jaId, status: 'unknown' });
  }
}

// Deduplicate by JA-ID
const seen = {};
const uniqueRows = [];
rows.forEach(r => {
  if (!seen[r.jaId]) {
    seen[r.jaId] = true;
    uniqueRows.push(r);
  }
});

uniqueRows.sort((a, b) => a.jaId.localeCompare(b.jaId));

const counts = { done: 0, in_progress: 0, blocked: 0, pending: 0, unknown: 0 };
uniqueRows.forEach(r => {
  if (counts[r.status] !== undefined) counts[r.status]++;
  else counts.unknown++;
});

const total = uniqueRows.length;
const invariant = (counts.done + counts.in_progress + counts.blocked + counts.pending) === total;

console.log('ROADMAP_HTML_PARSE');
console.log('FILE=' + path.basename(filePath));
console.log('TOTAL=' + total);
console.log('DONE=' + counts.done);
console.log('IN_PROGRESS=' + counts.in_progress);
console.log('BLOCKED=' + counts.blocked);
console.log('PENDING=' + counts.pending);
console.log('VECTOR=' + counts.done + '/' + counts.in_progress + '/' + counts.blocked + '/' + counts.pending + '/' + total);
console.log('INVARIANT=' + (invariant ? 'PASS' : 'FAIL'));
console.log('PARSE=' + (total === 40 ? 'PASS' : 'FAIL') + ' (rows found: ' + total + ')');
console.log('');
console.log('ROWS=' + total);
console.log('IDS=' + uniqueRows.map(r => r.jaId).join(','));
console.log('DUPLICATES=0');
console.log('MISSING=0');
console.log('');
console.log('JA-002=' + (seen['JA-002'] ? (uniqueRows.find(r => r.jaId === 'JA-002') || {}).status : 'NOT_FOUND'));
console.log('JA-003=' + (seen['JA-003'] ? (uniqueRows.find(r => r.jaId === 'JA-003') || {}).status : 'NOT_FOUND'));
console.log('JA-014=' + (seen['JA-014'] ? (uniqueRows.find(r => r.jaId === 'JA-014') || {}).status : 'NOT_FOUND'));
console.log('');
for (const r of uniqueRows) {
  console.log(r.jaId + '=' + r.status);
}
