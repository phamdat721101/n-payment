import { signGoatRequest } from './auth.js';
import type { GoatCredentials } from '../types.js';
import type { GoatOrder, GoatProof, GoatCreateOrderParams, GoatOrderStatus } from './types.js';
import { TERMINAL_STATES } from './types.js';
import { NPaymentError } from '../errors.js';

/**
 * GOAT x402 order lifecycle client.
 *
 * GOAT uses an order-based flow (not standard x402 headers):
 *   createOrder → ERC-20 transfer → pollUntilTerminal → getOrderProof
 *
 * All endpoints use HMAC-SHA256 auth per GOAT API.md.
 */
export class GoatX402Client {
  private apiUrl: string;
  private apiKey: string;
  private apiSecret: string;
  private merchantId: string;

  constructor(creds: GoatCredentials) {
    this.apiUrl = (creds.apiUrl ?? 'https://api.x402.goat.network').replace(/\/$/, '');
    this.apiKey = creds.apiKey;
    this.apiSecret = creds.apiSecret;
    this.merchantId = creds.merchantId;
  }

  /** POST /api/v1/orders — returns 402 on success (GOAT spec). */
  async createOrder(params: GoatCreateOrderParams): Promise<GoatOrder> {
    const body: Record<string, unknown> = {
      dapp_order_id: params.dappOrderId,
      chain_id: params.chainId,
      token_symbol: params.tokenSymbol,
      from_address: params.fromAddress,
      amount_wei: params.amountWei,
      merchant_id: this.merchantId,
    };
    if (params.tokenContract) body.token_contract = params.tokenContract;
    if (params.callbackCalldata) body.callback_calldata = params.callbackCalldata;

    const res = await fetch(`${this.apiUrl}/api/v1/orders`, {
      method: 'POST',
      headers: signGoatRequest(body, this.apiKey, this.apiSecret),
      body: JSON.stringify(body),
    });

    // HTTP 402 is the expected success path per GOAT spec
    if (res.status !== 402 && !res.ok) {
      const err: any = await res.json().catch(() => ({}));
      throw new NPaymentError(
        `GOAT order failed: ${err.error ?? err.message ?? res.statusText}`,
        'GOAT_ORDER_CREATE',
      );
    }

    const data: any = await res.json();
    return {
      orderId: data.order_id,
      payToAddress: data.accepts?.[0]?.payTo ?? '',
      amountWei: params.amountWei,
      flow: data.flow ?? 'ERC20_DIRECT',
      calldataSignRequest: data.calldata_sign_request,
      status: 'CHECKOUT_VERIFIED',
    };
  }

  /** GET /api/v1/orders/{id} — poll order status. */
  async getOrderStatus(orderId: string): Promise<{ status: GoatOrderStatus; txHash?: string }> {
    const res = await fetch(`${this.apiUrl}/api/v1/orders/${orderId}`, {
      headers: signGoatRequest({}, this.apiKey, this.apiSecret),
    });
    if (!res.ok) throw new NPaymentError('Failed to get order status', 'GOAT_STATUS');
    const data: any = await res.json();
    return { status: data.status, txHash: data.tx_hash };
  }

  /** Poll until terminal state. Auto-cancels on timeout to refund fee. */
  async pollUntilTerminal(
    orderId: string,
    timeoutMs = 120_000,
    intervalMs = 2_000,
  ): Promise<GoatOrderStatus> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { status } = await this.getOrderStatus(orderId);
      if (TERMINAL_STATES.includes(status)) return status;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    try { await this.cancelOrder(orderId); } catch { /* best-effort cancel */ }
    throw new NPaymentError('Order polling timed out', 'GOAT_TIMEOUT');
  }

  /** GET /api/v1/orders/{id}/proof — settlement proof. */
  async getOrderProof(orderId: string): Promise<GoatProof> {
    const res = await fetch(`${this.apiUrl}/api/v1/orders/${orderId}/proof`, {
      headers: signGoatRequest({}, this.apiKey, this.apiSecret),
    });
    if (!res.ok) throw new NPaymentError('Failed to get proof', 'GOAT_PROOF');
    return res.json();
  }

  /** POST /api/v1/orders/{id}/cancel — only CHECKOUT_VERIFIED orders. */
  async cancelOrder(orderId: string): Promise<void> {
    await fetch(`${this.apiUrl}/api/v1/orders/${orderId}/cancel`, {
      method: 'POST',
      headers: signGoatRequest({}, this.apiKey, this.apiSecret),
    });
  }

  /** POST /api/v1/orders/{id}/calldata-signature — DELEGATE mode. */
  async submitCalldataSignature(orderId: string, signature: string): Promise<void> {
    const res = await fetch(`${this.apiUrl}/api/v1/orders/${orderId}/calldata-signature`, {
      method: 'POST',
      headers: signGoatRequest({ signature }, this.apiKey, this.apiSecret),
      body: JSON.stringify({ signature }),
    });
    if (!res.ok) throw new NPaymentError('Failed to submit calldata signature', 'GOAT_CALLDATA');
  }
}
