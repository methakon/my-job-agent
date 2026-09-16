import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import * as WebSocket from 'ws';
import * as protobuf from 'protobufjs';
import * as path from 'path';

/**
 * Upstox V3 Market Data WebSocket Client
 *
 * Connects to Upstox V3 WebSocket feed, decodes protobuf messages,
 * and provides real-time tick data for NIFTY, BANKNIFTY, SENSEX options.
 *
 * Flow:
 * 1. Authorize via REST → get redirect URI
 * 2. Connect to WebSocket with authorized URI
 * 3. Subscribe to instruments in option_chain mode
 * 4. Decode protobuf messages → emit ticks
 */

export interface UpstoxV3Tick {
  instrumentKey: string;
  type: 'initial_feed' | 'live_feed' | 'market_info';
  timestamp: number;
  // LTPC fields
  ltp: number | null;
  closePrice: number | null;
  lastTradeTime: number | null;
  lastTradeQty: number | null;
  // Option chain specific
  firstDepth: { bidP: number; bidQ: number; askP: number; askQ: number } | null;
  optionGreeks: { delta: number; theta: number; gamma: number; vega: number; rho: number } | null;
  iv: number | null;
  oi: number | null;
  volume: number | null;
}

export interface UpstoxV3MarketInfo {
  type: 'market_info';
  timestamp: number;
  segmentStatus: Record<string, string>;
}

export interface UpstoxV3OptionChainResponse {
  instrumentKey: string;
  expiry: string;
  underlying: string;
  strike: number;
  optionType: 'CE' | 'PE';
  ltp: number;
  bid: number;
  ask: number;
  bidQty: number;
  askQty: number;
  volume: number;
  openInterest: number;
  iv: number | null;
  delta: number | null;
  theta: number | null;
  gamma: number | null;
  vega: number | null;
  rho: number | null;
  ts: Date;
}

@Injectable()
export class UpstoxV3WebSocketService implements OnModuleDestroy {
  private readonly logger = new Logger(UpstoxV3WebSocketService.name);
  private ws: WebSocket | null = null;
  private protoRoot: protobuf.Root | null = null;
  private FeedResponse: protobuf.Type | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly reconnectDelayMs = 5000;
  private readonly heartbeatIntervalMs = 30000;
  private wsUrl: string | null = null;
  private accessToken: string | null = null;
  private subscribedKeys: string[] = [];
  private tickCallbacks: ((tick: UpstoxV3Tick) => void)[] = [];
  private marketInfoCallbacks: ((info: UpstoxV3MarketInfo) => void)[] = [];
  private connected = false;
  private lastError: string | null = null;

  constructor() {
    this.loadProto();
  }

  private loadProto(): void {
    try {
      const protoPath = path.join(__dirname, 'MarketDataFeedV3.proto');
      this.protoRoot = protobuf.loadSync(protoPath);
      this.FeedResponse = this.protoRoot.lookupType('com.upstox.marketdatafeederv3udapi.rpc.proto.FeedResponse');
      this.logger.log('[UPSTOX-V3-WS] Proto file loaded successfully');
    } catch (err) {
      this.logger.error(`[UPSTOX-V3-WS] Failed to load proto file: ${err}`);
    }
  }

  /**
   * Authorize WebSocket connection via REST.
   * Returns the authorized WebSocket URL.
   */
  async authorize(accessToken: string, apiKey?: string): Promise<string | null> {
    try {
      const headers: Record<string, string> = {
        'Accept': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      };
      if (apiKey) headers['x-api-key'] = apiKey;

      const response = await fetch('https://api.upstox.com/v3/feed/market-data-feed/authorize', {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        const text = await response.text();
        this.logger.error(`[UPSTOX-V3-WS] Authorization failed: HTTP ${response.status} - ${text}`);
        return null;
      }

      const data = await response.json() as { data?: { authorized_redirect_uri?: string } };
      const wsUrl = data?.data?.authorized_redirect_uri;
      if (!wsUrl) {
        this.logger.error('[UPSTOX-V3-WS] Authorization response missing redirect URI');
        return null;
      }

      this.logger.log('[UPSTOX-V3-WS] Authorization successful');
      return wsUrl;
    } catch (err) {
      this.logger.error(`[UPSTOX-V3-WS] Authorization error: ${err}`);
      return null;
    }
  }

  /**
   * Connect to Upstox V3 WebSocket feed.
   */
  async connect(accessToken: string, apiKey?: string): Promise<boolean> {
    this.accessToken = accessToken;

    // Authorize first
    this.wsUrl = await this.authorize(accessToken, apiKey);
    if (!this.wsUrl) {
      this.lastError = 'Authorization failed';
      return false;
    }

    return this.connectWebSocket();
  }

  private connectWebSocket(): boolean {
    if (!this.wsUrl || !this.accessToken) {
      this.lastError = 'Missing WebSocket URL or access token';
      return false;
    }

    this.cleanup();
    this.logger.log(`[UPSTOX-V3-WS] Connecting to ${this.wsUrl.substring(0, 50)}...`);

    try {
      this.ws = new WebSocket(this.wsUrl, {
        headers: {
          'Accept': '*/*',
          'Authorization': `Bearer ${this.accessToken}`,
        },
        followRedirects: true,
      });

      this.ws.on('open', () => {
        this.connected = true;
        this.lastError = null;
        this.logger.log('[UPSTOX-V3-WS] Connected');
        this.startHeartbeat();
        // Re-subscribe after reconnect
        if (this.subscribedKeys.length > 0) {
          this.subscribe(this.subscribedKeys);
        }
      });

      this.ws.on('message', (data: Buffer | string) => {
        this.handleMessage(data);
      });

      this.ws.on('close', (code: number, reason: Buffer) => {
        this.connected = false;
        this.stopHeartbeat();
        this.logger.warn(`[UPSTOX-V3-WS] Disconnected: ${code} - ${reason.toString()}`);
        this.scheduleReconnect();
      });

      this.ws.on('error', (err: Error) => {
        this.lastError = err.message;
        this.logger.error(`[UPSTOX-V3-WS] Error: ${err.message}`);
      });

      return true;
    } catch (err) {
      this.lastError = `Connection failed: ${err}`;
      this.logger.error(`[UPSTOX-V3-WS] Connection failed: ${err}`);
      this.scheduleReconnect();
      return false;
    }
  }

  private handleMessage(data: Buffer | string): void {
    if (!this.FeedResponse) return;

    try {
      let msgBytes: Buffer;
      if (typeof data === 'string') {
        // Some messages come as JSON (e.g., market_info)
        try {
          const json = JSON.parse(data);
          if (json.type === 'market_info') {
            const info: UpstoxV3MarketInfo = {
              type: 'market_info',
              timestamp: Number(json.currentTs) || Date.now(),
              segmentStatus: json.marketInfo?.segmentStatus ?? {},
            };
            for (const cb of this.marketInfoCallbacks) {
              try { cb(info); } catch (e) { /* swallow */ }
            }
            return;
          }
        } catch { /* not JSON, try protobuf */ }
        msgBytes = Buffer.from(data, 'binary');
      } else {
        msgBytes = data;
      }

      // Decode protobuf
      const feedResponse = this.FeedResponse.decode(msgBytes) as unknown as {
        type: number;
        feeds: Record<string, { ltpc?: any; fullFeed?: any; firstLevelWithGreeks?: any; requestMode?: number }>;
        currentTs: number;
        marketInfo?: any;
      };

      const typeMap: Record<number, 'initial_feed' | 'live_feed' | 'market_info'> = {
        0: 'initial_feed',
        1: 'live_feed',
        2: 'market_info',
      };
      const feedType = typeMap[feedResponse.type] ?? 'live_feed';

      // Handle market_info from protobuf
      if (feedType === 'market_info' && feedResponse.marketInfo) {
        const segmentStatus: Record<string, string> = {};
        if (feedResponse.marketInfo.segmentStatus) {
          const statusMap: Record<number, string> = {
            0: 'PRE_OPEN_START', 1: 'PRE_OPEN_END', 2: 'NORMAL_OPEN',
            3: 'NORMAL_CLOSE', 4: 'CLOSING_START', 5: 'CLOSING_END',
          };
          for (const [k, v] of Object.entries(feedResponse.marketInfo.segmentStatus)) {
            segmentStatus[k] = statusMap[v as number] ?? String(v);
          }
        }
        const info: UpstoxV3MarketInfo = {
          type: 'market_info',
          timestamp: Number(feedResponse.currentTs) || Date.now(),
          segmentStatus,
        };
        for (const cb of this.marketInfoCallbacks) {
          try { cb(info); } catch (e) { /* swallow */ }
        }
        return;
      }

      // Process feed ticks
      if (!feedResponse.feeds) return;

      for (const [instrumentKey, feed] of Object.entries(feedResponse.feeds)) {
        const tick = this.parseFeed(instrumentKey, feedType, feedResponse.currentTs, feed);
        if (tick) {
          for (const cb of this.tickCallbacks) {
            try { cb(tick); } catch (e) { /* swallow */ }
          }
        }
      }
    } catch (err) {
      this.logger.warn(`[UPSTOX-V3-WS] Failed to decode message: ${err}`);
    }
  }

  private parseFeed(
    instrumentKey: string,
    type: 'initial_feed' | 'live_feed' | 'market_info',
    timestamp: number,
    feed: { ltpc?: any; fullFeed?: any; firstLevelWithGreeks?: any; requestMode?: number },
  ): UpstoxV3Tick | null {
    const ts = Number(timestamp) || Date.now();
    let ltp: number | null = null;
    let closePrice: number | null = null;
    let lastTradeTime: number | null = null;
    let lastTradeQty: number | null = null;
    let firstDepth: UpstoxV3Tick['firstDepth'] = null;
    let optionGreeks: UpstoxV3Tick['optionGreeks'] = null;
    let iv: number | null = null;
    let oi: number | null = null;
    let volume: number | null = null;

    // Extract from ltpc mode
    if (feed.ltpc) {
      ltp = feed.ltpc.ltp ?? null;
      closePrice = feed.ltpc.cp ?? null;
      lastTradeTime = feed.ltpc.ltt ?? null;
      lastTradeQty = feed.ltpc.ltq ?? null;
    }

    // Extract from option_chain mode (firstLevelWithGreeks)
    if (feed.firstLevelWithGreeks) {
      const flg = feed.firstLevelWithGreeks;
      if (flg.ltpc) {
        ltp = flg.ltpc.ltp ?? ltp;
        closePrice = flg.ltpc.cp ?? closePrice;
        lastTradeTime = flg.ltpc.ltt ?? lastTradeTime;
        lastTradeQty = flg.ltpc.ltq ?? lastTradeQty;
      }
      if (flg.firstDepth) {
        firstDepth = {
          bidP: flg.firstDepth.bidP ?? 0,
          bidQ: Number(flg.firstDepth.bidQ ?? 0),
          askP: flg.firstDepth.askP ?? 0,
          askQ: Number(flg.firstDepth.askQ ?? 0),
        };
      }
      if (flg.optionGreeks) {
        optionGreeks = {
          delta: flg.optionGreeks.delta ?? 0,
          theta: flg.optionGreeks.theta ?? 0,
          gamma: flg.optionGreeks.gamma ?? 0,
          vega: flg.optionGreeks.vega ?? 0,
          rho: flg.optionGreeks.rho ?? 0,
        };
      }
      iv = flg.iv ?? null;
      oi = flg.oi ?? null;
      volume = flg.vtt ?? null;
    }

    // Extract from full mode (fullFeed)
    if (feed.fullFeed) {
      const ff = feed.fullFeed;
      if (ff.marketFF) {
        if (ff.marketFF.ltpc) {
          ltp = ff.marketFF.ltpc.ltp ?? ltp;
          closePrice = ff.marketFF.ltpc.cp ?? closePrice;
          lastTradeTime = ff.marketFF.ltpc.ltt ?? lastTradeTime;
          lastTradeQty = ff.marketFF.ltpc.ltq ?? lastTradeQty;
        }
        if (ff.marketFF.marketLevel?.bidAskQuote?.length > 0) {
          const q = ff.marketFF.marketLevel.bidAskQuote[0];
          firstDepth = {
            bidP: q.bidP ?? 0,
            bidQ: Number(q.bidQ ?? 0),
            askP: q.askP ?? 0,
            askQ: Number(q.askQ ?? 0),
          };
        }
        if (ff.marketFF.optionGreeks) {
          optionGreeks = {
            delta: ff.marketFF.optionGreeks.delta ?? 0,
            theta: ff.marketFF.optionGreeks.theta ?? 0,
            gamma: ff.marketFF.optionGreeks.gamma ?? 0,
            vega: ff.marketFF.optionGreeks.vega ?? 0,
            rho: ff.marketFF.optionGreeks.rho ?? 0,
          };
        }
        iv = ff.marketFF.iv ?? null;
        oi = ff.marketFF.oi ?? null;
        volume = ff.marketFF.vtt ?? null;
      } else if (ff.indexFF) {
        if (ff.indexFF.ltpc) {
          ltp = ff.indexFF.ltpc.ltp ?? ltp;
          closePrice = ff.indexFF.ltpc.cp ?? closePrice;
          lastTradeTime = ff.indexFF.ltpc.ltt ?? lastTradeTime;
          lastTradeQty = ff.indexFF.ltpc.ltq ?? lastTradeQty;
        }
      }
    }

    // Skip ticks with no price data
    if (ltp === null) return null;

    return {
      instrumentKey,
      type,
      timestamp: ts,
      ltp,
      closePrice,
      lastTradeTime,
      lastTradeQty,
      firstDepth,
      optionGreeks,
      iv,
      oi,
      volume,
    };
  }

  /**
   * Subscribe to instruments in option_chain mode.
   * @param instrumentKeys - Array of instrument keys (e.g., ['NSE_INDEX|Nifty 50', 'NSE_FO|54321'])
   * @param mode - Subscription mode: 'ltpc' | 'option_chain' | 'full'
   */
  subscribe(instrumentKeys: string[], mode: 'ltpc' | 'option_chain' | 'full' = 'option_chain'): void {
    if (!this.connected || !this.ws) {
      this.logger.warn('[UPSTOX-V3-WS] Cannot subscribe: not connected');
      return;
    }

    // Store for re-subscription on reconnect
    this.subscribedKeys = [...new Set([...this.subscribedKeys, ...instrumentKeys])];

    const modeMap = { ltpc: 'ltpc', option_chain: 'option_greeks', full: 'full_d5' };
    const request = {
      guid: `upstox-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      method: 'sub',
      data: {
        mode: modeMap[mode],
        instrumentKeys: this.subscribedKeys.slice(0, 5000), // V3 limit
      },
    };

    this.ws.send(JSON.stringify(request));
    this.logger.log(`[UPSTOX-V3-WS] Subscribed to ${this.subscribedKeys.length} instruments in ${mode} mode`);
  }

  /**
   * Unsubscribe from all instruments.
   */
  unsubscribe(): void {
    if (!this.connected || !this.ws) return;

    const request = {
      guid: `upstox-unsub-${Date.now()}`,
      method: 'unsub',
      data: {
        instrumentKeys: this.subscribedKeys,
      },
    };

    this.ws.send(JSON.stringify(request));
    this.subscribedKeys = [];
    this.logger.log('[UPSTOX-V3-WS] Unsubscribed from all instruments');
  }

  /**
   * Register callback for tick data.
   */
  onTick(callback: (tick: UpstoxV3Tick) => void): () => void {
    this.tickCallbacks.push(callback);
    return () => {
      const idx = this.tickCallbacks.indexOf(callback);
      if (idx >= 0) this.tickCallbacks.splice(idx, 1);
    };
  }

  /**
   * Register callback for market info.
   */
  onMarketInfo(callback: (info: UpstoxV3MarketInfo) => void): () => void {
    this.marketInfoCallbacks.push(callback);
    return () => {
      const idx = this.marketInfoCallbacks.indexOf(callback);
      if (idx >= 0) this.marketInfoCallbacks.splice(idx, 1);
    };
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.connected && this.accessToken) {
        this.logger.log('[UPSTOX-V3-WS] Attempting reconnect...');
        this.connectWebSocket();
      }
    }, this.reconnectDelayMs);
  }

  private cleanup(): void {
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.stopHeartbeat();
  }

  /**
   * Get current connection status.
   */
  getStatus(): { connected: boolean; lastError: string | null; subscribedCount: number } {
    return {
      connected: this.connected,
      lastError: this.lastError,
      subscribedCount: this.subscribedKeys.length,
    };
  }

  onModuleDestroy(): void {
    this.cleanup();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
