const mysql = require('mysql2/promise');
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

async function getConnection() {
  return mysql.createConnection({
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: parseInt(process.env.MYSQL_PORT || '3307'),
    user: process.env.MYSQL_USER || 'mylife',
    password: process.env.MYSQL_PASSWORD,
    database: 'myjob_agent',
    connectTimeout: 10000,
  });
}

async function markDone(id, note) {
  const conn = await getConnection();
  try {
    await conn.execute(
      'UPDATE project_checklist_items SET status = ?, note = ?, updatedAt = NOW(6) WHERE id = ?',
      ['done', note || 'Report generated from archived data', String(id)]
    );
    console.log(`[OK] Item ${id} marked done`);
  } finally { await conn.end(); }
}

module.exports = { getConnection, markDone };
