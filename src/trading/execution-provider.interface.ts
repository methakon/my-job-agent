/** Broker-independent execution provider contract (Upstox Sandbox task 2026-09-05).
 *  The trading engine talks to this interface; concrete providers implement one
 *  execution environment each (FYERS real pipeline uses the internal paper-fill
 *  path; Upstox Sandbox has its own provider). Keeps strategy code broker-agnostic. */

export type ExecutionMode = 'REAL' | 'SANDBOX';

export interface PlaceOrderInput {
	instrument: string;
	side: 'BUY' | 'SELL';
	quantity: number; // units
	orderType?: 'MARKET' | 'LIMIT';
	limitPrice?: number;
	tag?: string;
}

export interface OrderState {
	providerOrderId: string;
	status: string; // provider-native status
	averagePrice?: number | null;
	quantity?: number;
	filledQuantity?: number;
	rejectReason?: string | null;
}

export interface PositionState {
	instrument: string;
	quantity: number;
	averagePrice: number;
	realizedPnl?: number;
	unrealizedPnl?: number;
}

export interface ExecutionProvider {
	readonly provider: string; // 'FYERS' | 'UPSTOX'
	readonly mode: ExecutionMode; // 'REAL' | 'SANDBOX'
	readonly enabled: boolean;

	placeOrder(input: PlaceOrderInput): Promise<OrderState>;
	modifyOrder(providerOrderId: string, patch: { quantity?: number; limitPrice?: number }): Promise<OrderState>;
	cancelOrder(providerOrderId: string): Promise<{ ok: boolean }>;
	orderStatus(providerOrderId: string): Promise<OrderState>;
	positions(): Promise<PositionState[]>;
	trades(): Promise<unknown[]>;
}
