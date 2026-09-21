'use strict';
// Compares DB, local HTTP, and public HTTP roadmap states
// Usage: node scripts/compare-roadmap-state.js
const fs = require('fs');
const { execSync } = require('child_process');

// Parse DB output: lines like "JA-001 DB=done" (single space)
function parseDbStatuses(text) {
  const statuses = {};
  const re = /^([A-Z]+-\d{3}) DB=(done|in_progress|blocked|pending)$/;
  for (const line of text.split('\n')) {
    const m = line.match(re);
    if (m) statuses[m[1]] = m[2];
  }
  return statuses;
}

// Parse HTML parser output: extract per-JA-ID statuses + aggregates
function parseHtmlOutput(text) {
  const statuses = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^(JA-\d{3})=(done|in_progress|blocked|pending|unknown|NOT_FOUND)$/i);
    if (m) statuses[m[1].toUpperCase()] = m[2].toLowerCase();
  }
  const totalMatch = text.match(/TOTAL=(\d+)/);
  const doneMatch = text.match(/DONE=(\d+)/);
  const ipMatch = text.match(/IN_PROGRESS=(\d+)/);
  const blMatch = text.match(/BLOCKED=(\d+)/);
  const peMatch = text.match(/PENDING=(\d+)/);
  return {
    statuses,
    total: totalMatch ? parseInt(totalMatch[1]) : 0,
    done: doneMatch ? parseInt(doneMatch[1]) : 0,
    in_progress: ipMatch ? parseInt(ipMatch[1]) : 0,
    blocked: blMatch ? parseInt(blMatch[1]) : 0,
    pending: peMatch ? parseInt(peMatch[1]) : 0,
  };
}

function norm(s) {
  if (!s || s === 'not_found' || s === 'unknown') return 'absent';
  return s;
}

// === Load data ===
let localParseOut, publicParseOut, dbOutput;
try {
  localParseOut = execSync('node scripts/parse-roadmap-html.js /tmp/job-roadmap-local.html',
    { encoding: 'utf8', timeout: 10000, cwd: '/home/swarna-sekhar-dhar/projects/my-job-agent' });
} catch (e) { localParseOut = e.stdout || e.message || ''; }
try {
  publicParseOut = execSync('node scripts/parse-roadmap-html.js /tmp/job-roadmap-public.html',
    { encoding: 'utf8', timeout: 10000, cwd: '/home/swarna-sekhar-dhar/projects/my-job-agent' });
} catch (e) { publicParseOut = e.stdout || e.message || ''; }
try {
  dbOutput = execSync('node scripts/read-roadmap-db.js',
    { encoding: 'utf8', timeout: 15000, cwd: '/home/swarna-sekhar-dhar/projects/my-job-agent' });
} catch (e) { dbOutput = e.stdout || e.message || ''; }

const dbStatuses = parseDbStatuses(dbOutput);
const localData = parseHtmlOutput(localParseOut);
const publicData = parseHtmlOutput(publicParseOut);

// DB aggregate
const dbAgg = { done: 0, in_progress: 0, blocked: 0, pending: 0 };
let dbTotal = 0;
Object.values(dbStatuses).forEach(s => { dbTotal++; if (dbAgg[s] !== undefined) dbAgg[s]++; });

// HTML aggregates
const localTotal = localData.total;
const publicTotal = publicData.total;

// === PRINT ===
console.log('ROADMAP_COMPARISON');
console.log('');
console.log('DB:');
console.log('  TOTAL=' + dbTotal);
console.log('  DONE=' + dbAgg.done);
console.log('  IN_PROGRESS=' + dbAgg.in_progress);
console.log('  BLOCKED=' + dbAgg.blocked);
console.log('  PENDING=' + dbAgg.pending);
console.log('  VECTOR=' + dbAgg.done + '/' + dbAgg.in_progress + '/' + dbAgg.blocked + '/' + dbAgg.pending + '/' + dbTotal);
console.log('');
console.log('LOCAL_HTTP:');
console.log('  TOTAL=' + localTotal);
console.log('  DONE=' + localData.done);
console.log('  IN_PROGRESS=' + localData.in_progress);
console.log('  BLOCKED=' + localData.blocked);
console.log('  PENDING=' + localData.pending);
console.log('  VECTOR=' + localData.done + '/' + localData.in_progress + '/' + localData.blocked + '/' + localData.pending + '/' + localTotal);
console.log('');
console.log('PUBLIC_HTTP:');
console.log('  TOTAL=' + publicTotal);
console.log('  DONE=' + publicData.done);
console.log('  IN_PROGRESS=' + publicData.in_progress);
console.log('  BLOCKED=' + publicData.blocked);
console.log('  PENDING=' + publicData.pending);
console.log('  VECTOR=' + publicData.done + '/' + publicData.in_progress + '/' + publicData.blocked + '/' + publicData.pending + '/' + publicTotal);
console.log('');
console.log('COUNT_COMPARISON:');
const totalMatch = (dbTotal === localTotal && dbTotal === publicTotal && localTotal === publicTotal);
const doneMatch = (dbAgg.done === localData.done && dbAgg.done === publicData.done);
const ipMatch = (dbAgg.in_progress === localData.in_progress && dbAgg.in_progress === publicData.in_progress);
const blMatch = (dbAgg.blocked === localData.blocked && dbAgg.blocked === publicData.blocked);
const peMatch = (dbAgg.pending === localData.pending && dbAgg.pending === publicData.pending);
console.log('  DB==LOCAL=' + (totalMatch && doneMatch && ipMatch && blMatch && peMatch ? 'PASS' : 'FAIL'));
console.log('  DB==PUBLIC=' + (totalMatch && doneMatch && ipMatch && blMatch && peMatch ? 'PASS' : 'FAIL'));
console.log('  LOCAL==PUBLIC=' + (localData.done === publicData.done &&
  localData.in_progress === publicData.in_progress &&
  localData.blocked === publicData.blocked &&
  localData.pending === publicData.pending ? 'PASS' : 'FAIL'));
console.log('  ALL_COUNTS_IDENTICAL=' + (totalMatch && doneMatch && ipMatch && blMatch && peMatch ? 'PASS' : 'FAIL'));
console.log('');

// === ROW-BY-ROW ===
const allIds = new Set([...Object.keys(dbStatuses), ...Object.keys(localData.statuses), ...Object.keys(publicData.statuses)]);
const sortedIds = Array.from(allIds).sort();

console.log('ROW_COMPARISON');
let allMatch = true;
for (const id of sortedIds) {
  const dbS = norm(dbStatuses[id]);
  const localS = norm(localData.statuses[id]);
  const publicS = norm(publicData.statuses[id]);
  const match = (dbS === localS && localS === publicS);
  if (!match) allMatch = false;
  console.log(id + ' DB=' + (dbStatuses[id] || 'NOT_IN_DB') + ' LOCAL=' + (localData.statuses[id] || 'NOT_FOUND') + ' PUBLIC=' + (publicData.statuses[id] || 'NOT_FOUND') + ' MATCH=' + (match ? 'PASS' : 'FAIL'));
}
console.log('');
console.log('ALL_ROWS_IDENTICAL=' + (allMatch ? 'PASS' : 'FAIL'));
console.log('');

const allOk = totalMatch && doneMatch && ipMatch && blMatch && peMatch && allMatch && dbTotal === 40;
process.exit(allOk ? 0 : 1);
