'use strict';
const mysql = require('mysql2/promise');
async function main() {
  const c = await mysql.createConnection({
    host: '127.0.0.1', port: 3307,
    user: 'mylife', password: process.env.MYSQL_PASSWORD,
    database: 'myjob_agent'
  });
  const [rows] = await c.query(
    "SELECT id, itemId, item, status, doneWhen, lastCommitSha, lastVerifiedAt " +
    "FROM job_application_roadmap_items " +
    "WHERE roadmapIdentity = 'my-job-agent-job-application' " +
    "ORDER BY itemOrder"
  );
  await c.end();
  const byId = {};
  rows.forEach(r => { byId[r.itemId] = r; });
  const ids = Object.keys(byId).sort();
  const total = rows.length;
  const counts = { done:0, in_progress:0, blocked:0, pending:0 };
  rows.forEach(r => { if (counts[r.status] !== undefined) counts[r.status]++; });
  const invariant = (counts.done + counts.in_progress + counts.blocked + counts.pending) === total;
  console.log('ROADMAP_DB_STATUS');
  console.log('TOTAL=' + total);
  console.log('DONE=' + counts.done);
  console.log('IN_PROGRESS=' + counts.in_progress);
  console.log('BLOCKED=' + counts.blocked);
  console.log('PENDING=' + counts.pending);
  console.log('VECTOR=' + counts.done + '/' + counts.in_progress + '/' + counts.blocked + '/' + counts.pending + '/' + total);
  console.log('INVARIANT=' + (invariant ? 'PASS' : 'FAIL'));
  console.log('');
  console.log('JA-002=' + (byId['JA-002'] ? byId['JA-002'].status : 'MISSING'));
  console.log('JA-003=' + (byId['JA-003'] ? byId['JA-003'].status : 'MISSING'));
  console.log('JA-014=' + (byId['JA-014'] ? byId['JA-014'].status : 'MISSING'));
  console.log('');
  // Print per-JA-ID status for ALL rows in DB (not just JA-001..JA-040)
  const allDbIds = Object.keys(byId).sort();
  for (const id of allDbIds) {
    console.log(id + ' DB=' + byId[id].status);
  }
  // Also report which expected IDs (JA-001..JA-040) are missing from DB
  const expectedRange = [];
  for (let i = 1; i <= 40; i++) expectedRange.push('JA-' + String(i).padStart(3,'0'));
  const missingFromRange = expectedRange.filter(id => !byId[id]);
  const allGood = total === 40 && invariant && counts.done === 7 && counts.in_progress === 2 && counts.blocked === 0 && counts.pending === 31;
  console.log('');
  console.log('ALL_GOOD=' + (allGood ? 'PASS' : 'FAIL'));
  process.exit(allGood ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(2); });
