#!/usr/bin/env node
/**
 * Position Exit Manager - Checks open positions and triggers exits when targets met
 * Runs via cron every 15 minutes during market hours
 */

require('dotenv').config();
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

async function checkAndExitPositions() {
  console.log('===== POSITION EXIT MANAGER =====');
  console.log(new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }));
  
  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST,
    port: parseInt(process.env.MYSQL_PORT || '3306'),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE || 'myjob_agent',
  });
  
  try {
    // Get open positions with decision targets from decisionParams JSON
    const [openTrades] = await conn.execute(`
      SELECT 
        id, instrument, side, quantity,
        entryPrice, orderedAt, decisionParams
      FROM fnf_trades 
      WHERE status = 'OPEN'
      ORDER BY orderedAt DESC
    `);
    
    console.log(`📊 Found ${openTrades.length} open position(s)`);
    
    for (const trade of openTrades) {
      console.log(`\n🔍 Checking position #${trade.id}: ${trade.instrument} ${trade.side}`);
      
      // Get latest quote
      const [quotes] = await conn.execute(`
        SELECT ltp, bid, ask, ts
        FROM fnf_option_quotes 
        WHERE contractSymbol = ?
        ORDER BY ts DESC 
        LIMIT 1
      `, [trade.instrument]);
      
      if (quotes.length === 0) {
        console.log(`  ❌ No recent quote found`);
        continue;
      }
      
      const quote = quotes[0];
      const currentPrice = parseFloat(quote.ltp);
      const entryPrice = parseFloat(trade.entryPrice);
      
      // Parse decisionParams JSON for target/stopLoss
      let targetPrice = entryPrice * 1.5; // Default 50% profit
      let stopPrice = entryPrice * 0.8;  // Default 20% stop
      
      try {
        if (trade.decisionParams) {
          const params = JSON.parse(trade.decisionParams);
          if (params.target) targetPrice = parseFloat(params.target);
          if (params.stopLoss) stopPrice = parseFloat(params.stopLoss);
        }
      } catch (e) {
        console.log(`  ⚠️ Could not parse decisionParams: ${e.message}`);
      }
      
      console.log(`  Entry: ₹${entryPrice.toFixed(2)}`);
      console.log(`  Current: ₹${currentPrice.toFixed(2)}`);
      console.log(`  Target: ₹${targetPrice.toFixed(2)}`);
      console.log(`  Stop: ₹${stopPrice.toFixed(2)}`);
      
      let shouldExit = false;
      let exitReason = '';
      
      if (trade.side === 'BUY') {
        if (currentPrice >= targetPrice) {
          shouldExit = true;
          exitReason = 'TARGET_REACHED';
          console.log(`  🎯 TARGET REACHED (+${((currentPrice - entryPrice) / entryPrice * 100).toFixed(2)}%)`);
        } else if (currentPrice <= stopPrice) {
          shouldExit = true;
          exitReason = 'STOP_LOSS_HIT';
          console.log(`  ⚠️ STOP-LOSS HIT (-${((entryPrice - currentPrice) / entryPrice * 100).toFixed(2)}%)`);
        }
      } else if (trade.side === 'SELL') {
        if (currentPrice <= targetPrice) {
          shouldExit = true;
          exitReason = 'TARGET_REACHED';
          console.log(`  🎯 TARGET REACHED (+${((entryPrice - currentPrice) / entryPrice * 100).toFixed(2)}%)`);
        } else if (currentPrice >= stopPrice) {
          shouldExit = true;
          exitReason = 'STOP_LOSS_HIT';
          console.log(`  ⚠️ STOP-LOSS HIT (-${((currentPrice - entryPrice) / entryPrice * 100).toFixed(2)}%)`);
        }
      }
      
      if (shouldExit) {
        console.log(`  🚨 EXIT SIGNAL: ${exitReason}`);
        
        // Log alert to file
        const alertLog = path.join(__dirname, '../logs/exit-alerts.log');
        const alertMsg = `[${new Date().toISOString()}] EXIT ALERT: Position #${trade.id} ${trade.instrument} ${trade.side} - ${exitReason}\n` +
                        `  Entry: ₹${entryPrice.toFixed(2)}, Current: ₹${currentPrice.toFixed(2)}\n` +
                        `  https://localhost:3010/fnf-trading (Review and close manually)\n`;
        
        fs.appendFileSync(alertLog, alertMsg);
        console.log(`  ✅ Alert logged to ${alertLog}`);
        
        // TODO: Auto-close via Fyers API when ready
        console.log(`  ⏳ Manual close required via dashboard`);
        
        // Update trade with exit alert flag (optional)
        await conn.execute(`
          UPDATE fnf_trades 
          SET exitAlertReason = ?, exitAlertAt = NOW(), exitAlertPrice = ?
          WHERE id = ?
        `, [exitReason, currentPrice, trade.id]);
      } else {
        const profitPct = trade.side === 'BUY' 
          ? ((currentPrice - entryPrice) / entryPrice * 100)
          : ((entryPrice - currentPrice) / entryPrice * 100);
        
        console.log(`  📈 Position active: ${profitPct.toFixed(2)}% profit`);
      }
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    throw error;
  } finally {
    await conn.end();
  }
}

async function main() {
  try {
    await checkAndExitPositions();
    console.log('\n✅ Position exit manager completed');
  } catch (error) {
    console.error('❌ Failed:', error.message);
    process.exit(1);
  }
}

// Run if script called directly
if (require.main === module) {
  main();
}

module.exports = { checkAndExitPositions };