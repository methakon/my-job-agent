INSERT INTO fnf_trades (id, instrument, side, quantity, entryPrice, exitPrice, grossPnl, cost, netPnl, status, orderedAt, closedAt, onRealData, executionProvider, executionMode)
VALUES
('zerodha-20260928-tr1', 'NSE:NIFTY26SEP22800PE', 'BUY', 65, 59.90, 64.10, 273.00, 35.00, 238.00, 'CLOSED', '2026-09-28 11:01:29', '2026-09-28 11:12:08', 1, 'ZERODHA', 'REAL'),
('zerodha-20260928-tr2', 'NSE:NIFTY26SEP22900CE', 'BUY', 65, 70.85, 75.80, 321.75, 35.00, 286.75, 'CLOSED', '2026-09-28 11:17:44', '2026-09-28 11:27:41', 1, 'ZERODHA', 'REAL'),
('zerodha-20260928-tr3', 'NSE:NIFTY26SEP22850PE', 'BUY', 65, 70.10, 82.80, 825.50, 35.00, 790.50, 'CLOSED', '2026-09-28 11:45:37', '2026-09-28 11:59:12', 1, 'ZERODHA', 'REAL'),
('zerodha-20260928-tr4', 'NSE:NIFTY26SEP22850PE', 'BUY', 65, 77.00, 64.30, -825.50, 35.00, -860.50, 'CLOSED', '2026-09-28 12:06:55', '2026-09-28 12:29:19', 1, 'ZERODHA', 'REAL'),
('zerodha-20260928-tr5', 'NSE:NIFTY26SEP22850PE', 'BUY', 130, 65.175, 78.00, 1667.25, 70.00, 1597.25, 'CLOSED', '2026-09-28 12:30:27', '2026-09-28 12:53:13', 1, 'ZERODHA', 'REAL')
ON DUPLICATE KEY UPDATE
  entryPrice = VALUES(entryPrice),
  exitPrice = VALUES(exitPrice),
  grossPnl = VALUES(grossPnl),
  cost = VALUES(cost),
  netPnl = VALUES(netPnl),
  status = VALUES(status),
  orderedAt = VALUES(orderedAt),
  closedAt = VALUES(closedAt);
