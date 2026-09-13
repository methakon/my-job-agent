import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExecutionProvider, ExecutionMode, PlaceOrderInput, OrderState, PositionState } from './execution-provider.interface';

/**
 * Upstox SANDBOX-only execution provider (2026-09-05 task).
 *
 * SAFETY MODEL:
 *  - SANDBOX ONLY: every endpoint call targets the Upstox Sandbox base URL
 *    (api-sandbox.upstox.com). There is NO live host in this provider.
 *  - FAIL CLOSED: if UPSTOX_SANDBOX_ENABLED !== 'true' or credentials are
 *    missing, the provider reports disabled and every call throws — it can
 *    never fall through to a live/real endpoint.
 *  - Config that asks for REAL mode is rejected at construction.
 *
 * NO TICK RECORDING: this provider has no WebSocket/tick/quote persistence of
 * any kind — sandbox market data is consumed transiently (or not at all). Only
 * order/execution state passes through this provider. Hermes persists sandbox
 * ORDER results in the isolated (on_real_data=false) records, never ticks.
 *
 * Credentials are intentionally NOT configured yet (account pending approval):
 * UPSTOX_SANDBOX_CLIENT_ID / _SECRET / _ACCESS_TOKEN remain unset, so Hermes
 * starts normally and this provider stays disabled.
 */
@Injectable()
export class UpstoxSandboxProvider implements ExecutionProvider {
	readonly provider = 'UPSTOX';
	readonly mode: ExecutionMode = 'SANDBOX';
	readonly onRealData = false;
	private readonly logger = new Logger('UpstoxSandboxProvider');

	private readonly baseUrl: string;
	private readonly clientId: string;
	private readonly clientSecret: string;
	private readonly accessToken: string;

	constructor(config: ConfigService) {
		// Fail closed: a REAL-mode request is a configuration error.
		const requestedMode = (config.get<string>('UPSTOX_SANDBOX_MODE') || 'SANDBOX').toUpperCase();
		if (requestedMode !== 'SANDBOX') {
			throw new Error('[UPSTOX][SANDBOX] refusing to start: UPSTOX_SANDBOX_MODE must be SANDBOX (live Upstox is out of scope)');
		}
		this.baseUrl = config.get<string>('UPSTOX_SANDBOX_BASE_URL') || 'https://api-sandbox.upstox.com';
		this.clientId = config.get<string>('UPSTOX_SANDBOX_CLIENT_ID') || '';
		this.clientSecret = config.get<string>('UPSTOX_SANDBOX_CLIENT_SECRET') || '';
		this.accessToken = config.get<string>('UPSTOX_SANDBOX_ACCESS_TOKEN') || '';
	}

	get enabled(): boolean {
		return (
			process.env.UPSTOX_SANDBOX_ENABLED === 'true' &&
			this.clientId !== '' &&
			this.clientSecret !== '' &&
			this.accessToken !== ''
		);
	}

	/** Private HTTP helper — sandbox host only, never the live host. */
	private async call(path: string, method = 'GET', body?: unknown): Promise<unknown> {
		if (!this.enabled) {
			throw new Error('[UPSTOX][SANDBOX][PAPER] not enabled — set UPSTOX_SANDBOX_ENABLED=true and configure UPSTOX_SANDBOX_CLIENT_ID/_SECRET/_ACCESS_TOKEN');
		}
		const res = await fetch(`${this.baseUrl}${path}`, {
			method,
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
				Authorization: `Bearer ${this.accessToken}`,
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		if (!res.ok) {
			throw new Error(`[UPSTOX][SANDBOX][PAPER] ${method} ${path} → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
		}
		return res.json() as Promise<unknown>;
	}

	async placeOrder(input: PlaceOrderInput): Promise<OrderState> {
		this.logger.log(`[UPSTOX][SANDBOX][PAPER] place ${input.side} ${input.quantity} ${input.instrument}`);
		const data = (await this.call('/v2/order/place', 'POST', {
			instrument_token: input.instrument,
			transaction_type: input.side === 'BUY' ? 'BUY' : 'SELL',
			quantity: input.quantity,
			order_type: input.orderType === 'LIMIT' ? 'LIMIT' : 'MARKET',
			product: 'D', // delivery for sandbox options testing
			// The sandbox host requires `validity` on every order (UDAPI1007), and requires BOTH
			// price and trigger_price for a LIMIT order (UDAPI1008 / UDAPI1036). Sending them always
			// keeps MARKET orders (which the host also prices) acceptable.
			validity: 'DAY',
			...(input.limitPrice !== undefined ? { price: String(input.limitPrice), trigger_price: String(input.limitPrice) } : {}),
		})) as { data?: { order_id?: string } };
		return { providerOrderId: String(data?.data?.order_id ?? ''), status: 'PENDING' };
	}

	async modifyOrder(providerOrderId: string, patch: { quantity?: number; limitPrice?: number }): Promise<OrderState> {
		this.logger.log(`[UPSTOX][SANDBOX][PAPER] modify ${providerOrderId}`);
		// NOTE the host's asymmetry, verified live: MODIFY takes `order_id` in the BODY (a query param
		// yields UDAPI1003 "Order id is required"), while CANCEL takes it as a query param. Modify also
		// requires order_type + validity, and price/trigger_price for a LIMIT order.
		await this.call('/v2/order/modify', 'PUT', {
			order_id: providerOrderId,
			order_type: patch.limitPrice !== undefined ? 'LIMIT' : 'MARKET',
			validity: 'DAY',
			...(patch.quantity !== undefined ? { quantity: patch.quantity } : {}),
			...(patch.limitPrice !== undefined ? { price: String(patch.limitPrice), trigger_price: String(patch.limitPrice) } : {}),
		});
		return { providerOrderId, status: 'MODIFIED' };
	}

	async cancelOrder(providerOrderId: string): Promise<{ ok: boolean }> {
		this.logger.log(`[UPSTOX][SANDBOX][PAPER] cancel ${providerOrderId}`);
		// order_id is a REQUEST PARAMETER on this host — a JSON body returns
		// "Required request parameter 'order_id' for method parameter type String".
		await this.call(`/v2/order/cancel?order_id=${encodeURIComponent(providerOrderId)}`, 'DELETE');
		return { ok: true };
	}

	async orderStatus(providerOrderId: string): Promise<OrderState> {
		const data = (await this.call(`/v2/order/details?order_id=${encodeURIComponent(providerOrderId)}`)) as {
			data?: { order_id?: string; status?: string; average_price?: string; filled_quantity?: number; status_message?: string };
		};
		const d = data?.data ?? {};
		return {
			providerOrderId: String(d.order_id ?? providerOrderId),
			status: String(d.status ?? 'UNKNOWN'),
			averagePrice: d.average_price !== undefined ? Number(d.average_price) : null,
			filledQuantity: d.filled_quantity,
			rejectReason: d.status_message ?? null,
		};
	}

	async positions(): Promise<PositionState[]> {
		// The sandbox host exposes NO portfolio endpoint (/v2/portfolio/* → 404 on api-sandbox).
		// Fail loudly instead of returning an empty list that would masquerade as "flat".
		try {
			const data = (await this.call('/v2/portfolio/short-term-positions')) as {
				data?: Array<{ trading_symbol?: string; net_qty?: number; net_avg_price?: string; realized_pnl?: string; unrealised_pnl?: string }>;
			};
			return (data?.data ?? []).map((p) => ({
				instrument: p.trading_symbol ?? '',
				quantity: Number(p.net_qty ?? 0),
				averagePrice: Number(p.net_avg_price ?? 0),
				realizedPnl: p.realized_pnl !== undefined ? Number(p.realized_pnl) : undefined,
				unrealizedPnl: p.unrealised_pnl !== undefined ? Number(p.unrealised_pnl) : undefined,
			}));
		} catch (error) {
			throw new Error(`[UPSTOX][SANDBOX] positions() unavailable — the sandbox host serves no portfolio endpoint (read the order book instead: GET /v2/order/retrieve-all). Cause: ${(error as Error).message}`);
		}
	}

	async trades(): Promise<unknown[]> {
		// The sandbox host has no /v2/order/trades (it requires a single order_id); the order BOOK is
		// /v2/order/retrieve-all. Returning the book keeps "list my sandbox orders" honest.
		const data = (await this.call('/v2/order/retrieve-all')) as { data?: unknown[] };
		return data?.data ?? [];
	}
}
