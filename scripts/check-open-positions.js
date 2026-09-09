#!/usr/bin/env node
/**
 * Quick script to check open positions and calculate profit/loss
 * Run with: node scripts/check-open-positions.js
 */

require('dotenv').config();
const mysql = require('mysql2/promise');

async function main() {
  console.log('===== OPEN POSITIONS CHECK =====');
  
  // Database connection
  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST,
    port: parseInt(process.env.MYSQL_PORT || '3306'),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE || 'myjob_agent',
  });
  
  try {
    // Get open positions
    const [openTrades] = await conn.execute(`
      SELECT 
        id, instrument, side, quantity, 
        entryPrice, exitPrice, netPnl,
        orderedAt, closedAt
      FROM fnf_trades 
      WHERE status = 'OPEN'
      ORDER BY orderedAt DESC
    `);
    
    console.log(`📊 Found ${openTrades.length} open position(s):\n`);
    
    if (openTrades.length === 0) {
      console.log('✅ No open positions.');
      return;
    }
    
    // For each open trade, get latest quote
    for (const trade of openTrades) {
      console.log(`Position #${trade.id}:`);
      console.log(`  Instrument: ${trade.instrument}`);
      console.log(`  Side: ${trade.side}`);
      console.log(`  Quantity: ${trade.quantity}`);
      console.log(`  Entry Price: ₹${trade.entryPrice}`);
      
      // Get latest quote
      const [quotes] = await conn.execute(`
        SELECT ltp, bid, ask, ts
        FROM fnf_option_quotes 
        WHERE contractSymbol = ?
        ORDER BY ts DESC 
        LIMIT 1
      `, [trade.instrument]);
      
      if (quotes.length > 0) {
        const quote = quotes[0];
        const currentPrice = parseFloat(quote.ltp);
        const entryPrice = parseFloat(trade.entryPrice);
        const quantity = parseInt(trade.quantity);
        
        let profitPct = 0;
        if (trade.side === 'BUY') {
          profitPct = ((currentPrice - entryPrice) / entryPrice) * 100;
        } else if (trade.side === 'SELL') {
          profitPct = ((entryPrice - currentPrice) / entryPrice) * 100;
        }
        
        const profitAmount = Math.abs(currentPrice - entryPrice) * quantity;
        
        console.log(`  Current LTP: ₹${currentPrice.toFixed(2)}`);
        console.log(`  Profit/Loss: ₹${profitAmount.toFixed(2)} (${profitPct.toFixed(2)}%)`);
        console.log(`  Quote Time: ${quote.ts}`);
        
        // Check if target reached (50% profit for BUY)
        const targetPrice = entryPrice * 1.5; // 50% profit target
        const stopPrice = entryPrice * 0.8; // 20% stop-loss
        
        console.log(`  Target (50%): ₹${targetPrice.toFixed(2)}`);
        console.log(`  Stop (20%): ₹${stopPrice.toFixed(2)}`);
        
        if (trade.side === 'BUY') {
          if (currentPrice >= targetPrice) {
            console.log(`  🎯 TARGET REACHED! Should CLOSE position.`);
          } else if (currentPrice <= stopPrice) {
            console.log(`  ⚠️ STOP-LOSS HIT! Should CLOSE position.`);
          } else {
            console.log(`  📈 Position still open: ${profitPct.toFixed(2)}% profit`);
          }
        }
      } else {
        console.log(`  ❌ No recent quote found`);
      }
      
      console.log('');
    }
    
  } finally {
    await conn.end();
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});