#!/usr/bin/env node
/**
 * Test if APP_SECRET can decrypt passwords from mail_accounts
 */

require('dotenv').config();
const crypto = require('crypto');
const mysql = require('mysql2/promise');

async function main() {
  console.log('===== TEST APP_SECRET DECRYPTION =====');
  
  const APP_SECRET = process.env.APP_SECRET;
  console.log(`APP_SECRET: ${APP_SECRET ? APP_SECRET.substring(0, 10) + '...' : 'NOT SET'}`);
  console.log(`Length: ${APP_SECRET ? APP_SECRET.length : 0} chars`);
  
  if (!APP_SECRET) {
    console.error('❌ APP_SECRET not found in .env');
    return;
  }
  
  // Create key from APP_SECRET (SHA-256)
  const key = crypto.createHash('sha256').update(APP_SECRET).digest();
  console.log(`Key (SHA-256): ${key.toString('hex').substring(0, 16)}...`);
  
  // Connect to DB
  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST,
    port: parseInt(process.env.MYSQL_PORT || '3306'),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE || 'myjob_agent',
  });
  
  try {
    // Get mail accounts
    const [accounts] = await conn.execute(`
      SELECT email, passwordEnc 
      FROM mail_accounts 
      WHERE LENGTH(passwordEnc) > 0
    `);
    
    console.log(`\n📧 Found ${accounts.length} mail accounts with encrypted passwords:`);
    
    for (const acc of accounts) {
      console.log(`\nAccount: ${acc.email}`);
      console.log(`PasswordEnc (first 20 chars): ${acc.passwordEnc.substring(0, 20)}...`);
      console.log(`Full length: ${acc.passwordEnc.length} chars`);
      
      // Try to decrypt (same logic as inbox-reader.service.ts)
      try {
        const [ivHex, dataHex] = acc.passwordEnc.split(':');
        console.log(`IV hex length: ${ivHex.length}`);
        console.log(`Data hex length: ${dataHex ? dataHex.length : 'N/A'}`);
        
        if (!ivHex || !dataHex) {
          console.log(`❌ Invalid format, missing : separator`);
          continue;
        }
        
        const d = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex, 'hex'));
        const decrypted = Buffer.concat([
          d.update(Buffer.from(dataHex, 'hex')),
          d.final()
        ]).toString('utf8');
        
        console.log(`✅ Decrypted password: ${decrypted}`);
        console.log(`Password length: ${decrypted.length} chars`);
        
      } catch (err) {
        console.log(`❌ Decryption failed: ${err.message}`);
      }
    }
    
  } finally {
    await conn.end();
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});