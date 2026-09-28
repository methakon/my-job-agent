const mysql = require('mysql2/promise');
const dotenv = require('dotenv');
dotenv.config();

const trades = [
    {
        id: "zerodha-20260928-tr1",
        instrument: "NSE:NIFTY26SEP22800PE",
        side: "BUY",
        quantity: 65,
        entryPrice: 59.90,
        exitPrice: 64.10,
        grossPnl: 273.00,
        cost: 35.00,
        netPnl: 238.00,
        status: "CLOSED",
        orderedAt: "2026-09-28 11:01:29",
        closedAt: "2026-09-28 11:12:08",
        executionProvider: "ZERODHA",
        executionMode: "REAL"
    },
    {
        id: "zerodha-20260928-tr2",
        instrument: "NSE:NIFTY26SEP22900CE",
        side: "BUY",
        quantity: 65,
        entryPrice: 70.85,
        exitPrice: 75.80,
        grossPnl: 321.75,
        cost: 35.00,
        netPnl: 286.75,
        status: "CLOSED",
        orderedAt: "2026-09-28 11:17:44",
        closedAt: "2026-09-28 11:27:41",
        executionProvider: "ZERODHA",
        executionMode: "REAL"
    },
    {
        id: "zerodha-20260928-tr3",
        instrument: "NSE:NIFTY26SEP22850PE",
        side: "BUY",
        quantity: 65,
        entryPrice: 70.10,
        exitPrice: 82.80,
        grossPnl: 825.50,
        cost: 35.00,
        netPnl: 790.50,
        status: "CLOSED",
        orderedAt: "2026-09-28 11:45:37",
        closedAt: "2026-09-28 11:59:12",
        executionProvider: "ZERODHA",
        executionMode: "REAL"
    },
    {
        id: "zerodha-20260928-tr4",
        instrument: "NSE:NIFTY26SEP22850PE",
        side: "BUY",
        quantity: 65,
        entryPrice: 77.00,
        exitPrice: 64.30,
        grossPnl: -825.50,
        cost: 35.00,
        netPnl: -860.50,
        status: "CLOSED",
        orderedAt: "2026-09-28 12:06:55",
        closedAt: "2026-09-28 12:29:19",
        executionProvider: "ZERODHA",
        executionMode: "REAL"
    },
    {
        id: "zerodha-20260928-tr5",
        instrument: "NSE:NIFTY26SEP22850PE",
        side: "BUY",
        quantity: 130,
        entryPrice: 65.175,
        exitPrice: 78.00,
        grossPnl: 1667.25,
        cost: 70.00,
        netPnl: 1597.25,
        status: "CLOSED",
        orderedAt: "2026-09-28 12:30:27",
        closedAt: "2026-09-28 12:53:13",
        executionProvider: "ZERODHA",
        executionMode: "REAL"
    }
];

async function main() {
    console.log("💾 [DB SYNC] Syncing Zerodha 28-09-2026 trades to MySQL fnf_trades...");
    
    let connection;
    try {
        connection = await mysql.createConnection({
            host: process.env.MYSQL_HOST || '127.0.0.1',
            port: parseInt(process.env.MYSQL_PORT || '3307', 10),
            user: process.env.MYSQL_USER || 'mylife',
            password: process.env.MYSQL_PASSWORD || 'rDJNh2U5cZADUwMxIb2GAa1!',
            database: process.env.DATABASE_NAME || 'myjob_agent'
        });

        for (const t of trades) {
            const query = `
                INSERT INTO fnf_trades (
                    id, instrument, side, quantity, entryPrice, exitPrice,
                    grossPnl, cost, netPnl, status, orderedAt, closedAt,
                    onRealData, executionProvider, executionMode
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
                ON DUPLICATE KEY UPDATE
                    entryPrice = VALUES(entryPrice),
                    exitPrice = VALUES(exitPrice),
                    grossPnl = VALUES(grossPnl),
                    cost = VALUES(cost),
                    netPnl = VALUES(netPnl),
                    status = VALUES(status),
                    orderedAt = VALUES(orderedAt),
                    closedAt = VALUES(closedAt);
            `;

            await connection.execute(query, [
                t.id, t.instrument, t.side, t.quantity, t.entryPrice, t.exitPrice,
                t.grossPnl, t.cost, t.netPnl, t.status, t.orderedAt, t.closedAt,
                t.executionProvider, t.executionMode
            ]);
            console.log(`  ✅ Synced trade ${t.id} (${t.instrument}) -> Net PnL: ₹${t.netPnl.toFixed(2)}`);
        }

        console.log("🎉 All 5 Zerodha 28-09-2026 trades successfully synced to fnf_trades!");
    } catch (err) {
        console.error("❌ DB Sync Error:", err.message);
    } finally {
        if (connection) await connection.end();
    }
}

main();
