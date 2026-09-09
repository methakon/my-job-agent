#!/usr/bin/env node
/**
 * Test IMAP connection with decrypted passwords
 */

require('dotenv').config();
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const { ImapFlow } = require('imapflow');

async function main() {
  console.log('===== TEST IMAP CONNECTION =====');
  
  const APP_SECRET = process.env.APP_SECRET;
  if (!APP_SECRET) {
    console.error('❌ APP_SECRET not found in .env');
    return;
  }
  
  // Create key from APP_SECRET (SHA-256)
  const key = crypto.createHash('sha256').update(APP_SECRET).digest();
  
  // Connect to DB
  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST,
    port: parseInt(process.env.MYSQL_PORT || '3306'),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE || 'myjob_agent',
  });
  
  try {
    console.log('\n🔍 Testing Gmail IMAP connections...\n');
    
    // Get mail accounts marked with is_app_password
    const [accounts] = await conn.execute(`
      SELECT email, passwordEnc, imap_host, imap_port, is_app_password
      FROM mail_accounts 
      WHERE use_imap = 1 AND is_app_password = 1
      LIMIT 2
    `);
    
    for (const acc of accounts) {
      console.log(`\n📧 Testing: ${acc.email}`);
      
      // Decrypt password
      let password = '';
      try {
        const [ivHex, dataHex] = acc.passwordEnc.split(':');
        if (!ivHex || !dataHex) {
          console.log(`❌ Invalid password format`);
          continue;
        }
        
        const d = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex, 'hex'));
        password = Buffer.concat([
          d.update(Buffer.from(dataHex, 'hex')),
          d.final()
        ]).toString('utf8');
        
        console.log(`✅ Password decrypted (${password.length} chars)`);
        console.log(`Password starts with: "${password.substring(0, 3)}..."`);
      } catch (decryptErr) {
        console.log(`❌ Decryption failed: ${decryptErr.message}`);
        continue;
      }
      
      // Try IMAP connection
      console.log(`🔌 Connecting to ${acc.imap_host || 'imap.gmail.com'}:${acc.imap_port || 993}...`);
      
      try {
        const client = new ImapFlow({
          host: acc.imap_host || 'imap.gmail.com',
          port: acc.imap_port || 993,
          secure: true,
          auth: { 
            user: acc.email, 
            pass: password 
          },
          logger: false,
          timeout: 30000, // 30 seconds
        });
        
        console.log(`⌛ Attempting connection...`);
        const start = Date.now();
        
        await client.connect();
        const elapsed = Date.now() - start;
        
        console.log(`✅ IMAP Connected successfully! (${elapsed}ms)`);
        console.log(`📬 Server says: ${client.serverInfo?.name || 'unknown'}`);
        
        // Try to get mailbox list
        try {
          const lock = await client.getMailboxLock('INBOX');
          console.log(`✅ INBOX locked successfully`);
          lock.release();
          console.log(`🔓 INBOX released`);
        } catch (lockErr) {
          console.log(`⚠️ Could not lock INBOX: ${lockErr.message}`);
        }
        
        await client.logout();
        console.log(`👋 Logged out successfully`);
        
        // Update success timestamp in DB
        await conn.execute(
          'UPDATE mail_accounts SET last_imap_success = NOW(), imap_failure_count = 0 WHERE email = ?',
          [acc.email]
        );
        
      } catch (imapErr) {
        console.log(`❌ IMAP Connection failed: ${imapErr.message}`);
        console.log(`❗ Error type: ${imapErr.constructor.name}`);
        
        // Update failure count
        await conn.execute(
          'UPDATE mail_accounts SET imap_failure_count = imap_failure_count + 1 WHERE email = ?',
          [acc.email]
        );
      }
    }
    
  } finally {
    await conn.end();
  }
  
  console.log('\n===== TEST COMPLETE =====');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});