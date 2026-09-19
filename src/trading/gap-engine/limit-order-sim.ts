/**
 * ITEM 107 — Simulate passive limit orders with no-fill/partial-fill.
 *
 * doneWhen: "Simulator produces fill/no-fill/partial outcomes with realistic queue position."
 *
 * PINNED SEMantics (limitsim-v1)
 *   Simulates a passive limit order sitting in the queue at a given price level.
 *   Models queue position, partial fills, and no-fill scenarios based on
 *   available liquidity at the order's price level.
 *
 * PURE: no clock, no I/O, no DB, no network, no AI, no randomness.
 * RESEARCH / SHADOW ONLY.
 */

export const LIMIT_ORDER_SIM_VERSION = 'limitsim-v1';

export type LimitOrderStatus = 'PENDING' | 'FILLED' | 'PARTIAL' | 'NO_FILL' | 'CANCELLED';

export type LimitOrderSide = 'BUY' | 'SELL';

export interface LimitOrderSimConfig {
  /** Maximum queue position (orders ahead in the book). */
  readonly maxQueuePosition: number;
  /** Minimum fill ratio for a partial fill. */
  readonly minPartialFillRatio: number;
}

export const DEFAULT_LIMIT_ORDER_SIM_CONFIG: LimitOrderSimConfig = {
  maxQueuePosition: 100,
  minPartialFillRatio: 0.1,
};

export interface LimitOrderRequest {
  readonly orderId: string;
  readonly symbol: string;
  readonly side: LimitOrderSide;
  readonly price: number;
  readonly quantity: number;
  /** Queue position at time of placement (0 = top of queue). */
  readonly queuePosition: number;
}

export interface LimitOrderSimResult {
  readonly orderId: string;
  readonly symbol: string;
  readonly side: LimitOrderSide;
  readonly price: number;
  readonly requestedQty: number;
  readonly filledQty: number;
  readonly status: LimitOrderStatus;
  readonly fillRatio: number;
  readonly queuePositionAtFill: number | null;
  readonly slippagePoints: number | null;
  readonly fillPrice: number | null;
}

export interface LimitOrderSimReport {
  readonly version: string;
  readonly config: LimitOrderSimConfig;
  readonly orders: readonly LimitOrderSimResult[];
  readonly summary: {
    readonly totalOrders: number;
    readonly filled: number;
    readonly partial: number;
    readonly noFill: number;
    readonly cancelled: number;
    readonly avgFillRatio: number;
  };
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Simulate a single passive limit order against observed liquidity.
 *
 * @param order       The limit order request
 * @param availableQty Available quantity at the order's price level
 * @param consumedQty  Quantity already consumed at this level (by aggressive orders)
 * @param config      Simulation config
 */
export function simulateLimitOrder(
  order: LimitOrderRequest,
  availableQty: number,
  consumedQty: number,
  config: Partial<LimitOrderSimConfig> = {},
): LimitOrderSimResult {
  const cfg = { ...DEFAULT_LIMIT_ORDER_SIM_CONFIG, ...config };

  if (!isNum(order.price) || order.price <= 0 || !isNum(order.quantity) || order.quantity <= 0) {
    return {
      orderId: order.orderId,
      symbol: order.symbol,
      side: order.side,
      price: order.price,
      requestedQty: order.quantity,
      filledQty: 0,
      status: 'NO_FILL',
      fillRatio: 0,
      queuePositionAtFill: null,
      slippagePoints: null,
      fillPrice: null,
    };
  }

  const effectiveAvailable = Math.max(0, availableQty - consumedQty);
  const effectiveQueuePos = Math.max(0, order.queuePosition - consumedQty);

  // No available liquidity at this level
  if (effectiveAvailable <= 0) {
    return {
      orderId: order.orderId,
      symbol: order.symbol,
      side: order.side,
      price: order.price,
      requestedQty: order.quantity,
      filledQty: 0,
      status: 'NO_FILL',
      fillRatio: 0,
      queuePositionAtFill: effectiveQueuePos,
      slippagePoints: 0,
      fillPrice: null,
    };
  }

  // Queue exhausted before our position
  if (effectiveQueuePos >= effectiveAvailable) {
    return {
      orderId: order.orderId,
      symbol: order.symbol,
      side: order.side,
      price: order.price,
      requestedQty: order.quantity,
      filledQty: 0,
      status: 'NO_FILL',
      fillRatio: 0,
      queuePositionAtFill: effectiveQueuePos,
      slippagePoints: 0,
      fillPrice: null,
    };
  }

  // Liquidity available after our queue position
  const qtyAvailableToUs = effectiveAvailable - effectiveQueuePos;
  const filledQty = Math.min(order.quantity, qtyAvailableToUs);
  const fillRatio = order.quantity > 0 ? filledQty / order.quantity : 0;

  let status: LimitOrderStatus;
  if (fillRatio >= 1.0) {
    status = 'FILLED';
  } else if (fillRatio >= cfg.minPartialFillRatio) {
    status = 'PARTIAL';
  } else {
    status = 'NO_FILL';
  }

  return {
    orderId: order.orderId,
    symbol: order.symbol,
    side: order.side,
    price: order.price,
    requestedQty: order.quantity,
    filledQty,
    status,
    fillRatio: Number(fillRatio.toFixed(6)),
    queuePositionAtFill: effectiveQueuePos,
    slippagePoints: 0, // limit orders fill at limit price, no slippage
    fillPrice: filledQty > 0 ? order.price : null,
  };
}

/**
 * Simulate a batch of limit orders.
 */
export function simulateLimitOrderBatch(
  orders: readonly LimitOrderRequest[],
  liquidityMap: Map<string, { availableQty: number; consumedQty: number }>,
  config: Partial<LimitOrderSimConfig> = {},
): LimitOrderSimReport {
  const cfg = { ...DEFAULT_LIMIT_ORDER_SIM_CONFIG, ...config };

  const results: LimitOrderSimResult[] = [];
  for (const order of orders) {
    const liq = liquidityMap.get(order.symbol) ?? { availableQty: 0, consumedQty: 0 };
    results.push(simulateLimitOrder(order, liq.availableQty, liq.consumedQty, config));
  }

  const filled = results.filter((r) => r.status === 'FILLED').length;
  const partial = results.filter((r) => r.status === 'PARTIAL').length;
  const noFill = results.filter((r) => r.status === 'NO_FILL').length;
  const cancelled = results.filter((r) => r.status === 'CANCELLED').length;
  const avgFillRatio =
    results.length > 0
      ? results.reduce((s, r) => s + r.fillRatio, 0) / results.length
      : 0;

  return {
    version: LIMIT_ORDER_SIM_VERSION,
    config: cfg,
    orders: results,
    summary: {
      totalOrders: results.length,
      filled,
      partial,
      noFill,
      cancelled,
      avgFillRatio: Number(avgFillRatio.toFixed(6)),
    },
  };
}
