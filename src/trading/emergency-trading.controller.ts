import { Controller, Get, Res } from '@nestjs/common';
import { Response } from 'express';
import { FnfTradingService } from './fnf-trading.service';
import { FnoMarketDataService } from './fno-market-data.service';

@Controller('emergency-trading')
export class EmergencyTradingController {
  constructor(
    private readonly trading: FnfTradingService,
    private readonly marketData: FnoMarketDataService,
  ) {}

  @Get()
  async emergencyPage(@Res() res: Response) {
    // Minimal HTML for paper trading
    const html = `<!DOCTYPE html>
<html>
<head><title>EMERGENCY Paper Trading</title>
<style>
body { font-family: monospace; background: #0d1117; color: #e6edf3; padding: 20px; }
.container { max-width: 1200px; margin: 0 auto; }
.status { background: #161b22; padding: 10px; border-radius: 5px; margin: 10px 0; }
.market-data { background: #21262d; padding: 15px; border-radius: 5px; margin: 10px 0; }
</style>
</head>
<body>
<div class="container">
  <h1>🆘 EMERGENCY PAPER TRADING</h1>
  <div class="status" id="status">Loading...</div>
  <div class="market-data" id="marketData">Waiting for market data...</div>
  <div style="margin-top: 20px;">
    <a href="/fnf-trading" style="color: #2f81f7;">Try Regular Trading Page</a> |
    <a href="/market-data" style="color: #2f81f7;">Market Data</a>
  </div>
</div>
<script>
  // Simple status check
  fetch('/health').then(r => r.text()).then(html => {
    document.getElementById('status').innerHTML = '✅ Service is running';
  });
  
  // Try to get market data
  fetch('/market-data/symbol/NIFTY').then(r => r.text()).then(text => {
    document.getElementById('marketData').innerHTML = 
      'Market data test: ' + (text.includes('NIFTY') ? '✅ Working' : '❌ Maybe needs auth');
  }).catch(e => {
    document.getElementById('marketData').innerHTML = 'Market data: Auth required';
  });
</script>
</body>
</html>`;
    return res.send(html);
  }
}
