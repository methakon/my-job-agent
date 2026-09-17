'use strict';
// Compares DB, local HTTP, and public HTTP roadmap states
const fs = require('fs');
const { execSync } = require('child_process');

function parseHtmlOutput(text) {
  const lines = text.split('\n');
  const statuses = {};
  for (const line of lines) {
    const m = line.match(/^(JA-\d{3})=(done|in_progress|blocked|pending|unknown|NOT_FOUND)$/i);
    if (m) statuses[m[1].toUpperCase()] = m[2].toLowerCase();
  }
  const totalMatch = text.match(/TOTAL=(\d+)/);
  const doneMatch = text.match(/DONE=(\d+)/);
  const inProgressMatch = text.match(/IN_PROGRESS=(\d+)/);
  const blockedMatch = text.match(/BLOCKED=(\d+)/);
  const pendingMatch = text.match(/PENDING=(\d+)/);
  return {
    statuses,
    total: totalMatch ? parseInt(totalMatch[1]) : 0,
    done: doneMatch ? parseInt(doneMatch[1]) : 0,
    in_progress: inProgressMatch ? parseInt(inProgressMatch[1]) : 0,
    blocked: blockedMatch ? parseInt(blockedMatch[1]) : 0,
    pending: pendingMatch ? parseInt(pendingMatch[1]) : 0,
  };
}

function parseDbOutput(text) {
  const lines = text.split('\n');
  const statuses = {};
  for (const line of lines) {
    let m = line.match(/^(JA-\d{3})\s+DB=(done|in_progress|blocked|pending)$/i);
    if (m) { statuses[m[1].toUpperCase()] = m[2].toLowerCase(); continue; }
    m = line.match(/^(JA-\d{3})\s+DB=MISSING$/i);
    if (m) statuses[m[1].toUpperCase()] = 'missing';
  }
  const totalMatch = text.match(/TOTAL=(\d+)/);
  const doneMatch = text.match(/DONE=(\d+)/);
  const inProgressMatch = text.match(/IN_PROGRESS=(\d+)/);
  const blockedMatch = text.match(/BLOCKED=(\d+)/);
  const pendingMatch = text.match(/PENDING=(\d+)/);
  return {
    statuses,
    total: totalMatch ? parseInt(totalMatch[1]) : 0,
    done: doneMatch ? parseInt(doneMatch[1]) : 0,
    in_progress: inProgressMatch ? parseInt(inProgressMatch[1]) : 0,
    blocked: blockedMatch ? parseInt(blockedMatch[1]) : 0,
    pending: pendingMatch ? parseInt(pendingMatch[1]) : 0,
  };
}

function norm(s) {
  if (s === 'missing' || s === 'not_found') return 'absent';
  return s;
}

// Load HTML files
const localHtml = fs.readFileSync('/tmp/job-roadmap-local.html', 'utf8');
const publicHtml = fs.readFileSync('/tmp/job-roadmap-public.html', 'utf8');

// Run parsers
let localParseOut, publicParseOut, dbOutput;
try { localParseOut = execSync('node scripts/parse-roadmap-html.js /tmp/job-roadmap-local.html', { encoding: 'utf8', timeout: 10000, cwd: '/home/swarna-sekhar-dhar/projects/my-job-agent' }); } catch(e) { localParseOut = e.stdout || e.message || ''; }
try { publicParseOut = execSync('node scripts/parse-roadmap-html.js /tmp/job-roadmap-public.html', { encoding: 'utf8', timeout: 10000, cwd: '/home/swarna-sekhar-dhar/projects/my-job-agent' }); } catch(e) { publicParseOut = e.stdout || e.message || ''; }
try { dbOutput = execSync('node scripts/read-roadmap-db.js', { encoding: 'utf8', timeout: 15000, cwd: '/home/swarna-sekhar-dhar/projects/my-job-agent' }); } catch(e) { dbOutput = e.stdout || e.message || ''; }

const dbData = parseDbOutput(dbOutput);
const localData = parseHtmlOutput(localParseOut);
const publicData = parseHtmlOutput(publicParseOut);

console.log('ROADMAP_COMPARISON');
console.log('');
console.log('DB:');
console.log('  TOTAL=' + dbData.total);
console.log('  DONE=' + dbData.done);
console.log('  IN_PROGRESS=' + dbData.in_progress);
console.log('  BLOCKED=' + dbData.blocked);
console.log('  PENDING=' + dbData.pending);
console.log('  VECTOR=' + dbData.done + '/' + dbData.in_progress + '/' + dbData.blocked + '/' + dbData.pending + '/' + dbData.total);
console.log('');
console.log('LOCAL_HTTP:');
console.log('  TOTAL=' + localData.total);
console.log('  DONE=' + localData.done);
console.log('  IN_PROGRESS=' + localData.in_progress);
console.log('  BLOCKED=' + localData.blocked);
console.log('  PENDING=' + localData.pending);
console.log('  VECTOR=' + localData.done + '/' + localData.in_progress + '/' + localData.blocked + '/' + localData.pending + '/' + localData.total);
console.log('');
console.log('PUBLIC_HTTP:');
console.log('  TOTAL=' + publicData.total);
console.log('  DONE=' + publicData.done);
console.log('  IN_PROGRESS=' + publicData.in_progress);
console.log('  BLOCKED=' + publicData.blocked);
console.log('  PENDING=' + publicData.pending);
console.log('  VECTOR=' + publicData.done + '/' + publicData.in_progress + '/' + publicData.blocked + '/' + publicData.pending + '/' + publicData.total);
console.log('');
console.log('COUNT_COMPARISON:');
const dbEqLocal = (dbData.total === localData.total && dbData.done === localData.done &&
                   dbData.in_progress === localData.in_progress && dbData.blocked === localData.blocked &&
                   dbData.pending === localData.pending);
const dbEqPublic = (dbData.total === publicData.total && dbData.done === publicData.done &&
                    dbData.in_progress === publicData.in_progress && dbData.blocked === publicData.blocked &&
                    dbData.pending === publicData.pending);
const localEqPublic = (localData.total === publicData.total && localData.done === publicData.done &&
                       localData.in_progress === publicData.in_progress && localData.blocked === publicData.blocked &&
                       localData.pending === publicData.pending);
const allIdentical = dbEqLocal && dbEqPublic;
console.log('  DB==LOCAL=' + (dbEqLocal ? 'PASS' : 'FAIL'));
console.log('  DB==PUBLIC=' + (dbEqPublic ? 'PASS' : 'FAIL'));
console.log('  LOCAL==PUBLIC=' + (localEqPublic ? 'PASS' : 'FAIL'));
console.log('  ALL_COUNTS_IDENTICAL=' + (allIdentical ? 'PASS' : 'FAIL'));
console.log('');

// Full row comparison with normalized status
console.log('ROW_COMPARISON');
const allIds = Object.keys(dbData.statuses).sort();
let allMatch = true;
for (const id of allIds) {
  const dbS = norm(dbData.statuses[id] || 'missing');
  const localS = norm(localData.statuses[id] || 'not_found');
  const publicS = norm(publicData.statuses[id] || 'not_found');
  const match = (dbS === localS && localS === publicS);
  if (!match) allMatch = false;
  console.log(id + ' DB=' + dbData.statuses[id] + ' LOCAL=' + (localData.statuses[id]||'NOT_FOUND') + ' PUBLIC=' + (publicData.statuses[id]||'NOT_FOUND') + ' MATCH=' + (match ? 'PASS' : 'FAIL'));
}
console.log('');
console.log('ALL_40_ROWS_IDENTICAL=' + (allMatch ? 'PASS' : 'FAIL'));
console.log('');

const allOk = allIdentical && allMatch && dbData.total === 40;
process.exit(allOk ? 0 : 1);
